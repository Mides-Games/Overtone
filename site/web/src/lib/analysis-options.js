/**
 * How a person asks for an analysis (W11.1, W3.21, W12.19), on the browser's
 * side: the form's fields into the `{ mode, options }` the API takes, checked
 * with the API's own bounds (site/api/src/utils/analysis-options.js) so a
 * mistake is said here, before anything is sent. The API checks again.
 *
 * Every field is optional and its default is "nothing said": a form left
 * alone sends `normal` with no hints, the analysis as it always was.
 */
export const MODES = ['fast', 'normal', 'strict']
export const DEFAULT_MODE = 'normal'
export const BPM_RANGE = [30, 400]
export const METERS = [2, 3, 4, 5, 6, 7]
export const MIN_STRETCH_S = 10

export const EMPTY_FORM = {
  mode: DEFAULT_MODE,
  tempo: '', // '' | 'constant' | 'changes'
  bpmKind: '', // '' | 'about' | 'range'
  bpm: '',
  bpmMin: '',
  bpmMax: '',
  meter: '', // '' or a number of beats
  start: '', // 'm:ss' or seconds
  end: '',
}

/** "1:23.5", "83.5" or "" as seconds; NaN for anything else. */
export function parseTime(text) {
  const value = String(text ?? '').trim()
  if (!value) return null
  const parts = value.split(':')
  if (parts.length > 2 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return Number.NaN
  return parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(parts[0])
}

/** Seconds as "m:ss", for the fields and the notes. */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return ''
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

const number = (text) => {
  const value = String(text ?? '').trim().replace(',', '.')
  return value === '' ? null : Number(value)
}

/**
 * The form as `{ mode, options, error }`. `error` is the key of what is
 * wrong (`modes.errors.*`), or null; `durationS` is the file's length when
 * known, which a stretch has to fit in. `allowStretch` is false for a batch:
 * one stretch cannot fit several songs.
 */
export function buildRequest(form, { durationS = null, allowStretch = true } = {}) {
  const options = {}
  const mode = MODES.includes(form.mode) ? form.mode : DEFAULT_MODE
  const fail = (error) => ({ mode, options: {}, error })

  if (form.tempo === 'constant' || form.tempo === 'changes') options.tempo = form.tempo
  const inRange = (v) => Number.isFinite(v) && v >= BPM_RANGE[0] && v <= BPM_RANGE[1]
  if (form.bpmKind === 'about') {
    const bpm = number(form.bpm)
    if (bpm !== null) {
      if (!inRange(bpm)) return fail('bpm')
      options.bpm = Math.round(bpm * 1000) / 1000
    }
  } else if (form.bpmKind === 'range') {
    const low = number(form.bpmMin)
    const high = number(form.bpmMax)
    if (low !== null || high !== null) {
      if (!inRange(low) || !inRange(high)) return fail('bpm')
      if (!(low < high)) return fail('range')
      options.bpm_min = Math.round(low * 1000) / 1000
      options.bpm_max = Math.round(high * 1000) / 1000
    }
  }
  if (form.meter !== '' && form.meter !== null && form.meter !== undefined) {
    const meter = Number(form.meter)
    if (!Number.isInteger(meter) || meter < 1 || meter > 16) return fail('meter')
    options.meter = meter
  }
  const start = parseTime(form.start)
  const end = parseTime(form.end)
  if (start !== null || end !== null) {
    if (!allowStretch) return fail('stretchBatch')
    const from = start ?? 0
    const to = end ?? durationS
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0) return fail('stretch')
    if (durationS && to > durationS + 0.5) return fail('stretchPast')
    if (to - from < MIN_STRETCH_S) return fail('stretchShort')
    options.start_s = Math.round(from * 1000) / 1000
    options.end_s = Math.round(Math.min(to, durationS ?? to) * 1000) / 1000
  }
  return { mode, options, error: null }
}

/** Whether the request says anything but the defaults. */
export const isDefault = ({ mode, options }) => mode === DEFAULT_MODE && Object.keys(options ?? {}).length === 0

/**
 * One job's cost in seconds as `{ low, high }`, from the API's measured cost
 * table (`/health`, `costs`); null without the table or the length. The same
 * sum the API's estimate makes (utils/estimate.js).
 */
export function jobCost(costs, mode, seconds) {
  const cost = costs?.[mode]
  if (!cost || !Number.isFinite(seconds) || seconds <= 0) return null
  const minutes = seconds / 60
  const low = cost.fixed + cost.perMin * minutes
  return { low, high: Math.max(low, cost.highPerMin * minutes) }
}

/**
 * A range of seconds as words: "≈ 10 s – 1 min", always marked as an
 * estimate by the caller's label. Seconds under two minutes are rounded to
 * 5 s, the rest to whole minutes: anything finer would claim a precision the
 * measurement does not have. `highS` null reads "at least".
 */
export function formatRange(t, lowS, highS) {
  const say = (s) => {
    if (s < 120) return t('modes.estimate.seconds', { count: Math.max(5, Math.round(s / 5) * 5) })
    return t('modes.estimate.minutes', { count: Math.round(s / 60) })
  }
  if (highS === null || highS === undefined) return t('modes.estimate.atLeast', { value: say(lowS) })
  const a = say(lowS)
  const b = say(highS)
  return a === b ? t('modes.estimate.about', { value: a }) : t('modes.estimate.range', { low: a, high: b })
}

/** The compare view of two analyses (W3.24, W12.11, pages/Compare.jsx). */
export const compareHref = (a, b) => `/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`
