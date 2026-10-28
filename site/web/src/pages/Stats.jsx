import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { NextLinks } from '../components/ui/Doc.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { api } from '../lib/api.js'
import { barScale, bucketName, shares } from '../lib/stats.js'

/**
 * The site's public statistics (W12.13), as `GET /api/v1/stats` counts them:
 * aggregates only, recomputed by the API at most once a minute. The page
 * draws, it does not count.
 *
 * The charts are inline SVG drawn at the box's own pixel width (a
 * ResizeObserver), so their words stay at reading size from a phone to a
 * desktop instead of scaling with a viewBox. Each is a picture with a summary
 * for screen readers, and the histogram has its numbers as a table too. One
 * hue each, the theme's own tokens: the accent for the BPMs, and tempo
 * (the site's tempo colour) beside it for the tempo changes, both always
 * labelled in text. Every number is a readout (mono, tabular, slashed zero),
 * in the charts too, so a column of counts lines up.
 *
 * The totals are a meter's row of readouts separated by hairlines, not cards
 * (docs/design.md, section 11); the charts sit on the page's own ground.
 */

/** The width of `ref`'s box, in CSS pixels, kept current. */
function useWidth() {
  const ref = useRef(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

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

const ROW = 28
const LABEL_W = 80
const COUNT_W = 56

function BpmChart({ buckets }) {
  const { t, i18n } = useTranslation()
  const [box, width] = useWidth()
  const counts = buckets.map((b) => b.count)
  const total = counts.reduce((a, b) => a + b, 0)
  const scale = barScale(counts)
  const names = buckets.map((b) => {
    const { key, values } = bucketName(b)
    return t(key, values)
  })
  const number = (n) => n.toLocaleString(i18n.language)
  const plot = Math.max(0, width - LABEL_W - COUNT_W)
  const height = buckets.length * ROW
  // Quarter lines under the bars, so a length reads against something.
  const ticks = [0.25, 0.5, 0.75, 1]

  return (
    <div className="space-y-4">
      <div ref={box}>
        {total === 0 ? (
          <p className="text-label text-dim">{t('siteStats.bpm.empty')}</p>
        ) : (
          width > 0 && (
            <svg width={width} height={height} role="img" aria-label={t('siteStats.bpm.label', { count: total })} className="block">
              {ticks.map((f) => (
                <line key={f} x1={LABEL_W + f * plot} x2={LABEL_W + f * plot} y1="0" y2={height} className="stroke-line" strokeWidth="1" strokeDasharray="2 4" />
              ))}
              <line x1={LABEL_W} x2={LABEL_W} y1="0" y2={height} className="stroke-line-strong" strokeWidth="1" />
              {buckets.map((b, i) => {
                const y = i * ROW
                const w = scale[i] * plot
                return (
                  <g key={names[i]}>
                    <title>{`${names[i]} BPM: ${number(b.count)}`}</title>
                    {/* A row-high hit target, wider than the bar. */}
                    <rect x="0" y={y} width={width} height={ROW} className="fill-transparent" />
                    <text x={LABEL_W - 10} y={y + ROW / 2} dy="0.35em" textAnchor="end" className="readout fill-muted text-[12px]">
                      {names[i]}
                    </text>
                    {b.count > 0 && <rect x={LABEL_W} y={y + 6} width={Math.max(2, w)} height={ROW - 12} rx="2" className="fill-accent" />}
                    <text x={LABEL_W + Math.max(2, w) + 8} y={y + ROW / 2} dy="0.35em" className={`readout text-[12px] ${b.count ? 'fill-text' : 'fill-dim'}`}>
                      {number(b.count)}
                    </text>
                  </g>
                )
              })}
            </svg>
          )
        )}
      </div>
      {total > 0 && (
        <details className="group text-label">
          <summary className="btn-quiet btn-sm -ml-2.5 w-fit cursor-pointer list-none [&::-webkit-details-marker]:hidden">{t('siteStats.bpm.table')}</summary>
          <table className="mt-3 w-full max-w-sm border-collapse text-left">
            <caption className="sr-only">{t('siteStats.bpm.title')}</caption>
            <thead>
              <tr>
                <th scope="col" className="label border-b border-line py-2 pr-4 font-medium">
                  {t('siteStats.bpm.axis')}
                </th>
                <th scope="col" className="label border-b border-line py-2 text-right font-medium">
                  {t('siteStats.bpm.count')}
                </th>
              </tr>
            </thead>
            <tbody className="readout divide-y divide-line">
              {buckets.map((b, i) => (
                <tr key={names[i]}>
                  <th scope="row" className="py-1.5 pr-4 font-normal text-muted">
                    {names[i]}
                  </th>
                  <td className="py-1.5 text-right text-text">{number(b.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  )
}

function TempoChart({ single, variable }) {
  const { t, i18n } = useTranslation()
  const [box, width] = useWidth()
  const total = single + variable
  const [pSingle, pVariable] = shares([single, variable])
  const gap = single && variable ? 2 : 0
  const a = total ? ((width - gap) * single) / total : 0
  const number = (n) => n.toLocaleString(i18n.language)
  const parts = [
    { key: 'single', count: single, pct: pSingle, tone: 'bg-accent' },
    { key: 'variable', count: variable, pct: pVariable, tone: 'bg-tempo' },
  ]

  return (
    <div className="space-y-4">
      <div ref={box}>
        {total === 0 ? (
          <p className="text-label text-dim">{t('siteStats.bpm.empty')}</p>
        ) : (
          width > 0 && (
            <svg width={width} height="16" role="img" aria-label={t('siteStats.tempo.label', { single, variable })} className="block">
              {single > 0 && (
                <rect x="0" y="0" width={a} height="16" rx="2" className="fill-accent">
                  <title>{`${t('siteStats.tempo.single')}: ${number(single)} (${pSingle} %)`}</title>
                </rect>
              )}
              {variable > 0 && (
                <rect x={a + gap} y="0" width={width - a - gap} height="16" rx="2" className="fill-tempo">
                  <title>{`${t('siteStats.tempo.variable')}: ${number(variable)} (${pVariable} %)`}</title>
                </rect>
              )}
            </svg>
          )
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-6">
        {parts.map((p) => (
          <div key={p.key} className="min-w-0 space-y-1.5">
            <dt className="flex items-center gap-2 text-label text-muted">
              <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] ${p.tone}`} />
              {t(`siteStats.tempo.${p.key}`)}
            </dt>
            <dd className="readout flex items-baseline gap-2">
              <span className="text-title text-text">{number(p.count)}</span>
              <span className="text-label text-dim">{total ? `${p.pct} %` : ''}</span>
            </dd>
          </div>
        ))}
      </dl>
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
