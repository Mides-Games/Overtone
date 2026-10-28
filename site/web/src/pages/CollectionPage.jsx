import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
import TimingList from '../components/TimingList.jsx'
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
      <div className="panel space-y-3 p-6">
        <h1 className="font-display text-title font-bold uppercase">{t('social.collections.notFoundTitle')}</h1>
        <p className="text-label text-muted">{t('social.collections.notFound')}</p>
        <Link to="/recent" className="btn-ghost">
          {t('timings.page.toRecent')}
        </Link>
      </div>
    )
  }
  if (!page) return error ? <p className="text-label text-dim">{t('result.reconnecting')}</p> : <BrandLoader className="py-16" />

  const { collection } = page
  return (
    <div className="space-y-8">
      <header className="rise space-y-2">
        <p className="label text-accent">
          {t('social.collections.eyebrow')} · {collection.public ? t('social.collections.public') : t('social.collections.private')}
        </p>
        <h1 className="font-display text-[clamp(1.5rem,1.2rem+1.2vw,2.1rem)] font-bold break-words">{collection.name}</h1>
        <p className="text-caption text-dim">
          {collection.owner && (
            <>
              <Link to={userPath(collection.owner.username)} className="text-accent hover:underline">
                @{collection.owner.username}
              </Link>{' '}
              ·{' '}
            </>
          )}
          {t('social.collections.count', { count: collection.count })}
          {collection.mine && (
            <>
              {' '}
              ·{' '}
              <Link to="/profile?tab=collections" className="text-accent hover:underline">
                {t('social.collections.manage')}
              </Link>
            </>
          )}
        </p>
      </header>
      {page.timings.length === 0 ? (
        <p className="rounded-panel border border-line px-4 py-8 text-center text-label text-dim">{t('social.collections.empty')}</p>
      ) : (
        <TimingList timings={page.timings} />
      )}
      {page.next && (
        <button type="button" className="btn-ghost w-full" onClick={more} disabled={loading}>
          {loading ? t('common.loading') : t('timings.more')}
        </button>
      )}
    </div>
  )
}
