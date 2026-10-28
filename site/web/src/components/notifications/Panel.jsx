import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { applyChange, CHANGED, commitChange, DROPDOWN_SIZE, listNotifications, unreadStore } from '../../lib/notifications.js'
import useUnread from '../../hooks/useUnread.js'
import Icon from '../ui/Icon.jsx'
import Skeleton from '../ui/Skeleton.jsx'
import Tabs from '../ui/Tabs.jsx'
import NotificationItem, { listKeys } from './NotificationItem.jsx'

/**
 * The bell's panel (W13.17): a popover under the bell, at the bar's right
 * edge (the bar's width less a margin on a phone). Its own chunk, loaded the
 * first time the bell opens, so the bar every page carries holds only the
 * button and the poll.
 *
 * - A header with "Mark all as read" and "Delete read"; All and Unread tabs;
 *   the latest DROPDOWN_SIZE; each row's read/unread and delete buttons; "See
 *   all" to `/notifications`; an empty state.
 * - Every change moves the bell's count at once and takes the server's
 *   answer as the truth (lib/notifications.js `commitChange`).
 * - Focus as in the palette's dialog: it moves into the panel when it opens
 *   (the first row, else the panel), Tab and Shift+Tab stay inside, Escape
 *   closes and gives the focus back to the bell. A click outside closes it
 *   without taking the focus anywhere. The arrow keys move between rows,
 *   Enter opens one, Delete removes it.
 * - Opening one marks it read and follows its link (a path on this site).
 */
export default function Panel({ onClose, bellRef }) {
  const { t } = useTranslation()
  const titleId = useId()
  const ref = useRef(null)
  const [tab, setTab] = useState('all')
  const [page, setPage] = useState(null)
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState(false)
  const focusAfter = useRef('first')

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const data = await listNotifications({ limit: DROPDOWN_SIZE, unread: tab === 'unread' })
      unreadStore.set(data.unread)
      setPage(data)
    } catch {
      setFailed(true)
    }
  }, [tab])

  useEffect(() => {
    load()
    // A change made on `/notifications` behind the panel.
    const onChanged = (event) => event.detail?.source !== 'panel' && load()
    window.addEventListener(CHANGED, onChanged)
    return () => window.removeEventListener(CHANGED, onChanged)
  }, [load])

  // The focus: into the panel once the list is there, then wherever a delete left it.
  useEffect(() => {
    const want = focusAfter.current
    if (!want || (page === null && !failed)) return
    focusAfter.current = null
    const panel = ref.current
    if (!panel) return
    const target =
      (want !== 'first' && panel.querySelector(`[data-notification="${want}"]`)) || panel.querySelector('[data-notification]') || panel
    target.focus()
  }, [page, failed])

  // Escape, a click outside, and Tab kept inside.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        bellRef.current?.focus()
        return
      }
      if (event.key !== 'Tab' || !ref.current) return
      const focusable = [...ref.current.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]')].filter(
        (el) => el.offsetParent !== null,
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const onDown = (event) => {
      if (!ref.current?.contains(event.target) && !bellRef.current?.contains(event.target)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose, bellRef])

  async function change(changeOf, { reload = false } = {}) {
    setError(false)
    const before = page
    setPage((current) => current && { ...current, items: applyChange(current.items, changeOf) })
    try {
      await commitChange(changeOf, before?.items, 'panel')
      if (reload || tab === 'unread') load()
    } catch {
      setError(true)
      load()
    }
  }

  function open(n) {
    if (!n.read) commitChange({ read: [n.id] }, page?.items, 'panel').catch(() => {})
    onClose()
  }

  function remove(id, nextId) {
    focusAfter.current = nextId ?? 'first'
    change({ remove: [id] }, { reload: true })
  }

  const unread = useUnread()
  const items = page?.items ?? null
  // In the unread tab nothing says how many are read: the button stays on, and deleting none is harmless.
  const hasRead = page ? (tab === 'all' ? page.total > unread : true) : false

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="menu pop-in absolute inset-x-2 top-full mt-1 flex max-h-[calc(100dvh-var(--bar-height)-1rem)] flex-col p-0 focus:outline-none sm:inset-x-auto sm:right-0 sm:mt-2 sm:w-[25rem]"
      style={{ '--origin': 'top right' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 pt-3">
        <h2 id={titleId} className="text-body font-semibold text-text">
          {t('notifications.title')}
        </h2>
        <div className="-mr-1.5 flex items-center">
          <button type="button" onClick={() => change({ allRead: true })} disabled={!unread} className="btn-quiet btn-sm px-2">
            <Icon name="check" size={15} />
            {t('notifications.allRead')}
          </button>
          <button type="button" onClick={() => change({ removeRead: true }, { reload: true })} disabled={!hasRead} className="btn-quiet btn-sm px-2">
            <Icon name="trash" size={15} />
            {t('notifications.deleteRead')}
          </button>
        </div>
      </div>

      <Tabs
        id="bell"
        label={t('notifications.filter')}
        tabs={[
          { key: 'all', label: t('notifications.all') },
          { key: 'unread', label: t('notifications.unreadTab'), count: unread },
        ]}
        value={tab}
        onChange={(key) => {
          setPage(null)
          setTab(key)
        }}
        className="mt-1 px-1.5"
      />

      <div role="tabpanel" id={`bell-panel-${tab}`} aria-labelledby={`bell-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {error && (
          <p role="alert" className="px-3 pt-2 text-caption text-red">
            {t('notifications.changeFailed')}
          </p>
        )}
        {failed && (
          <div className="space-y-2 px-3 py-4 text-center">
            <p className="text-caption text-red">{t('notifications.failed')}</p>
            <button type="button" onClick={load} className="btn-ghost btn-sm">
              {t('notifications.retry')}
            </button>
          </div>
        )}
        {!failed && items === null && (
          <div className="space-y-3 px-3 py-4" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        )}
        {items?.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
            <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-dim">
              <Icon name="bell" size={18} />
            </span>
            <p className="text-label font-medium text-text">{tab === 'unread' ? t('notifications.emptyUnread') : t('notifications.empty')}</p>
            <p className="text-caption text-muted">{t('notifications.emptyHint')}</p>
          </div>
        )}
        {items?.length > 0 && (
          <ul className="space-y-0.5 p-1.5" onKeyDown={(event) => listKeys(event, { onDelete: remove })}>
            {items.map((n) => (
              <li key={n.id}>
                <NotificationItem
                  notification={n}
                  onOpen={open}
                  onToggleRead={(item) => change(item.read ? { unread: [item.id] } : { read: [item.id] })}
                  onDelete={(item) => {
                    const at = items.findIndex((x) => x.id === item.id)
                    remove(item.id, items[at + 1]?.id ?? items[at - 1]?.id ?? null)
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <Link
        to="/notifications"
        onClick={onClose}
        className="flex items-center justify-center gap-1.5 border-t border-line px-3 py-2.5 text-label font-semibold text-accent hover:underline"
      >
        {t('notifications.seeAll')}
        <Icon name="arrow-right" size={14} />
      </Link>
    </div>
  )
}
