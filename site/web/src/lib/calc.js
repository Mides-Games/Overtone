/**
 * The timing calculator's arithmetic (W13.9), pure so the tests reach it
 * without a browser; the page is pages/Calculator.jsx.
 *
 * A beat is a quarter note's worth of the BPM, as osu! counts it: one beat
 * lasts 60000 / BPM ms. A divisor d splits the beat into d ticks (osu!'s
 * "beat snap divisor": 1/4 is four ticks a beat). A bar is `meter` beats.
 *
 * Every function takes plain numbers and returns null (or an object of
 * nulls) when its input cannot give an answer: an empty field, a zero or
 * negative BPM, a span that does not move forward. The page shows "–" for a
 * null; it never shows a number it had to invent.
 */

const ok = (x) => typeof x === 'number' && Number.isFinite(x)
const positive = (x) => ok(x) && x > 0

/**
 * A field's text as a number: a comma is a decimal point (half the site's
 * languages write one), spaces are ignored, and anything else that is not a
 * plain number is null. "1,5" is 1.5; "1 234.5" is 1234.5; "" and "abc" are null.
 */
export function parseNumber(text) {
  if (typeof text === 'number') return ok(text) ? text : null
  const clean = String(text ?? '')
    .trim()
    .replace(/[\s  ]/g, '')
    .replace(',', '.')
    .replace(/^[−–]/, '-')
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(clean)) return null
  const n = Number(clean)
  return ok(n) ? n : null
}

/** One beat in ms at `bpm`. */
export const msPerBeat = (bpm) => (positive(bpm) ? 60000 / bpm : null)

/** The BPM whose beat lasts `ms`. The same formula: it is its own inverse. */
export const bpmFromMs = (ms) => (positive(ms) ? 60000 / ms : null)

/** One tick of divisor `divisor` (1/divisor of a beat) in ms. */
export function tickMs(bpm, divisor) {
  const beat = msPerBeat(bpm)
  return beat !== null && positive(divisor) ? beat / divisor : null
}

/**
 * How many ticks of 1/`divisor` a span of `ms` is at `bpm`: `{ ticks, beats,
 * nearest, offMs }`, `nearest` the whole tick closest to it and `offMs` how far
 * the span is past that tick (negative: short of it).
 */
export function msToTicks(ms, bpm, divisor) {
  const tick = tickMs(bpm, divisor)
  if (tick === null || !ok(ms)) return { ticks: null, beats: null, nearest: null, offMs: null }
  const ticks = ms / tick
  const nearest = Math.round(ticks)
  return { ticks, beats: ms / msPerBeat(bpm), nearest, offMs: ms - nearest * tick }
}

/** `ticks` ticks of 1/`divisor` at `bpm`, in ms. */
export function ticksToMs(ticks, bpm, divisor) {
  const tick = tickMs(bpm, divisor)
  return tick !== null && ok(ticks) ? ticks * tick : null
}

/**
 * Where a second red line falls on the first one's grid: the first at
 * `fromMs` and `bpm`, the second at `toMs`. `{ spanMs, beats, bars, nearestBeat,
 * offMs, gridMs }`: `beats` the span in the first line's beats, `nearestBeat`
 * the whole beat closest, `gridMs` where that beat sits and `offMs` how far the
 * second line is from it (positive: late). A second line that only restates
 * the first one's grid has `offMs` 0.
 */
export function lineOffset(fromMs, bpm, toMs, meter = 4) {
  const beat = msPerBeat(bpm)
  if (beat === null || !ok(fromMs) || !ok(toMs)) return { spanMs: null, beats: null, bars: null, nearestBeat: null, offMs: null, gridMs: null }
  const spanMs = toMs - fromMs
  const beats = spanMs / beat
  const nearestBeat = Math.round(beats)
  const gridMs = fromMs + nearestBeat * beat
  return { spanMs, beats, bars: positive(meter) ? beats / meter : null, nearestBeat, offMs: toMs - gridMs, gridMs }
}

/**
 * The earliest offset that draws the same grid as a line at `offsetMs`: the
 * offset folded into the first beat, [0, one beat). osu! starts a red line's
 * grid where the line is, so this is where the same beats would begin at the
 * song's start.
 */
export function firstBeatOffset(offsetMs, bpm) {
  const beat = msPerBeat(bpm)
  if (beat === null || !ok(offsetMs)) return null
  const folded = ((offsetMs % beat) + beat) % beat
  return folded >= beat - 1e-9 ? 0 : folded
}

/**
 * How far a grid at `mappedBpm` drifts from one at `trueBpm` over `bars` bars
 * of `meter` beats, both starting together: `{ beats, driftMs, perBarMs }`,
 * positive when the mapped grid runs late (a slower BPM). The drift grows
 * linearly: each beat adds the difference of the two beat lengths.
 */
export function drift(trueBpm, mappedBpm, bars, meter = 4) {
  const a = msPerBeat(trueBpm)
  const b = msPerBeat(mappedBpm)
  if (a === null || b === null || !ok(bars) || !positive(meter)) return { beats: null, driftMs: null, perBarMs: null }
  const beats = bars * meter
  return { beats, driftMs: beats * (b - a), perBarMs: meter * (b - a) }
}

/**
 * The BPMs that drift `driftMs` from `bpm` in `bars` bars of `meter` beats:
 * `{ slower, faster, bpmDelta }`. `slower` runs late by that much, `faster`
 * early; `bpmDelta` is the smaller distance from `bpm`, which is the
 * precision a BPM needs for its grid to stay within `driftMs` over that span.
 */
export function bpmForDrift(bpm, driftMs, bars, meter = 4) {
  const beat = msPerBeat(bpm)
  if (beat === null || !ok(driftMs) || !positive(bars) || !positive(meter)) return { slower: null, faster: null, bpmDelta: null }
  const perBeat = Math.abs(driftMs) / (bars * meter)
  const slower = 60000 / (beat + perBeat)
  const faster = beat - perBeat > 0 ? 60000 / (beat - perBeat) : null
  return { slower, faster, bpmDelta: bpm - slower }
}

/**
 * The BPM that puts `beats` beats between two timestamps (ms): `{ bpm,
 * beatMs }`. The order of the timestamps does not matter; zero beats or the
 * same timestamp twice gives nulls.
 */
export function bpmFromSpan(startMs, endMs, beats) {
  if (!ok(startMs) || !ok(endMs) || !positive(beats)) return { bpm: null, beatMs: null }
  const span = Math.abs(endMs - startMs)
  if (!(span > 0)) return { bpm: null, beatMs: null }
  return { bpm: (beats * 60000) / span, beatMs: span / beats }
}

/**
 * A number for a readout: `digits` decimals, trailing zeros kept so a column
 * lines up, "–" for null, a true minus sign, and no "-0".
 */
export function readout(x, digits = 3) {
  if (!ok(x)) return '–'
  const text = x.toFixed(digits)
  if (/^-0(\.0*)?$/.test(text)) return text.slice(1)
  return text.replace(/^-/, '−')
}

/**
 * The step an arrow key moves a field by: 1, ×10 with Shift, ×0.1 with Alt
 * (a finer step for the decimals a timing needs); `base` scales all three.
 */
export function arrowStep(event, base = 1) {
  if (event?.shiftKey) return base * 10
  if (event?.altKey) return base / 10
  return base
}

/**
 * `value` moved by `delta`, rounded to the step's own decimals so 0.1 + 0.2
 * reads 0.3, as text for the field. A field that holds no number starts at 0.
 */
export function stepValue(text, delta) {
  const now = parseNumber(text) ?? 0
  const decimals = Math.max(decimalsOf(now), decimalsOf(delta))
  return String(Number((now + delta).toFixed(Math.min(9, decimals))))
}

export const CALCULATOR_PATH = '/tools/calculator'

/**
 * The calculator with a red line's BPM and offset filled in (the result
 * page's link): `?bpm=` to 6 decimals and `?offset=` to 3, the zeros dropped.
 * Timing only, never a file name, so the address says nothing about the song.
 */
export function calculatorPath(line) {
  if (!line || !(line.beatMs > 0) || !Number.isFinite(line.timeMs)) return CALCULATOR_PATH
  const params = new URLSearchParams({ bpm: String(Number((60000 / line.beatMs).toFixed(6))), offset: String(Number(line.timeMs.toFixed(3))) })
  return `${CALCULATOR_PATH}?${params}`
}

/** What a link fills in: `{ bpm, offset }` as field text, '' when absent or not a number. */
export function calculatorSeed(search) {
  const params = new URLSearchParams(search ?? '')
  const pick = (key, test) => {
    const n = parseNumber(params.get(key) ?? '')
    return n !== null && test(n) ? String(n) : ''
  }
  return { bpm: pick('bpm', (n) => n > 0 && n < 10000), offset: pick('offset', (n) => Math.abs(n) < 1e8) }
}

const decimalsOf = (x) => {
  const s = String(x)
  if (/e-/i.test(s)) return Number(s.split(/e-/i)[1]) + (s.split('.')[1]?.split(/e/i)[0].length ?? 0)
  return s.split('.')[1]?.length ?? 0
}
