import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { countLabel, loadStats } from '../../lib/home.js'

/**
 * Analyses done and songs waiting, from `GET /api/v1/stats` (W12.13), read
 * once after the first paint. Nothing is drawn until it answers, and nothing
 * at all when it does not (the route not deployed yet answers 404): the
 * numbers are colour, so their absence is not an error.
 *
 * Set as a meter's readouts, not as cards: a mono figure over its label,
 * separated by hairlines. Each figure links to the page that explains it.
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
    <section aria-label={t('home.live.title')} className="fade-in">
      <dl className="flex flex-wrap gap-x-10 gap-y-4">
        {items.map((item, i) => (
          <div key={item.key} className={`min-w-[9rem] space-y-1 ${i > 0 ? 'sm:border-l sm:border-line sm:pl-10' : ''}`}>
            <dt className="label flex items-center gap-2">
              {item.key === 'queue' && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />}
              {t(`home.live.${item.key}`)}
            </dt>
            <dd className="readout text-heading font-medium text-text">
              <Link to={item.to} className="transition-colors duration-150 hover:text-accent">
                {countLabel(item.value, i18n.language)}
              </Link>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
