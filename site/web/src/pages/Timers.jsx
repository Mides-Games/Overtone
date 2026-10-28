import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'

import Avatar from '../components/Avatar.jsx'
import BrandLoader from '../components/BrandLoader.jsx'
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
    <div className="space-y-8">
      <header className="rise space-y-2">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('social.timers.title')}</h1>
        <p className="max-w-[60ch] text-muted">{t('social.timers.subtitle')}</p>
      </header>

      <div role="group" aria-label={t('social.sort.label')} className="flex flex-wrap gap-1">
        {ORDERS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={by === key}
            onClick={() => setParams(key === 'uses' ? {} : { by: key }, { replace: true })}
            className="tool-btn px-3 font-display text-caption font-semibold uppercase"
          >
            {t(`social.timers.by.${key}`)}
          </button>
        ))}
      </div>

      {failed ? (
        <p className="text-label text-red">{t('social.failed')}</p>
      ) : !data ? (
        <BrandLoader className="py-16" />
      ) : (
        <section className="space-y-3">
          <p className="text-caption text-dim">
            {by === 'stars' ? t('social.timers.minStars', { count: data.min.ratings }) : t('social.timers.minUses', { count: data.min.uses })}
          </p>
          {data.timers.length === 0 ? (
            <p className="rounded-panel border border-line px-4 py-8 text-center text-label text-dim">{t('social.timers.empty')}</p>
          ) : (
            <ol className="divide-y divide-line rounded-panel border border-line">
              {data.timers.map((row, i) => (
                <li key={row.user.username}>
                  <Link to={userPath(row.user.username)} className="flex items-center gap-3 px-4 py-3 transition hover:bg-surface-2">
                    <span className="readout w-7 shrink-0 text-right text-label text-dim">{i + 1}</span>
                    <Avatar account={row.user} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-label font-semibold text-text">{row.user.displayName || row.user.username}</p>
                      <p className="readout truncate text-caption text-dim">
                        @{row.user.username} · {t('social.timers.published', { count: row.published })}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="readout text-label text-text">
                        {by === 'stars' ? (
                          <>
                            <span className="text-amber">★</span> {ratingLabel(row.rating.average)}
                          </>
                        ) : (
                          t('social.uses.short', { count: row.uses })
                        )}
                      </p>
                      <p className="readout text-caption text-dim">
                        {by === 'stars' ? t('social.stars.count', { count: row.rating.count }) : `★ ${ratingLabel(row.rating.average)}`}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
          )}
          <p className="text-caption text-dim">{t('social.timers.howOrdered')}</p>
        </section>
      )}
    </div>
  )
}
