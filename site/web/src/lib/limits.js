/**
 * W13.20: a refusal for one of the person's own limits, read as what the
 * notice under the upload form says: which limit, why, and when it frees up.
 * Pure, so the tests reach it without a browser.
 *
 * The API says (site/api `limitRefusal`): `QUOTA_EXCEEDED` and `CACHE_LIMIT`
 * free at the next 00:00 UTC, with `retryAfterS`; `PENDING_LIMIT` frees when
 * one of the person's songs in the queue finishes. The countdown runs from
 * `retryAfterS` and the moment the answer arrived, not from `resetAt` and the
 * visitor's clock, which may be minutes wrong.
 */
export const LIMIT_CODES = ['QUOTA_EXCEEDED', 'CACHE_LIMIT', 'PENDING_LIMIT']

/**
 * `{ code, frees: 'reset' | 'finish', deadline, limit, scope, pending }` for
 * a refusal this notice explains, else null. `deadline` is a time on this
 * page's own clock (ms), null when the limit frees with a song instead.
 */
export function limitOf(error, receivedAt = Date.now()) {
  if (!error || !LIMIT_CODES.includes(error.code)) return null
  const d = error.details ?? {}
  const limit = Number.isInteger(d.limit) ? d.limit : null
  const scope = d.scope === 'account' ? 'account' : 'anonymous'
  if (error.code === 'PENDING_LIMIT') {
    return { code: error.code, frees: 'finish', deadline: null, limit, scope, pending: Number.isInteger(d.pending) ? d.pending : limit }
  }
  const seconds = Number(d.retryAfterS)
  // An older API sent no time: the next midnight UTC by this clock, the best left to say.
  const deadline =
    Number.isFinite(seconds) && seconds > 0 && seconds <= 86_400 ? receivedAt + seconds * 1000 : nextUtcMidnight(receivedAt)
  return { code: error.code, frees: 'reset', deadline, limit, scope, pending: null }
}

export const nextUtcMidnight = (now) => {
  const at = new Date(now)
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1)
}

/** What is left until `deadline`, as h:mm:ss (or m:ss under an hour); "0:00" once it passed. */
export function countdown(deadline, now = Date.now()) {
  const left = Math.max(0, Math.ceil((deadline - now) / 1000))
  const h = Math.floor(left / 3600)
  const m = Math.floor((left % 3600) / 60)
  const s = String(left % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
