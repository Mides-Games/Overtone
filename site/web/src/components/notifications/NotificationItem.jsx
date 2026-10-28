import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { iconOf, notificationLink, notificationMessage, relativeTime } from '../../lib/notifications.js'
import Icon from '../ui/Icon.jsx'

/**
 * One notification (W13.17), as the bell's panel and `/notifications` draw
 * it: the kind's icon, what happened, how long ago, an unread dot, and two
 * icon buttons, read/unread and delete. The text is a link to where it
 * happened (`notificationLink`, a path on this site only); following it marks
 * it read. Each row's link carries `data-notification` so the list's arrow
 * keys can move between rows (`listKeys`), and Delete on a row removes it.
 *
 * `select` (the page's bulk actions) adds a checkbox before the icon.
 */
export default function NotificationItem({ notification: n, onOpen, onToggleRead, onDelete, select = null, busy = false }) {
  const { t, i18n } = useTranslation()
  const now = useNow()
  const { key, values, state } = notificationMessage(n, t('timings.untitled'))
  const text = t(key, { ...values, ...(state ? { to: t(`community.states.${state}`, { defaultValue: state }) } : {}) })
  const to = notificationLink(n)
  const when = new Date(n.createdAt)

  const body = (
    <>
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${n.read ? 'bg-surface-2 text-dim' : 'bg-accent/15 text-accent'}`}
      >
        <Icon name={iconOf(n)} size={16} />
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className={`block break-words text-label ${n.read ? 'text-muted' : 'font-medium text-text'}`}>{text}</span>
        {n.kind === 'vote' && n.payload?.verdict === 'off' && (n.payload.proposedBpm != null || n.payload.proposedOffsetMs != null) && (
          <span className="readout block text-caption text-dim">
            {t('notifications.proposed', { bpm: n.payload.proposedBpm ?? '–', offset: n.payload.proposedOffsetMs ?? '–' })}
          </span>
        )}
        <time
          dateTime={n.createdAt}
          title={when.toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })}
          className="block text-caption text-dim"
        >
          {relativeTime(when, i18n.language, now)}
        </time>
        {!n.read && <span className="sr-only">{t('notifications.unreadMark')}</span>}
      </span>
    </>
  )
  const main = 'flex min-w-0 flex-1 items-start gap-3 rounded-control px-2 py-2 text-left focus-visible:-outline-offset-2'

  return (
    <div className={`group flex items-start gap-1 rounded-control transition-colors duration-150 ease-out hover:bg-surface-2 ${busy ? 'opacity-60' : ''}`}>
      {select && (
        <input
          type="checkbox"
          checked={select.checked}
          onChange={(e) => select.onChange(e.target.checked)}
          aria-label={t('notifications.select', { text })}
          className="ml-2 mt-4 h-4 w-4 shrink-0 accent-[var(--accent)]"
        />
      )}
      {to ? (
        <Link to={to} onClick={() => onOpen(n)} data-notification={n.id} className={main}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={() => onOpen(n)} data-notification={n.id} className={main}>
          {body}
        </button>
      )}
      <span aria-hidden="true" className={`mt-4 h-2 w-2 shrink-0 rounded-full ${n.read ? 'bg-transparent' : 'bg-accent'}`} />
      <span className="flex shrink-0 items-center self-center">
        <button
          type="button"
          onClick={() => onToggleRead(n)}
          aria-label={n.read ? t('notifications.markUnread') : t('notifications.markRead')}
          title={n.read ? t('notifications.markUnread') : t('notifications.markRead')}
          className="icon-btn h-8 min-w-8"
          disabled={busy}
        >
          <Icon name={n.read ? 'dot' : 'check'} size={16} />
        </button>
        <button
          type="button"
          onClick={() => onDelete(n)}
          aria-label={t('notifications.delete')}
          title={t('notifications.delete')}
          className="icon-btn h-8 min-w-8 hover:text-red"
          disabled={busy}
        >
          <Icon name="trash" size={16} />
        </button>
      </span>
    </div>
  )
}

/** The time now, again every minute while a list is on screen, so "3 min ago" does not stand still. */
function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * The list's keys, for an onKeyDown on the element around the rows: the up
 * and down arrows (Home, End) move between the rows' links, wherever the
 * focus is in a row; Delete removes the row the focus is in. Enter is the
 * link's own. Returns true when it handled the key.
 */
export function listKeys(event, { onDelete }) {
  const rows = [...event.currentTarget.querySelectorAll('[data-notification]')]
  if (!rows.length) return false
  const at = rows.findIndex((row) => row.closest('li')?.contains(event.target))
  const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[event.key]
  if (go !== undefined) {
    event.preventDefault()
    rows[Math.max(0, Math.min(rows.length - 1, at === -1 && event.key === 'ArrowUp' ? rows.length - 1 : go))]?.focus()
    return true
  }
  if (event.key === 'Delete' && at !== -1 && event.target.tagName !== 'INPUT') {
    event.preventDefault()
    // The focus goes to the next row, else the one before, once this one is gone.
    const next = rows[at + 1] ?? rows[at - 1] ?? null
    onDelete(rows[at].getAttribute('data-notification'), next?.getAttribute('data-notification') ?? null)
    return true
  }
  return false
}
