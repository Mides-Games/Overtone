import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { useSettings } from '../context/SettingsContext.jsx'
import { useTheme } from '../context/ThemeContext.jsx'
import usePageMeta from '../hooks/usePageMeta.js'
import { LANGS } from '../i18n.js'
import { DEFAULT_VOLUME, saveVolumes, savedVolumes } from '../lib/player.js'
import { recentAnalyses } from '../lib/recent.js'
import {
  FONT_MAX,
  FONT_MIN,
  FONT_STEP,
  LATENCY_KEY,
  LATENCY_MAX,
  LATENCY_MIN,
  MOTIONS,
  cleanFontScale,
  PALETTES,
  THEMES,
  parseLatency,
  readLatency,
} from '../lib/settings.js'

/**
 * `/settings` (W12.15): how the site looks and sounds in this browser. Every
 * choice is stored here and nowhere else, no account needed (ADR-W6), and
 * takes effect as it is made; there is no Save button. The theme and the
 * language keep the keys midesprojects.com shares; the rest is
 * `overtone.settings`, the player's `overtone.player.volumes` and
 * `overtone.player.latencyMs` (lib/settings.js says which is which).
 */

function Section({ title, note, children }) {
  return (
    <section className="panel space-y-5 p-5 sm:p-6">
      <div className="space-y-1">
        <h2 className="font-display text-title font-semibold">{title}</h2>
        {note && <p className="text-label text-muted">{note}</p>}
      </div>
      {children}
    </section>
  )
}

/** A row of radio buttons drawn as a segmented control; arrows move between them, as radios do. */
function Choice({ legend, name, value, options, onChange, hint }) {
  return (
    <fieldset className="space-y-2">
      <legend className="label mb-2">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <label
            key={option.value}
            className="relative inline-flex h-9 cursor-pointer items-center rounded-control border border-line-strong px-3 text-label text-text transition hover:border-line-hover has-checked:border-accent has-checked:bg-accent/15 has-checked:text-accent has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
      {hint && <p className="text-caption text-dim">{hint}</p>}
    </fieldset>
  )
}

function Toggle({ label, hint, checked, onChange }) {
  const id = useId()
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
      <div className="space-y-0.5">
        <label htmlFor={id} className="text-label font-semibold text-text">
          {label}
        </label>
        {hint && <p className="text-caption text-dim">{hint}</p>}
      </div>
    </div>
  )
}

function Slider({ label, value, min, max, step, onChange, format }) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="label">
          {label}
        </label>
        <output htmlFor={id} className="readout text-label text-text">
          {format(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-[var(--accent)]"
      />
    </div>
  )
}

const systemPrefers = (query) => {
  try {
    return window.matchMedia(query).matches
  } catch {
    return false
  }
}

function Appearance() {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const { settings, update, reset } = useSettings()
  const systemReduce = systemPrefers('(prefers-reduced-motion: reduce)')
  const percent = Math.round(settings.fontScale * 100)

  return (
    <Section title={t('settings.appearance.title')} note={t('settings.appearance.note')}>
      <Choice
        legend={t('settings.theme.label')}
        name="theme"
        value={theme}
        options={THEMES.map((value) => ({ value, label: t(`settings.theme.${value}`) }))}
        onChange={setTheme}
        hint={t('settings.theme.hint')}
      />

      <Toggle
        label={t('settings.contrast.label')}
        hint={t('settings.contrast.hint')}
        checked={settings.contrast === 'more'}
        onChange={(on) => update({ contrast: on ? 'more' : 'normal' })}
      />

      <div className="space-y-2">
        <Slider
          label={t('settings.font.label')}
          value={percent}
          min={FONT_MIN * 100}
          max={FONT_MAX * 100}
          step={FONT_STEP * 100}
          onChange={(value) => update({ fontScale: cleanFontScale(value / 100) })}
          format={(value) => `${value} %`}
        />
        <p className="text-caption text-dim">{t('settings.font.hint')}</p>
      </div>

      <div className="space-y-3">
        <Choice
          legend={t('settings.palette.label')}
          name="palette"
          value={settings.palette}
          options={PALETTES.map((value) => ({ value, label: t(`settings.palette.${value}`) }))}
          onChange={(palette) => update({ palette })}
          hint={t('settings.palette.hint')}
        />
        {/* The four colours the map paints, as they are now: they change with the choice above. */}
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={t('settings.palette.preview')}>
          {[
            ['bg-red', 'red'],
            ['bg-amber', 'amber'],
            ['bg-lavender', 'lavender'],
            ['bg-accent', 'accent'],
          ].map(([swatch, name]) => (
            <li key={name} className="flex items-center gap-2 rounded-control border border-line px-2.5 py-2 text-caption text-muted">
              <span aria-hidden="true" className={`h-4 w-4 shrink-0 rounded-sm ${swatch}`} />
              {t(`settings.palette.swatch.${name}`)}
            </li>
          ))}
        </ul>
      </div>

      <Choice
        legend={t('settings.motion.label')}
        name="motion"
        value={settings.reducedMotion}
        options={MOTIONS.map((value) => ({ value, label: t(`settings.motion.${value}`) }))}
        onChange={(reducedMotion) => update({ reducedMotion })}
        hint={t(systemReduce ? 'settings.motion.systemReduce' : 'settings.motion.systemAllow')}
      />

      <button type="button" className="btn-ghost" onClick={reset}>
        {t('settings.reset')}
      </button>
    </Section>
  )
}

function Language() {
  const { t, i18n } = useTranslation()
  return (
    <Section title={t('settings.language.title')}>
      <Choice
        legend={t('settings.language.label')}
        name="language"
        value={LANGS.includes(i18n.language) ? i18n.language : 'en'}
        options={LANGS.map((value) => ({ value, label: t(`settings.language.${value}`) }))}
        onChange={(lng) => i18n.changeLanguage(lng)}
      />
    </Section>
  )
}

const storedLatency = () => {
  try {
    return readLatency(localStorage.getItem(LATENCY_KEY))
  } catch {
    return null
  }
}

function Audio() {
  const { t } = useTranslation()
  const [volumes, setVolumes] = useState(() => {
    const saved = savedVolumes()
    return { song: saved.song ?? DEFAULT_VOLUME, click: saved.click ?? DEFAULT_VOLUME, clicksOn: saved.clicksOn ?? true }
  })
  const [latency, setLatency] = useState(storedLatency)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState(false)
  const latest = recentAnalyses()[0]

  // The calibration may run in another tab while this one is open.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === LATENCY_KEY) setLatency(readLatency(event.newValue))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const changeVolumes = (patch) => {
    const next = { ...volumes, ...patch }
    setVolumes(next)
    saveVolumes(next)
  }

  const writeLatency = (value) => {
    try {
      if (value === null) localStorage.removeItem(LATENCY_KEY)
      else localStorage.setItem(LATENCY_KEY, String(value))
    } catch {
      // Storage blocked: nothing to keep it in.
    }
    setLatency(storedLatency())
  }

  const onSubmit = (event) => {
    event.preventDefault()
    const value = parseLatency(typed)
    setError(value === null)
    if (value === null) return
    writeLatency(value)
    setTyped('')
  }

  return (
    <Section title={t('settings.audio.title')} note={t('settings.audio.note')}>
      <div className="grid gap-5 sm:grid-cols-2">
        <Slider
          label={t('settings.audio.song')}
          value={Math.round(volumes.song * 100)}
          min={0}
          max={100}
          step={1}
          onChange={(value) => changeVolumes({ song: value / 100 })}
          format={(value) => `${value} %`}
        />
        <Slider
          label={t('settings.audio.click')}
          value={Math.round(volumes.click * 100)}
          min={0}
          max={100}
          step={1}
          onChange={(value) => changeVolumes({ click: value / 100 })}
          format={(value) => `${value} %`}
        />
      </div>
      <Toggle label={t('settings.audio.clicksOn')} checked={volumes.clicksOn} onChange={(clicksOn) => changeVolumes({ clicksOn })} />

      <div className="space-y-3 border-t border-line pt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="label">{t('settings.latency.label')}</h3>
          <p className="readout text-body text-text" aria-live="polite">
            {latency === null ? t('settings.latency.none') : t('settings.latency.value', { ms: latency })}
          </p>
        </div>
        <p className="text-caption text-dim">
          {t('settings.latency.hint')}{' '}
          <Link to={latest ? `/analyze/${latest.id}` : '/recent'} className="text-accent underline-offset-2 hover:underline">
            {t(latest ? 'settings.latency.calibrateLatest' : 'settings.latency.calibrateRecent')}
          </Link>
        </p>
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2" noValidate>
          <div className="min-w-0 flex-1 space-y-1">
            <label htmlFor="latency-input" className="label">
              {t('settings.latency.type')}
            </label>
            <input
              id="latency-input"
              type="text"
              inputMode="decimal"
              className="field readout"
              placeholder={t('settings.latency.placeholder')}
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value)
                setError(false)
              }}
              aria-invalid={error}
              aria-describedby={error ? 'latency-error' : undefined}
            />
          </div>
          <button type="submit" className="btn-primary" disabled={!typed.trim()}>
            {t('settings.latency.save')}
          </button>
          <button type="button" className="btn-ghost" disabled={latency === null} onClick={() => writeLatency(null)}>
            {t('settings.latency.reset')}
          </button>
        </form>
        {error && (
          <p id="latency-error" role="alert" className="text-caption text-red">
            {t('settings.latency.invalid', { min: LATENCY_MIN, max: LATENCY_MAX })}
          </p>
        )}
      </div>
    </Section>
  )
}

export default function Settings() {
  const { t } = useTranslation()
  usePageMeta(t('settings.title'), t('settings.description'))

  return (
    <div className="rise mx-auto max-w-3xl space-y-6">
      <header className="space-y-3">
        <h1 className="font-display text-[clamp(1.8rem,1.4rem+1.6vw,2.4rem)] font-bold uppercase">{t('settings.title')}</h1>
        <p className="max-w-[60ch] leading-relaxed text-muted">{t('settings.subtitle')}</p>
      </header>
      <Appearance />
      <Language />
      <Audio />
    </div>
  )
}
