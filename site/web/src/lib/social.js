/**
 * Social v2 on published timings (W5.6, W6, W13.15, W13.18), as the pages ask
 * for it: stars, "I used this", comments, collections, profiles and the
 * ranking of timers. Pure where it can be, so the tests reach it without a
 * browser; the requests go through lib/api.js.
 */
import { api } from './api.js'
import { listQuery } from './timings.js'

/** The caps the API holds the text to (site/api utils/social.js), so the forms can say so first. */
export const LIMITS = { comment: 1000, collectionName: 80 }

/** The badges a profile can show, in the order it shows them (site/api `badgesOf`). */
export const BADGES = ['first-timing', 'published-10', 'published-50', 'suggestion-accepted', 'used-by-others', 'ranked-match']

/** The recent list's orders. */
export const SORTS = ['new', 'rated', 'used']

/** A time in the song as m:ss (or h:mm:ss past an hour), from milliseconds. */
export function formatAt(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/**
 * What a reader typed as a time in the song, as whole milliseconds: `m:ss`,
 * `h:mm:ss` or plain seconds (`42`, `42.5`). Null for empty; NaN for
 * anything else, so the form can say it is not a time.
 */
export function parseAt(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const parts = raw.split(':')
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return Number.NaN
  if (parts.slice(0, -1).some((p) => p.includes('.'))) return Number.NaN
  const nums = parts.map(Number)
  if (nums.length > 1 && nums.slice(1).some((n) => n >= 60)) return Number.NaN
  const seconds = nums.reduce((acc, n) => acc * 60 + n, 0)
  return Math.round(seconds * 1000)
}

/**
 * The osu! beatmapset link as the API will keep it, or null when the text is
 * not one. The same rule as the server's (site/api `beatmapUrlOf`): the
 * server decides, this only lets the form say "not a beatmapset link" before
 * sending it.
 */
export function beatmapLink(text) {
  const raw = String(text ?? '').trim()
  const match =
    /^https?:\/\/(?:www\.)?osu\.ppy\.sh\/(?:beatmapsets\/(\d{1,10})\/?(?:#(osu|taiko|fruits|mania)\/(\d{1,10}))?|s\/(\d{1,10})\/?)$/.exec(raw)
  if (!match) return null
  const set = Number(match[1] ?? match[4])
  if (set < 1) return null
  return `https://osu.ppy.sh/beatmapsets/${set}${match[2] ? `#${match[2]}/${Number(match[3])}` : ''}`
}

/** How much of a comment its mark on the tempo map shows (W13.15); the list has the rest. */
export const MARK_TEXT = 80

/**
 * The timed comments of a page as marks on the tempo map (W13.15): those
 * with a time inside the song, not hidden (staff and the author still see a
 * hidden one in the list, marked; the map is for everyone), each with its
 * author's name and the start of its text on one line.
 */
export function commentMarks(items, durationS = 0) {
  const end = durationS > 0 ? durationS * 1000 : Number.POSITIVE_INFINITY
  return (items ?? [])
    .filter((c) => Number.isInteger(c.atMs) && c.atMs >= 0 && c.atMs <= end && !c.hidden)
    .map((c) => {
      const flat = String(c.body ?? '').replace(/\s+/g, ' ').trim()
      const points = [...flat]
      return {
        id: c.id,
        atMs: c.atMs,
        author: c.author?.username ?? null,
        text: points.length > MARK_TEXT ? `${points.slice(0, MARK_TEXT - 1).join('')}…` : flat,
      }
    })
    .sort((a, b) => a.atMs - b.atMs)
}

/** "4.25" for a rating, a dash for none. */
export const ratingLabel = (average) => (average === null || average === undefined ? '–' : Number(average).toFixed(2).replace(/\.?0+$/, ''))

/** A timer's public page on this site. */
export const userPath = (username) => `/u/${encodeURIComponent(username)}`

/** A collection's page on this site. */
export const collectionPath = (id) => `/c/${id}`

/** The query string of a list with an order: the filters, then `sort` when it is not the default. */
export function sortedQuery(filters, options = {}) {
  const base = listQuery(filters, options)
  if (!SORTS.includes(filters?.sort) || filters.sort === 'new') return base
  return `${base ? `${base}&` : '?'}sort=${filters.sort}`
}

// ── Requests ────────────────────────────────────────────────────────────────

export const timingSocial = (id) => api(`/timings/${id}/social`)
export const rate = (id, stars) => api(`/timings/${id}/rating`, stars ? { method: 'PUT', json: { stars } } : { method: 'DELETE' })
export const markUsed = (id, beatmapUrl) => api(`/timings/${id}/use`, { method: 'PUT', json: beatmapUrl ? { beatmapUrl } : {} })
export const unmarkUsed = (id) => api(`/timings/${id}/use`, { method: 'DELETE' })

export const listComments = (id, offset = 0) => api(`/timings/${id}/comments${offset ? `?offset=${offset}` : ''}`)
export const postComment = (id, body, atMs) => api(`/timings/${id}/comments`, { method: 'POST', json: { body, ...(atMs === null ? {} : { atMs }) } })
export const deleteComment = (id, commentId) => api(`/timings/${id}/comments/${commentId}`, { method: 'DELETE' })

export const myCollections = (timingId = null) => api(`/me/collections${timingId ? `?timing=${timingId}` : ''}`)
export const createCollection = (name, isPublic = false) => api('/collections', { method: 'POST', json: { name, public: isPublic } })
export const getCollection = (id, cursor = null) => api(`/collections/${id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
export const updateCollection = (id, change) => api(`/collections/${id}`, { method: 'PATCH', json: change })
export const deleteCollection = (id) => api(`/collections/${id}`, { method: 'DELETE' })
export const addToCollection = (id, timingId) => api(`/collections/${id}/items/${timingId}`, { method: 'PUT' })
export const removeFromCollection = (id, timingId) => api(`/collections/${id}/items/${timingId}`, { method: 'DELETE' })

export const userProfile = (username) => api(`/users/${encodeURIComponent(username)}`)
export const userTimings = (username, filters, options) => api(`/users/${encodeURIComponent(username)}/timings${sortedQuery(filters, options)}`)
export const myProfile = () => api('/me/profile')
export const setProfilePrivate = (on) => api('/me/profile', { method: 'PUT', json: { private: Boolean(on) } })
export const timers = (by = 'uses') => api(`/timers?by=${by === 'stars' ? 'stars' : 'uses'}`)
export const sortedTimings = (filters, options) => api(`/timings${sortedQuery(filters, options)}`)
