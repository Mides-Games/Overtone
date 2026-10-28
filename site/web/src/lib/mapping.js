/**
 * Mapping helpers for the .osz and the patched .osu (W13.1-W13.5), all built
 * in the browser from the red lines as the reader exports them and from what
 * the engine already sent (the attacks and the onset envelope):
 *
 * - the grid and snapping to it (W13.2, and the test map's ticks);
 * - which divisor the attacks fall on, and the `BeatDivisor` to suggest (W13.3);
 * - the long silences as osu! breaks (W13.4);
 * - a playable test map: a circle on every beat or half beat (W13.1);
 * - the game modes and the empty difficulties' settings (W13.5).
 *
 * None of these is a measurement of the timing. The divisor and the breaks
 * are guesses from the attacks, the test map is for the mapper's own hands;
 * the page says so. Pure functions on arrays and strings, so node:test runs
 * them.
 */
import { roundHalfEven } from './timing.js'

/** The beat divisors osu!'s editor offers, and so the ones a snap may use. */
export const SNAP_DIVISORS = [1, 2, 3, 4, 6, 8, 12, 16]

/**
 * Red lines as osu! reads them: `{ time, beatLength, meter }` from
 * `[TimingPoints]` rows (strings), red ones only, sorted. A row that is not a
 * red line (a green one, a comment) is skipped.
 */
export function redPoints(rows) {
  const out = []
  for (const raw of rows) {
    const f = String(raw).trim().split(',')
    if (f.length < 2 || f[0].startsWith('//')) continue
    const time = Number(f[0])
    const beatLength = Number(f[1])
    const red = f.length > 6 ? f[6].trim() !== '0' : beatLength > 0
    if (!red || !Number.isFinite(time) || !(beatLength > 0)) continue
    out.push({ time, beatLength, meter: Math.max(1, Math.round(Number(f[2])) || 4) })
  }
  return out.sort((a, b) => a.time - b.time)
}

/** The red line in force at `ms`: the last at or before it, else the first (osu! reads earlier objects against it). */
export function pointAt(points, ms) {
  let found = points[0] ?? null
  for (const p of points) if (p.time <= ms + 1e-9) found = p
  return found
}

/**
 * The nearest tick of the 1/`divisor` grid to `ms`, in whole ms as osu!
 * stores an object's time. The grid is the red line in force at `ms`,
 * counted from its own offset (a red line restarts it).
 */
export function snapTime(points, ms, divisor) {
  const p = pointAt(points, ms)
  if (!p) return roundHalfEven(ms)
  const step = p.beatLength / divisor
  return roundHalfEven(p.time + Math.round((ms - p.time) / step) * step)
}

/* ------------------------------------------------------------------ W13.3 */

/** The divisors the histogram sorts attacks into, simplest first, and what is left over. */
export const HISTOGRAM_DIVISORS = [1, 2, 3, 4, 6, 8]
/** The divisors a suggestion may name, in the order of their fineness. */
export const SUGGESTED_DIVISORS = [2, 3, 4, 6, 8]
/** Fewer attacks than this on any tick, and nothing is suggested. */
export const MIN_ATTACKS = 16
/** The share of the attacks on some tick that the suggested divisor must hold. */
export const COVERAGE = 0.9

/**
 * How far an attack may sit from a tick and still count as on it: a 48th of
 * the beat, so the tick sets of 1/6 and 1/8 (the closest pair, a 24th of a
 * beat apart) never both claim an attack, and at most 15 ms, the drift a
 * well-timed map's attacks show.
 */
export const tolerance = (beatMs) => Math.min(15, beatMs / 48)

/**
 * The simplest divisor an attack at `ms` sits on under `line`
 * (`{ timeMs, beatMs }`): 1 (the beat), 2, 3, 4, 6 or 8, or 0 when it is on
 * none of them.
 */
export function divisorOf(ms, line) {
  const beat = line.beatMs
  const tol = tolerance(beat)
  const into = (((ms - line.timeMs) % beat) + beat) % beat
  for (const d of HISTOGRAM_DIVISORS) {
    const step = beat / d
    const off = Math.abs(into - Math.round(into / step) * step)
    if (off <= tol + 1e-9) return d
  }
  return 0
}

const emptyBins = () => Object.fromEntries([...HISTOGRAM_DIVISORS, 0].map((d) => [d, 0]))

/**
 * The attacks per divisor under each red line and over the song. `onsets` is
 * the result's `{ t_ms, w }`; each attack counts its weight (0-100, as a
 * share: a faint one counts less), and belongs to the line it falls under (an
 * attack before the first line, to the first). Returns `{ lines: [h], all: h }`,
 * each `h` being `{ bins, attacks, onTick }`: `bins` the weights keyed by
 * divisor (0 = on none), `attacks` the count and `onTick` the count on some
 * tick.
 */
export function divisorHistogram(onsets, lines) {
  const t = onsets?.t_ms ?? []
  const w = onsets?.w ?? []
  const per = lines.map(() => ({ bins: emptyBins(), attacks: 0, onTick: 0 }))
  const all = { bins: emptyBins(), attacks: 0, onTick: 0 }
  if (!lines.length) return { lines: per, all }
  let li = 0
  for (let i = 0; i < t.length; i++) {
    const ms = t[i]
    if (!Number.isFinite(ms)) continue
    while (li + 1 < lines.length && lines[li + 1].timeMs <= ms) li++
    const line = lines[li]
    if (!(line.beatMs > 0)) continue
    const d = divisorOf(ms, line)
    const weight = Number.isFinite(w[i]) ? Math.max(0, w[i]) / 100 : 1
    for (const h of [per[li], all]) {
      h.bins[d] += weight
      h.attacks++
      if (d) h.onTick++
    }
  }
  return { lines: per, all }
}

/**
 * The `BeatDivisor` to suggest from a histogram's `{ bins, onTick }`: the
 * coarsest of 1/2, 1/3, 1/4, 1/6 and 1/8 whose ticks hold at least 90 % of
 * the attacks that sit on any tick (1/6 holds 1/1, 1/2, 1/3 and 1/6; 1/8
 * holds 1/1, 1/2, 1/4 and 1/8), else the one that holds most. Null with fewer
 * than 16 attacks on any tick: too little to say.
 */
export function suggestDivisor({ bins, onTick }) {
  const onTicks = HISTOGRAM_DIVISORS.reduce((sum, d) => sum + bins[d], 0)
  if (!(onTick >= MIN_ATTACKS) || onTicks <= 0) return null
  const coverage = (d) => HISTOGRAM_DIVISORS.filter((c) => d % c === 0).reduce((sum, c) => sum + bins[c], 0) / onTicks
  const first = SUGGESTED_DIVISORS.find((d) => coverage(d) >= COVERAGE - 1e-9)
  if (first) return first
  return SUGGESTED_DIVISORS.reduce((best, d) => (coverage(d) > coverage(best) + 1e-9 ? d : best))
}

/* ------------------------------------------------------------------ W13.4 */

/**
 * osu!'s break rules, as osu!(lazer)'s `BreakPeriod` states them as far as
 * we know: a break starts at least 200 ms after the object before it, ends at
 * least 450 ms before the object after it, and is at least 650 ms long.
 */
export const GAP_BEFORE_BREAK = 200
export const GAP_AFTER_BREAK = 450
export const MIN_BREAK_MS = 650
/**
 * Our own rule on top: only a silence of at least 5 s becomes a break. osu!
 * would take one of 1.3 s, but a pause that short is a rest the mapper maps
 * around, not a break the player is shown.
 */
export const MIN_SILENCE_MS = 5000
/** An envelope value at or under this (of 100, the song's loudest) is silence. */
export const QUIET = 5
/** An attack this strong (of 100) inside a stretch means it was not silent. */
export const LOUD_ATTACK = 20

/**
 * Suggested breaks, `{ startMs, endMs }` in whole ms: the stretches where the
 * onset envelope (the result's `onset_envelope`, `{ span_ms, v, start_ms }`)
 * stays at or under QUIET and no attack of LOUD_ATTACK or more sounds, of at
 * least MIN_SILENCE_MS, between the first and the last attack (osu! never has
 * a break before the first object or after the last). Each is shrunk by
 * osu!'s gaps and kept when it is still at least MIN_BREAK_MS long.
 */
export function suggestBreaks({ envelope, onsets }) {
  const v = envelope?.v ?? []
  const span = envelope?.span_ms ?? 0
  const t = onsets?.t_ms ?? []
  const w = onsets?.w ?? []
  if (!v.length || !(span > 0) || t.length < 2) return []
  const from = envelope.start_ms ?? 0
  const per = span / v.length
  const loud = []
  for (let i = 0; i < t.length; i++) if (!Number.isFinite(w[i]) || w[i] >= LOUD_ATTACK) loud.push(t[i])
  if (loud.length < 2) return []
  const first = loud[0]
  const last = loud[loud.length - 1]

  const quiet = []
  let run = null
  v.forEach((value, i) => {
    if (value <= QUIET) {
      if (run) run.b = i + 1
      else quiet.push((run = { a: i, b: i + 1 }))
    } else run = null
  })

  const out = []
  for (const q of quiet) {
    let a = from + q.a * per
    let b = from + q.b * per
    // Only between the first and the last attack; and no loud attack inside.
    a = Math.max(a, first)
    b = Math.min(b, last)
    const inside = loud.filter((ms) => ms > a + 1e-6 && ms < b - 1e-6)
    // A loud attack splits the stretch: each side is judged on its own.
    const edges = [a, ...inside, b]
    for (let k = 0; k + 1 < edges.length; k++) {
      const s = edges[k]
      const e = edges[k + 1]
      if (e - s < MIN_SILENCE_MS) continue
      const startMs = Math.ceil(s + GAP_BEFORE_BREAK)
      const endMs = Math.floor(e - GAP_AFTER_BREAK)
      if (endMs - startMs >= MIN_BREAK_MS) out.push({ startMs, endMs })
    }
  }
  return out
}

/** The `[Events]` rows for `breaks`, as osu! writes them. */
export const breakRows = (breaks) => breaks.map((b) => `2,${b.startMs},${b.endMs}`)

/* ------------------------------------------------------------------ W13.5 */

/** osu!'s four modes, by their `Mode:` number. */
export const MODES = [
  { mode: 0, key: 'osu' },
  { mode: 1, key: 'taiko' },
  { mode: 2, key: 'catch' },
  { mode: 3, key: 'mania' },
]
/** The key counts offered for mania, written as `CircleSize`. */
export const MANIA_KEYS = [4, 5, 6, 7, 8, 9, 10]
export const normalMode = (mode) => (MODES.some((m) => m.mode === mode) ? mode : 0)
export const normalKeys = (keys) => (MANIA_KEYS.includes(keys) ? keys : 4)

/**
 * The empty difficulties, Easy to Expert, each a starting point the mapper
 * moves in the editor: HP, CS, OD and AR rising with the level as most ranked
 * sets have them. Our choice, not a rule of osu!'s; mania writes the key count
 * as CircleSize instead.
 */
export const DIFFICULTIES = [
  { name: 'Easy', hp: 2, cs: 3, od: 2, ar: 3 },
  { name: 'Normal', hp: 3, cs: 3.5, od: 4, ar: 5 },
  { name: 'Hard', hp: 4, cs: 4, od: 6, ar: 7 },
  { name: 'Insane', hp: 5, cs: 4, od: 8, ar: 9 },
  { name: 'Expert', hp: 6, cs: 4.2, od: 9, ar: 9.4 },
]
/** osu!'s default difficulty, what the Timing difficulty has always had. */
export const DEFAULT_DIFFICULTY = { hp: 5, cs: 4, od: 5, ar: 5 }

/* ------------------------------------------------------------------ W13.1 */

/** The test map's subdivisions: a circle on every beat, or on every half beat. */
export const TEST_SUBS = [1, 2]
/** A test map never holds more circles than this (a 10-minute song at 200 BPM in halves is 4000). */
export const MAX_TEST_OBJECTS = 20000
export const testVersion = (sub) => `Overtone test (1/${sub})`

// osu!'s hitsound bits and object types.
const WHISTLE = 2
const FINISH = 4
const CIRCLE = 1
const NEW_COMBO = 4

/**
 * Where a circle goes on the 512x384 playfield, by its place in the bar
 * (`slot` of `slots`): around a circle of radius 120 from the top, clockwise,
 * so every bar draws the same ring and the bar's first beat is always at the
 * top. Mania puts them in the columns in turn, the bar's first in the first
 * column; taiko ignores the position.
 */
function position(slot, slots, mode, keys) {
  if (mode === 3) {
    const column = slot % keys
    return { x: Math.floor(((column + 0.5) * 512) / keys), y: 192 }
  }
  if (mode === 1) return { x: 256, y: 192 }
  const angle = (slot / slots) * 2 * Math.PI
  return { x: Math.round(256 + 120 * Math.sin(angle)), y: Math.round(192 - 120 * Math.cos(angle)) }
}

/**
 * The test map's `[HitObjects]` rows: a circle on every beat (`sub` 1) or half
 * beat (`sub` 2) of every red line, from the first red line to `durationMs`
 * (a line's ticks stop where the next one starts), none inside a break and
 * its gaps. The bar's first beat starts a combo and plays a finish (a big don
 * in taiko); a half beat plays a whistle (a kat in taiko), so the hands hear
 * the bar and the off-beat apart.
 */
export function testObjects({ points, durationMs, sub = 1, mode = 0, keys = 4, breaks = [] }) {
  const s = TEST_SUBS.includes(sub) ? sub : 1
  const m = normalMode(mode)
  const k = normalKeys(keys)
  const rows = []
  const inBreak = (ms) => breaks.some((b) => ms > b.startMs - GAP_BEFORE_BREAK && ms < b.endMs + GAP_AFTER_BREAK)
  points.forEach((p, i) => {
    const end = Math.min(i + 1 < points.length ? points[i + 1].time : Infinity, durationMs)
    const step = p.beatLength / s
    const slots = p.meter * s
    for (let n = 0; rows.length < MAX_TEST_OBJECTS; n++) {
      const ms = roundHalfEven(p.time + n * step)
      if (ms >= end - 0.5) break
      if (inBreak(ms)) continue
      const slot = n % slots
      const { x, y } = position(slot, slots, m, k)
      const barStart = slot === 0
      const type = CIRCLE | (barStart ? NEW_COMBO : 0)
      const sound = barStart ? FINISH : n % s ? WHISTLE : 0
      rows.push(`${x},${y},${ms},${type},${sound},0:0:0:0:`)
    }
  })
  return rows
}
