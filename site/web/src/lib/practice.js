/**
 * Practice mode (W13.8): one stretch of the song played N times, each a
 * little faster, from half speed to full, after a bar counted in. The plan is
 * pure arithmetic, kept here so node:test can check it; the player
 * (lib/player.js) schedules it on the audio clock.
 */
import { BAR, BEAT, lowerBound } from './timing.js'

export const PRACTICE_FROM = 0.5
export const PRACTICE_TO = 1
export const PRACTICE_REPS = [3, 4, 5, 6, 8]
export const DEFAULT_REPS = 4
/** A stretch shorter than this is no stretch to practise; longer than this, a section at a time. */
export const MIN_STRETCH_S = 0.5
export const MAX_STRETCH_S = 120

/** `n` rates from `from` to `to`, evenly spaced and rounded to the hundredth; one repetition plays at `to`. */
export function practiceRates(n, from = PRACTICE_FROM, to = PRACTICE_TO) {
  const count = Math.max(1, Math.round(n))
  if (count === 1) return [to]
  return Array.from({ length: count }, (_, k) => Math.round((from + ((to - from) * k) / (count - 1)) * 100) / 100)
}

/**
 * The count-in for a stretch that starts at `a` seconds, from the beat grid
 * (`clickGrid`'s `{ t, level }`): the beats of one bar before `a`, as song
 * seconds relative to `a` (negative), each with its level, the first a bar's.
 * Read off the grid itself, so a 3/4 section counts three and a tempo change
 * is honoured; with no grid near, four beats at 120 BPM.
 */
export function countIn(grid, a) {
  const t = grid?.t ?? []
  const level = grid?.level ?? []
  if (t.length < 2) return Array.from({ length: 4 }, (_, k) => ({ s: (k - 4) * 0.5, level: k === 0 ? BAR : BEAT }))
  const i = Math.min(lowerBound(t, a - 1e-6), t.length - 1)
  const beat = beatNear(t, i)
  // Beats per bar: from the bar line at or before `a` to the next one, else four.
  let bar = i
  while (bar > 0 && level[bar] !== BAR) bar--
  let next = bar + 1
  while (next < t.length && level[next] !== BAR) next++
  const meter = level[bar] === BAR && next < t.length ? Math.max(2, Math.min(7, next - bar)) : 4
  return Array.from({ length: meter }, (_, k) => ({ s: (k - meter) * beat, level: k === 0 ? BAR : BEAT }))
}

function beatNear(t, i) {
  if (t.length < 2) return 0.5
  const j = Math.min(Math.max(i, 1), t.length - 1)
  return t[j] - t[j - 1] || 0.5
}

/**
 * The schedule, in real seconds from the start: the count-in at the first
 * rate, then each repetition of `[a, b)` back to back.
 *
 *   { a, b, rates, counts: [{ at, level }], reps: [{ at, end, rate }], end }
 */
export function practicePlan({ a, b, rates, count = [] }) {
  const first = rates[0] ?? 1
  // The count-in plays in the first repetition's time: its beats are song seconds before `a`, at that rate.
  const lead = count.length ? -count[0].s / first : 0
  const counts = count.map((c) => ({ at: lead + c.s / first, level: c.level }))
  const reps = []
  let at = lead
  for (const rate of rates) {
    const end = at + (b - a) / rate
    reps.push({ at, end, rate })
    at = end
  }
  return { a, b, rates, counts, reps, end: at }
}

/**
 * Where the plan is `elapsed` real seconds after its start:
 * `{ rep (-1 in the count-in), pos (song seconds), rate, done }`.
 */
export function practiceAt(plan, elapsed) {
  const { reps, a, b } = plan
  if (!reps.length || elapsed < reps[0].at) return { rep: -1, pos: a, rate: reps[0]?.rate ?? 1, done: false }
  for (let k = 0; k < reps.length; k++) {
    const r = reps[k]
    if (elapsed < r.end) return { rep: k, pos: Math.min(b, a + (elapsed - r.at) * r.rate), rate: r.rate, done: false }
  }
  const last = reps[reps.length - 1]
  return { rep: reps.length - 1, pos: b, rate: last.rate, done: true }
}
