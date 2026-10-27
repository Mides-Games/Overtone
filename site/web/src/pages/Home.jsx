import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import TimingList from '../components/TimingList.jsx'
import TimingStrip from '../components/TimingStrip.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { recentTimings } from '../lib/timings.js'

const FEATURES = ['upload', 'confidence', 'account']
const ON_HOME = 5

/**
 * The latest timings people published (W5.1), a few of them, with the way to
 * the whole list. Nothing is shown until there is one: an empty box on the
 * front page says nothing useful, and a failed read says nothing at all.
 */
function RecentTimings() {
  const { t } = useTranslation()
  const [timings, setTimings] = useState(null)

  useEffect(() => {
    let alive = true
    recentTimings({}, { limit: ON_HOME })
      .then((data) => alive && setTimings(data.timings))
      .catch(() => alive && setTimings([]))
    return () => {
      alive = false
    }
  }, [])

  if (!timings?.length) return null
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="label">{t('timings.home.title')}</h2>
        <Link to="/recent" className="text-label text-accent hover:underline">
          {t('timings.home.all')} →
        </Link>
      </div>
      <TimingList timings={timings} />
    </section>
  )
}

export default function Home() {
  const { t } = useTranslation()
  const { account } = useAuth()

  return (
    <div className="space-y-16 sm:space-y-20">
      <section className="grid items-center gap-10 lg:grid-cols-[1fr_1.15fr]">
        <div className="rise min-w-0 space-y-6">
          <p className="label text-accent">{t('home.eyebrow')}</p>
          <h1 className="font-display text-display font-bold uppercase tracking-[-0.01em]">{t('home.title')}</h1>
          <p className="max-w-[56ch] text-body text-muted">{t('home.subtitle')}</p>
          <div className="flex flex-wrap gap-3">
            <Link to="/analyze" className="btn-primary px-5">
              {t('home.cta')}
            </Link>
            {account === null && (
              <Link to="/login" className="btn-ghost">
                {t('home.secondary')}
              </Link>
            )}
          </div>
        </div>
        <div className="rise min-w-0" style={{ animationDelay: '80ms' }}>
          <TimingStrip />
        </div>
      </section>

      <section className="grid gap-px overflow-hidden rounded-panel border border-line bg-line md:grid-cols-3">
        {FEATURES.map((key) => (
          <article key={key} className="space-y-2 bg-surface p-6">
            <h2 className="font-display text-[17px] font-semibold">{t(`home.features.${key}.title`)}</h2>
            <p className="text-label leading-relaxed text-muted">{t(`home.features.${key}.body`)}</p>
          </article>
        ))}
      </section>

      <RecentTimings />

      <section className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-5">
        <span className="chip-amber shrink-0">{t('home.checkByEar')}</span>
        <p className="max-w-[72ch] text-label leading-relaxed text-muted">{t('home.honest')}</p>
      </section>
    </div>
  )
}
