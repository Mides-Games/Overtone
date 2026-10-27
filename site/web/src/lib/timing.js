/**
 * What the result page computes from a `timing-result` on its own: the grid
 * the red lines imply, the drift of the attacks from it, and the exports once
 * the reader has adjusted the lines (×2 / ÷2, a global nudge). Pure functions,
 * no React, so the canvas, the clicks and the exports read the same numbers.
 *
 * Nothing here is a new estimate. An adjustment is the reader's, to be checked
 * by ear; the engine's own reading is the result as it came.
 */
import { changesLines, optionsNote } from './export-options.js'

/** Click levels, as the engine's `click_schedule`: 2 the bar's first beat, 1 a beat. */
export const BAR = 2
export const BEAT = 1

/** The engine's own bound on how long a click track is (MAX_CLICK_SECONDS). */
const MAX_CLICK_SECONDS = 1800

/** First index of a sorted array whose value is >= x. */
export function lowerBound(array, x) {
  let lo = 0
  let hi = array.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (array[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Python's round(): halves to even, so an exported offset matches the engine's. */
export function roundHalfEven(x) {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

/**
 * The `[TimingPoints]` rows the engine wrote (`osu_timing`), one per red line,
 * as `{ offset, beatLength }` strings kept as written. `null` when they do not
 * line up with the red lines one to one.
 */
function osuRows(result) {
  const rows = String(result?.osu_timing ?? '')
    .split(/\r?\n/)
    .filter((row) => row && !row.startsWith('//'))
    .map((row) => row.split(','))
  return rows.length === (result?.red_lines ?? []).length ? rows : null
}

/**
 * The red lines as the reader has them: `factor` 0.5, 1 or 2 scales every
 * BPM (display and export only; the offsets stay), `nudgeMs` moves every line
 * by the same amount. Each line keeps its index into the result's own lists.
 */
export function adjustLines(result, { factor = 1, nudgeMs = 0 } = {}) {
  const rows = osuRows(result)
  return (result?.red_lines ?? []).map((line, index) => {
    // The engine's beat length to 12 decimals when it is there; the line's own otherwise.
    const written = rows ? Number(rows[index][1]) : NaN
    const beatMs = (Number.isFinite(written) && written > 0 ? written : line.beat_length_ms) / factor
    return {
      index,
      timeMs: line.time_ms + nudgeMs,
      bpm: line.bpm * factor,
      beatMs,
      meter: Math.max(1, Math.min(16, Math.round(line.meter) || 4)),
      meterKnown: Boolean(line.meter_known),
    }
  })
}

/**
 * Every click the lines imply, as the engine's `click_schedule` builds them
 * (accent on, no subdivision): each line clicks from its offset up to, not
 * onto, the next line; the last one to the end of the audio, inclusive; the
 * first beat of each bar of the line's meter is the accented one. Seconds in
 * a Float64Array, levels in a Uint8Array, sorted.
 */
export function clickGrid(lines, durationS) {
  const duration = Math.min(Math.max(durationS || 0, 1), MAX_CLICK_SECONDS)
  const times = []
  const levels = []
  lines.forEach((line, i) => {
    if (!(line.beatMs > 0) || !Number.isFinite(line.timeMs)) return
    const start = line.timeMs / 1000
    const last = i + 1 === lines.length
    const end = last ? duration : lines[i + 1].timeMs / 1000
    const beat = line.beatMs / 1000
    for (let k = 0; k < 200_000; k++) {
      const t = start + k * beat
      if (last ? t > end + 1e-6 : t >= end - 1e-6) break
      times.push(t)
      levels.push(k % line.meter === 0 ? BAR : BEAT)
    }
  })
  return { t: Float64Array.from(times), level: Uint8Array.from(levels) }
}

/** The index of the line that governs `seconds` (the last one at or before it; 0 before the first). */
export function governing(lines, seconds) {
  let found = 0
  for (let i = 0; i < lines.length; i++) if (lines[i].timeMs / 1000 <= seconds + 1e-9) found = i
  return found
}

/**
 * How far each attack sits from the nearest 1/1, 1/2, 1/3 or 1/4 tick of the
 * line that governs it, in ms: the worker's per-line measure (worker/
 * timing_result.py `_drift`), here for every attack so the drift lane can draw
 * it and the table can follow an adjustment. NaN for an attack before the first line.
 */
export function attackDrift(onsetsMs, lines) {
  const out = new Float32Array(onsetsMs.length)
  let g = 0
  for (let i = 0; i < onsetsMs.length; i++) {
    const t = onsetsMs[i]
    while (g + 1 < lines.length && lines[g + 1].timeMs <= t) g++
    const line = lines[g]
    if (!line || t < line.timeMs || !(line.beatMs > 0)) {
      out[i] = NaN
      continue
    }
    const position = (t - line.timeMs) / line.beatMs
    let best = Infinity
    for (const divisor of [1, 2, 3, 4]) {
      const off = t - (line.timeMs + (Math.round(position * divisor) / divisor) * line.beatMs)
      if (Math.abs(off) < Math.abs(best)) best = off
    }
    out[i] = best
  }
  return out
}

function weightedQuantile(values, weights, q) {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b])
  const total = weights.reduce((sum, w) => sum + w, 0)
  let running = 0
  for (const i of order) {
    running += weights[i]
    if (running >= q * total) return values[i]
  }
  return values[order[order.length - 1]]
}

/**
 * Per line, the drift summary the worker reports (`drift_ms`, `drift_p90_ms`,
 * `drift_bias_ms`), recomputed for adjusted lines from the attacks and their
 * per-attack drift. `null` under four attacks, as there.
 */
export function lineDrift(onsets, drift, lines, durationMs) {
  const t = onsets?.t_ms ?? []
  const w = onsets?.w ?? []
  return lines.map((line, i) => {
    const end = i + 1 < lines.length ? lines[i + 1].timeMs : durationMs
    const sizes = []
    const signed = []
    const weights = []
    for (let j = lowerBound(t, line.timeMs); j < t.length && t[j] < end; j++) {
      if (!(w[j] > 0) || !Number.isFinite(drift[j])) continue
      sizes.push(Math.abs(drift[j]))
      signed.push(drift[j])
      weights.push(w[j])
    }
    if (sizes.length < 4) return { drift_ms: null, drift_p90_ms: null, drift_bias_ms: null, onsets: sizes.length }
    return {
      drift_ms: weightedQuantile(sizes, weights, 0.5),
      drift_p90_ms: weightedQuantile(sizes, weights, 0.9),
      drift_bias_ms: weightedQuantile(signed, weights, 0.5),
      onsets: sizes.length,
    }
  })
}

/** A short note of an adjustment, for the exports' comment line and the page. */
export function adjustmentNote({ factor, nudgeMs }) {
  const parts = []
  if (factor === 2) parts.push('x2')
  if (factor === 0.5) parts.push('/2')
  if (nudgeMs) parts.push(`${nudgeMs > 0 ? '+' : ''}${nudgeMs} ms`)
  return parts.join(', ')
}

const isAdjusted = ({ factor, nudgeMs }) => factor !== 1 || nudgeMs !== 0

/**
 * The `[TimingPoints]` block, CRLF, as the API's timing.txt sends it. Not
 * adjusted, it is the engine's own rows; adjusted, the same rows rebuilt from
 * the adjusted lines, with a comment line saying so (osu! reads comments on
 * their own lines only, which is where it goes). `options` are the export
 * options (W12.8) the `lines` were already put through (`exportLines`): when
 * they change the lines, the rows are rebuilt too and the comment names them.
 */
export function timingText(result, lines = [], adjustment = { factor: 1, nudgeMs: 0 }, options = null) {
  let rows = String(result?.osu_timing ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
  if (isAdjusted(adjustment) || changesLines(options)) {
    const header = rows.filter((row) => row.startsWith('//'))
    const notes = [adjustmentNote(adjustment), optionsNote(options)].filter(Boolean).join(', ')
    rows = [
      ...header,
      `// ${isAdjusted(adjustment) ? 'Adjusted' : 'Exported'} on the Overtone site (${notes}): check it by ear`,
      ...lines.map((line) => `${roundHalfEven(line.timeMs)},${line.beatMs.toFixed(12)},${line.meter},1,0,100,1,0`),
    ]
  }
  return `[TimingPoints]\r\n${rows.join('\r\n')}\r\n`
}

/** The red lines as CSV, the API's columns (site/api/src/utils/upload.js), adjusted when they are. */
export function timingCsv(result, lines) {
  const rows = ['time_ms,bpm,beat_length_ms,meter,confidence,level']
  lines.forEach((line) => {
    const section = result.sections?.[line.index] ?? {}
    rows.push(
      [
        Number(line.timeMs.toFixed(3)),
        Number(line.bpm.toFixed(6)),
        Number(line.beatMs.toFixed(6)),
        line.meter,
        section.confidence ?? '',
        section.level ?? '',
      ].join(','),
    )
  })
  return `${rows.join('\r\n')}\r\n`
}

/** The result as the API served it, for the JSON download: the engine's reading, never adjusted. */
export const resultJson = (result) => `${JSON.stringify(result, null, 2)}\n`

/**
 * A plain-text summary to keep or paste: the song, the readings, one row per
 * red line with its level, and the spans worth a listen (`checks`, from
 * `checkSpans`). English, as the other exports are; CRLF, as osu!'s files.
 */
export function summaryText({ filename, result, lines, adjustment = { factor: 1, nudgeMs: 0 }, checks = [] }) {
  const out = [`Overtone timing: ${filename ?? 'song'}`, '']
  const bpm = result.global_bpm === null || result.global_bpm === undefined ? null : result.global_bpm * adjustment.factor
  out.push(`BPM        ${formatBpm(bpm)}`)
  out.push(`Offset     ${formatMs(lines[0]?.timeMs ?? null)} ms`)
  out.push(`Meter      ${result.meter ?? '–'}`)
  out.push(`Red lines  ${lines.length}`)
  out.push(`Length     ${formatClock((result.duration_s ?? 0) * 1000)}`)
  if (isAdjusted(adjustment)) out.push(`Adjusted   ${adjustmentNote(adjustment)} (on the site, by the reader: check it by ear)`)
  out.push('', 'Time        BPM       Meter  Confidence  Level')
  lines.forEach((line) => {
    const section = result.sections?.[line.index] ?? {}
    const confidence = typeof section.confidence === 'number' ? `${Math.round(section.confidence * 100)}%` : '–'
    out.push(
      `${formatClock(line.timeMs).padEnd(11)} ${formatBpm(line.bpm).padEnd(9)} ${`${line.meter}/4`.padEnd(6)} ${confidence.padEnd(11)} ${section.level ?? '–'}`,
    )
  })
  out.push('', checks.length ? 'Check here' : 'Check here: nothing flagged')
  for (const item of checks) out.push(`${formatClock(item.startMs)} - ${formatClock(item.endMs)}  ${item.reasons.join(', ')}`)
  out.push('', `Engine v3 ${result.engine_hash ?? ''} · Beat This! vote ${result.beat_vote ? 'on' : 'off'}`, 'Check these red lines by ear before you rank.')
  return `${out.join('\r\n')}\r\n`
}

/** A file name for a download, as the API's `downloadName`: `<song>-timing.txt`. */
export function downloadName(filename, suffix) {
  const stem = (filename ?? 'overtone')
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._ -]+/g, '')
    .trim()
    .slice(0, 80)
  return `${stem || 'overtone'}-${suffix}`
}

/**
 * The archive of a batch (W3.15): one `timing.txt` per song that has a
 * timing, the engine's own rows, built from the results the page already
 * holds so the zip needs no request.
 */
export const batchFiles = (items) =>
  items
    .filter((item) => item.status === 'done' && item.result)
    .map((item) => ({ name: downloadName(item.file.name, 'timing.txt'), text: timingText(item.result) }))

/** Hands `text` (or bytes) to the browser as a file to save. Nothing leaves the page. */
export function saveText(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Up to three decimals, trailing zeros dropped: 128, 128.37, 222.222.
export const formatBpm = (bpm) => (bpm === null || bpm === undefined ? '–' : String(Number(Number(bpm).toFixed(3))))

export const formatMs = (ms) => (ms === null || ms === undefined ? '–' : String(Math.round(ms)))

/** m:ss.sss */
export const formatClock = (ms) => {
  const total = Math.max(0, ms) / 1000
  const minutes = Math.floor(total / 60)
  const seconds = (total - minutes * 60).toFixed(3).padStart(6, '0')
  return `${minutes}:${seconds}`
}

/** m:ss with `decimals` of a second, for the ruler. */
export const formatRuler = (seconds, decimals = 0) => {
  const scale = 10 ** decimals
  const whole = Math.round(Math.max(0, seconds) * scale) / scale
  const m = Math.floor(whole / 60)
  const s = (whole - m * 60).toFixed(decimals)
  return `${m}:${s.padStart(decimals ? 3 + decimals : 2, '0')}`
}
