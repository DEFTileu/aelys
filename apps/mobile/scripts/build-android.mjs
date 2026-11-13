import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Match the existing Mac distribution; self-hosted builds override this value.
const DEFAULT_BACKEND = 'https://api-production-1cea.up.railway.app/api/v1'

export function androidBuildEnv(env) {
  const baseUrl = env.VITE_API_BASE_URL || DEFAULT_BACKEND
  let url
  try { url = new URL(baseUrl) } catch { throw new Error('Android builds require an HTTPS backend ending in /api/v1') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/api/v1' || baseUrl !== `${url.origin}/api/v1`) {
    throw new Error('Android builds require an HTTPS backend ending in /api/v1')
  }
  return { ...env, VITE_API_BASE_URL: baseUrl }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = spawnSync('tauri', ['android', 'build', ...process.argv.slice(2)], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: androidBuildEnv(process.env), stdio: 'inherit',
    })
    if (result.error) throw new Error('Could not launch the Android build; check the Tauri toolchain')
    process.exitCode = result.status ?? 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
