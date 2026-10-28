/**
 * Published timings (W3.27, W5.1) and the account's history (W3.26), as the
 * pages ask for them. Pure where it can be, so the tests reach it without a
 * browser; the requests themselves go through lib/api.js.
 */
import { api } from './api.js'

/** The filters a list page starts from: nothing narrowed. */
export const NO_FILTERS = Object.freeze({ q: '', bpmMin: '', bpmMax: '', tempo: '', status: '', from: '', to: '' })

const BPM = /^\d{1,4}(\.\d{1,3})?$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * The query string for one page: the filters that are set and read as the
 * API reads them, and the cursor. A half-typed BPM ("1.") or an empty field
 * is left out rather than sent to be refused. Returns '' or '?a=b&...'.
 */
export function listQuery(filters = {}, { cursor = null, limit = null, kind = 'recent' } = {}) {
  const params = new URLSearchParams()
  const q = String(filters.q ?? '').trim()
  if (q) params.set('q', q.slice(0, 100))
  for (const key of ['bpmMin', 'bpmMax']) {
    const value = String(filters[key] ?? '').trim()
    if (BPM.test(value)) params.set(key, value)
  }
  if (filters.tempo === 'single' || filters.tempo === 'variable') params.set('tempo', filters.tempo)
  if (kind === 'history') {
    if (['queued', 'running', 'done', 'refused', 'failed'].includes(filters.status)) params.set('status', filters.status)
    for (const key of ['from', 'to']) if (DAY.test(filters[key] ?? '')) params.set(key, filters[key])
  }
  if (limit) params.set('limit', String(limit))
  if (cursor) params.set('cursor', cursor)
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** "Artist - Title", the title alone, or null. */
export function songLine({ title, artist } = {}) {
  if (!title) return artist || null
  return artist ? `${artist} - ${title}` : title
}

/** A list's BPM: whole when it is whole, else to two decimals; a dash for none. */
export function bpmLabel(bpm) {
  if (bpm === null || bpm === undefined || !Number.isFinite(Number(bpm))) return '–'
  const n = Math.round(Number(bpm) * 100) / 100
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '')
}

/** The public page of timing `id`, on this site. */
export const timingPath = (id) => `/t/${id}`

// ── Requests ────────────────────────────────────────────────────────────────

export const recentTimings = (filters, options) => api(`/timings${listQuery(filters, options)}`)
export const myAnalyses = (filters, options) => api(`/me/analyses${listQuery(filters, { ...options, kind: 'history' })}`)
export const publicTiming = (id) => api(`/timings/${id}`)

/** Publishes your analysis; `makePublic` also lifts a private one's privacy (else 409 PRIVATE). */
export const publishAnalysis = (id, { makePublic = false } = {}) =>
  api(`/analyses/${id}/publish`, { method: 'POST', json: makePublic ? { makePublic: true } : {} })

export const unpublishAnalysis = (id) => api(`/analyses/${id}/publish`, { method: 'DELETE' })

/** Deletes one of your finished analyses (or cancels a queued one): the same route. */
export const deleteAnalysis = (id) => api(`/analyses/${id}`, { method: 'DELETE' })

/** Whether the visitor's file is timing `id`'s audio. Only the answer comes back, never the timing's hash. */
export async function checkTimingAudio(id, sha1) {
  const { match } = await api(`/timings/${id}/check`, { method: 'POST', json: { sha1 } })
  return Boolean(match)
}
