import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const runtimeEnv = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> }
}).process?.env
const backendOrigin = runtimeEnv?.AELYS_BACKEND_ORIGIN || 'http://127.0.0.1:8000'
// Keep the browser's exact loopback origin for the backend's CSRF checks,
// including when the launcher selects a fallback web port.
const backendProxy = { target: backendOrigin, changeOrigin: false }
let launchId = ''

export default defineConfig({
  plugins: [react(), {
    name: 'aelys-local-identity',
    apply: 'serve',
    config(_config, { mode }) {
      launchId = mode !== 'test' ? globalThis.crypto.randomUUID() : ''
      return { define: { 'import.meta.env.VITE_LOCAL_LAUNCH_ID': JSON.stringify(launchId) } }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const { method, url } = request as typeof request & { method?: string; url?: string }
        if (method !== 'GET' || url !== '/__aelys_dev') return next()
        response.setHeader('Content-Type', 'application/json')
        response.setHeader('Cache-Control', 'no-store')
        response.end(JSON.stringify({ service: 'aelys-web', backend_origin: backendOrigin.replace(/\/+$/, ''), launch_id: launchId }))
      })
    },
  }],
  server: {
    port: 5173,
    proxy: {
      '/api': backendProxy,
      '/healthz': backendProxy,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/tests/**/*.test.{ts,tsx}'],
  },
})
