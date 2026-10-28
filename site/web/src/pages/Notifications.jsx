import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'

import { NotificationRow, useUnread } from '../components/Bell.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import { SkeletonRows } from '../components/ui/Skeleton.jsx'
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

  if (account === undefined) return <SkeletonRows rows={4} label={t('common.loading')} className="border-y border-line" />
  if (account === null) {
    return (
      <div className="space-y-8">
        <PageHeader title={t('notifications.title')} lede={t('notifications.subtitle')} />
        <EmptyState
          title={t('notifications.signIn')}
          className="border-y border-line"
          action={
            <Link to="/login" state={{ from: '/notifications' }} className="btn-primary">
              <Icon name="user" size={16} />
              {t('nav.signIn')}
            </Link>
          }
        />
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
    <div className="space-y-10">
      <PageHeader title={t('notifications.title')} lede={t('notifications.subtitle')} />

      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label={t('notifications.filter')} className="flex gap-1.5">
            {[false, true].map((only) => (
              <button key={String(only)} type="button" aria-pressed={onlyUnread === only} onClick={() => setOnlyUnread(only)} className="tool-btn px-3 font-sans">
                {only ? t('notifications.unreadOnly', { count: unread }) : t('notifications.all')}
              </button>
            ))}
          </div>
          {unread > 0 && (
            <button type="button" className="btn-ghost btn-sm" onClick={allRead}>
              <Icon name="check" size={15} />
              {t('notifications.allRead')}
            </button>
          )}
        </div>

        {failed && (
          <p role="alert" className="text-caption text-red">
            {t('notifications.failed')}
          </p>
        )}
        {!page && !failed && <SkeletonRows rows={4} label={t('common.loading')} className="border-y border-line" />}
        {page && page.items.length === 0 && <EmptyState title={t('notifications.empty')} className="border-y border-line" />}
        {page && page.items.length > 0 && (
          <ul className="divide-y divide-line border-y border-line">
            {page.items.map((n) => (
              <li key={n.id} className="py-1">
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
    </div>
  )
}
