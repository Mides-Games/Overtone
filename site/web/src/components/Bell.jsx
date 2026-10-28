import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'

import {
  DROPDOWN_SIZE,
  listNotifications,
  markRead,
  notificationLink,
  notificationMessage,
  pollDelay,
  unreadCount,
  unreadStore,
} from '../lib/notifications.js'

/**
 * The notification bell (W13.17), in the navbar for a signed-in account:
 * the unread count, and a dropdown with the latest few, "mark all read" and
 * a link to `/notifications`.
 *
 * Polled politely: the unread count once a minute while the tab is seen,
 * not at all while it is hidden (it asks again the moment it is shown or
 * focused), backing off after failures (lib/notifications.js `pollDelay`).
 * The list itself is read only when the dropdown opens.
 */
export const useUnread = () => useSyncExternalStore(unreadStore.subscribe, unreadStore.get)

export default function Bell() {
  const { t } = useTranslation()
  const unread = useUnread()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState(null)
  const [failed, setFailed] = useState(false)
  const ref = useRef(null)
  const buttonRef = useRef(null)
  const navigate = useNavigate()

  // The polite poll.
  useEffect(() => {
    let timer = null
    let failures = 0
    let stopped = false
    const schedule = () => {
      clearTimeout(timer)
      const delay = pollDelay({ hidden: document.visibilityState === 'hidden', failures })
      if (delay !== null && !stopped) timer = setTimeout(check, delay)
    }
    const check = async () => {
      try {
        const { unread: n } = await unreadCount()
        unreadStore.set(n)
        failures = 0
      } catch (error) {
        // Signed out elsewhere: nothing more to ask until the page knows.
        if (error.status === 401) {
          stopped = true
          return
        }
        failures += 1
      }
      schedule()
    }
    const wake = () => {
      if (document.visibilityState !== 'hidden') check()
      else clearTimeout(timer)
    }
    check()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
    }
  }, [])

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const data = await listNotifications({ limit: DROPDOWN_SIZE })
      setItems(data.items)
      unreadStore.set(data.unread)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    if (!open) return undefined
    load()
    const close = (event) => {
      if (event.type === 'keydown' ? event.key === 'Escape' : !ref.current?.contains(event.target)) {
        setOpen(false)
        if (event.type === 'keydown') buttonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open, load])

  async function allRead() {
    try {
      const { unread: n } = await markRead('all')
      unreadStore.set(n)
      setItems((list) => list?.map((n2) => ({ ...n2, read: true })) ?? list)
    } catch {
      setFailed(true)
    }
  }

  async function follow(n) {
    setOpen(false)
    if (!n.read) {
      markRead([n.id])
        .then((data) => unreadStore.set(data.unread))
        .catch(() => {})
    }
    const to = notificationLink(n)
    if (to) navigate(to)
  }

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('notifications.bell', { count: unread })}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative flex h-8 min-w-8 items-center justify-center rounded-control px-1.5 text-muted transition hover:bg-surface-3 hover:text-text"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="readout absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none text-accent-ink">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="rise fixed inset-x-2 top-16 z-50 rounded-panel border border-line-strong bg-surface p-1.5 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.6)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-80">
          <div className="flex items-center justify-between gap-2 border-b border-line px-2.5 pb-2 pt-1">
            <p className="label">{t('notifications.title')}</p>
            {unread > 0 && (
              <button type="button" onClick={allRead} className="text-caption text-accent hover:underline">
                {t('notifications.allRead')}
              </button>
            )}
          </div>
          {failed && <p className="px-2.5 py-3 text-caption text-red">{t('notifications.failed')}</p>}
          {!failed && items === null && <p className="px-2.5 py-3 text-caption text-dim">{t('common.loading')}</p>}
          {items?.length === 0 && <p className="px-2.5 py-3 text-caption text-dim">{t('notifications.empty')}</p>}
          {items?.length > 0 && (
            <ul className="max-h-[60vh] overflow-y-auto py-1">
              {items.map((n) => (
                <li key={n.id}>
                  <NotificationRow notification={n} onOpen={() => follow(n)} />
                </li>
              ))}
            </ul>
          )}
          <Link to="/notifications" onClick={() => setOpen(false)} className="block border-t border-line px-2.5 pb-1 pt-2 text-center text-caption text-accent hover:underline">
            {t('notifications.seeAll')}
          </Link>
        </div>
      )}
    </div>
  )
}

/** One notification: what happened, when, and a dot while it is unread. A button that follows its link. */
export function NotificationRow({ notification: n, onOpen }) {
  const { t, i18n } = useTranslation()
  const { key, values, state } = notificationMessage(n, t('timings.untitled'))
  const text = t(key, { ...values, ...(state ? { to: t(`community.states.${state}`, { defaultValue: state }) } : {}) })
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full items-start gap-2.5 rounded-control px-2.5 py-2 text-left transition hover:bg-surface-3 ${n.read ? 'text-muted' : 'text-text'}`}
    >
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? 'bg-transparent' : 'bg-accent'}`}
      />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block break-words text-label">{text}</span>
        {n.kind === 'vote' && n.payload?.verdict === 'off' && (n.payload.proposedBpm !== null || n.payload.proposedOffsetMs !== null) && (
          <span className="readout block text-caption text-dim">
            {t('notifications.proposed', { bpm: n.payload.proposedBpm ?? '–', offset: n.payload.proposedOffsetMs ?? '–' })}
          </span>
        )}
        <time dateTime={n.createdAt} className="block text-caption text-dim">
          {new Date(n.createdAt).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
      </span>
      {!n.read && <span className="sr-only">{t('notifications.unreadMark')}</span>}
    </button>
  )
}
