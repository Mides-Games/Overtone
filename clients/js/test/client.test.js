import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { startTestApi } from '../../testing/api.mjs'
import {
  AnalysisFailedError, AuthenticationError, NetworkError, NotFoundError, Overtone, OvertoneError, PermissionError,
  RateLimitError, TimeoutError, apiRoot, queryOf, retryAfterSeconds,
} from '../overtone.mjs'

// The real site/api, in memory, with a stand-in worker (clients/testing/api.mjs).
// The site counts 10 uploads per token per 10 minutes: these tests make 5.
let api
let client
before(async () => {
  api = await startTestApi()
  client = new Overtone({ token: api.token, baseUrl: api.base, timeoutMs: 5000 })
})
after(() => api.close())

const audio = () => new Uint8Array(randomBytes(512))
const fast = { intervalMs: 30, timeoutMs: 10_000 }

test('the pure parts: the API root, the query string and Retry-After', () => {
  assert.equal(apiRoot('https://o.test'), 'https://o.test/api/v1')
  assert.equal(apiRoot('https://o.test/'), 'https://o.test/api/v1')
  assert.equal(apiRoot('https://o.test/api/v1/'), 'https://o.test/api/v1')
  assert.equal(queryOf({ q: 'a b', bpmMin: 100, empty: '', none: null }), '?q=a+b&bpmMin=100')
  assert.equal(queryOf({}), '')
  assert.equal(retryAfterSeconds('7'), 7)
  assert.equal(retryAfterSeconds(null), null)
  assert.equal(retryAfterSeconds('soon'), null)
  assert.equal(retryAfterSeconds(new Date(10_000).toUTCString(), 4_000), 6)
  assert.throws(() => new Overtone({ token: 'nope' }), TypeError)
  // The token never shows up when the client is logged.
  assert.ok(!JSON.stringify(new Overtone({ token: 'ot_secret' })).includes('ot_secret'))
})

test('health and me answer for any token', async () => {
  assert.equal((await client.health()).status, 'ok')
  const me = await client.me()
  assert.ok(me.account.username)
})

test('upload a file and wait for its result, then read it every way', async () => {
  const seen = []
  const analysis = await client.analyze(audio(), { filename: 'song-174.mp3', onUpdate: (a) => seen.push(a.status), ...fast })
  assert.equal(analysis.status, 'done')
  assert.equal(analysis.result.global_bpm, 174)
  assert.ok(seen.at(-1) === 'done')

  const again = await client.analysis(analysis.id)
  assert.equal(again.id, analysis.id)
  const text = await client.analysisTimingText(analysis.id)
  assert.match(text, /\[TimingPoints\]/)
  const csv = await client.analysisTimingCsv(analysis.id)
  assert.match(csv.split('\n')[0], /bpm/i)
  const versions = await client.analysisVersions(analysis.id)
  assert.ok(Array.isArray(versions.readings) && Array.isArray(versions.adjustments))

  const page = await client.myAnalyses({ limit: 50 })
  assert.ok(page.analyses.some((a) => a.id === analysis.id))
  const all = []
  for await (const row of client.allMyAnalyses({ limit: 1 })) all.push(row.id)
  assert.ok(all.includes(analysis.id))
  assert.equal(new Set(all).size, all.length, 'no page repeats a row')
})

test('the same audio again is answered from the lookup, without an upload', async () => {
  const bytes = audio()
  const first = await client.analyze(bytes, { filename: 'again-150.ogg', ...fast })
  const second = await client.upload(bytes, { filename: 'again-150.ogg' })
  assert.equal(second.cached, true)
  assert.notEqual(second.id, first.id)
})

test('a file read from disk is analysed under its own name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overtone-client-'))
  const path = join(dir, 'from disk 140.flac')
  writeFileSync(path, randomBytes(300))
  const analysis = await client.analyzeFile(path, fast)
  assert.equal(analysis.filename, 'from disk 140.flac')
  assert.equal(analysis.result.global_bpm, 140)
})

test('a failed analysis is an AnalysisFailedError with the row', async () => {
  await assert.rejects(client.analyze(audio(), { filename: 'will-fail.mp3', ...fast }), (error) => {
    assert.ok(error instanceof AnalysisFailedError)
    assert.equal(error.code, 'ANALYSIS_FAILED')
    assert.equal(error.analysis.status, 'failed')
    return true
  })
})

test('the Discord example builds its embed from a real analysis', async () => {
  const { messageFor } = await import('../examples/discord-webhook.mjs')
  const analysis = await client.analysis(api.timingId)
  const message = messageFor(analysis, 'published-174.mp3')
  assert.equal(message.embeds[0].title, 'published-174.mp3')
  assert.equal(message.embeds[0].fields[0].value, '174')
  assert.match(message.embeds[0].description, /174\.00/)
  const refused = messageFor({ status: 'refused', result: { refusal: { message: 'noise' } } }, 'noise.wav')
  assert.match(refused.embeds[0].description, /noise/)
})

test('the public timings: list, one, timing.txt and CSV', async () => {
  const page = await client.timings({ limit: 5 })
  assert.ok(page.timings.some((t) => t.id === api.timingId))
  const one = await client.timing(api.timingId)
  assert.equal(one.bpm, 174)
  assert.match(await client.timingText(api.timingId), /\[TimingPoints\]/)
  assert.match(await client.timingCsv(api.timingId), /174/)
})

test('the API\'s errors come back typed, with their codes', async () => {
  await assert.rejects(client.timing('0'.repeat(32)), (e) => e instanceof NotFoundError && e.code === 'NOT_FOUND' && e.status === 404)
  await assert.rejects(client.analysis('f'.repeat(32)), NotFoundError)
  const readOnly = new Overtone({ token: api.readOnlyToken, baseUrl: api.base })
  await assert.rejects(readOnly.myAnalyses(), (e) => e instanceof PermissionError && e.code === 'TOKEN_SCOPE' && e.details.scope === 'read:analyses')
  await assert.rejects(readOnly.upload(audio(), { filename: 'x.mp3', lookup: false }), (e) => e.code === 'TOKEN_SCOPE')
  const revoked = new Overtone({ token: `ot_${'A'.repeat(43)}`, baseUrl: api.base })
  await assert.rejects(revoked.me(), (e) => e instanceof AuthenticationError && e.code === 'INVALID_TOKEN')
  // A route a token may not use at all.
  await assert.rejects(client.request('GET', '/me/tokens'), (e) => e instanceof PermissionError && e.code === 'TOKEN_NOT_ALLOWED')
  await assert.rejects(client.upload(audio(), { filename: 'notes.txt', lookup: false }), (e) => e.code === 'UNSUPPORTED_FORMAT' && e.status === 400)
  await assert.rejects(client.upload(audio(), {}), TypeError)
})

// â”€â”€ 429 and timeouts, against a stand-in that misbehaves on purpose â”€â”€â”€â”€â”€â”€â”€â”€

/** A local server answering each request with the next of `answers` (status, headers, body). */
const stub = async (answers, { hang = false } = {}) => {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push({ at: Date.now(), auth: req.headers.authorization })
    if (hang) return // never answers
    const [status, headers, body] = answers[Math.min(hits.length - 1, answers.length - 1)]
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, hits, close: () => { server.closeAllConnections(); server.close() } }
}

const limited = [429, { 'Retry-After': '1' }, { error: { status: 429, message: 'Too many requests.', code: 'RATE_LIMITED' } }]

test('a 429 with Retry-After is waited out and retried', async () => {
  const s = await stub([limited, [200, {}, { status: 'ok' }]])
  try {
    const c = new Overtone({ token: 'ot_x', baseUrl: s.base })
    assert.deepEqual(await c.health(), { status: 'ok' })
    assert.equal(s.hits.length, 2)
    assert.ok(s.hits[1].at - s.hits[0].at >= 950, 'it waited the second it was told')
    assert.equal(s.hits[0].auth, 'Bearer ot_x')
  } finally {
    s.close()
  }
})

test('a 429 is thrown when retries run out, the wait is too long, or there is no Retry-After', async () => {
  const s = await stub([limited])
  try {
    const none = new Overtone({ token: 'ot_x', baseUrl: s.base, maxRetries: 0 })
    await assert.rejects(none.health(), (e) => e instanceof RateLimitError && e.code === 'RATE_LIMITED' && e.retryAfter === 1)
    const impatient = new Overtone({ token: 'ot_x', baseUrl: s.base, maxRetryWaitMs: 500 })
    await assert.rejects(impatient.health(), RateLimitError)
  } finally {
    s.close()
  }
  const quota = await stub([[429, {}, { error: { status: 429, message: 'Quota.', code: 'QUOTA_EXCEEDED', details: { limit: 50, scope: 'account' } } }]])
  try {
    const c = new Overtone({ token: 'ot_x', baseUrl: quota.base })
    await assert.rejects(c.health(), (e) => e.code === 'QUOTA_EXCEEDED' && e.details.limit === 50 && e.retryAfter === null)
    assert.equal(quota.hits.length, 1, 'a quota is not retried')
  } finally {
    quota.close()
  }
})

test('a request that hangs times out, and a closed port is a NetworkError', async () => {
  const s = await stub([], { hang: true })
  try {
    const c = new Overtone({ token: 'ot_x', baseUrl: s.base, timeoutMs: 150 })
    await assert.rejects(c.health(), (e) => e instanceof TimeoutError && e.code === 'TIMEOUT' && e instanceof OvertoneError)
  } finally {
    s.close()
  }
  const gone = await stub([])
  gone.close()
  const c = new Overtone({ token: 'ot_x', baseUrl: gone.base, timeoutMs: 15_000 }) // Windows takes ~2 s to give up on a closed port
  await assert.rejects(c.health(), (e) => e instanceof NetworkError && e.code === 'NETWORK')
})

test('waiting for an analysis gives up at its own deadline', async () => {
  const s = await stub([[200, {}, { id: 'a', status: 'queued', position: 3 }]])
  try {
    const c = new Overtone({ token: 'ot_x', baseUrl: s.base })
    await assert.rejects(c.waitFor('a', { intervalMs: 20, timeoutMs: 100 }), (e) => e instanceof TimeoutError)
  } finally {
    s.close()
  }
})
