import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BpmChart, TempoChart } from '../components/StatsCharts.jsx'
import { NextLinks } from '../components/ui/Doc.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { api } from '../lib/api.js'

/**
 * The site's public statistics (W12.13), as `GET /api/v1/stats` counts them:
 * aggregates only, recomputed by the API at most once a minute. The page
 * draws, it does not count.
 *
 * The charts (components/StatsCharts.jsx, shared with the profile) are
 * inline SVG at the box's own width. Every number is a readout (mono,
 * tabular, slashed zero), in the charts too, so a column of counts lines up.
 *
 * The totals are a meter's row of readouts separated by hairlines, not cards
 * (docs/design.md, section 11); the charts sit on the page's own ground.
 */

/** One readout: the label over the figure, a hairline on its left from the second on. */
function Readout({ label, value, unit }) {
  return (
    <div className="flex min-w-0 flex-col justify-between gap-1.5 border-t border-line py-4 pr-4">
      <dt className="label break-words">{label}</dt>
      <dd className="readout text-heading font-medium leading-none text-text">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </dd>
    </div>
  )
}

/** One block of the page: a mono label for its heading, then its content and a note. */
function Block({ id, title, children, note, className = '' }) {
  return (
    <section aria-labelledby={id} className={`min-w-0 space-y-5 border-t border-line pt-6 ${className}`}>
      <h2 id={id} className="heading-title">
        {title}
      </h2>
      {children}
      {note && <p className="max-w-[60ch] text-caption leading-relaxed text-dim">{note}</p>}
    </section>
  )
}

/** The page's shape while the first answer is on its way: the readout row and two charts. */
function Loading() {
  const { t } = useTranslation()
  return (
    <div role="status" aria-label={t('siteStats.loading')} className="space-y-12">
      <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-3 lg:grid-cols-6" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-2.5 border-t border-line py-4">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-6 w-20" />
          </div>
        ))}
      </div>
      <div className="space-y-3" aria-hidden="true">
        {['w-3/5', 'w-4/5', 'w-full', 'w-2/3', 'w-2/5', 'w-1/5'].map((w) => (
          <Skeleton key={w} className={`h-3 ${w}`} />
        ))}
      </div>
    </div>
  )
}

export default function Stats() {
  const { t, i18n } = useTranslation()
  usePageMeta(t('siteStats.title'), t('siteStats.description'))
  // undefined while asking, null after a failure.
  const [stats, setStats] = useState(undefined)

  const load = useCallback(() => {
    setStats(undefined)
    api('/stats')
      .then(setStats)
      .catch(() => setStats(null))
  }, [])

  useEffect(load, [load])

  const number = (n) => n.toLocaleString(i18n.language)
  const seconds = (s) => t('siteStats.time.seconds', { value: s.toLocaleString(i18n.language, { maximumFractionDigits: 1 }) })

  return (
    <div className="rise space-y-12">
      <header className="max-w-[70ch] space-y-4">
        <p className="eyebrow">{t('learn.footer.title')}</p>
        <h1 className="heading-headline">{t('siteStats.title')}</h1>
        <p className="lede">{t('siteStats.intro')}</p>
      </header>

      {stats === undefined ? (
        <Loading />
      ) : stats === null ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-6">
          <p role="alert" className="text-label text-red">
            {t('siteStats.error')}
          </p>
          <button type="button" className="btn-ghost btn-sm" onClick={load}>
            {t('siteStats.retry')}
          </button>
        </div>
      ) : (
        <>
          <section aria-labelledby="stats-totals" className="space-y-4">
            <h2 id="stats-totals" className="heading-title">
              {t('siteStats.totals.title')}
            </h2>
            <dl className="grid grid-cols-2 gap-x-6 sm:grid-cols-3 lg:grid-cols-6">
              {['done', 'songs', 'published', 'refused', 'failed', 'cached'].map((key) => (
                <Readout key={key} label={t(`siteStats.totals.${key}`)} value={number(stats.totals[key])} />
              ))}
            </dl>
            <p className="max-w-[70ch] text-caption leading-relaxed text-dim">{t('siteStats.totals.note')}</p>
          </section>

          <div className="grid gap-x-12 gap-y-12 lg:grid-cols-12">
            <Block id="stats-bpm" title={t('siteStats.bpm.title')} className="lg:col-span-7">
              <BpmChart buckets={stats.bpm.buckets} />
            </Block>

            <div className="space-y-12 lg:col-span-5">
              <Block id="stats-tempo" title={t('siteStats.tempo.title')} note={t('siteStats.tempo.note')}>
                <TempoChart single={stats.tempo.single} variable={stats.tempo.variable} />
              </Block>

              <Block
                id="stats-time"
                title={t('siteStats.time.title')}
                note={
                  stats.analysisTime.medianS === null
                    ? t('siteStats.time.notEnough', { min: stats.analysisTime.minCount, days: stats.analysisTime.days })
                    : t('siteStats.time.note', { count: stats.analysisTime.count, days: stats.analysisTime.days })
                }
              >
                <dl className="grid grid-cols-2 gap-x-6">
                  <Readout label={t('siteStats.time.median')} value={stats.analysisTime.medianS === null ? '–' : seconds(stats.analysisTime.medianS)} />
                  <Readout label={t('siteStats.time.p90')} value={stats.analysisTime.p90S === null ? '–' : seconds(stats.analysisTime.p90S)} />
                </dl>
              </Block>

              <Block id="stats-queue" title={t('siteStats.queue.title')}>
                <dl className="grid grid-cols-2 gap-x-6">
                  <Readout label={t('siteStats.queue.queued')} value={number(stats.queue.queued)} />
                  <Readout label={t('siteStats.queue.running')} value={number(stats.queue.running)} />
                </dl>
                <NextLinks links={[{ to: '/queue', label: t('siteStats.queue.link') }]} />
              </Block>
            </div>
          </div>

          <p className="readout border-t border-line pt-4 text-caption text-dim">
            {t('siteStats.updated', { time: new Date(stats.generatedAt).toLocaleTimeString(i18n.language, { timeStyle: 'short' }) })}
          </p>
        </>
      )}
    </div>
  )
}
