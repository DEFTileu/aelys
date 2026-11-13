import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const good = "package: name='com.aelys.mobile' versionCode='42' versionName='1.2.3'\nnative-code: 'arm64-v8a'\n"
const url = 'https://example.com/releases/aelys.apk'
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'aelys-manifest-'))
  const apk = join(dir, 'app.apk')
  await writeFile(apk, 'signed apk bytes')
  try { await run(apk) } finally { await rm(dir, { recursive: true, force: true }) }
}
function tools(badging = good, verify = true) {
  return async (command, args) => {
    if (command === 'apksigner' && args[0] === 'verify') {
      if (!verify) throw new Error('sensitive tool output')
      return ''
    }
    if (command === 'aapt' && args[0] === 'dump' && args[1] === 'badging') return badging
    throw new Error('unexpected command')
  }
}
async function generate(apk, options = {}) {
  const { generateManifest } = await import('./android-update-manifest.mjs')
  return generateManifest({ apk, url, runTool: tools(), ...options })
}

test('generates the exact manifest from verified metadata and real APK bytes', async () => fixture(async apk => {
  assert.deepEqual(await generate(apk), {
    schema_version: 1, package_id: 'com.aelys.mobile', version: '1.2.3', version_code: 42,
    targets: { 'android-aarch64': { url, sha256: createHash('sha256').update('signed apk bytes').digest('hex'), size_bytes: 16 } },
  })
}))

test('rejects failed signature verification without exposing tool output', async () => fixture(async apk => {
  await assert.rejects(generate(apk, { runTool: tools(good, false) }), error => /signature/i.test(error.message) && !error.message.includes('sensitive'))
}))

test('rejects invalid APK package, stable version, code, and ABI', async () => fixture(async apk => {
  for (const badging of [
    good.replace('com.aelys.mobile', 'com.other.app'), good.replace('1.2.3', '1.2.3-rc.1'),
    good.replace('1.2.3', '01.2.3'), good.replace("versionCode='42'", "versionCode='0'"),
    good.replace("versionCode='42'", "versionCode='2100000001'"),
    good.replace("versionCode='42'", "versionCode='9007199254740992'"),
    good.replace('arm64-v8a', 'x86_64'), good.replace("native-code: 'arm64-v8a'", ''),
    good + "package: name='com.aelys.mobile' versionCode='42' versionName='1.2.3'\n",
  ]) await assert.rejects(generate(apk, { runTool: tools(badging) }))
}))

test('rejects unsafe artifact URLs', async () => fixture(async apk => {
  for (const badUrl of ['http://example.com/a.apk', 'https://u:p@example.com/a.apk', 'https://example.com/a.apk?x=1', 'https://example.com/a.apk#x', 'https://example.com/a.zip', 'https://example.com/']) {
    await assert.rejects(generate(apk, { url: badUrl }))
  }
}))

test('rejects empty and oversized APKs', async () => fixture(async apk => {
  await truncate(apk, 0)
  await assert.rejects(generate(apk))
  await truncate(apk, 128 * 1024 * 1024 + 1)
  await assert.rejects(generate(apk))
}))

test('CLI invokes supplied SDK tools and emits JSON without changing the APK', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { chmod, readFile } = await import('node:fs/promises')
  const directory = await mkdtemp(join(tmpdir(), 'aelys-manifest-cli-'))
  const apk = join(directory, 'release.apk')
  const signer = join(directory, 'apksigner')
  const aapt = join(directory, 'aapt')
  try {
    await writeFile(apk, 'APK fixture')
    await writeFile(signer, '#!/bin/sh\n[ "$1" = verify ] && [ "$2" = "' + apk + '" ]\n')
    await writeFile(aapt, '#!/bin/sh\n[ "$1" = dump ] && [ "$2" = badging ] || exit 1\nprintf "%s\\n" "package: name=\x27com.aelys.mobile\x27 versionCode=\x2742\x27 versionName=\x271.2.3\x27" "native-code: \x27arm64-v8a\x27"\n')
    await chmod(signer, 0o755); await chmod(aapt, 0o755)
    const script = new URL('./android-update-manifest.mjs', import.meta.url).pathname
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [script, '--apk', apk, '--url', url, '--apksigner', signer, '--aapt', aapt])
    assert.equal(JSON.parse(stdout).version_code, 42)
    assert.equal(stderr, '')
    assert.equal(await readFile(apk, 'utf8'), 'APK fixture')
    await assert.rejects(promisify(execFile)(process.execPath, [script, '--apk', apk, '--url', 'https://secret@example.com/a.apk', '--apksigner', signer, '--aapt', aapt]), error => !error.stderr.includes('secret'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
