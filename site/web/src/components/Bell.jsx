import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'

import useUnread from '../hooks/useUnread.js'
import { pollDelay, unreadCount, unreadStore } from '../lib/notifications.js'
import Icon from './ui/Icon.jsx'
import Skeleton from './ui/Skeleton.jsx'

// The panel is its own chunk, fetched the first time the bell opens.
const Panel = lazy(() => import('./notifications/Panel.jsx'))

/**
 * The notification bell (W13.17), at the right of the navbar for a signed-in
 * account, on every page and every width: the unread count (99+ past 99),
 * and the panel (components/notifications/Panel.jsx) under it.
 *
 * Polled politely: the unread count once a minute while the tab is seen,
 * not at all while it is hidden (it asks again the moment it is shown or
 * focused), backing off after failures (lib/notifications.js `pollDelay`).
 * The list itself is read only when the panel opens. A change made in the
 * panel or on `/notifications` moves the count at once (`commitChange`).
 */
export default function Bell() {
  const { t } = useTranslation()
  const unread = useUnread()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef(null)
  const { pathname } = useLocation()

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

  // A followed link closes it.
  useEffect(() => setOpen(false), [pathname])
  const close = useCallback(() => setOpen(false), [])

  return (
    <div className="sm:relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('notifications.bell', { count: unread })}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="icon-btn relative"
      >
        <Icon name="bell" size={18} />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="readout absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none text-accent-ink"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <Suspense
          fallback={
            <div className="menu absolute inset-x-2 top-full mt-1 space-y-2 p-3 sm:inset-x-auto sm:right-0 sm:mt-2 sm:w-[25rem]" role="status" aria-label={t('common.loading')}>
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          }
        >
          <Panel onClose={close} bellRef={buttonRef} />
        </Suspense>
      )}
    </div>
  )
}
