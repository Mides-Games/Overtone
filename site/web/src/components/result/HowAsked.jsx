import { useTranslation } from 'react-i18next'

import { formatTime } from '../../lib/analysis-options.js'

/**
 * How this analysis was asked for (W11.1, W3.21, W12.19), and what the
 * result says about each hint: the mode it ran in, the hints, the stretch it
 * covered, and the checks the worker made of every hint against the audio
 * (`hint_checks`). A hint the audio contradicts is an amber line here, never
 * a quiet change in the timing.
 *
 * Shown on every result: even with nothing chosen it says the mode, since
 * the same song in another mode is another result.
 */
export default function HowAsked({ analysis }) {
  const { t } = useTranslation()
  const result = analysis.result ?? {}
  const mode = result.mode ?? analysis.mode ?? 'normal'
  const options = result.options ?? analysis.options ?? {}
  const checks = result.hint_checks ?? []
  const stretch = result.stretch ?? null
  const hints = hintList(t, options)

  return (
    <section className="panel space-y-3 p-4" aria-labelledby="how-asked">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="how-asked" className="label">{t('modes.result.title')}</h2>
        <span className="chip-accent">{t(`modes.names.${mode}`)}</span>
      </div>
      <p className="text-caption text-muted">
        {t(`modes.about.${mode}`)} {result.beat_vote === false && mode !== 'fast' ? t('modes.result.noVote') : ''}
      </p>
      {stretch && (
        <p className="rounded-control border border-amber/40 bg-amber/10 px-3 py-2 text-label text-text">
          {t('modes.result.stretch', { from: formatTime(stretch.start_ms / 1000), to: formatTime(stretch.end_ms / 1000) })}
        </p>
      )}
      {hints.length > 0 && (
        <p className="text-caption text-dim">
          {t('modes.result.hints')} {hints.join(' · ')}
        </p>
      )}
      {checks.length > 0 && (
        <ul className="space-y-1.5">
          {checks.map((check) => (
            <li
              key={check.key}
              className={`rounded-control border px-3 py-2 text-caption ${
                check.level === 'warn' ? 'border-amber/40 bg-amber/10 text-text' : 'border-line bg-surface-2 text-muted'
              }`}
            >
              {checkText(t, check)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The hints as short phrases, in the reader's language. */
export function hintList(t, options) {
  const out = []
  if (options.tempo) out.push(t(`modes.options.${options.tempo}`))
  if (options.bpm) out.push(t('modes.result.aboutBpm', { bpm: options.bpm }))
  if (options.bpm_min) out.push(t('modes.result.rangeBpm', { low: options.bpm_min, high: options.bpm_max }))
  if (options.meter) out.push(t('modes.options.beats', { count: options.meter }))
  if (Number.isFinite(options.start_s)) {
    out.push(t('modes.result.stretchShort', { from: formatTime(options.start_s), to: formatTime(options.end_s) }))
  }
  return out
}

/** One check as a sentence; an unknown key (a newer worker's) as its plain key. */
function checkText(t, { key, values = {} }) {
  const octave = values.factor ? t(values.factor > 1 ? 'modes.checks.double' : 'modes.checks.half') : ''
  switch (key) {
    case 'tempo_not_constant':
      return t('modes.checks.tempo_not_constant', { count: values.count })
    case 'tempo_constant':
      return t('modes.checks.tempo_constant', { bpm: values.bpm })
    case 'bpm_far':
      return `${t('modes.checks.bpm_far', { bpm: values.bpm, expected: values.expected })} ${octave}`.trim()
    case 'bpm_outside':
      return `${t('modes.checks.bpm_outside', { count: values.count, low: values.min, high: values.max })} ${octave}`.trim()
    case 'octave_window':
      return values.default_bpm
        ? t('modes.checks.octave_window_moved', { low: values.low, high: values.high, bpm: values.default_bpm })
        : t('modes.checks.octave_window', { low: values.low, high: values.high })
    case 'meter_differs':
      return t('modes.checks.meter_differs', { meter: values.meter, found: (values.found ?? []).join(', ') })
    case 'meter_applied':
      return t('modes.checks.meter_applied', { meter: values.meter, count: values.count })
    default:
      return key
  }
}
