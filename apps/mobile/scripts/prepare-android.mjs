import { cp, readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

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
  const secured = secureManifest(source)
  if (secured !== source) await writeFile(manifest, secured)
  await installLauncherIcons(project)
  console.log('Android packaged network policy: cleartext disabled; Aelys launcher icons installed')
  if (await rotateDebugApk(project, process.env)) console.log('Previous debug APK retained as .apk.previous; packaging a fresh archive')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareAndroid()
}
