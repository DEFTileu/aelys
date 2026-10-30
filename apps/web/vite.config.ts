import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const runtimeEnv = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> }
}).process?.env
const backendOrigin = runtimeEnv?.AELYS_BACKEND_ORIGIN || 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react(), {
    name: 'aelys-local-identity',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const { method, url } = request as typeof request & { method?: string; url?: string }
        if (method !== 'GET' || url !== '/__aelys_dev') return next()
        response.setHeader('Content-Type', 'application/json')
        response.setHeader('Cache-Control', 'no-store')
        response.end(JSON.stringify({ service: 'aelys-web', backend_origin: backendOrigin.replace(/\/+$/, '') }))
      })
    },
  }],
  server: {
    port: 5173,
    proxy: {
      '/api': backendOrigin,
      '/healthz': backendOrigin,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/tests/**/*.test.{ts,tsx}'],
  },
})
