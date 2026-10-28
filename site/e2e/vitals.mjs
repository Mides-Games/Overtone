#!/usr/bin/env node
/**
 * LCP and CLS of the built site (W10.1), measured as a phone on a slow
 * network would meet it:
 *
 *   pnpm --dir site/web build && pnpm --dir site/e2e vitals
 *
 * The build (site/web/dist) is served by deploy/web/serve.mjs, the
 * production server, in front of serve-api.mjs (the dev API in memory and a
 * fake worker), each on its own port: E2E_WEB_PORT and E2E_API_PORT, 5291 and
 * 3091 unless set. Headless Chromium loads each page RUNS times with the
 * cache off, under Lighthouse's mobile profile: 150 ms round trip, 1.6 Mbit/s
 * down, 750 kbit/s up, the CPU slowed 4x. A PerformanceObserver records the
 * largest contentful paint and the layout shifts (CLS as the largest session
 * window: shifts less than 1 s apart, at most 5 s long, none just after
 * input). The median of the runs is printed per page.
 *
 * Exits 1 when a median LCP is over 2.5 s or a CLS over 0.1, the roadmap's
 * budgets (the "good" thresholds of Web Vitals). A local number, not a field
 * one: one machine, an emulated network, no real phone.
 *
 * VITALS_DIST and VITALS_SERVE point it at another build and another
 * serve.mjs, to measure a before beside an after; VITALS_RUNS sets the runs.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

import { clickWav } from './fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
// Another build or another serve.mjs, to measure a before against an after.
const dist = resolve(process.env.VITALS_DIST || join(root, 'site', 'web', 'dist'))
const serveScript = resolve(process.env.VITALS_SERVE || join(root, 'deploy', 'web', 'serve.mjs'))
const apiPort = process.env.E2E_API_PORT || '3091'
const webPort = process.env.E2E_WEB_PORT || '5291'
const base = `http://127.0.0.1:${webPort}`
const RUNS = Number(process.env.VITALS_RUNS || 3)
const LCP_MS = 2500
const CLS = 0.1

const PAGES = ['/', '/analyze', '/queue', '/community', '/recent', '/status', '/terms', '/credits']

const children = []
const stop = () => {
  for (const child of children) child.kill()
}
process.on('exit', stop)

function start(script, env) {
  const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] })
  children.push(child)
  return child
}

async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`${url} did not answer in 30 s`)
}

/** Runs in the page before its scripts: LCP and CLS as Web Vitals define them. */
function observe() {
  const vitals = { lcp: 0, cls: 0, worst: 0, moved: '' }
  window.__vitals = vitals
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) vitals.lcp = entry.startTime
  }).observe({ type: 'largest-contentful-paint', buffered: true })
  let window_ = 0
  let first = 0
  let last = 0
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.hadRecentInput) continue
      // What moved in the largest shift, so a red CLS names its cause.
      if (entry.value > vitals.worst) {
        vitals.worst = entry.value
        vitals.moved = (entry.sources ?? [])
          .map((s) => s.node)
          .filter((n) => n && n.nodeType === 1)
          .map((n) => `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}.${String(n.className).split(' ').slice(0, 3).join('.')}`)
          .join(' | ')
      }
      if (window_ && entry.startTime - last < 1000 && entry.startTime - first < 5000) window_ += entry.value
      else {
        window_ = entry.value
        first = entry.startTime
      }
      last = entry.startTime
      vitals.cls = Math.max(vitals.cls, window_)
    }
  }).observe({ type: 'layout-shift', buffered: true })
}

async function measure(context, path) {
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6e6 / 8) | 0,
    uploadThroughput: (750e3 / 8) | 0,
  })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.addInitScript(observe)
  await page.goto(base + path, { waitUntil: 'load', timeout: 60_000 })
  await page.locator('main h1').first().waitFor({ timeout: 30_000 })
  // Lists and the status page fill in after a request; let them land.
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(1000)
  const vitals = await page.evaluate(() => window.__vitals)
  await page.close()
  return vitals
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

async function main() {
  if (!existsSync(join(dist, 'index.html'))) {
    console.error('vitals: no build in site/web/dist; run `pnpm --dir site/web build` first')
    return 1
  }
  start(join(here, 'serve-api.mjs'), { E2E_API_PORT: apiPort, E2E_WEB_PORT: webPort })
  await waitFor(`http://127.0.0.1:${apiPort}/api/v1/health`)
  start(serveScript, {
    PORT: webPort,
    WEB_ROOT: dist,
    API_UPSTREAM: `http://127.0.0.1:${apiPort}`,
    HSTS: '0',
  })
  await waitFor(base)

  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 412, height: 823 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })

  // A finished analysis of this context's own, for the result page.
  const setup = await context.newPage()
  await setup.goto(`${base}/analyze`)
  await setup.locator('input#audio').setInputFiles({ name: 'Vitals - Song.wav', mimeType: 'audio/wav', buffer: clickWav(23_000) })
  await setup.getByRole('button', { name: /^Analyze$/ }).click()
  await setup.waitForURL(/\/analyze\/[0-9a-f]{32}$/)
  await setup.locator('table').first().waitFor({ timeout: 30_000 })
  const result = new URL(setup.url()).pathname
  await setup.close()

  const failures = []
  console.log(`page                 LCP median (runs)            CLS median   ${RUNS} runs, mobile profile`)
  for (const path of [...PAGES, result]) {
    const runs = []
    for (let i = 0; i < RUNS; i++) runs.push(await measure(context, path))
    const lcp = median(runs.map((r) => r.lcp))
    const cls = median(runs.map((r) => r.cls))
    const name = path === result ? '/analyze/<id>' : path
    const each = runs.map((r) => Math.round(r.lcp)).join(', ')
    console.log(`${name.padEnd(20)} ${String(Math.round(lcp)).padStart(5)} ms (${each})`.padEnd(50) + `${cls.toFixed(3)}`)
    if (lcp > LCP_MS) failures.push(`${name}: LCP ${Math.round(lcp)} ms over ${LCP_MS}`)
    if (cls > CLS) {
      const worst = runs.reduce((a, b) => (b.worst > a.worst ? b : a))
      failures.push(`${name}: CLS ${cls.toFixed(3)} over ${CLS}; the largest shift moved ${worst.moved || 'nodes no longer in the page'}`)
    }
  }
  await browser.close()
  stop()
  for (const failure of failures) console.error(`vitals: ${failure}`)
  if (!failures.length) console.log('vitals: ok')
  return failures.length ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`vitals: ${error.stack ?? error.message}`)
    stop()
    process.exit(1)
  },
)
