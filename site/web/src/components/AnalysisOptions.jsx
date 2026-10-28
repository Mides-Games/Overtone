import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import Icon from './ui/Icon.jsx'
import { EMPTY_FORM, formatRange, jobCost, METERS, MODES } from '../lib/analysis-options.js'

/**
 * The options before analysing (W3.21): the mode (W11.1), what the person
 * knows of the tempo and the bar, and a stretch (W12.19). Folded away by
 * default, and every default is "nothing said": a form nobody opens sends
 * the analysis as it always was.
 *
 * `durationS` is the one file's length, when there is one file and its
 * length is known: each mode then says roughly how long it takes for it, from
 * the cost the API measured (`costs`). With several files there is no
 * stretch to choose (`allowStretch`).
 */
export default function AnalysisOptions({ form, onChange, costs = null, durationS = null, allowStretch = true, error = null }) {
  const { t } = useTranslation()
  const id = useId()
  const set = (key) => (event) => onChange({ ...form, [key]: event.target.value })
  const changed = Object.keys(EMPTY_FORM).some((key) => form[key] !== EMPTY_FORM[key])

  return (
    // Folded between hairlines inside the form, not a box in the panel (docs/design.md, section 11.1).
    <details className="group/options border-y border-line">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-2.5 transition-colors duration-150 ease-out hover:text-accent [&::-webkit-details-marker]:hidden">
        <span className="space-y-0.5">
          <span className="flex items-center gap-2 text-label font-semibold text-text">
            <Icon name="sliders" size={16} className="text-dim" />
            {t('modes.options.title')}
          </span>
          <span className="block pl-6 text-caption text-dim">
            {t(`modes.names.${form.mode}`)}
            {changed ? ` · ${t('modes.options.changed')}` : ` · ${t('modes.options.defaults')}`}
          </span>
        </span>
        <Icon name="chevron-down" size={16} className="text-dim transition-transform duration-150 ease-out group-open/options:rotate-180" />
      </summary>

      <div className="space-y-5 border-t border-line py-4">
        <fieldset className="space-y-2">
          <legend className="label">{t('modes.options.mode')}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {MODES.map((mode) => {
              const cost = jobCost(costs, mode, durationS)
              return (
                <label
                  key={mode}
                  className={`flex cursor-pointer flex-col gap-1 rounded-control border px-3 py-2.5 transition ${
                    form.mode === mode ? 'border-accent bg-accent/5' : 'border-line-strong hover:border-line-hover'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name={`${id}-mode`}
                      value={mode}
                      checked={form.mode === mode}
                      onChange={set('mode')}
                      className="accent-[var(--accent)]"
                    />
                    <span className="heading-title text-body">{t(`modes.names.${mode}`)}</span>
                  </span>
                  <span className="text-caption text-muted">{t(`modes.about.${mode}`)}</span>
                  {cost && (
                    <span className="readout text-caption text-dim">
                      {t('modes.estimate.label')} {formatRange(t, cost.low, cost.high)}
                    </span>
                  )}
                </label>
              )
            })}
          </div>
          <p className="text-caption text-dim">{t('modes.options.modeNote')}</p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <label className="space-y-1">
            <span className="label">{t('modes.options.tempo')}</span>
            <select className="field" value={form.tempo} onChange={set('tempo')}>
              <option value="">{t('modes.options.unknown')}</option>
              <option value="constant">{t('modes.options.constant')}</option>
              <option value="changes">{t('modes.options.changes')}</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="label">{t('modes.options.meter')}</span>
            <select className="field" value={form.meter} onChange={set('meter')}>
              <option value="">{t('modes.options.unknown')}</option>
              {METERS.map((beats) => (
                <option key={beats} value={String(beats)}>
                  {t('modes.options.beats', { count: beats })}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="space-y-1 sm:col-span-2">
            <legend className="label">{t('modes.options.bpm')}</legend>
            <div className="flex flex-wrap items-center gap-2">
              <select className="field w-auto" value={form.bpmKind} onChange={set('bpmKind')} aria-label={t('modes.options.bpm')}>
                <option value="">{t('modes.options.unknown')}</option>
                <option value="about">{t('modes.options.about')}</option>
                <option value="range">{t('modes.options.range')}</option>
              </select>
              {form.bpmKind === 'about' && (
                <input
                  type="text"
                  inputMode="decimal"
                  className="field readout w-28"
                  value={form.bpm}
                  onChange={set('bpm')}
                  placeholder="174"
                  aria-label={t('modes.options.aboutBpm')}
                />
              )}
              {form.bpmKind === 'range' && (
                <>
                  <input type="text" inputMode="decimal" className="field readout w-24" value={form.bpmMin} onChange={set('bpmMin')} placeholder="160" aria-label={t('modes.options.fromBpm')} />
                  <span className="text-dim">–</span>
                  <input type="text" inputMode="decimal" className="field readout w-24" value={form.bpmMax} onChange={set('bpmMax')} placeholder="190" aria-label={t('modes.options.toBpm')} />
                </>
              )}
            </div>
          </fieldset>

          <fieldset className="space-y-1 sm:col-span-2" disabled={!allowStretch}>
            <legend className="label">{t('modes.options.stretch')}</legend>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                inputMode="decimal"
                className="field readout w-24"
                value={form.start}
                onChange={set('start')}
                placeholder="0:30"
                aria-label={t('modes.options.from')}
              />
              <span className="text-dim">–</span>
              <input
                type="text"
                inputMode="decimal"
                className="field readout w-24"
                value={form.end}
                onChange={set('end')}
                placeholder="1:30"
                aria-label={t('modes.options.to')}
              />
            </div>
            <p className="text-caption text-dim">{allowStretch ? t('modes.options.stretchNote') : t('modes.options.stretchOne')}</p>
          </fieldset>
        </div>

        <p className="text-caption leading-relaxed text-dim">{t('modes.options.honest')}</p>

        {changed && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => onChange(EMPTY_FORM)}>
            {t('modes.options.reset')}
          </button>
        )}

        {error && (
          <p role="alert" className="text-caption text-red">
            {t(`modes.errors.${error}`)}
          </p>
        )}
      </div>
    </details>
  )
}
