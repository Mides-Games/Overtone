import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import BrandLoader from '../components/BrandLoader.jsx'
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
 * hue each, the theme's own tokens: the accent for the BPMs, and lavender
 * (the site's tempo colour) beside it for the tempo changes, both always
 * labelled in text.
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

function Tile({ label, value, note }) {
  return (
    <div className="space-y-1 bg-surface px-4 py-3">
      <dt className="label">{label}</dt>
      <dd className="readout text-title text-text">{value}</dd>
      {note && <dd className="text-caption text-dim">{note}</dd>}
    </div>
  )
}

const ROW = 26
const LABEL_W = 76
const COUNT_W = 48

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

  return (
    <div className="space-y-3">
      <div ref={box}>
        {total === 0 ? (
          <p className="text-label text-dim">{t('siteStats.bpm.empty')}</p>
        ) : (
          width > 0 && (
            <svg width={width} height={height} role="img" aria-label={t('siteStats.bpm.label', { count: total })} className="block">
              {buckets.map((b, i) => {
                const y = i * ROW
                const w = scale[i] * plot
                return (
                  <g key={names[i]}>
                    <title>{`${names[i]} BPM: ${number(b.count)}`}</title>
                    {/* A row-high hit target, wider than the bar. */}
                    <rect x="0" y={y} width={width} height={ROW} className="fill-transparent" />
                    <text x={LABEL_W - 10} y={y + ROW / 2} dy="0.35em" textAnchor="end" className="fill-muted font-mono text-[12px]">
                      {names[i]}
                    </text>
                    <line x1={LABEL_W} x2={LABEL_W} y1={y + 2} y2={y + ROW - 2} className="stroke-line-strong" strokeWidth="1" />
                    {b.count > 0 && <rect x={LABEL_W} y={y + 5} width={Math.max(2, w)} height={ROW - 10} rx="3" className="fill-accent" />}
                    <text x={LABEL_W + Math.max(2, w) + 6} y={y + ROW / 2} dy="0.35em" className="fill-text font-mono text-[12px]">
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
        <details className="text-label">
          <summary className="cursor-pointer text-accent hover:underline">{t('siteStats.bpm.table')}</summary>
          <table className="mt-2 w-full max-w-sm text-left">
            <thead>
              <tr className="label">
                <th scope="col" className="py-1 pr-4 font-semibold">{t('siteStats.bpm.axis')}</th>
                <th scope="col" className="py-1 text-right font-semibold">{t('siteStats.bpm.count')}</th>
              </tr>
            </thead>
            <tbody className="readout divide-y divide-line">
              {buckets.map((b, i) => (
                <tr key={names[i]}>
                  <th scope="row" className="py-1 pr-4 font-normal">{names[i]}</th>
                  <td className="py-1 text-right">{number(b.count)}</td>
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
    { key: 'variable', count: variable, pct: pVariable, tone: 'bg-lavender' },
  ]

  return (
    <div className="space-y-3">
      <div ref={box}>
        {total === 0 ? (
          <p className="text-label text-dim">{t('siteStats.bpm.empty')}</p>
        ) : (
          width > 0 && (
            <svg width={width} height="20" role="img" aria-label={t('siteStats.tempo.label', { single, variable })} className="block">
              {single > 0 && (
                <rect x="0" y="0" width={a} height="20" rx="3" className="fill-accent">
                  <title>{`${t('siteStats.tempo.single')}: ${number(single)} (${pSingle} %)`}</title>
                </rect>
              )}
              {variable > 0 && (
                <rect x={a + gap} y="0" width={width - a - gap} height="20" rx="3" className="fill-lavender">
                  <title>{`${t('siteStats.tempo.variable')}: ${number(variable)} (${pVariable} %)`}</title>
                </rect>
              )}
            </svg>
          )
        )}
      </div>
      <ul className="flex flex-wrap gap-x-6 gap-y-1 text-label text-muted">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-2">
            <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm ${p.tone}`} />
            {t(`siteStats.tempo.${p.key}`)}
            <span className="readout text-text">{number(p.count)}</span>
            <span className="readout text-dim">{total ? `${p.pct} %` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Panel({ title, children, note }) {
  return (
    <section className="space-y-3">
      <h2 className="label">{title}</h2>
      {children}
      {note && <p className="text-caption leading-relaxed text-dim">{note}</p>}
    </section>
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
    <div className="rise mx-auto max-w-[72ch] space-y-8">
      <header className="space-y-3">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('siteStats.title')}</h1>
        <p className="leading-relaxed text-muted">{t('siteStats.intro')}</p>
      </header>

      {stats === undefined ? (
        <BrandLoader className="py-16" />
      ) : stats === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-label text-red">{t('siteStats.error')}</p>
          <button type="button" className="btn-ghost h-9" onClick={load}>
            {t('siteStats.retry')}
          </button>
        </div>
      ) : (
        <>
          <Panel title={t('siteStats.totals.title')} note={t('siteStats.totals.note')}>
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line sm:grid-cols-3">
              {['done', 'songs', 'published', 'refused', 'failed', 'cached'].map((key) => (
                <Tile key={key} label={t(`siteStats.totals.${key}`)} value={number(stats.totals[key])} />
              ))}
            </dl>
          </Panel>

          <Panel title={t('siteStats.bpm.title')}>
            <BpmChart buckets={stats.bpm.buckets} />
          </Panel>

          <Panel title={t('siteStats.tempo.title')} note={t('siteStats.tempo.note')}>
            <TempoChart single={stats.tempo.single} variable={stats.tempo.variable} />
          </Panel>

          <Panel
            title={t('siteStats.time.title')}
            note={
              stats.analysisTime.medianS === null
                ? t('siteStats.time.notEnough', { min: stats.analysisTime.minCount, days: stats.analysisTime.days })
                : t('siteStats.time.note', { count: stats.analysisTime.count, days: stats.analysisTime.days })
            }
          >
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line">
              <Tile label={t('siteStats.time.median')} value={stats.analysisTime.medianS === null ? '–' : seconds(stats.analysisTime.medianS)} />
              <Tile label={t('siteStats.time.p90')} value={stats.analysisTime.p90S === null ? '–' : seconds(stats.analysisTime.p90S)} />
            </dl>
          </Panel>

          <Panel title={t('siteStats.queue.title')}>
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line">
              <Tile label={t('siteStats.queue.queued')} value={number(stats.queue.queued)} />
              <Tile label={t('siteStats.queue.running')} value={number(stats.queue.running)} />
            </dl>
            <p className="text-label">
              <Link to="/queue" className="text-accent hover:underline">
                {t('siteStats.queue.link')} →
              </Link>
            </p>
          </Panel>

          <p className="readout text-caption text-dim">
            {t('siteStats.updated', { time: new Date(stats.generatedAt).toLocaleTimeString(i18n.language, { timeStyle: 'short' }) })}
          </p>
        </>
      )}
    </div>
  )
}
