import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import { NotificationRow, useUnread } from '../components/Bell.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { listNotifications, markRead, notificationLink, unreadStore } from '../lib/notifications.js'

/**
 * Every notification an account keeps (W13.17), newest first, fifty a page:
 * all of them or the unread ones, each a link to where it happened, which
 * marks it read. The bell in the navbar shows the same count.
 */
export default function Notifications() {
  const { t } = useTranslation()
  usePageMeta(t('notifications.title'), t('notifications.subtitle'))
  const { account } = useAuth()
  const navigate = useNavigate()
  const unread = useUnread()
  const [onlyUnread, setOnlyUnread] = useState(false)
  const [page, setPage] = useState(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(
    async (offset = 0) => {
      setFailed(false)
      try {
        const data = await listNotifications({ offset, unread: onlyUnread })
        unreadStore.set(data.unread)
        setPage((current) => (offset && current ? { ...data, items: [...current.items, ...data.items] } : data))
      } catch {
        setFailed(true)
      }
    },
    [onlyUnread],
  )

  useEffect(() => {
    if (account) load()
  }, [account, load])

  if (account === undefined) return <BrandLoader className="py-16" />
  if (account === null) {
    return (
      <div className="panel space-y-3 p-6">
        <h1 className="font-display text-title font-bold uppercase">{t('notifications.title')}</h1>
        <p className="text-label text-muted">{t('notifications.signIn')}</p>
        <Link to="/login" className="btn-primary">
          {t('nav.signIn')}
        </Link>
      </div>
    )
  }

  async function allRead() {
    try {
      const data = await markRead('all')
      unreadStore.set(data.unread)
      setPage((current) => current && { ...current, items: current.items.map((n) => ({ ...n, read: true })) })
    } catch {
      setFailed(true)
    }
  }

  function open(n) {
    if (!n.read) {
      markRead([n.id])
        .then((data) => unreadStore.set(data.unread))
        .catch(() => {})
    }
    const to = notificationLink(n)
    if (to) navigate(to)
  }

  return (
    <div className="space-y-6">
      <header className="rise space-y-2">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('notifications.title')}</h1>
        <p className="max-w-[60ch] text-muted">{t('notifications.subtitle')}</p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label={t('notifications.filter')} className="flex gap-1">
          {[false, true].map((only) => (
            <button
              key={String(only)}
              type="button"
              aria-pressed={onlyUnread === only}
              onClick={() => setOnlyUnread(only)}
              className={onlyUnread === only ? 'chip-accent' : 'chip hover:text-text'}
            >
              {only ? t('notifications.unreadOnly', { count: unread }) : t('notifications.all')}
            </button>
          ))}
        </div>
        {unread > 0 && (
          <button type="button" className="btn-ghost h-8 px-3" onClick={allRead}>
            {t('notifications.allRead')}
          </button>
        )}
      </div>

      {failed && <p className="text-caption text-red">{t('notifications.failed')}</p>}
      {!page && !failed && <BrandLoader className="py-10" />}
      {page && page.items.length === 0 && <p className="text-caption text-dim">{t('notifications.empty')}</p>}
      {page && page.items.length > 0 && (
        <ul className="panel divide-y divide-line p-1">
          {page.items.map((n) => (
            <li key={n.id}>
              <NotificationRow notification={n} onOpen={() => open(n)} />
            </li>
          ))}
        </ul>
      )}
      {page && page.items.length < page.total && (
        <button type="button" className="btn-ghost mx-auto flex" onClick={() => load(page.items.length)}>
          {t('social.more')}
        </button>
      )}
      <p className="text-caption text-dim">{t('notifications.kept')}</p>
    </div>
  )
}
