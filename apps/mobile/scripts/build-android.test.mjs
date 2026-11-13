import { test } from 'node:test'
import assert from 'node:assert/strict'

test('Android builds include the existing hosted backend unless explicitly overridden', async () => {
  const { androidBuildEnv } = await import('./build-android.mjs')
  assert.equal(androidBuildEnv({}).VITE_API_BASE_URL, 'https://api-production-1cea.up.railway.app/api/v1')
  const env = androidBuildEnv({ VITE_API_BASE_URL: 'https://self-hosted.example/api/v1', OTHER: 'retained' })
  assert.equal(env.VITE_API_BASE_URL, 'https://self-hosted.example/api/v1')
  assert.equal(env.OTHER, 'retained')
})

test('Android builds reject relative, HTTP, credential-bearing and malformed backend addresses', async () => {
  const { androidBuildEnv } = await import('./build-android.mjs')
  for (const value of ['/api/v1', 'http://127.0.0.1:8000/api/v1', 'https://user:secret@example.com/api/v1', 'https://example.com/api/v1?secret=x', 'https://example.com/api/v1#fragment', 'https://example.com/wrong', 'not a URL']) {
    assert.throws(() => androidBuildEnv({ VITE_API_BASE_URL: value }), /HTTPS backend/)
  }
})
