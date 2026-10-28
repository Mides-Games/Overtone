import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { RECENT_ON_HOME } from '../../lib/home.js'
import { recentTimings } from '../../lib/timings.js'
import TimingList from '../TimingList.jsx'
import Icon from '../ui/Icon.jsx'
import { SkeletonRows } from '../ui/Skeleton.jsx'
import SectionHead from './SectionHead.jsx'

/**
 * The latest timings people published (W5.1), a few of them, with the way to
 * the whole list. While the request runs, skeleton rows the list's shape hold
 * the place; once it answers with none, or fails, the section is gone: an
 * empty box on the front page says nothing useful, and a failed read says
 * nothing at all. The request starts after the first paint and blocks
 * nothing above it.
 */
export default function RecentTimings({ className = '' }) {
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
    <section aria-labelledby="home-recent" aria-busy={timings === null} className={`space-y-8 ${className}`}>
      <SectionHead id="home-recent" eyebrow={t('home.recent.eyebrow')} title={t('home.recent.title')}>
        <Link to="/recent" className="btn-quiet -mr-2.5">
          {t('timings.home.all')}
          <Icon name="arrow-right" size={16} />
        </Link>
      </SectionHead>
      {timings === null ? (
        <SkeletonRows rows={3} label={t('home.recent.loading')} className="border-y border-line" />
      ) : (
        <TimingList timings={timings} />
      )}
    </section>
  )
}
