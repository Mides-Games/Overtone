import { useTranslation } from 'react-i18next'

import { HISTOGRAM_DIVISORS, suggestDivisor } from '../../lib/mapping.js'
import { formatClock } from '../../lib/timing.js'

/** The bins in the order the bars are drawn: the divisors, then "on none". */
const BINS = [...HISTOGRAM_DIVISORS, 0]
/** Red lines past this many are left to the whole song's bars. */
const MAX_LINES = 12

/**
 * Where the attacks fall (W13.3): for the whole song and under each red line,
 * the share of the attacks (by weight) whose simplest divisor is 1/1, 1/2,
 * 1/3, 1/4, 1/6 or 1/8, or none, with the divisor that would be suggested.
 * `histogram` is lib/mapping.js `divisorHistogram`'s; `lines` the red lines
 * it was built on. A reading of the attacks, not of the timing: the page says
 * so.
 */
export default function DivisorChart({ histogram, lines }) {
  const { t } = useTranslation()
  if (!histogram?.all.attacks) return null
  const several = lines.length > 1
  return (
    <section className="space-y-2 border-t border-line px-4 py-3" aria-labelledby="divisor-chart-title">
      <h3 id="divisor-chart-title" className="label">
        {t('divisors.title')}
      </h3>
      <Bars title={t('divisors.all')} h={histogram.all} />
      {several && (
        <details className="group">
          <summary className="cursor-pointer list-none text-caption text-dim hover:text-text">
            <span aria-hidden className="mr-1 inline-block transition group-open:rotate-90">
              ▸
            </span>
            {t('divisors.perLine')}
          </summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {histogram.lines.slice(0, MAX_LINES).map((h, i) =>
              h.attacks ? <Bars key={i} title={t('divisors.line', { n: i + 1, time: formatClock(lines[i].timeMs) })} h={h} /> : null,
            )}
          </div>
        </details>
      )}
      <p className="text-caption text-dim">{t('divisors.note')}</p>
    </section>
  )
}

function Bars({ title, h }) {
  const { t } = useTranslation()
  const total = BINS.reduce((sum, d) => sum + h.bins[d], 0)
  const suggested = suggestDivisor(h)
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-baseline justify-between gap-2 text-caption text-text">
        <span>{title}</span>
        <span className={suggested ? 'chip-amber px-1.5 py-0' : 'text-dim'}>
          {suggested ? t('divisors.suggested', { divisor: `1/${suggested}` }) : t('divisors.none')}
        </span>
      </p>
      <ul className="space-y-0.5">
        {BINS.map((d) => {
          const pct = total > 0 ? Math.round((h.bins[d] / total) * 100) : 0
          const name = d ? `1/${d}` : t('divisors.other')
          return (
            <li key={d} className="grid grid-cols-[3.5rem_1fr_2.5rem] items-center gap-2 text-caption" aria-label={t('divisors.aria', { divisor: name, pct })}>
              <span className="readout text-dim" aria-hidden>
                {name}
              </span>
              <span className="h-2 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                <span className={`block h-full ${d ? 'bg-accent' : 'bg-line-strong'}`} style={{ width: `${pct}%` }} />
              </span>
              <span className="readout text-right text-dim" aria-hidden>
                {pct}%
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
