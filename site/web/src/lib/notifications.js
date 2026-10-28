/**
 * The notification bell (W13.17), as the navbar and `/notifications` read
 * it: the requests, where each kind of notification leads and what it says,
 * how long ago it was, the polite schedule the bell polls the unread count
 * on, and the optimistic count after a mark or a delete. Pure where it can
 * be, so the tests reach it without a browser.
 */
import { api } from './api.js'

/** The kinds the API sends (site/api services/notification.service.js); `staff` reaches staff only. */
export const KINDS = ['suggestion', 'comment', 'use', 'vote', 'analysis', 'staff']

/** Each kind's icon in the panel and on the page (components/ui/Icon.jsx); a mapper's confirmation has its own. */
export const KIND_ICON = { suggestion: 'bulb', comment: 'comment', use: 'download', vote: 'star', analysis: 'wave', staff: 'flag' }
export const iconOf = (n) => (n?.kind === 'vote' && n.payload?.mapper ? 'trophy' : (KIND_ICON[n?.kind] ?? 'bell'))

/**
 * How long the bell waits before asking again: a minute while the tab is
 * seen, nothing while it is hidden (the page asks again the moment it is
 * shown), and after a failure 2, 4, 8 minutes up to 15, so a server that is
 * down is not asked every minute by every open tab.
 */
export const POLL_MS = 60_000
/** How many the navbar's panel shows; `/notifications` pages by fifty. */
export const DROPDOWN_SIZE = 8
export const PAGE_SIZE = 50
export const MAX_BACKOFF_MS = 15 * 60_000

export function pollDelay({ hidden = false, failures = 0 } = {}) {
  if (hidden) return null
  if (failures <= 0) return POLL_MS
  return Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** failures)
}

const ID = /^[0-9a-f]{32}$/
/** A path on this site: one slash, then nothing a scheme or a host could hide in. The API's SAME_SITE. */
export const SAME_SITE = /^\/(?!\/)[A-Za-z0-9/_?=#-]*$/

/**
 * Where a notification leads on this site, or null. The API's `target.path`
 * first (it builds one for every kind, from checked ids), checked again here
 * so a link is never anything but a path on this site; a notification read
 * from an API without targets is led from its kind and payload.
 */
export function notificationLink(n) {
  const path = n?.target?.path
  if (typeof path === 'string' && SAME_SITE.test(path)) return path
  const p = n?.payload ?? {}
  switch (n?.kind) {
    case 'suggestion':
      return ID.test(p.suggestion ?? '') ? `/community?suggestion=${p.suggestion}#suggestion-${p.suggestion}` : '/community'
    case 'comment':
      return ID.test(p.timing ?? '') ? `/t/${p.timing}${ID.test(p.comment ?? '') ? `#comment-${p.comment}` : ''}` : null
    case 'use':
    case 'vote':
      return ID.test(p.timing ?? '') ? `/t/${p.timing}` : null
    case 'analysis':
      return ID.test(p.analysis ?? '') ? `/analyze/${p.analysis}` : null
    case 'staff':
      return '/staff'
    default:
      return null
  }
}

/**
 * The i18n key and values a notification is written with. Every value is
 * the payload's own text, which the page renders as text; a missing name
 * reads as the untitled song.
 */
export function notificationMessage(n, untitled) {
  const p = n?.payload ?? {}
  const title = typeof p.title === 'string' && p.title ? p.title : untitled
  switch (n?.kind) {
    case 'suggestion':
      return { key: 'notifications.text.suggestion', values: { title, to: p.to ?? '' }, state: p.to ?? null }
    case 'comment':
      return { key: 'notifications.text.comment', values: { user: p.user ?? '?', title } }
    case 'use':
      return { key: 'notifications.text.use', values: { user: p.user ?? '?', title } }
    case 'vote':
      if (p.mapper) return { key: 'notifications.text.verified', values: { user: p.mapper, title } }
      return { key: p.verdict === 'on' ? 'notifications.text.voteOn' : 'notifications.text.voteOff', values: { title } }
    case 'analysis': {
      const name = typeof p.name === 'string' && p.name ? p.name : untitled
      const status = ['done', 'refused', 'failed'].includes(p.status) ? p.status : 'done'
      return { key: `notifications.text.analysis.${status}`, values: { title: name } }
    }
    case 'staff':
      if (p.item === 'correction') return { key: 'notifications.text.staff.correction', values: { title } }
      return { key: `notifications.text.staff.report.${['suggestion', 'review', 'comment'].includes(p.kind) ? p.kind : 'item'}`, values: {} }
    default:
      return { key: 'notifications.text.unknown', values: {} }
  }
}

// ── When ────────────────────────────────────────────────────────────────────

const DAY = 86_400_000
const UNITS = [
  ['year', 365 * DAY],
  ['month', 30 * DAY],
  ['week', 7 * DAY],
  ['day', DAY],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

/**
 * How long ago, as `Intl.RelativeTimeFormat` takes it: the largest whole
 * unit, negative for the past. Under a minute is `{ value: 0, unit: 'minute' }`,
 * which the format says as "this minute"; a clock a little ahead of the
 * server's reads the same, never "in 2 min".
 */
export function relativeParts(date, now = Date.now()) {
  const ms = Math.max(0, now - new Date(date).getTime())
  for (const [unit, size] of UNITS) {
    if (ms >= size) return { value: -Math.floor(ms / size), unit }
  }
  return { value: 0, unit: 'minute' }
}

/** "3 min ago", "yesterday", "hace 3 min", in `language`; the date itself where the format is missing. */
export function relativeTime(date, language, now = Date.now()) {
  const { value, unit } = relativeParts(date, now)
  try {
    return new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' }).format(value, unit)
  } catch {
    return new Date(date).toLocaleString(language)
  }
}

// ── Requests ────────────────────────────────────────────────────────────────

export const unreadCount = () => api('/me/notifications/unread')
export const listNotifications = ({ offset = 0, limit = PAGE_SIZE, unread = false, kinds = [] } = {}) => {
  const known = kinds.filter((k) => KINDS.includes(k))
  return api(
    `/me/notifications?limit=${limit}${offset ? `&offset=${offset}` : ''}${unread ? '&unread=1' : ''}${known.length ? `&kind=${known.join(',')}` : ''}`,
  )
}
export const markRead = (ids) => api('/me/notifications/read', { method: 'POST', json: ids === 'all' ? { all: true } : { ids } })
export const markUnread = (ids) => api('/me/notifications/unread', { method: 'POST', json: { ids } })
export const deleteNotification = (id) => api(`/me/notifications/${id}`, { method: 'DELETE' })
export const deleteRead = () => api('/me/notifications?read=true', { method: 'DELETE' })

// ── Changes, made at once and put right by the answer ──────────────────────

/**
 * A change the panel or the page makes:
 *
 *   { read: [ids] } | { unread: [ids] } | { remove: [ids] } | { allRead: true } | { removeRead: true }
 *
 * `optimisticUnread` is the count once it is made, before the server says,
 * so the bell moves at once; the answer's `unread` puts it right a moment
 * later, or, when the request failed, a fresh read of the count does.
 */
export function optimisticUnread(count, items, change) {
  const byId = new Map((items ?? []).map((n) => [n.id, n]))
  const unreadAmong = (ids) => ids.filter((id) => byId.has(id) && !byId.get(id).read).length
  if (change.allRead) return 0
  if (change.read) return Math.max(0, count - unreadAmong(change.read))
  if (change.remove) return Math.max(0, count - unreadAmong(change.remove))
  if (change.unread) return count + change.unread.filter((id) => byId.get(id)?.read).length
  return count
}

/** `items` after `change`, as the server will have them. */
export function applyChange(items, change) {
  if (!items) return items
  if (change.allRead) return items.map((n) => (n.read ? n : { ...n, read: true }))
  if (change.removeRead) return items.filter((n) => !n.read)
  if (change.read) return items.map((n) => (change.read.includes(n.id) ? { ...n, read: true } : n))
  if (change.unread) return items.map((n) => (change.unread.includes(n.id) ? { ...n, read: false } : n))
  if (change.remove) return items.filter((n) => !change.remove.includes(n.id))
  return items
}

/** The request that makes `change`; every one answers with `{ unread }` among the rest. */
export async function sendChange(change) {
  if (change.allRead) return markRead('all')
  if (change.removeRead) return deleteRead()
  if (change.read) return markRead(change.read)
  if (change.unread) return markUnread(change.unread)
  if (change.remove) {
    let last = null
    // One at a time: the page deletes a handful at most, and the last answer has the final count.
    for (const id of change.remove) last = await deleteNotification(id)
    return last
  }
  return null
}

// ── One count for the bell and the page ─────────────────────────────────────

/**
 * The unread count, shared by the navbar's bell and `/notifications`, so
 * reading one there clears the bell at once. A tiny external store for
 * `useSyncExternalStore`.
 */
export function createUnreadStore() {
  let unread = 0
  const listeners = new Set()
  return {
    get: () => unread,
    set(next) {
      const value = Number.isInteger(next) && next >= 0 ? next : 0
      if (value === unread) return
      unread = value
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const unreadStore = createUnreadStore()

/**
 * Makes `change` on the server with the count moved first: `unreadStore`
 * takes the optimistic count now and the server's when it answers. On a
 * failure the count is read again and the error thrown, so the caller can
 * reload its list. Once made, CHANGED is sent on `window` with `source`, so
 * the bell's panel and `/notifications`, both open, read each other's changes.
 */
export const CHANGED = 'overtone:notifications'

export async function commitChange(change, items, source = null) {
  unreadStore.set(optimisticUnread(unreadStore.get(), items, change))
  try {
    const answer = await sendChange(change)
    if (Number.isInteger(answer?.unread)) unreadStore.set(answer.unread)
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHANGED, { detail: { source } }))
    return answer
  } catch (error) {
    unreadCount()
      .then((data) => unreadStore.set(data.unread))
      .catch(() => {})
    throw error
  }
}
