/**
 * Votes on published timings (W13.14), the mapper's badge (W13.16) and the
 * staff panel's requests (W13.19). Pure where it can be; the requests go
 * through lib/api.js.
 */
import { api } from './api.js'

/** The API's bounds (site/api utils/votes.js), so the form says so before sending. */
export const BPM_MIN = 20
export const BPM_MAX = 1000
export const OFFSET_MIN = -10_000

/**
 * The body of an "off" vote from what the form holds: the BPM and the offset
 * as typed (empty for none) and the permission box. `{ error }` names the
 * field that is wrong, so the form can say which; `durationS` bounds the
 * offset as the server does. A comma is read as a decimal point.
 */
export function offVote({ bpm = '', offset = '', trainingOk = false }, durationS = 0) {
  const body = { verdict: 'off' }
  const bpmText = String(bpm).trim().replace(',', '.')
  if (bpmText) {
    const n = Number(bpmText)
    if (!/^\d+(\.\d+)?$/.test(bpmText) || n < BPM_MIN || n > BPM_MAX) return { error: 'bpm' }
    body.proposedBpm = Math.round(n * 1000) / 1000
  }
  const offsetText = String(offset).trim()
  if (offsetText) {
    const n = Number(offsetText)
    const end = durationS > 0 ? Math.ceil(durationS * 1000) : 86_400_000
    if (!/^-?\d+$/.test(offsetText) || n < OFFSET_MIN || n > end) return { error: 'offset' }
    body.proposedOffsetMs = n
  }
  const correction = body.proposedBpm !== undefined || body.proposedOffsetMs !== undefined
  if (correction && trainingOk) body.trainingOk = true
  return { body, correction }
}

// ── Requests ────────────────────────────────────────────────────────────────

export const timingVotes = (id) => api(`/timings/${id}/votes`)
export const castVote = (id, body) => api(`/timings/${id}/vote`, { method: 'PUT', json: body })
export const removeVote = (id) => api(`/timings/${id}/vote`, { method: 'DELETE' })

export const staffOverview = () => api('/staff/overview')
export const corrections = (state = 'pending', offset = 0) => api(`/staff/corrections?state=${state}${offset ? `&offset=${offset}` : ''}`)
export const reviewCorrection = (id, action, reason = null) =>
  api(`/staff/corrections/${id}`, { method: 'POST', json: { action, ...(reason ? { reason } : {}) } })
