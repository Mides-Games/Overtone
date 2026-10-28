import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { countLabel, loadStats } from '../../lib/home.js'

/**
 * Analyses done and songs waiting, from `GET /api/v1/stats` (W12.13), read
 * once after the first paint. Nothing is drawn until it answers, and nothing
 * at all when it does not (the route not deployed yet answers 404): the
 * numbers are colour, so their absence is not an error.
 */
export default function LiveNumbers() {
  const { t, i18n } = useTranslation()
  const [stats, setStats] = useState(null)

  useEffect(() => {
    let alive = true
    loadStats().then((value) => alive && setStats(value))
    return () => {
      alive = false
    }
  }, [])

  // "0 analyses done" on a new site says the wrong thing: the block waits for the first one.
  if (!stats?.analyses) return null
  const items = [
    { key: 'analyses', value: stats.analyses, to: '/stats' },
    stats.queue !== null && { key: 'queue', value: stats.queue, to: '/queue' },
  ].filter(Boolean)

  return (
    <section aria-label={t('home.live.title')} className="rise flex flex-wrap items-stretch gap-px overflow-hidden rounded-panel border border-line bg-line">
      {items.map((item) => (
        <div key={item.key} className="min-w-[10rem] flex-1 bg-surface px-4 py-3">
          <p className="label flex items-center gap-1.5">
            {item.key === 'queue' && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />}
            {t(`home.live.${item.key}`)}
          </p>
          <p className="readout text-title text-text">
            {item.to ? (
              <Link to={item.to} className="hover:text-accent">
                {countLabel(item.value, i18n.language)}
              </Link>
            ) : (
              countLabel(item.value, i18n.language)
            )}
          </p>
        </div>
      ))}
    </section>
  )
}
