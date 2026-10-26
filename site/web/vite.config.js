import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The web is served from the same origin as the API: in development Vite
 * proxies /api to site/api, in production the reverse proxy does. So the
 * session cookie is first-party and the API needs no CORS.
 *
 * Port 5173 is fixed (strictPort) because the API's default SITE_URL, and
 * with it the SSO redirect_uri, is http://localhost:5173.
 */
const apiPort = process.env.API_PORT ?? '3001'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
    },
  },
})
