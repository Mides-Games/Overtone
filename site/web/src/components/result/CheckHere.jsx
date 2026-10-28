import { useTranslation } from 'react-i18next'

import { DRIFT_P90_MS } from '../../lib/check-spans.js'
import { formatClock } from '../../lib/timing.js'
import EmptyState from '../ui/EmptyState.jsx'
import Icon from '../ui/Icon.jsx'

/** Each reason's tone, as the map and the table draw the same thing. */
const TONES = {
  check: 'chip-amber',
  medium: 'chip-tempo',
  drift: 'chip-amber',
  hint: 'chip-amber',
  swing: 'chip-tempo',
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
    <section className="space-y-3" aria-labelledby="check-here">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="check-here" className="heading-title">
          {t('check.title')}
          {spans.length > 0 && <span className="readout ml-2 text-label font-normal text-dim">{spans.length}</span>}
        </h3>
        <p className="text-caption text-dim">{spans.length ? t('check.note') : ''}</p>
      </div>
      {spans.length === 0 ? (
        <EmptyState title={t('check.empty')} className="border-y border-line py-6" />
      ) : (
        <ul className="max-h-80 divide-y divide-line overflow-auto border-y border-line">
          {spans.map((span) => (
            <li
              key={span.key}
              // A phone puts the time and the buttons on one row and the reasons under them.
              className={`grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 px-2 py-2 transition-colors duration-150 ease-out sm:flex ${active === span.key ? 'bg-accent/10' : ''}`}
            >
              <span className="readout text-label text-text sm:min-w-[11.5rem]">
                {formatClock(span.startMs)} – {formatClock(span.endMs)}
              </span>
              <span className="order-last col-span-2 flex min-w-0 flex-1 flex-wrap items-center gap-1.5 sm:order-none">
                {span.reasons.map((reason) => (
                  <span key={reason} className={TONES[reason]} title={t(`check.why.${reason}`, { ms: DRIFT_P90_MS })}>
                    {t(`check.reason.${reason}`)}
                  </span>
                ))}
                <span className="text-caption text-dim">{detail(t, span)}</span>
              </span>
              <span className="flex shrink-0 gap-1">
                <button type="button" className="tool-btn px-2.5" aria-pressed={active === span.key} onClick={() => onShow(span)}>
                  {t('check.show')}
                </button>
                <button type="button" className="tool-btn" disabled={!canPlay} onClick={() => onPlay(span)} title={t('check.play')} aria-label={t('check.play')}>
                  <Icon name="loop" size={15} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-caption text-dim">{canPlay ? t('check.how') : t('check.needsAudio')}</p>
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
