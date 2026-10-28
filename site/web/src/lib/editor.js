/**
 * The timing editor (W7, W12.17): the reader's own edits of the red lines,
 * as pure functions, so the map, the table, the keys and the tests all move
 * the same lines the same way.
 *
 * Ported from the desktop app's editing helpers, which are still in
 * `python/overtone.py` (`add_timing_point`, `update_timing_point`,
 * `delete_timing_point`, `nudge_timing_point`, `set_meter`,
 * `rescale_section`, `split_section`, `merge_sections`), with the refit they
 * call (`_refit_section` over `_grade_span`, `_forward_fit`,
 * `_recentre_phase`, `_refine_grid`, `_ls_fit`, `_grid_quality`).
 * test/editor.test.js holds them to the Python's own outputs
 * (test/fixtures/editor-golden.json, written by editor-golden.py beside it).
 *
 * Where they differ, on purpose:
 * - The site's red lines are already where the engine shows them: the worker
 *   writes them after `snap_timing_points`, so Python's `_shown_offset` is
 *   the line's own time here.
 * - An edit that would put two red lines within MIN_GAP_MS of each other is
 *   refused instead of written: osu! reads two uninherited points at one time
 *   as one, and the reader meant neither.
 * - Above MAX_SCAN_ONSETS attacks in one span, the refit keeps the strongest
 *   with ties broken by time; numpy's unstable sort breaks them its own way.
 *
 * Nothing here is an estimate of the engine's. An edited line is the
 * reader's, to be checked by ear, and the engine's reading stays as it came.
 *
 * A line here is `{ timeMs, beatMs, meter, meterKnown, source }`: `source`
 * is the index of the engine's red line it came from, -1 for one the reader
 * added or split off. Its BPM is 60000 / beatMs.
 */
import { lowerBound, roundHalfEven } from './timing.js'

/** The bar lengths the editor offers, in beats (EDIT_METERS). */
export const METERS = Array.from({ length: 16 }, (_, i) => i + 1)
/** At most this many red lines in an edited timing: the API caps a saved version at the same. */
export const MAX_LINES = 512
/** Two red lines closer than this are one line to osu!; the editor refuses to make them. */
export const MIN_GAP_MS = 1
/** The BPM a typed or rescaled line may have; rescale_section's own bound is 30-600. */
export const BPM_RANGE = [1, 5000]
export const RESCALE_RANGE = [30, 600]

/** An edit the editor refuses, with a key the page translates (`editor.errors.<code>`). */
export class EditError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'EditError'
    this.code = code
  }
}

export const bpmOf = (line) => 60000 / line.beatMs

/** The page's lines (lib/timing.js `adjustLines`) as the editor's. */
export const editLines = (lines) =>
  lines.map((line) => ({
    timeMs: line.timeMs,
    beatMs: line.beatMs,
    meter: line.meter,
    meterKnown: Boolean(line.meterKnown),
    source: Number.isInteger(line.source) ? line.source : Number.isInteger(line.index) ? line.index : -1,
  }))

const sorted = (lines) => [...lines].sort((a, b) => a.timeMs - b.timeMs)

function checkIndex(lines, index) {
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) throw new EditError('noLine', 'No timing point at that index.')
}

function checkGaps(lines) {
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].timeMs - lines[i - 1].timeMs < MIN_GAP_MS) throw new EditError('tooClose')
  }
}

function checkBpm(bpm) {
  if (!Number.isFinite(bpm) || bpm <= 0) throw new EditError('badBpm', 'Offset must be finite and BPM positive.')
  if (bpm < BPM_RANGE[0] || bpm > BPM_RANGE[1]) throw new EditError('bpmRange')
}

/** The lines re-sorted, with where `moved` went, after the gap check. */
function placed(lines, moved) {
  const out = sorted(lines)
  checkGaps(out)
  return { lines: out, selected: moved ? out.indexOf(moved) : null }
}

/** `add_timing_point`: a hand-placed line at `timeMs` with `bpm`, kept sorted. */
export function addLine(lines, timeMs, bpm, { meter = 4 } = {}) {
  if (!Number.isFinite(timeMs)) throw new EditError('badTime', 'Offset must be finite and BPM positive.')
  checkBpm(bpm)
  if (lines.length >= MAX_LINES) throw new EditError('tooMany')
  const line = { timeMs, beatMs: 60000 / bpm, meter: METERS.includes(meter) ? meter : 4, meterKnown: false, source: -1 }
  return placed([...lines, line], line)
}

/**
 * `update_timing_point`: one line's time and BPM replaced, its meter kept
 * (a dragged line, or a BPM typed). `bpm` null keeps the line's beat as it is,
 * to the last decimal.
 */
export function updateLine(lines, index, timeMs, bpm = null) {
  checkIndex(lines, index)
  if (!Number.isFinite(timeMs)) throw new EditError('badTime', 'Offset must be finite and BPM positive.')
  if (bpm !== null) checkBpm(bpm)
  const old = lines[index]
  const line = { ...old, timeMs, beatMs: bpm === null ? old.beatMs : 60000 / bpm }
  return placed(lines.map((l, i) => (i === index ? line : l)), line)
}

/** `delete_timing_point`: the first line anchors the map and stays. */
export function deleteLine(lines, index) {
  checkIndex(lines, index)
  if (index === 0) throw new EditError('first', 'The first timing point anchors the map and cannot be deleted.')
  return { lines: lines.filter((_, i) => i !== index), selected: Math.min(index, lines.length - 2) }
}

/**
 * `nudge_timing_point`: one line moved by `deltaMs`; a nudge stops at 0 ms
 * rather than carry a line from the audio into the time before it, and a line
 * already before 0 ms moves by exactly `deltaMs`.
 */
export function nudgeLine(lines, index, deltaMs) {
  checkIndex(lines, index)
  const shown = lines[index].timeMs
  let timeMs = shown + deltaMs
  if (shown >= 0 && timeMs < 0) timeMs = 0
  const line = { ...lines[index], timeMs }
  return placed(lines.map((l, i) => (i === index ? line : l)), line)
}

/** `set_meter`: one line's bar length in beats (1-16), its beat kept; the reader said so, so it is known. */
export function setMeter(lines, index, meter) {
  checkIndex(lines, index)
  if (!Number.isInteger(meter) || !METERS.includes(meter)) throw new EditError('badMeter', 'A bar holds 1 to 16 beats.')
  return { lines: lines.map((l, i) => (i === index ? { ...l, meter, meterKnown: true } : l)), selected: index }
}

/** `rescale_section`: one section's BPM doubled or halved, its line where it is; the result stays within 30-600. */
export function rescaleSection(lines, index, factor) {
  checkIndex(lines, index)
  if (factor !== 0.5 && factor !== 2) throw new EditError('badFactor', 'Section factor must be 2 or 1/2.')
  const bpm = bpmOf(lines[index]) * factor
  if (bpm < RESCALE_RANGE[0] || bpm > RESCALE_RANGE[1]) throw new EditError('rescaleRange')
  return { lines: lines.map((l, i) => (i === index ? { ...l, beatMs: l.beatMs / factor } : l)), selected: index }
}

// ── The refit: one section's beat fitted to its attacks, its red line held ──

const REFERENCE_DIVISORS = [1, 2, 3, 4]
const REFERENCE_DIVISOR_SLACK = 0.9
const REFERENCE_MIN_ATTACKS = 8
const REFERENCE_MIN_SHARE = 0.4
const REFERENCE_LOCK_BEATS = 8
const REFERENCE_PERIOD_BAND = [0.8, 1.25]
const MAX_SCAN_ONSETS = 5000
const REFINE_TOLERANCES = [0.3, 0.18, 0.1, 0.06, 0.04]

/** numpy's mod: the result takes the divisor's sign. */
const mod = (x, p) => x - Math.floor(x / p) * p

/** One weighted least-squares pass of t ≈ phase + k·period (`_ls_fit`). */
function lsFit(t, w, period, phase, tol) {
  if (t.length < 4 || period <= 0) return null
  const x = []
  const tt = []
  const ww = []
  const inlier = new Uint8Array(t.length)
  for (let i = 0; i < t.length; i++) {
    const k = roundHalfEven((t[i] - phase) / period)
    if (Math.abs(t[i] - (phase + k * period)) <= tol) {
      inlier[i] = 1
      x.push(k)
      tt.push(t[i])
      ww.push(w[i])
    }
  }
  if (x.length < 4) return null
  if (Math.max(...x) - Math.min(...x) < 2) return null
  let sw = 0
  let sx = 0
  let st = 0
  for (let i = 0; i < x.length; i++) {
    sw += ww[i]
    sx += ww[i] * x[i]
    st += ww[i] * tt[i]
  }
  const xm = sx / sw
  const tm = st / sw
  let sxx = 0
  let sxt = 0
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - xm
    sxx += ww[i] * dx * dx
    sxt += ww[i] * dx * (tt[i] - tm)
  }
  if (!(sxx > 1e-12)) return null
  const next = sxt / sxx
  if (!Number.isFinite(next) || next <= 0) return null
  if (!(0.5 * period <= next && next <= 2 * period)) return null
  return { period: next, phase: tm - next * xm, inlier }
}

/** The phase snapped onto the densest cluster of residuals, not their mean (`_recentre_phase`). */
function recentrePhase(t, w, period, phase) {
  if (t.length < 4 || period <= 0) return phase
  const width = Math.min(0.012, 0.06 * period)
  if (t.length > MAX_SCAN_ONSETS) {
    const keep = t
      .map((_, i) => i)
      .sort((a, b) => w[b] - w[a] || a - b)
      .slice(0, MAX_SCAN_ONSETS)
      .sort((a, b) => a - b)
    t = keep.map((i) => t[i])
    w = keep.map((i) => w[i])
  }
  const residual = t.map((ti) => mod(ti - phase + 0.5 * period, period) - 0.5 * period)
  const step = period / 400
  let best = -Infinity
  let bestShift = 0
  for (let j = 0; j <= 400; j++) {
    const shift = j === 400 ? 0.5 * period : -0.5 * period + j * step
    let score = 0
    for (let i = 0; i < residual.length; i++) {
      const s = (residual[i] - shift) / width
      score += w[i] * Math.exp(-0.5 * Math.min(s * s, 60))
    }
    if (score > best) {
      best = score
      bestShift = shift
    }
  }
  return phase + bestShift
}

/** Iteratively tightened fit; each pass discards attacks off the grid (`_refine_grid`). */
function refineGrid(t, w, period, phase) {
  for (let n = 0; n < REFINE_TOLERANCES.length; n++) {
    if (n === 2) phase = recentrePhase(t, w, period, phase)
    const fit = lsFit(t, w, period, phase, Math.max(REFINE_TOLERANCES[n] * period, 0.006))
    if (!fit) break
    period = fit.period
    phase = fit.phase
  }
  return { period, phase }
}

/** Share of attack weight on the grid and the RMS residual in ms (`_grid_quality`, coverage left out). */
function gridQuality(t, w, period, phase, tolRatio = 0.12) {
  if (!t.length || period <= 0) return { share: 0, rms: 999 }
  const tol = Math.max(tolRatio * period, 0.006)
  let inW = 0
  let allW = 0
  let sq = 0
  let n = 0
  for (let i = 0; i < t.length; i++) {
    allW += w[i]
    const r = t[i] - (phase + roundHalfEven((t[i] - phase) / period) * period)
    if (Math.abs(r) <= tol) {
      inW += w[i]
      sq += r * r
      n++
    }
  }
  if (!n) return { share: 0, rms: 999 }
  return { share: inW / Math.max(allW, 1e-9), rms: Math.sqrt(sq / n) * 1000 }
}

const within = (t, w, lo, hi) => {
  const tt = []
  const ww = []
  for (let i = 0; i < t.length; i++) {
    if (t[i] >= lo && t[i] <= hi) {
      tt.push(t[i])
      ww.push(w[i])
    }
  }
  return [tt, ww]
}

/** The phase locked on the span's first window, then refitted on windows doubling forward (`_forward_fit`). */
function forwardFit(t, w, period, phase, start, stop, lock) {
  const lo = period * REFERENCE_PERIOD_BAND[0]
  const hi = period * REFERENCE_PERIOD_BAND[1]
  let span = lock
  const [ft, fw] = within(t, w, start, start + span)
  phase = recentrePhase(ft, fw, period, phase)
  for (;;) {
    const [wt, ww] = within(t, w, start, Math.min(stop, start + span))
    if (wt.length >= 8) {
      const fit = refineGrid(wt, ww, period, phase)
      if (!(lo <= fit.period && fit.period <= hi)) return { period, phase }
      period = fit.period
      phase = fit.phase
    }
    if (start + span >= stop) return { period, phase }
    span *= 2
  }
}

/** One span fitted at 1/1-1/4 of its beat, the coarsest that explains the attacks kept (`_grade_span`, its BPM and share). */
function gradeSpan(t, w, offsetS, beatS, endS) {
  const fits = REFERENCE_DIVISORS.map((divisor) => {
    const atom = beatS / divisor
    const { period, phase } = forwardFit(t, w, atom, offsetS, offsetS, endS, REFERENCE_LOCK_BEATS * beatS)
    const { share, rms } = gridQuality(t, w, period, phase)
    return { divisor, period, share, rms }
  })
  const top = Math.max(...fits.map((f) => f.share))
  const fit = fits.find((f) => f.share >= REFERENCE_DIVISOR_SLACK * top)
  return { divisor: fit.divisor, share: fit.share, residualMs: fit.rms, fittedBpm: 60 / (fit.period * fit.divisor) }
}

/**
 * `_refit_section`: the BPM the attacks of one section keep, its red line
 * held, never further than the band from where it started. Fewer than eight
 * attacks (`kept: 'few'`), or a grid that explains under 40 % of their weight
 * (`kept: 'weak'`), keeps the BPM and says why instead of guessing.
 * `attacks` is `{ t, w }` in seconds, sorted.
 */
export function refitSection(attacks, offsetMs, bpm, endMs) {
  const startS = offsetMs / 1000
  const beatS = 60 / bpm
  const endS = endMs / 1000
  const slack = (0.5 * beatS) / Math.max(...REFERENCE_DIVISORS)
  const t = []
  const w = []
  for (let i = 0; i < attacks.t.length; i++) {
    if (attacks.t[i] >= startS - slack && attacks.t[i] < endS - slack) {
      t.push(attacks.t[i])
      w.push(attacks.w[i])
    }
  }
  const row = { offsetMs, bpmBefore: bpm, bpm, attacks: t.length, share: null, kept: null }
  if (t.length < REFERENCE_MIN_ATTACKS || endS <= startS) return { ...row, kept: 'few' }
  const graded = gradeSpan(t, w, startS, beatS, endS)
  row.share = graded.share
  if (graded.share < REFERENCE_MIN_SHARE) return { ...row, kept: 'weak' }
  return { ...row, bpm: graded.fittedBpm }
}

/** The result's attacks (`onsets`, ms and weights 0-100) in seconds, as the refit reads them. */
export function attacksOf(onsets) {
  const t = Float64Array.from(onsets?.t_ms ?? [], (ms) => ms / 1000)
  const w = Float64Array.from(onsets?.w ?? [], (x) => Number(x) || 0)
  return w.length === t.length ? { t, w } : { t, w: new Float64Array(t.length).fill(1) }
}

/** A refitted section's beat: the line's own to the last decimal when the BPM was kept. */
const refitBeat = (row, line) => (row.kept ? line.beatMs : 60000 / row.bpm)

/**
 * `split_section`: section `index` in two, where its tempo changes. The new
 * line goes on the section's own beat nearest `atMs`, so the bars before it
 * stay where they were; it must be a beat or more after the section's line
 * and before the next. Both halves are refitted to their attacks. Returns
 * the lines, the new line's index and a report of both halves.
 */
export function splitSection(lines, index, atMs, attacks, endMs) {
  checkIndex(lines, index)
  if (lines.length >= MAX_LINES) throw new EditError('tooMany')
  const line = lines[index]
  const start = line.timeMs
  const stop = index + 1 < lines.length ? lines[index + 1].timeMs : endMs
  const beatMs = line.beatMs
  const k = roundHalfEven((atMs - start) / beatMs)
  const splitMs = start + k * beatMs
  if (k < 1 || splitMs > stop - 0.5 * beatMs) throw new EditError('splitOutside', 'Split inside the section: a beat or more after its red line, before the next one.')
  const bpm = bpmOf(line)
  const first = refitSection(attacks, start, bpm, splitMs)
  const second = refitSection(attacks, splitMs, bpm, stop)
  const head = { ...line, beatMs: refitBeat(first, line) }
  // A split on a beat need not be on a bar: the new line's meter is a guess.
  const tail = { timeMs: splitMs, beatMs: refitBeat(second, line), meter: line.meter, meterKnown: false, source: -1 }
  const out = placed(lines.map((l, i) => (i === index ? head : l)).concat([tail]), tail)
  return { ...out, report: { splitMs, sections: [first, second] } }
}

/**
 * `merge_sections`: section `index` and the next as one; the next red line
 * goes and the whole span is refitted from `index`'s line, which keeps its time.
 */
export function mergeSections(lines, index, attacks, endMs) {
  if (!Number.isInteger(index) || index < 0 || index >= lines.length - 1) throw new EditError('noNext', 'There is no next section to merge with.')
  const line = lines[index]
  const stop = index + 2 < lines.length ? lines[index + 2].timeMs : endMs
  const row = refitSection(attacks, line.timeMs, bpmOf(line), stop)
  const out = lines.filter((_, i) => i !== index + 1).map((l, i) => (i === index ? { ...l, beatMs: refitBeat(row, line) } : l))
  return { lines: out, selected: index, report: { removedMs: lines[index + 1].timeMs, sections: [row] } }
}

// ── Snapping a dragged line ──────────────────────────────────────────────────

/** The value of sorted `times` nearest `x` within `tolerance`, or `x` itself. */
export function snapTo(times, x, tolerance) {
  if (!times?.length || !(tolerance > 0)) return x
  const i = lowerBound(times, x)
  let best = x
  let distance = tolerance
  for (const j of [i - 1, i]) {
    if (j < 0 || j >= times.length) continue
    const d = Math.abs(times[j] - x)
    if (d <= distance) {
      distance = d
      best = times[j]
    }
  }
  return best
}

// ── Frames: the page's adjustment (×2 / ÷2, nudge) around the edits ─────────

/**
 * Edits are kept as the lines before the page's ×2 / ÷2 and nudge, so either
 * can still change after an edit and both apply to the edited lines as they
 * apply to the engine's. The editor works on what the reader sees; these turn
 * one into the other. Times are kept to the microsecond, which also takes off
 * the float noise of a nudge added and taken away.
 */
export const toBase = (lines, { factor = 1, nudgeMs = 0 } = {}) =>
  lines.map((l) => ({ ...l, timeMs: Math.round((l.timeMs - nudgeMs) * 1000) / 1000, beatMs: l.beatMs * factor }))

/** The engine's red lines as edit lines, before any adjustment: its beat lengths as written (12 decimals). */
export function engineEditLines(result) {
  const rows = String(result?.osu_timing ?? '')
    .split(/\r?\n/)
    .filter((row) => row && !row.startsWith('//') && row !== '[TimingPoints]')
    .map((row) => row.split(','))
  const lines = result?.red_lines ?? []
  return lines.map((line, i) => {
    const written = rows.length === lines.length ? Number(rows[i][1]) : NaN
    return {
      timeMs: line.time_ms,
      beatMs: Number.isFinite(written) && written > 0 ? written : line.beat_length_ms,
      meter: Math.max(1, Math.min(16, Math.round(line.meter) || 4)),
      meterKnown: Boolean(line.meter_known),
      source: i,
    }
  })
}

/** Whether a base line differs from the engine line it came from. */
export function lineEdited(line, engine) {
  const from = line.source >= 0 ? engine[line.source] : null
  if (!from) return true
  return Math.abs(line.timeMs - from.timeMs) > 5e-4 || Math.abs(line.beatMs - from.beatMs) > 1e-9 || line.meter !== from.meter || line.meterKnown !== from.meterKnown
}

/** `base` when it changes something of the engine's lines; null when it is the engine's reading again. */
export function normaliseEdits(base, engine) {
  if (!base) return null
  if (base.length !== engine.length) return base
  return base.some((line, i) => line.source !== i || lineEdited(line, engine)) ? base : null
}

// ── Keeping edits: compact rows, checked on the way in ──────────────────────

/** `[timeMs, beatMs, meter, meterKnown 0/1, source]` per line: what a saved version and this browser hold. */
export const packEdits = (lines) => lines.map((l) => [l.timeMs, l.beatMs, l.meter, l.meterKnown ? 1 : 0, l.source])

/**
 * Packed rows back into lines, or null when they are not a timing the page
 * can apply: the same checks the API makes on a saved version
 * (site/api services/version.service.js `parseLines`), so what one accepts
 * the other reads.
 */
export function unpackEdits(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_LINES) return null
  const out = []
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 5) return null
    const [timeMs, beatMs, meter, known, source] = row
    if (!Number.isFinite(timeMs) || Math.abs(timeMs) > 86_400_000) return null
    if (!Number.isFinite(beatMs) || beatMs < 60000 / BPM_RANGE[1] || beatMs > 60000 / BPM_RANGE[0]) return null
    if (!METERS.includes(meter) || (known !== 0 && known !== 1) || !Number.isInteger(source) || source < -1 || source > 9999) return null
    if (out.length && timeMs - out[out.length - 1].timeMs < MIN_GAP_MS) return null
    out.push({ timeMs, beatMs, meter, meterKnown: known === 1, source })
  }
  return out
}

/** A short, stable key of an edit (FNV-1a over its packed rows): two versions with the same edits share it. */
export function editsKey(lines) {
  if (!lines) return ''
  const text = JSON.stringify(packEdits(lines))
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ── Undo and redo ───────────────────────────────────────────────────────────

/** At most this many steps are kept to undo. */
export const HISTORY_LIMIT = 200

/**
 * The edits' history: `steps[at]` is the present. Each step is
 * `{ edits, label }`, `edits` the base lines (null: the engine's) and `label`
 * `{ key, values }` for the page to name it. Pure: each call returns a new one.
 */
export const createHistory = (edits = null, label = { key: 'start' }) => ({ steps: [{ edits, label }], at: 0 })

export function commit(history, edits, label) {
  const steps = [...history.steps.slice(0, history.at + 1), { edits, label }]
  const drop = Math.max(0, steps.length - HISTORY_LIMIT)
  return { steps: steps.slice(drop), at: steps.length - 1 - drop }
}

export const canUndo = (history) => history.at > 0
export const canRedo = (history) => history.at < history.steps.length - 1
export const undo = (history) => (canUndo(history) ? { ...history, at: history.at - 1 } : history)
export const redo = (history) => (canRedo(history) ? { ...history, at: history.at + 1 } : history)
/** Straight to step `at` of the list, as a click on the visible history does. */
export const jump = (history, at) => (Number.isInteger(at) && at >= 0 && at < history.steps.length ? { ...history, at } : history)
export const present = (history) => history.steps[history.at].edits

// ── This browser's copy, per analysis ───────────────────────────────────────

const draftKey = (id) => `overtone.edits.${id}`

/** The edits this browser kept for analysis `id`, or null. Storage blocked or damaged reads as none. */
export function readDraft(id) {
  try {
    const raw = JSON.parse(localStorage.getItem(draftKey(id)) ?? 'null')
    return raw && raw.v === 1 ? unpackEdits(raw.lines) : null
  } catch {
    return null
  }
}

/** Keeps (or, with null, forgets) the edits of analysis `id` in this browser. A convenience: blocked storage keeps nothing. */
export function writeDraft(id, edits) {
  try {
    if (edits) localStorage.setItem(draftKey(id), JSON.stringify({ v: 1, lines: packEdits(edits) }))
    else localStorage.removeItem(draftKey(id))
  } catch {
    // Storage blocked or full: the edits stay on the page until it closes.
  }
}
