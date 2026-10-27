import { defineConfig, devices } from '@playwright/test'

/**
 * The site end to end (W10.6), local only: CLAUDE.md keeps every check out
 * of CI. One line from the repository root:
 *
 *   pnpm --dir site/e2e test
 *
 * It starts its own API (serve-api.mjs: the dev API in memory and a fake
 * worker) and its own Vite, on E2E_API_PORT and E2E_WEB_PORT (3090 and 5290
 * unless set), so it never meets a `pnpm dev` on 3001/5173, then runs
 * headless Chromium (`pnpm --dir site/e2e exec playwright install chromium`
 * once per machine). A server already on those ports is reused, so a second
 * run while one is open is quick.
 *
 * 127.0.0.1, not localhost: localhost cookies are shared across ports, and
 * another dev server's sign-in would sign this run's out.
 *
 * One worker: the specs share one API's rate limits and queue, and the
 * machine is shared.
 */
const apiPort = process.env.E2E_API_PORT || '3090'
const webPort = process.env.E2E_WEB_PORT || '5290'
const base = `http://127.0.0.1:${webPort}`

export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: base,
    ...devices['Desktop Chrome'],
    viewport: { width: 1366, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node serve-api.mjs',
      url: `http://127.0.0.1:${apiPort}/api/v1/health`,
      env: { E2E_API_PORT: apiPort, E2E_WEB_PORT: webPort },
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `node ../web/node_modules/vite/bin/vite.js ../web --port ${webPort} --strictPort --host 127.0.0.1`,
      url: base,
      env: { API_PORT: apiPort },
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
})
