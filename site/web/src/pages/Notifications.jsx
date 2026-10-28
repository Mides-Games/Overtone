import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'

import NotificationItem, { listKeys } from '../components/notifications/NotificationItem.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import { SkeletonRows } from '../components/ui/Skeleton.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import useUnread from '../hooks/useUnread.js'
import { applyChange, CHANGED, commitChange, KINDS, listNotifications, PAGE_SIZE } from '../lib/notifications.js'

/**
 * Every notification an account keeps (W13.17), newest first, fifty a page:
 * all of them or the unread ones, of every kind or one, each a link to where
 * it happened (following it marks it read). The bell's actions are here too,
 * and in bulk: tick some, or the whole page, and mark them read or unread or
 * delete them; "Mark all as read" and "Delete read" act on every page.
 *
 * Which ones and which page live in the address (`?unread=1&kind=vote&page=2`),
 * so the back button returns to the same list. The arrow keys move between
 * rows, Enter opens one, Delete removes it, as in the bell's panel.
 */
export default function Notifications() {
  const { t } = useTranslation()
  usePageMeta(t('notifications.title'), t('notifications.subtitle'))
  const { account } = useAuth()
  const unread = useUnread()
  const [params, setParams] = useSearchParams()
  const onlyUnread = params.get('unread') === '1'
  const kind = KINDS.includes(params.get('kind')) ? params.get('kind') : ''
  const pageNo = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1)
  const [page, setPage] = useState(null)
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [busy, setBusy] = useState(false)

  const kinds = useMemo(() => KINDS.filter((k) => k !== 'staff' || account?.role === 'moderator'), [account?.role])

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const data = await listNotifications({ offset: (pageNo - 1) * PAGE_SIZE, unread: onlyUnread, kinds: kind ? [kind] : [] })
      setPage(data)
      setSelected((current) => new Set([...current].filter((id) => data.items.some((n) => n.id === id))))
    } catch {
      setFailed(true)
    }
  }, [pageNo, onlyUnread, kind])

  useEffect(() => {
    if (!account) return undefined
    load()
    // A change made in the bell's panel over this page.
    const onChanged = (event) => event.detail?.source !== 'page' && load()
    window.addEventListener(CHANGED, onChanged)
    return () => window.removeEventListener(CHANGED, onChanged)
  }, [account, load])

  // A page emptied by deletes, past the end, goes back one.
  const lastPage = page ? Math.max(1, Math.ceil(page.total / PAGE_SIZE)) : 1
  useEffect(() => {
    if (page && page.items.length === 0 && pageNo > lastPage) setParam({ page: lastPage > 1 ? String(lastPage) : '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageNo, lastPage])

  function setParam(changes) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value)
          else next.delete(key)
        }
        return next
      },
      { replace: true },
    )
  }

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

  async function change(changeOf, { reload = true } = {}) {
    setError(false)
    setBusy(true)
    const before = page?.items
    setPage((current) => current && { ...current, items: applyChange(current.items, changeOf) })
    try {
      await commitChange(changeOf, before, 'page')
      setSelected(new Set())
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
    if (reload) load()
  }

  function open(n) {
    if (!n.read) commitChange({ read: [n.id] }, page?.items, 'page').catch(() => {})
  }

  function remove(id, nextId) {
    change({ remove: [id] })
    // The focus goes to the next row once this one is drawn without it.
    if (nextId) requestAnimationFrame(() => document.querySelector(`[data-notification="${nextId}"]`)?.focus())
  }

  const items = page?.items ?? []
  const chosen = [...selected]
  const allChosen = items.length > 0 && items.every((n) => selected.has(n.id))
  const first = page ? (pageNo - 1) * PAGE_SIZE + 1 : 0
  const last = page ? (pageNo - 1) * PAGE_SIZE + items.length : 0

  const toggle = (id, on) =>
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  return (
    <div className="space-y-10">
      <PageHeader title={t('notifications.title')} lede={t('notifications.subtitle')} />

      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div role="group" aria-label={t('notifications.filter')} className="flex gap-1.5">
            {[false, true].map((only) => (
              <button
                key={String(only)}
                type="button"
                aria-pressed={onlyUnread === only}
                onClick={() => setParam({ unread: only ? '1' : '', page: '' })}
                className="tool-btn px-3 font-sans"
              >
                {only ? t('notifications.unreadOnly', { count: unread }) : t('notifications.all')}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <span className="label">{t('notifications.kind')}</span>
            <select value={kind} onChange={(e) => setParam({ kind: e.target.value, page: '' })} className="field h-9 w-auto py-0 text-label">
              <option value="">{t('notifications.allKinds')}</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {t(`notifications.kinds.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <button type="button" className="btn-ghost btn-sm" onClick={() => change({ allRead: true })} disabled={!unread || busy}>
              <Icon name="check" size={15} />
              {t('notifications.allRead')}
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => change({ removeRead: true })} disabled={busy}>
              <Icon name="trash" size={15} />
              {t('notifications.deleteRead')}
            </button>
          </div>
        </div>

        {items.length > 0 && (
          <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-3">
            <label className="flex cursor-pointer items-center gap-2 pl-2 text-label text-muted">
              <input
                type="checkbox"
                checked={allChosen}
                onChange={(e) => setSelected(e.target.checked ? new Set(items.map((n) => n.id)) : new Set())}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              {chosen.length ? t('notifications.selected', { count: chosen.length }) : t('notifications.selectPage')}
            </label>
            {chosen.length > 0 && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('notifications.bulk')}>
                <button type="button" className="btn-quiet btn-sm" disabled={busy} onClick={() => change({ read: chosen })}>
                  <Icon name="check" size={15} />
                  {t('notifications.markRead')}
                </button>
                <button type="button" className="btn-quiet btn-sm" disabled={busy} onClick={() => change({ unread: chosen })}>
                  <Icon name="dot" size={15} />
                  {t('notifications.markUnread')}
                </button>
                <button type="button" className="btn-quiet btn-sm" disabled={busy} onClick={() => change({ remove: chosen })}>
                  <Icon name="trash" size={15} />
                  {t('notifications.delete')}
                </button>
              </div>
            )}
          </div>
        )}

        {(failed || error) && (
          <p role="alert" className="text-caption text-red">
            {failed ? t('notifications.failed') : t('notifications.changeFailed')}
          </p>
        )}
        {!page && !failed && <SkeletonRows rows={4} label={t('common.loading')} className="border-y border-line" />}
        {page && items.length === 0 && (
          <EmptyState title={onlyUnread ? t('notifications.emptyUnread') : t('notifications.empty')} className="border-y border-line">
            {t('notifications.emptyHint')}
          </EmptyState>
        )}
        {items.length > 0 && (
          <ul className="divide-y divide-line border-b border-line" onKeyDown={(event) => listKeys(event, { onDelete: remove })}>
            {items.map((n, i) => (
              <li key={n.id} className="py-1">
                <NotificationItem
                  notification={n}
                  onOpen={open}
                  onToggleRead={(item) => change(item.read ? { unread: [item.id] } : { read: [item.id] }, { reload: onlyUnread })}
                  onDelete={(item) => remove(item.id, items[i + 1]?.id ?? items[i - 1]?.id ?? null)}
                  select={{ checked: selected.has(n.id), onChange: (on) => toggle(n.id, on) }}
                />
              </li>
            ))}
          </ul>
        )}

        {page && page.total > PAGE_SIZE && (
          <nav aria-label={t('notifications.pages')} className="flex items-center justify-between gap-3">
            <button type="button" className="btn-ghost btn-sm" disabled={pageNo <= 1} onClick={() => setParam({ page: pageNo - 1 > 1 ? String(pageNo - 1) : '' })}>
              <Icon name="arrow-left" size={15} />
              {t('notifications.previous')}
            </button>
            <p className="readout text-caption text-dim">{t('notifications.range', { first, last, total: page.total })}</p>
            <button type="button" className="btn-ghost btn-sm" disabled={pageNo >= lastPage} onClick={() => setParam({ page: String(pageNo + 1) })}>
              {t('notifications.next')}
              <Icon name="arrow-right" size={15} />
            </button>
          </nav>
        )}
        <p className="text-caption text-dim">{t('notifications.kept')}</p>
      </div>
    </div>
  )
}
