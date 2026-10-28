import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { barScale, bucketName, shares } from '../lib/stats.js'

/**
 * The BPM histogram and the tempo split (W12.13), drawn for /stats and, from
 * a person's published timings, for their profile (2026-10-28): the same
 * buckets, so the two read alike.
 *
 * Inline SVG drawn at the box's own pixel width (a ResizeObserver), so their
 * words stay at reading size from a phone to a desktop instead of scaling
 * with a viewBox. Each is a picture with a summary for screen readers, and
 * the histogram has its numbers as a table too. One hue each, the theme's
 * own tokens: the accent for the BPMs, and tempo beside it for the tempo
 * changes, both always labelled in text.
 */

/** The width of `ref`'s box, in CSS pixels, kept current. */
export function useWidth() {
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

const ROW = 28
const LABEL_W = 80
const COUNT_W = 56

export function BpmChart({ buckets }) {
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

export function TempoChart({ single, variable }) {
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
