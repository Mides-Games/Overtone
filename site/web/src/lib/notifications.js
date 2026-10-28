/**
 * The notification bell (W13.17), as the navbar and `/notifications` read
 * it: the requests, where each kind of notification leads and what it says,
 * and the polite schedule the bell polls the unread count on. Pure where it
 * can be, so the tests reach it without a browser.
 */
import { api } from './api.js'

/** The kinds the API sends (site/api services/notification.service.js). */
export const KINDS = ['suggestion', 'comment', 'use', 'vote', 'analysis']

/**
 * How long the bell waits before asking again: a minute while the tab is
 * seen, nothing while it is hidden (the page asks again the moment it is
 * shown), and after a failure 2, 4, 8 minutes up to 15, so a server that is
 * down is not asked every minute by every open tab.
 */
export const POLL_MS = 60_000
/** How many the navbar's dropdown shows; `/notifications` pages by fifty. */
export const DROPDOWN_SIZE = 8
export const MAX_BACKOFF_MS = 15 * 60_000

export function pollDelay({ hidden = false, failures = 0 } = {}) {
  if (hidden) return null
  if (failures <= 0) return POLL_MS
  return Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** failures)
}

const ID = /^[0-9a-f]{32}$/

/** Where a notification leads on this site, or null when its payload is not one this page understands. */
export function notificationLink(n) {
  const p = n?.payload ?? {}
  switch (n?.kind) {
    case 'suggestion':
      return ID.test(p.suggestion ?? '') ? `/community#suggestion-${p.suggestion}` : '/community'
    case 'comment':
      return ID.test(p.timing ?? '') ? `/t/${p.timing}${ID.test(p.comment ?? '') ? `#comment-${p.comment}` : ''}` : null
    case 'use':
    case 'vote':
      return ID.test(p.timing ?? '') ? `/t/${p.timing}` : null
    case 'analysis':
      return ID.test(p.analysis ?? '') ? `/analyze/${p.analysis}` : null
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
    default:
      return { key: 'notifications.text.unknown', values: {} }
  }
}

// ── Requests ────────────────────────────────────────────────────────────────

export const unreadCount = () => api('/me/notifications/unread')
export const listNotifications = ({ offset = 0, limit = 50, unread = false } = {}) =>
  api(`/me/notifications?limit=${limit}${offset ? `&offset=${offset}` : ''}${unread ? '&unread=1' : ''}`)
export const markRead = (ids) => api('/me/notifications/read', { method: 'POST', json: ids === 'all' ? { all: true } : { ids } })

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
