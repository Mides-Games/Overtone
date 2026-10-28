import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { readChangelog, timelinePath } from './scripts/changelog.mjs'
import { openapiPath, readOpenApi } from './scripts/openapi.mjs'

/**
 * The web is served from the same origin as the API: in development Vite
 * proxies /api to site/api, in production the reverse proxy does. So the
 * session cookie is first-party and the API needs no CORS.
 *
 * Port 5173 is fixed (strictPort) because the API's default SITE_URL, and
 * with it the SSO redirect_uri, is http://localhost:5173.
 */
const apiPort = process.env.API_PORT ?? '3001'

/**
 * `virtual:changelog`: the last entries of docs/timeline.md as JSON
 * (scripts/changelog.mjs, W5.5), read when a build or the dev server first
 * asks for it. Nothing generated is committed, so it cannot go stale.
 */
function changelog() {
  const id = 'virtual:changelog'
  const resolved = `\0${id}`
  return {
    name: 'overtone-changelog',
    resolveId: (source) => (source === id ? resolved : null),
    load(source) {
      if (source !== resolved) return null
      this.addWatchFile(timelinePath)
      return `export default ${JSON.stringify(readChangelog())}`
    },
  }
}

/**
 * `virtual:openapi`: the API's reference (site/api/docs/openapi.yaml) as the
 * `/developers` page reads it (scripts/openapi.mjs, W12.20). Read when asked,
 * like the changelog, so the page is always the document as it is.
 */
function openapi() {
  const id = 'virtual:openapi'
  const resolved = `\0${id}`
  return {
    name: 'overtone-openapi',
    resolveId: (source) => (source === id ? resolved : null),
    load(source) {
      if (source !== resolved) return null
      this.addWatchFile(openapiPath)
      return `export default ${JSON.stringify(readOpenApi())}`
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), changelog(), openapi()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
    },
  },
})
