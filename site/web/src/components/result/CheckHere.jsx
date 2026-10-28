import { useTranslation } from 'react-i18next'

import { DRIFT_P90_MS } from '../../lib/check-spans.js'
import { formatClock } from '../../lib/timing.js'

/** Each reason's tone, as the map and the table draw the same thing. */
const TONES = {
  check: 'border-amber/40 bg-amber/10 text-amber',
  medium: 'border-tempo/40 bg-tempo/10 text-tempo',
  drift: 'border-amber/40 bg-amber/10 text-amber',
  hint: 'border-amber/40 bg-amber/10 text-amber',
  swing: 'border-tempo/40 bg-tempo/10 text-tempo',
}

/**
 * "Check here" (W3.25): the spans worth a listen first, from `checkSpans`,
 * sorted by time. Each one can be shown on the map (the loop band, no audio
 * needed) or played there in a loop with the clicks. An empty list says so,
 * and still says to listen.
 */
export default function CheckHere({ spans, active, canPlay, onShow, onPlay }) {
  const { t } = useTranslation()
  return (
    <section className="panel overflow-hidden" aria-labelledby="check-here">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <h2 id="check-here" className="label text-text">
          {t('check.title')}
          {spans.length > 0 && <span className="readout ml-2 text-dim">{spans.length}</span>}
        </h2>
        <p className="text-caption text-dim">{spans.length ? t('check.note') : ''}</p>
      </div>
      {spans.length === 0 ? (
        <p className="px-4 py-3 text-label text-muted">{t('check.empty')}</p>
      ) : (
        <ul className="max-h-80 divide-y divide-line overflow-auto">
          {spans.map((span) => (
            <li
              key={span.key}
              // A phone puts the time and the buttons on one row and the reasons under them.
              className={`grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 px-4 py-2 sm:flex ${active === span.key ? 'bg-accent/10' : ''}`}
            >
              <span className="readout text-label text-text sm:min-w-[11.5rem]">
                {formatClock(span.startMs)} – {formatClock(span.endMs)}
              </span>
              <span className="order-last col-span-2 flex min-w-0 flex-1 flex-wrap items-center gap-1.5 sm:order-none">
                {span.reasons.map((reason) => (
                  <span key={reason} className={`chip ${TONES[reason]}`} title={t(`check.why.${reason}`, { ms: DRIFT_P90_MS })}>
                    {t(`check.reason.${reason}`)}
                  </span>
                ))}
                <span className="text-caption text-dim">{detail(t, span)}</span>
              </span>
              <span className="flex shrink-0 gap-1">
                <button type="button" className="tool-btn px-2.5" aria-pressed={active === span.key} onClick={() => onShow(span)}>
                  {t('check.show')}
                </button>
                <button type="button" className="tool-btn px-2" disabled={!canPlay} onClick={() => onPlay(span)} title={t('check.play')}>
                  ⟲<span className="sr-only">{t('check.play')}</span>
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-line px-4 py-2 text-caption text-dim">{canPlay ? t('check.how') : t('check.needsAudio')}</p>
    </section>
  )
}

/** One short line on what the span is: which red lines, how far the attacks drift, which way a hint goes. */
function detail(t, span) {
  const parts = []
  if (span.sections) {
    const [a, b] = span.sections
    parts.push(a === b ? t('check.line', { n: a + 1 }) : t('check.lines', { from: a + 1, to: b + 1 }))
  }
  if (span.reasons.includes('drift') && typeof span.driftP90Ms === 'number') parts.push(t('check.drift', { ms: span.driftP90Ms.toFixed(1) }))
  if (span.reasons.includes('hint')) parts.push(t('check.pulse'))
  if (span.feel === 'triplets') parts.push(t('check.triplets'))
  return parts.join(' · ')
}
