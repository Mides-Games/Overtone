import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { RECENT_ON_HOME } from '../../lib/home.js'
import { recentTimings } from '../../lib/timings.js'
import TimingList from '../TimingList.jsx'
import SectionHead from './SectionHead.jsx'

/**
 * The latest timings people published (W5.1), a few of them, with the way to
 * the whole list. While the request runs, a few blank rows hold the place;
 * once it answers with none, or fails, the section is gone: an empty box on
 * the front page says nothing useful, and a failed read says nothing at all.
 * The request starts after the first paint and blocks nothing above it.
 */
export default function RecentTimings() {
  const { t } = useTranslation()
  const [timings, setTimings] = useState(null)

  useEffect(() => {
    let alive = true
    recentTimings({}, { limit: RECENT_ON_HOME })
      .then((data) => alive && setTimings(Array.isArray(data?.timings) ? data.timings : []))
      .catch(() => alive && setTimings([]))
    return () => {
      alive = false
    }
  }, [])

  if (timings?.length === 0) return null
  return (
    <section aria-labelledby="home-recent" aria-busy={timings === null} className="space-y-6">
      <SectionHead id="home-recent" eyebrow={t('home.recent.eyebrow')} title={t('home.recent.title')}>
        <Link to="/recent" className="text-label text-accent hover:underline">
          {t('timings.home.all')} →
        </Link>
      </SectionHead>
      {timings === null ? <Placeholder label={t('home.recent.loading')} /> : <TimingList timings={timings} />}
    </section>
  )
}

/** Three rows the shape of TimingList's, so the list does not push the page when it lands. */
function Placeholder({ label }) {
  return (
    <ul className="divide-y divide-line rounded-panel border border-line" role="status" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-3" aria-hidden="true">
          <span className="h-8 w-8 shrink-0 rounded-full bg-surface-3" />
          <span className="flex-1 space-y-2">
            <span className="block h-3 w-2/5 rounded bg-surface-3" />
            <span className="block h-2.5 w-1/4 rounded bg-surface-2" />
          </span>
          <span className="h-3 w-14 rounded bg-surface-3" />
        </li>
      ))}
    </ul>
  )
}
