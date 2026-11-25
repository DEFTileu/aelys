import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Android microphone callback validates origin, resources, consent and cancellation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aelys-mic-test-'))
  const files = {
    'Manifest.kt': `package android\nobject Manifest { object permission { const val RECORD_AUDIO = "record" } }\nobject R { object string { const val cancel = 0; const val ok = 1 } }`,
    'Uri.kt': `package android.net\nclass Uri(val scheme: String?, val host: String?, val port: Int = -1, val userInfo: String? = null, val path: String? = null, val query: String? = null, val fragment: String? = null)`,
    'Web.kt': `package android.webkit\nimport android.net.Uri\nopen class PermissionRequest(val origin: Uri, val resources: Array<String>) { var result = "pending"; fun deny() { result = "deny" }; fun grant(r: Array<String>) { result = r.joinToString() }; companion object { const val RESOURCE_AUDIO_CAPTURE = "audio"; const val RESOURCE_VIDEO_CAPTURE = "video" } }\nopen class WebChromeClient { open fun onPermissionRequestCanceled(request: PermissionRequest) {} }`,
    'Dialog.kt': `package android.app\nclass AlertDialog { fun show() {}; fun dismiss() {}; class Builder(val activity: Any) { fun setMessage(s: String) = this; fun setNegativeButton(i: Int, f: (Any?, Int) -> Unit) = this; fun setPositiveButton(i: Int, f: (Any?, Int) -> Unit): Builder { positive = f; return this }; fun setOnCancelListener(f: (Any?) -> Unit) = this; fun create() = AlertDialog(); companion object { lateinit var positive: (Any?, Int) -> Unit } } }`,
  }
  const handler = readFileSync(new URL('../android/microphone-handler.kt', import.meta.url), 'utf8')
  files['Test.kt'] = `import android.Manifest\nimport android.webkit.*\nimport android.net.Uri\nclass Activity { var callback: ((Boolean?) -> Unit)? = null; fun requestPermissions(p: Array<String>, cb: (Boolean?) -> Unit) { check(p.contentEquals(arrayOf(Manifest.permission.RECORD_AUDIO))); callback = cb } }\nclass Client(val activity: Activity): WebChromeClient() {\n${handler}\nfun handle(r: PermissionRequest) = aelysHandleMicrophone(r)\n}\nfun main() {\nval a = Activity(); val c = Client(a)\nfun req(u: Uri, vararg r: String) = PermissionRequest(u, arrayOf(*r))\nval audio = PermissionRequest.RESOURCE_AUDIO_CAPTURE\nfor (u in listOf(Uri("https", "tauri.localhost"), Uri("http", "evil.test"), Uri("http", "tauri.localhost", 80), Uri("http", "tauri.localhost", path="/bad"))) { val r=req(u,audio); check(c.handle(r)); check(r.result == "deny") }\nval mixed=req(Uri("http", "tauri.localhost"),audio,"video"); check(c.handle(mixed)); check(mixed.result == "deny")\nval unrelated=req(Uri("http", "tauri.localhost"),"video"); check(!c.handle(unrelated))\nval ok=req(Uri("http", "tauri.localhost",path="/"),audio); check(c.handle(ok)); check(ok.result == "pending"); android.app.AlertDialog.Builder.positive(null,0); a.callback!!(false); check(ok.result == "deny")\nval accepted=req(Uri("http", "tauri.localhost"),audio); check(c.handle(accepted)); android.app.AlertDialog.Builder.positive(null,0); a.callback!!(true); check(accepted.result == "audio")\nval cancelled=req(Uri("http", "tauri.localhost"),audio); check(c.handle(cancelled)); android.app.AlertDialog.Builder.positive(null,0); c.onPermissionRequestCanceled(cancelled); a.callback!!(true); check(cancelled.result == "pending")\n}`
  try {
    for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data)
    execFileSync('kotlinc', [...Object.keys(files).map((f) => join(dir, f)), '-include-runtime', '-d', join(dir, 'test.jar')], { stdio: 'pipe' })
    execFileSync('java', ['-jar', join(dir, 'test.jar')], { stdio: 'pipe' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
