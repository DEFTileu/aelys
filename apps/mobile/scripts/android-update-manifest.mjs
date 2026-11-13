#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const MAX_SIZE = 128 * 1024 * 1024
const PACKAGE = 'com.aelys.mobile'

async function runSdkTool(command, args) {
  const { stdout } = await exec(command, args, { maxBuffer: 1024 * 1024 })
  return stdout
}

function validateUrl(value) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('Invalid artifact URL') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      value.includes('?') || value.includes('#') || !parsed.pathname.endsWith('.apk')) {
    throw new Error('Artifact URL must be HTTPS, without credentials, query or fragment, and end in .apk')
  }
  return value
}

function parseBadging(output) {
  const lines = output.split(/\r?\n/)
  const packages = lines.filter(line => line.startsWith('package: '))
  const native = lines.filter(line => line.startsWith('native-code:'))
  if (packages.length !== 1 || native.length !== 1) throw new Error('Invalid APK metadata or ABI')
  const fields = [...packages[0].matchAll(/(?:^|\s)(name|versionCode|versionName)='([^']*)'/g)]
  const values = Object.fromEntries(fields.map(([, key, value]) => [key, value]))
  if (fields.length !== 3 || new Set(fields.map(([, key]) => key)).size !== 3 || values.name !== PACKAGE) throw new Error('Invalid APK package metadata')
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(values.versionName)) throw new Error('APK versionName must be stable semver')
  if (!/^[1-9]\d*$/.test(values.versionCode) || !Number.isSafeInteger(Number(values.versionCode)) || Number(values.versionCode) > 2_100_000_000) throw new Error('Invalid APK versionCode')
  if (!native[0].split(/\s+/).includes("'arm64-v8a'")) throw new Error('APK does not contain arm64-v8a native code')
  return { version: values.versionName, version_code: Number(values.versionCode) }
}

export async function generateManifest({ apk, url, apksigner = 'apksigner', aapt = 'aapt', runTool = runSdkTool }) {
  validateUrl(url)
  if (typeof apk !== 'string' || !apk) throw new Error('APK path is required')
  const file = await open(apk, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size < 1 || before.size > MAX_SIZE) throw new Error('APK must be a nonempty file no larger than 128 MiB')
    try { await runTool(apksigner, ['verify', apk]) } catch { throw new Error('APK signature verification failed') }
    let badging
    try { badging = await runTool(aapt, ['dump', 'badging', apk]) } catch { throw new Error('APK metadata inspection failed') }
    const metadata = parseBadging(badging)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length
      if (size > MAX_SIZE) throw new Error('APK exceeds 128 MiB')
      hash.update(chunk)
    }
    const after = await file.stat()
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('APK changed during inspection')
    return { schema_version: 1, package_id: PACKAGE, ...metadata, targets: { 'android-aarch64': { url, sha256: hash.digest('hex'), size_bytes: size } } }
  } finally { await file.close() }
}

async function main(args) {
  const options = {}
  const allowed = new Set(['apk', 'url', 'apksigner', 'aapt'])
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.startsWith('--') ? args[i].slice(2) : ''
    if (!allowed.has(key) || Object.hasOwn(options, key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node android-update-manifest.mjs --apk PATH --url HTTPS_APK_URL [--apksigner PATH] [--aapt PATH]')
    options[key] = args[i + 1]
  }
  if (!options.apk || !options.url) throw new Error('Usage: node android-update-manifest.mjs --apk PATH --url HTTPS_APK_URL [--apksigner PATH] [--aapt PATH]')
  const manifest = await generateManifest(options)
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Manifest generation failed. Check arguments, APK, and Android SDK tools. No manifest was generated.\n')
    process.exitCode = 1
  })
}
