import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, checkApi, normalizeApiBaseUrl } from '../lib/api'
import viteConfig from '../../vite.config'

describe('API boundary configuration', () => {
  it('normalizes a configured base URL without trailing slash', () => {
    expect(normalizeApiBaseUrl(' https://example.test/api/v1/ ')).toBe('https://example.test/api/v1')
  })

  it('uses the documented local default for blank values', () => {
    expect(normalizeApiBaseUrl('')).toBe('/api/v1')
  })
})

describe('API health verification', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it.each([
    ['/api/v1', '/healthz'],
    [' https://api.example.test/api/v1/ ', 'https://api.example.test/healthz'],
  ])('checks backend health for %s', async (baseUrl, healthUrl) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }))
    vi.stubGlobal('fetch', fetchImpl)

    await expect(checkApi({ baseUrl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith(healthUrl, { headers: { Accept: 'application/json' } })
  })

  it.each([
    ['SPA fallback HTML', '<!doctype html><html><body>Aelys</body></html>', 'text/html'],
    ['JSON body served as HTML', '{"status":"ok"}', 'text/html'],
    ['malformed JSON', '<html>Aelys</html>', 'application/json'],
    ['missing health status', '{}', 'application/json'],
    ['unhealthy status', '{"status":"error"}', 'application/json'],
    ['null body', 'null', 'application/json'],
    ['primitive body', '"ok"', 'application/json'],
  ])('rejects HTTP 200 with %s', async (_name, body, contentType) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Type': contentType } })))

    await expect(checkApi({ baseUrl: '/api/v1' })).rejects.toMatchObject({
      name: 'ApiError', status: 200, message: 'API returned an invalid health response',
    })
  })

  it('preserves an unsuccessful HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unavailable', { status: 503 })))
    await expect(checkApi({ baseUrl: '/api/v1' })).rejects.toMatchObject({ name: 'ApiError', status: 503 })
  })

  it('propagates a transport failure', async () => {
    const error = new TypeError('Failed to fetch')
    vi.stubGlobal('fetch', vi.fn(async () => { throw error }))
    await expect(checkApi({ baseUrl: '/api/v1' })).rejects.toBe(error)
    expect(error).not.toBeInstanceOf(ApiError)
  })

  it('proxies health checks to the same backend as API requests', () => {
    expect(viteConfig.server?.proxy?.['/api']).toBe('http://127.0.0.1:8000')
    expect(viteConfig.server?.proxy?.['/healthz']).toBe(viteConfig.server?.proxy?.['/api'])
  })
})
