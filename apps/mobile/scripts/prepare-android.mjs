import { cp, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

// Tauri's generated debug manifest otherwise allows HTTP to every destination.
// Packaged APKs use bundled assets and must keep the same TLS policy as release.
export function secureManifest(source) {
  const matches = [...source.matchAll(/android:usesCleartextTraffic="([^"]*)"/g)]
  if (matches.length !== 1 || !['${usesCleartextTraffic}', 'false'].includes(matches[0][1])) {
    throw new Error('Unexpected Android cleartext policy; review the generated manifest before building')
  }
  if (/android:networkSecurityConfig\s*=/.test(source)) {
    throw new Error('Unexpected Android network security override; review it before building')
  }
  return source.replace('android:usesCleartextTraffic="${usesCleartextTraffic}"', 'android:usesCleartextTraffic="false"')
}

const microphoneHandler = readFileSync(new URL('../android/microphone-handler.kt', import.meta.url), 'utf8')
const chromeMarker = '  // The WebView gives us the requesting origin here; the Rust callback does not.'

export function addMicrophonePermission(source) {
  const permission = '<uses-permission android:name="android.permission.RECORD_AUDIO" />'
  if (source.includes(permission)) return source
  const anchor = '<uses-permission android:name="android.permission.INTERNET" />'
  if (source.split(anchor).length !== 2 || source.includes('android.permission.RECORD_AUDIO')) throw new Error('Unexpected Android manifest; review before building')
  return source.replace(anchor, `${anchor}\n    ${permission}`)
}

export function patchWebChromeClient(source) {
  if (source.includes(chromeMarker)) {
    if (!source.includes('if (aelysHandleMicrophone(request)) return') || !source.includes(microphoneHandler)) throw new Error('Unexpected microphone handler; review before building')
    return source
  }
  const anchor = '  override fun onPermissionRequest(request: PermissionRequest) {'
  if (source.split(anchor).length !== 2 || source.includes('override fun onPermissionRequestCanceled(')) throw new Error('Unexpected WebChromeClient; review before building')
  return source.replace(anchor, `${microphoneHandler}${anchor}\n    if (aelysHandleMicrophone(request)) return`)
}

const gradleHook = `
// Aelys: patch Wry after Rust generates Kotlin and before it is compiled.
afterEvaluate {
    tasks.matching { Regex("compile(.*)Kotlin").matches(it.name) }.forEach { kotlinTask ->
        val variant = Regex("compile(.*)Kotlin").matchEntire(kotlinTask.name)!!.groupValues[1]
        val patchTask = tasks.register<Exec>("aelysPatch${'$'}{variant}Microphone") {
            dependsOn("rustBuild${'$'}{variant}")
            workingDir(projectDir)
            commandLine("node", "../../../../scripts/prepare-android.mjs", "patch-webchrome")
        }
        kotlinTask.dependsOn(patchTask)
    }
}
`
export function patchAndroidGradle(source) {
  if (source.includes(gradleHook)) return source
  if (source.split('    id("rust")').length !== 2 || source.includes('// Aelys: patch Wry')) throw new Error('Unexpected Android Gradle template; review before building')
  return source + gradleHook
}

export async function patchGeneratedWebChrome(project) {
  const java = new URL('app/src/main/java/', project)
  const clients = (await readdir(java, { recursive: true })).filter(path => path.endsWith('/RustWebChromeClient.kt'))
  if (clients.length !== 1) throw new Error('Expected exactly one generated RustWebChromeClient; review before building')
  const client = new URL(clients[0], java)
  const source = await readFile(client, 'utf8')
  const patched = patchWebChromeClient(source)
  if (source !== patched) await writeFile(client, patched)
}

// Incremental packaging can retain the previous large uncompressed .so as dead
// ZIP space. Keep the old debug APK recoverable while forcing a fresh archive.
// Restrict this to our generated universal debug output; signed releases stay put.
export async function rotateDebugApk(androidProject, env) {
  if (env.TAURI_ENV_PLATFORM !== 'android' || env.TAURI_ENV_DEBUG !== 'true') return false
  const apk = new URL('app/build/outputs/apk/universal/debug/app-universal-debug.apk', androidProject)
  try {
    await rename(apk, new URL(`${apk.href}.previous`))
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export async function installLauncherIcons(androidProject, iconSource = new URL('../src-tauri/icons/android/', import.meta.url)) {
  for (const file of ['mipmap-mdpi/ic_launcher.png', 'mipmap-anydpi-v26/ic_launcher.xml', 'mipmap-anydpi-v33/ic_launcher.xml']) await readFile(new URL(file, iconSource))
  await cp(iconSource, new URL('app/src/main/res/', androidProject), { recursive: true })
}

export async function prepareAndroid() {
  const project = new URL('../src-tauri/gen/android/', import.meta.url)
  const manifest = new URL('app/src/main/AndroidManifest.xml', project)
  const source = await readFile(manifest, 'utf8').catch((cause) => {
    throw new Error('Initialize the Android project with `tauri android init` before building', { cause })
  })
  const secured = addMicrophonePermission(secureManifest(source))
  if (secured !== source) await writeFile(manifest, secured)
  const gradle = new URL('app/build.gradle.kts', project)
  const gradleSource = await readFile(gradle, 'utf8')
  const patchedGradle = patchAndroidGradle(gradleSource)
  if (patchedGradle !== gradleSource) await writeFile(gradle, patchedGradle)
  await installLauncherIcons(project)
  console.log('Android packaged network policy: cleartext disabled; Aelys launcher icons installed')
  if (await rotateDebugApk(project, process.env)) console.log('Previous debug APK retained as .apk.previous; packaging a fresh archive')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'patch-webchrome') await patchGeneratedWebChrome(new URL('../src-tauri/gen/android/', import.meta.url))
  else await prepareAndroid()
}
