import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'

import Avatar from '../components/Avatar.jsx'
import TimingList from '../components/TimingList.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import Skeleton, { SkeletonRows } from '../components/ui/Skeleton.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { getCollection, userPath } from '../lib/social.js'

/**
 * A collection's page (W6, /c/<id>): its name, whose it is, and its
 * published timings, latest added first. A private one opens only for its
 * owner; for anyone else it is the same "not found" as one that never was.
 * A timing its uploader took back drops out of the list until it is back.
 */
export default function CollectionPage() {
  const { t } = useTranslation()
  const { id } = useParams()
  const [page, setPage] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  usePageMeta(page?.collection.name ?? t('social.collections.title'), t('social.collections.description'))

  useEffect(() => {
    let alive = true
    setPage(null)
    setError(null)
    getCollection(id)
      .then((data) => alive && setPage(data))
      .catch((failure) => alive && setError(failure.status === 404 ? 'notFound' : 'network'))
    return () => {
      alive = false
    }
  }, [id])

  async function more() {
    setLoading(true)
    try {
      const next = await getCollection(id, page.next)
      setPage((current) => ({ ...next, timings: [...current.timings, ...next.timings] }))
    } catch {
      setError('network')
    } finally {
      setLoading(false)
    }
  }

  if (error === 'notFound') {
    return (
      <div className="space-y-8">
        <PageHeader title={t('social.collections.notFoundTitle')} lede={t('social.collections.notFound')} />
        <EmptyState
          title={t('social.collections.notFoundTitle')}
          className="border-y border-line"
          action={
            <Link to="/recent" className="btn-ghost">
              {t('timings.page.toRecent')}
              <Icon name="arrow-right" size={16} />
            </Link>
          }
        />
      </div>
    )
  }
  if (!page) {
    return error ? (
      <p role="status" className="text-label text-dim">
        {t('result.reconnecting')}
      </p>
    ) : (
      <div className="space-y-10" role="status" aria-label={t('common.loading')}>
        <div className="space-y-3" aria-hidden="true">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-10 w-2/3 max-w-md" />
          <Skeleton className="h-3 w-48" />
        </div>
        <SkeletonRows rows={4} className="border-y border-line" />
      </div>
    )
  }

  const { collection } = page
  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow={
          <>
            {t('social.collections.eyebrow')}
            <span className="inline-flex items-center gap-1.5 text-dim">
              <Icon name={collection.public ? 'globe' : 'lock'} size={13} />
              {collection.public ? t('social.collections.public') : t('social.collections.private')}
            </span>
          </>
        }
        title={collection.name}
        action={
          collection.mine && (
            <Link to="/profile?tab=collections" className="btn-ghost btn-sm">
              <Icon name="pencil" size={15} />
              {t('social.collections.manage')}
            </Link>
          )
        }
      >
        <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-label text-muted">
          {collection.owner && (
            <Link to={userPath(collection.owner.username)} className="group inline-flex items-center gap-2 font-medium text-text">
              <Avatar account={collection.owner} size={24} decorative />
              <span className="group-hover:text-accent group-hover:underline">@{collection.owner.username}</span>
            </Link>
          )}
          <span className="readout">{t('social.collections.count', { count: collection.count })}</span>
        </p>
      </PageHeader>
      <section className="space-y-6" aria-label={collection.name}>
        {page.timings.length === 0 ? (
          <EmptyState title={t('social.collections.empty')} className="border-y border-line" />
        ) : (
          <TimingList timings={page.timings} />
        )}
        {page.next && (
          <button type="button" className="btn-ghost mx-auto flex" onClick={more} disabled={loading}>
            {loading ? t('common.loading') : t('timings.more')}
          </button>
        )}
      </section>
    </div>
  )
}
