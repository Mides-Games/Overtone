import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'

import Avatar from '../components/Avatar.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import Icon from '../components/ui/Icon.jsx'
import PageHeader from '../components/ui/PageHeader.jsx'
import Reveal from '../components/ui/Reveal.jsx'
import { SkeletonRows } from '../components/ui/Skeleton.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { ratingLabel, timers, userPath } from '../lib/social.js'

/**
 * The ranking of timers (W6): by how many times other people used their
 * published timings, or by the stars those timings received. Each order has
 * a minimum to enter, and the page says what it is: with few people on the
 * site, a short honest list beats a long one padded with single votes.
 * Private profiles are left out by the API.
 */
const ORDERS = ['uses', 'stars']

export default function Timers() {
  const { t } = useTranslation()
  usePageMeta(t('social.timers.title'), t('social.timers.subtitle'))
  const [params, setParams] = useSearchParams()
  const by = params.get('by') === 'stars' ? 'stars' : 'uses'
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setData(null)
    setFailed(false)
    timers(by)
      .then((next) => alive && setData(next))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [by])

  return (
    <div className="space-y-10">
      <PageHeader title={t('social.timers.title')} lede={t('social.timers.subtitle')} />

      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label={t('social.sort.label')} className="flex flex-wrap gap-1.5">
            {ORDERS.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={by === key}
                onClick={() => setParams(key === 'uses' ? {} : { by: key }, { replace: true })}
                className="tool-btn px-3 font-sans"
              >
                {t(`social.timers.by.${key}`)}
              </button>
            ))}
          </div>
          {data && (
            <p className="text-caption text-dim">
              {by === 'stars' ? t('social.timers.minStars', { count: data.min.ratings }) : t('social.timers.minUses', { count: data.min.uses })}
            </p>
          )}
        </div>

        {failed ? (
          <p role="alert" className="text-label text-red">
            {t('social.failed')}
          </p>
        ) : !data ? (
          <SkeletonRows rows={5} label={t('common.loading')} className="border-y border-line" />
        ) : (
          <section className="space-y-4" aria-label={t('social.timers.title')}>
            {data.timers.length === 0 ? (
              <EmptyState title={t('social.timers.empty')} className="border-y border-line" />
            ) : (
              <Reveal as="ol" className="divide-y divide-line border-y border-line">
                {data.timers.map((row, i) => (
                  <li key={row.user.username} data-reveal style={{ '--i': i }}>
                    <Link
                      to={userPath(row.user.username)}
                      className="group -mx-3 flex items-center gap-4 rounded-control px-3 py-3.5 transition-colors duration-150 ease-out hover:bg-surface-2"
                    >
                      <span className={`readout w-8 shrink-0 text-right text-title font-semibold ${i < 3 ? 'text-accent' : 'text-dim'}`}>{i + 1}</span>
                      <Avatar account={row.user} size={40} decorative />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-body font-semibold text-text group-hover:text-accent">{row.user.displayName || row.user.username}</p>
                        <p className="readout truncate text-caption text-dim">
                          @{row.user.username} · {t('social.timers.published', { count: row.published })}
                        </p>
                      </div>
                      <div className="shrink-0 space-y-0.5 text-right">
                        <p className="readout flex items-center justify-end gap-1.5 text-title font-semibold text-text">
                          {by === 'stars' ? (
                            <>
                              <Icon name="star-filled" size={16} strokeWidth={1} className="text-amber" />
                              {ratingLabel(row.rating.average)}
                            </>
                          ) : (
                            t('social.uses.short', { count: row.uses })
                          )}
                        </p>
                        <p className="readout flex items-center justify-end gap-1 text-caption text-dim">
                          {by === 'stars' ? (
                            t('social.stars.count', { count: row.rating.count })
                          ) : (
                            <>
                              <Icon name="star" size={12} />
                              {ratingLabel(row.rating.average)}
                            </>
                          )}
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </Reveal>
            )}
            <p className="max-w-[72ch] text-caption text-dim">{t('social.timers.howOrdered')}</p>
          </section>
        )}
      </div>
    </div>
  )
}
