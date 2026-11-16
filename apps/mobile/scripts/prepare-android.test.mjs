import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installLauncherIcons, rotateDebugApk, secureManifest } from './prepare-android.mjs'

test('packaged debug and release ignore the generated HTTP-enabling placeholder', () => {
  const original = '<application android:usesCleartextTraffic="${usesCleartextTraffic}" android:label="Aelys" />'
  const secured = secureManifest(original)
  assert.equal(secured, '<application android:usesCleartextTraffic="false" android:label="Aelys" />')
  assert.equal(secureManifest(secured), secured)
})

test('fails closed when an unreviewed template changes the network policy', () => {
  for (const source of [
    '<application />',
    '<application android:usesCleartextTraffic="true" />',
    '<application android:usesCleartextTraffic="false" /><application android:usesCleartextTraffic="false" />',
    '<application android:usesCleartextTraffic="false" android:networkSecurityConfig="@xml/network" />',
  ]) assert.throws(() => secureManifest(source), /review/)
})

test('fresh debug packaging preserves the previous APK and leaves releases untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aelys-android-packaging-'))
  const project = pathToFileURL(`${directory}/`)
  const apk = new URL('app/build/outputs/apk/universal/debug/app-universal-debug.apk', project)
  const release = new URL('app/build/outputs/apk/universal/release/app-universal-release.apk', project)
  try {
    await mkdir(new URL('.', apk), { recursive: true })
    await mkdir(new URL('.', release), { recursive: true })
    await writeFile(apk, 'previous debug APK')
    await writeFile(release, 'signed release')
    assert.equal(await rotateDebugApk(project, { TAURI_ENV_PLATFORM: 'android', TAURI_ENV_DEBUG: 'true' }), true)
    await assert.rejects(readFile(apk), { code: 'ENOENT' })
    assert.equal(await readFile(new URL(`${apk.href}.previous`), 'utf8'), 'previous debug APK')
    assert.equal(await readFile(release, 'utf8'), 'signed release')
    assert.equal(await rotateDebugApk(project, { TAURI_ENV_PLATFORM: 'android', TAURI_ENV_DEBUG: 'true' }), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('does not rotate archives for release, manual preparation, or a different platform', async () => {
  // A nonexistent root makes accidental filesystem operations fail the test.
  const root = pathToFileURL('/nonexistent-aelys-project/')
  for (const env of [
    {},
    { TAURI_ENV_PLATFORM: 'android' },
    { TAURI_ENV_PLATFORM: 'android', TAURI_ENV_DEBUG: 'false' },
    { TAURI_ENV_PLATFORM: 'darwin', TAURI_ENV_DEBUG: 'true' },
  ]) assert.equal(await rotateDebugApk(root, env), false)
})


test('restores branded adaptive icons after Android initialization without replacing other resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aelys-launcher-icons-'))
  const project = pathToFileURL(`${directory}/project/`)
  const icons = pathToFileURL(`${directory}/icons/`)
  const fixtures = {
    'mipmap-mdpi/ic_launcher.png': 'brand-png',
    'mipmap-anydpi-v26/ic_launcher.xml': '<adaptive-icon>brand</adaptive-icon>',
    'mipmap-anydpi-v33/ic_launcher.xml': '<adaptive-icon>themed-brand</adaptive-icon>',
  }
  try {
    for (const [name, value] of Object.entries(fixtures)) {
      await mkdir(new URL('.', new URL(name, icons)), { recursive: true })
      await writeFile(new URL(name, icons), value)
    }
    const other = new URL('app/src/main/res/xml/file_paths.xml', project)
    await mkdir(new URL('.', other), { recursive: true }); await writeFile(other, 'existing file-provider policy')
    await installLauncherIcons(project, icons)
    for (const [name, value] of Object.entries(fixtures)) assert.equal(await readFile(new URL(`app/src/main/res/${name}`, project), 'utf8'), value)
    assert.equal(await readFile(other, 'utf8'), 'existing file-provider policy')
    await writeFile(new URL('app/src/main/res/mipmap-mdpi/ic_launcher.png', project), 'regenerated template')
    await installLauncherIcons(project, icons)
    assert.equal(await readFile(new URL('app/src/main/res/mipmap-mdpi/ic_launcher.png', project), 'utf8'), 'brand-png')
    await assert.rejects(installLauncherIcons(project, new URL('missing/', icons)), { code: 'ENOENT' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('microphone setup adds only RECORD_AUDIO and fails on unfamiliar manifests', async () => {
  const { addMicrophonePermission } = await import('./prepare-android.mjs')
  const manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <uses-permission android:name="android.permission.INTERNET" />\n</manifest>'
  const updated = addMicrophonePermission(manifest)
  assert.match(updated, /android\.permission\.RECORD_AUDIO/)
  assert.equal(addMicrophonePermission(updated), updated)
  assert.throws(() => addMicrophonePermission('<manifest />'), /review/)
})

test('WebView patch is idempotent and rejects unfamiliar generated clients', async () => {
  const { patchWebChromeClient } = await import('./prepare-android.mjs')
  const client = 'class RustWebChromeClient {\n  override fun onPermissionRequest(request: PermissionRequest) {\n    val requestedResources = request.resources\n  }\n}'
  const patched = patchWebChromeClient(client)
  assert.match(patched, /aelysHandleMicrophone\(request\)/)
  assert.match(patched, /onPermissionRequestCanceled/)
  assert.equal(patchWebChromeClient(patched), patched)
  assert.throws(() => patchWebChromeClient('class Unknown {}'), /review/)
})

test('Android Kotlin compilation is ordered after the matching Rust build and patches the generated client', async () => {
  const { patchAndroidGradle } = await import('./prepare-android.mjs')
  const source = 'plugins {\n    id("rust")\n}\n'
  const patched = patchAndroidGradle(source)
  assert.match(patched, /rustBuild\$\{variant\}/)
  assert.match(patched, /patch-webchrome/)
  assert.equal(patchAndroidGradle(patched), patched)
  assert.throws(() => patchAndroidGradle('plugins {}'), /review/)
})

test('both native shells allow blob audio without allowing data media', async () => {
  for (const config of ['../../desktop/src-tauri/tauri.conf.json', '../src-tauri/tauri.conf.json']) {
    const { app } = JSON.parse(await readFile(new URL(config, import.meta.url), 'utf8'))
    assert.match(app.security.csp, /(?:^|;)\s*media-src 'self' blob:(?:;|$)/)
  }
})

test('patches Wry Kotlin inside the generated package directory and rejects ambiguous clients', async () => {
  const { patchGeneratedWebChrome } = await import('./prepare-android.mjs')
  const directory = await mkdtemp(join(tmpdir(), 'aelys-webchrome-'))
  const project = pathToFileURL(`${directory}/`)
  const client = new URL('app/src/main/java/com/aelys/mobile/generated/RustWebChromeClient.kt', project)
  try {
    await mkdir(new URL('.', client), { recursive: true })
    await writeFile(client, 'class RustWebChromeClient {\n  override fun onPermissionRequest(request: PermissionRequest) {\n  }\n}')
    await patchGeneratedWebChrome(project)
    const first = await readFile(client, 'utf8')
    assert.match(first, /aelysHandleMicrophone\(request\)/)
    await patchGeneratedWebChrome(project)
    assert.equal(await readFile(client, 'utf8'), first)
    const duplicate = new URL('app/src/main/java/other/RustWebChromeClient.kt', project)
    await mkdir(new URL('.', duplicate), { recursive: true }); await writeFile(duplicate, 'duplicate')
    await assert.rejects(patchGeneratedWebChrome(project), /exactly one/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
