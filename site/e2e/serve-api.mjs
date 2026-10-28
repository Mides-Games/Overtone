#!/usr/bin/env node
/**
 * The API as the end-to-end run needs it: site/api's own dev launcher
 * (dev.js, so the dev sign-in is on and the store is in memory) with
 * OVERTONE_WORKER=0, and beside it, in this process, a fake worker that
 * claims every job over /api/internal like worker/main.py and answers it
 * with fixture.mjs's result after a second of progress. No Python, no model:
 * the run tests the site, not the engine.
 *
 *   E2E_API_PORT=3090 E2E_WEB_PORT=5290 node site/e2e/serve-api.mjs
 *
 * playwright.config.js starts it.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fakeResult } from './fixture.mjs'

const port = process.env.E2E_API_PORT || '3090'
const site = process.env.E2E_SITE_URL || `http://127.0.0.1:${process.env.E2E_WEB_PORT || '5290'}`

Object.assign(process.env, {
  PORT: port,
  SITE_URL: site,
  OVERTONE_WORKER: '0',
  MIDES_DEV_LOGIN: '1',
  WORKER_TOKEN: randomBytes(32).toString('base64url'),
  // Its own spool, so a run never meets a dev server's files.
  SPOOL_DIR: mkdtempSync(join(tmpdir(), 'overtone-e2e-spool-')),
  // Every test uploads from 127.0.0.1; the default 5 a day would end the run.
  ANON_DAILY_LIMIT: '1000',
  USER_DAILY_LIMIT: '1000',
})
// Without a database, whatever DATABASE_URL a developer's shell holds.
delete process.env.DATABASE_URL

await import('../api/src/dev.js')

const ENGINE_HASH = 'e2e0fa4e'
const internal = `http://127.0.0.1:${port}/api/internal`
const call = (path, body) =>
  fetch(`${internal}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WORKER_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One job at a time, as the real worker: claim, report a stage, answer. */
async function work() {
  for (;;) {
    try {
      const claim = await call('/jobs/claim', { engine_hash: ENGINE_HASH })
      if (claim.status === 200) {
        const job = await claim.json()
        await call(`/jobs/${job.id}/progress`, { attempt: job.attempt, stage: 'tempo', progress: 0.5 })
        // A file named "slow" stays running long enough for a test to look at it.
        await sleep(/slow/i.test(job.filename ?? '') ? 8000 : 1000)
        const done = await call(`/jobs/${job.id}/result`, { attempt: job.attempt, result: fakeResult(ENGINE_HASH) })
        if (done.status !== 204) console.error(`[e2e worker] result refused: ${done.status} ${await done.text()}`)
        continue
      }
    } catch (error) {
      // The API is still starting, or stopping with the run.
      if (error?.cause?.code !== 'ECONNREFUSED') console.error(`[e2e worker] ${error.message}`)
    }
    await sleep(300)
  }
}

work()
