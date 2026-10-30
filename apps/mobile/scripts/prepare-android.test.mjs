import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rotateDebugApk, secureManifest } from './prepare-android.mjs'

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
