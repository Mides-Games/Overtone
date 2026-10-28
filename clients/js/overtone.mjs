/**
 * overtone-client: the Overtone public API with a personal token (W13.22).
 *
 * One ES module, no dependencies, built on `fetch`: Node 18+ and browsers.
 * A token belongs in a script, a bot or a server, never in a web page
 * others load: the API has no CORS on purpose, so a page on another site
 * cannot call it anyway.
 *
 *   import { Overtone } from './overtone.mjs'
 *   const overtone = new Overtone({ token: process.env.OVERTONE_TOKEN })
 *   const analysis = await overtone.analyzeFile('song.mp3')
 *   console.log(analysis.result.global_bpm)
 *
 * What it does for you, and nothing else:
 * - the token in `Authorization: Bearer`, the `/api/v1` prefix, JSON in and out;
 * - every error as an `OvertoneError` carrying the API's own `code`
 *   (`INVALID_TOKEN`, `TOKEN_SCOPE`, `QUOTA_EXCEEDED`, ...), its HTTP status
 *   and `details`, with a subclass per kind you are likely to branch on;
 * - a 429 that says `Retry-After` is waited out and retried (up to
 *   `maxRetries`, never longer than `maxRetryWaitMs`); a 429 without it (the
 *   daily quota, the pending cap) is thrown at once, as waiting would not help;
 * - every request has a timeout (`timeoutMs`; uploads `uploadTimeoutMs`);
 * - an upload first asks whether the same audio was analysed already (its
 *   SHA-1, when the runtime has Web Crypto), so a known song costs no upload.
 */

export const VERSION = '0.1.0'
export const DEFAULT_BASE_URL = 'https://overtone.midesprojects.com'

/** Any error from the API, the network or a timeout. `code` is the API's when it gave one. */
export class OvertoneError extends Error {
  constructor(message, { status = null, code = null, details = null, retryAfter = null, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'OvertoneError'
    /** The HTTP status, or null when no answer came. */
    this.status = status
    /** The API's stable code (`NOT_FOUND`, `TOKEN_SCOPE`, ...), or the client's own (`TIMEOUT`, `NETWORK`, `ANALYSIS_FAILED`). */
    this.code = code
    /** The API's `details` object, when it sent one (a quota's `limit` and `scope`, a missing `scope`). */
    this.details = details
    /** Seconds the API asked to wait (Retry-After), or null. */
    this.retryAfter = retryAfter
  }
}

/** 401: the token is missing, malformed or revoked (`INVALID_TOKEN`). */
export class AuthenticationError extends OvertoneError {
  name = 'AuthenticationError'
}
/** 403: the route is not open to tokens (`TOKEN_NOT_ALLOWED`) or the token lacks the scope (`TOKEN_SCOPE`). */
export class PermissionError extends OvertoneError {
  name = 'PermissionError'
}
/** 404: no such analysis or timing, or not yours (the API does not tell the two apart). */
export class NotFoundError extends OvertoneError {
  name = 'NotFoundError'
}
/** 429: `RATE_LIMITED` (after the retries ran out), `QUOTA_EXCEEDED` or `PENDING_LIMIT`. */
export class RateLimitError extends OvertoneError {
  name = 'RateLimitError'
}
/** The request, or a wait for an analysis, took longer than allowed. `code` is `TIMEOUT`. */
export class TimeoutError extends OvertoneError {
  name = 'TimeoutError'
}
/** No answer at all: DNS, refused connection, reset. `code` is `NETWORK`. */
export class NetworkError extends OvertoneError {
  name = 'NetworkError'
}
/** The analysis ended `failed` (the worker could not read the audio, say). `code` is `ANALYSIS_FAILED`; `analysis` is the row. */
export class AnalysisFailedError extends OvertoneError {
  name = 'AnalysisFailedError'
}

const BY_STATUS = { 401: AuthenticationError, 403: PermissionError, 404: NotFoundError, 429: RateLimitError }

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })

/** Seconds from a Retry-After header (delta-seconds or an HTTP date), or null. */
export function retryAfterSeconds(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return Number(text)
  const at = Date.parse(text)
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null
}

/** The query string of `filters`, without empty values. */
export function queryOf(filters = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** `https://site`, `https://site/` or `https://site/api/v1` -> `https://site/api/v1`. */
export function apiRoot(baseUrl) {
  const trimmed = String(baseUrl).replace(/\/+$/, '')
  return trimmed.endsWith('/api/v1') ? trimmed : `${trimmed}/api/v1`
}

const toBytes = async (data) => {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  throw new TypeError('The audio must be a Uint8Array, an ArrayBuffer, a Blob or a File.')
}

const sha1Hex = async (bytes) => {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null // Node 18 without the global, or an insecure page: no lookup, just upload.
  const digest = new Uint8Array(await subtle.digest('SHA-1', bytes))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

const TERMINAL = new Set(['done', 'refused', 'failed'])
const TRANSIENT = new Set([502, 503, 504])

export class Overtone {
  /**
   * @param {object} options
   * @param {string} options.token  A personal token from /settings/tokens (`ot_...`).
   * @param {string} [options.baseUrl]  The site, e.g. https://overtone.midesprojects.com (or its /api/v1).
   * @param {number} [options.timeoutMs=30000]  Per request.
   * @param {number} [options.uploadTimeoutMs=300000]  Per upload.
   * @param {number} [options.maxRetries=3]  Retries of a 429 that sent Retry-After.
   * @param {number} [options.maxRetryWaitMs=60000]  The longest Retry-After waited out; a longer one is thrown.
   * @param {typeof fetch} [options.fetch]  Another fetch (a test's, or one with a proxy).
   */
  constructor({
    token,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = 30_000,
    uploadTimeoutMs = 300_000,
    maxRetries = 3,
    maxRetryWaitMs = 60_000,
    fetch: fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof token !== 'string' || !token.startsWith('ot_')) {
      throw new TypeError('An Overtone token starts with ot_: make one at /settings/tokens.')
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('No fetch: use Node 18 or later, or pass options.fetch.')
    this.root = apiRoot(baseUrl)
    this.timeoutMs = timeoutMs
    this.uploadTimeoutMs = uploadTimeoutMs
    this.maxRetries = maxRetries
    this.maxRetryWaitMs = maxRetryWaitMs
    // Kept off the instance's enumerable fields, so logging the client never prints it.
    Object.defineProperty(this, 'token', { value: token, enumerable: false })
    Object.defineProperty(this, 'fetch', { value: fetchImpl.bind(globalThis), enumerable: false })
  }

  /**
   * One call. Returns the parsed JSON, the text (`as: 'text'`) or nothing
   * (204). Throws an OvertoneError. 429 with Retry-After is waited out.
   */
  async request(method, path, { body, headers = {}, as = 'json', timeoutMs = this.timeoutMs, signal } = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = await this.#send(method, path, { body, headers, timeoutMs, signal })
      if (response.ok) {
        if (response.status === 204) return null
        return as === 'text' ? response.text() : response.json()
      }
      const error = await this.#errorOf(response)
      const wait = error.retryAfter
      if (response.status === 429 && wait !== null && attempt < this.maxRetries && wait * 1000 <= this.maxRetryWaitMs) {
        await sleep(wait * 1000, signal)
        continue
      }
      throw error
    }
  }

  async #send(method, path, { body, headers, timeoutMs, signal }) {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    const onAbort = () => timeout.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await this.fetch(`${this.root}${path}`, {
        method,
        body,
        headers: { Accept: 'application/json', ...headers, Authorization: `Bearer ${this.token}` },
        signal: timeout.signal,
      })
    } catch (cause) {
      if (signal?.aborted) throw signal.reason ?? cause
      if (timeout.signal.aborted) {
        throw new TimeoutError(`${method} ${path} took longer than ${timeoutMs} ms.`, { code: 'TIMEOUT', cause })
      }
      throw new NetworkError(`${method} ${path} got no answer: ${cause?.message ?? cause}`, { code: 'NETWORK', cause })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async #errorOf(response) {
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    const error = payload?.error ?? {}
    const Kind = BY_STATUS[response.status] ?? OvertoneError
    return new Kind(error.message || `HTTP ${response.status}`, {
      status: response.status,
      code: error.code ?? null,
      details: error.details ?? null,
      retryAfter: retryAfterSeconds(response.headers.get('Retry-After')),
    })
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  /** `{ status }` of the API. Any token. */
  health() {
    return this.request('GET', '/health')
  }

  /** The token's account: `{ account }`. Any token. */
  me() {
    return this.request('GET', '/me')
  }

  /** One of your analyses: status, queue position, progress, and the result once done. `read:analyses`. */
  analysis(id) {
    return this.request('GET', `/analyses/${encodeURIComponent(id)}`)
  }

  /** One page of your analyses, newest first: `{ analyses, next }`. Filters: q, status, bpmMin, bpmMax, from, to, limit, cursor. `read:analyses`. */
  myAnalyses(filters = {}) {
    return this.request('GET', `/me/analyses${queryOf(filters)}`)
  }

  /** Every analysis of yours under `filters`, page after page. */
  async *allMyAnalyses(filters = {}) {
    let cursor = filters.cursor ?? null
    do {
      const page = await this.myAnalyses({ ...filters, cursor })
      yield* page.analyses
      cursor = page.next
    } while (cursor)
  }

  /** The saved versions of one of your analyses (W12.21). `read:analyses`. */
  analysisVersions(id) {
    return this.request('GET', `/analyses/${encodeURIComponent(id)}/versions`)
  }

  /** Your analysis's `[TimingPoints]` block, as osu! writes it. `read:analyses`. */
  analysisTimingText(id) {
    return this.request('GET', `/analyses/${encodeURIComponent(id)}/timing.txt`, { as: 'text' })
  }

  /** Your analysis's red lines as CSV. `read:analyses`. */
  analysisTimingCsv(id) {
    return this.request('GET', `/analyses/${encodeURIComponent(id)}/timing.csv`, { as: 'text' })
  }

  /** One page of everyone's published timings: `{ timings, next }`. Filters: q, bpmMin, bpmMax, tempo, sort, limit, cursor. `read:timings`. */
  timings(filters = {}) {
    return this.request('GET', `/timings${queryOf(filters)}`)
  }

  /** One published timing, with its result. `read:timings`. */
  timing(id) {
    return this.request('GET', `/timings/${encodeURIComponent(id)}`)
  }

  /** A published timing's `[TimingPoints]` block. `read:timings`. */
  timingText(id) {
    return this.request('GET', `/timings/${encodeURIComponent(id)}/timing.txt`, { as: 'text' })
  }

  /** A published timing's red lines as CSV. `read:timings`. */
  timingCsv(id) {
    return this.request('GET', `/timings/${encodeURIComponent(id)}/timing.csv`, { as: 'text' })
  }

  // ── Uploads ───────────────────────────────────────────────────────────

  /**
   * Sends a song for analysis as the token's account (`upload`), within its
   * daily quota. Resolves to `{ id, status, cached }` at once; `waitFor(id)`
   * waits for the result.
   *
   * @param {Uint8Array|ArrayBuffer|Blob} data  The audio file's bytes.
   * @param {object} options
   * @param {string} options.filename  Its name; the extension says the format (mp3, ogg, wav, flac, m4a, opus).
   * @param {'fast'|'normal'|'strict'} [options.mode]
   * @param {object} [options.options]  Hints (AnalysisOptions in the reference).
   * @param {boolean} [options.private]  Keep it off the public queue.
   * @param {string} [options.title]  The title tag, shown on the queue.
   * @param {string} [options.artist]
   * @param {number} [options.duration]  Its length in seconds, for the queue's estimate.
   * @param {boolean} [options.lookup=true]  Ask by SHA-1 first; a known song is answered without uploading.
   */
  async upload(data, { filename, mode, options, private: hidden, title, artist, duration, lookup = true, signal } = {}) {
    if (typeof filename !== 'string' || !filename.trim()) throw new TypeError('upload() needs options.filename, with its extension.')
    const bytes = await toBytes(data)
    if (lookup) {
      const sha1 = await sha1Hex(bytes)
      if (sha1) {
        const found = await this.request('POST', '/analyses/lookup', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha1, filename, size: bytes.byteLength, private: hidden === true, title, artist, mode, options, duration }),
          signal,
        })
        if (found.cached) return found
      }
    }
    const headers = { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(filename) }
    if (hidden) headers['X-Private'] = '1'
    if (title) headers['X-Title'] = encodeURIComponent(title)
    if (artist) headers['X-Artist'] = encodeURIComponent(artist)
    if (mode) headers['X-Mode'] = mode
    if (options) headers['X-Options'] = encodeURIComponent(JSON.stringify(options))
    if (Number.isFinite(duration)) headers['X-Duration'] = String(duration)
    return this.request('POST', '/analyses', { body: bytes, headers, timeoutMs: this.uploadTimeoutMs, signal })
  }

  /**
   * Polls one of your analyses until it is done, refused or failed, and
   * resolves to it. A refusal (`status: 'refused'`, the engine found no
   * steady pulse) is an answer, not an error; `failed` throws
   * AnalysisFailedError. A passing 502/503/504 or lost connection is polled
   * through (five in a row is thrown).
   *
   * @param {string} id
   * @param {object} [options]
   * @param {number} [options.intervalMs=2000]  Between polls; the queue moves in seconds, not milliseconds.
   * @param {number} [options.timeoutMs=1800000]  The whole wait (30 minutes by default).
   * @param {(analysis: object) => void} [options.onUpdate]  Called with every poll's answer.
   * @param {AbortSignal} [options.signal]
   */
  async waitFor(id, { intervalMs = 2000, timeoutMs = 30 * 60_000, onUpdate, signal } = {}) {
    const deadline = Date.now() + timeoutMs
    let strikes = 0
    for (;;) {
      let analysis = null
      try {
        analysis = await this.analysis(id)
        strikes = 0
      } catch (error) {
        const passing = error instanceof NetworkError || error instanceof TimeoutError || TRANSIENT.has(error?.status)
        if (!passing || ++strikes >= 5) throw error
      }
      if (analysis) {
        onUpdate?.(analysis)
        if (analysis.status === 'failed') {
          const failure = new AnalysisFailedError(analysis.error ?? 'The analysis failed.', { code: 'ANALYSIS_FAILED' })
          failure.analysis = analysis
          throw failure
        }
        if (TERMINAL.has(analysis.status)) return analysis
      }
      if (Date.now() + intervalMs > deadline) {
        throw new TimeoutError(`Analysis ${id} did not finish within ${timeoutMs} ms.`, { code: 'TIMEOUT' })
      }
      await sleep(intervalMs, signal)
    }
  }

  /** `upload` then `waitFor`: the finished analysis. */
  async analyze(data, options = {}) {
    const { intervalMs, timeoutMs, onUpdate, signal, ...upload } = options
    const created = await this.upload(data, { ...upload, signal })
    return this.waitFor(created.id, { intervalMs, timeoutMs, onUpdate, signal })
  }

  /** Node only: reads `path` and analyses it, named by its own file name unless `options.filename` says otherwise. */
  async analyzeFile(path, options = {}) {
    const { readFile } = await import('node:fs/promises')
    const { basename } = await import('node:path')
    return this.analyze(await readFile(path), { filename: basename(path), ...options })
  }
}

export default Overtone
