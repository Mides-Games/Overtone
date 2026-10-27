/**
 * What the result page makes of the reader's taps (W12.2-W12.4): their device's
 * audio latency, a tempo tapped by hand, and how far their taps sit from the
 * red lines' grid. Pure functions of numbers, no DOM, so each rule is tested.
 *
 * A tap is a person's hand, not a measurement of the song: every reading here
 * comes with its spread and how many taps it kept, and none is offered under
 * a minimum count. The page proposes; the reader applies, by ear.
 */
import { lowerBound } from './timing.js'

/** Where the device's latency is kept (shared key, see docs/site.md). */
export const LATENCY_KEY = 'overtone.player.latencyMs'
/** A stored latency outside this range is a broken value, not a device. */
export const LATENCY_LIMIT_MS = 500

/** Taps further apart than this start a new run: the reader stopped and began again. */
export const TAP_GAP_MS = 2000
/** The most recent taps kept in a run; older ones fall off, so a run follows a tempo change. */
export const TAP_KEEP = 24

/** Fewest taps for each reading: four taps give three intervals; an offset wants about two bars. */
export const MIN_TEMPO_TAPS = 4
export const MIN_OFFSET_TAPS = 8
export const MIN_LATENCY_TAPS = 8

/** MAD to a normal standard deviation. */
const MAD_SCALE = 1.4826

export function median(values) {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The median of `values` after the outliers are dropped: anything further
 * from the median than `k` robust deviations (1.4826 × MAD), or than `floor`
 * when the taps agree so well that the MAD is about nothing (a dead-steady
 * hand must not throw out a tap 2 ms off). Then the median and the spread
 * (1.4826 × MAD) of what was kept, and how many were kept and dropped.
 */
export function robustCentre(values, { k = 3, floor = 0 } = {}) {
  const finite = values.filter(Number.isFinite)
  if (!finite.length) return { centre: NaN, spread: NaN, kept: 0, dropped: values.length, values: [] }
  const m = median(finite)
  const mad = median(finite.map((v) => Math.abs(v - m))) * MAD_SCALE
  const limit = Math.max(k * mad, floor)
  const kept = finite.filter((v) => Math.abs(v - m) <= limit)
  const centre = median(kept)
  return {
    centre,
    spread: median(kept.map((v) => Math.abs(v - centre))) * MAD_SCALE,
    kept: kept.length,
    dropped: values.length - kept.length,
    values: kept,
  }
}

/**
 * The run with one more tap at `atMs` (a performance timestamp): a gap longer
 * than `TAP_GAP_MS` starts a new run, and only the last `TAP_KEEP` are held.
 * A tap at or before the last one (a key's auto-repeat, a doubled event) is
 * ignored.
 */
export function addTap(taps, atMs, keep = TAP_KEEP) {
  if (!Number.isFinite(atMs)) return taps
  const last = taps[taps.length - 1]
  if (last !== undefined && atMs <= last) return taps
  if (last !== undefined && atMs - last > TAP_GAP_MS) return [atMs]
  return [...taps, atMs].slice(-keep)
}

/**
 * The tempo of a run of taps (ms): the median interval with the stray ones
 * dropped (a missed or doubled tap is half or twice the others), and the
 * spread of the BPM the kept intervals give, in BPM. `null` under
 * `MIN_TEMPO_TAPS` taps.
 */
export function tapTempo(taps) {
  if (taps.length < MIN_TEMPO_TAPS) return null
  const intervals = []
  for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1])
  // A tenth of the interval: a hand is easily that uneven without a tap being stray.
  const { centre, kept, values } = robustCentre(intervals, { floor: median(intervals) * 0.1 })
  if (!(centre > 0) || kept < MIN_TEMPO_TAPS - 1) return null
  const spread = robustCentre(values.map((v) => 60000 / v)).spread
  return { bpm: 60000 / centre, spreadBpm: Number.isFinite(spread) ? spread : 0, taps: taps.length, kept: kept + 1 }
}

/**
 * A tapped tempo against the result's at the same place: `match` within 4 %,
 * `double` or `half` when the tap is near twice or half of it (the octave the
 * engine may have picked the other way), `other` with the ratio otherwise.
 * Four per cent: a run of a dozen taps is rarely closer than 1-2 %, and the
 * next simple ratio (3:2) is 50 % away.
 */
export function compareTempo(tapBpm, resultBpm, tolerance = 0.04) {
  if (!(tapBpm > 0) || !(resultBpm > 0)) return null
  const ratio = tapBpm / resultBpm
  for (const [kind, target] of [
    ['match', 1],
    ['double', 2],
    ['half', 0.5],
  ]) {
    if (Math.abs(ratio / target - 1) <= tolerance) return { kind, ratio }
  }
  return { kind: 'other', ratio }
}

/**
 * Each time in `times` (seconds) against the nearest entry of the sorted
 * `grid` (seconds), signed: positive when it comes after it. In ms.
 */
export function offsetsToGrid(times, grid) {
  const out = []
  for (const t of times) {
    const i = lowerBound(grid, t)
    let best = NaN
    for (const j of [i - 1, i]) {
      if (j < 0 || j >= grid.length) continue
      const d = t - grid[j]
      if (!Number.isFinite(best) || Math.abs(d) < Math.abs(best)) best = d
    }
    if (Number.isFinite(best)) out.push(best * 1000)
  }
  return out
}

/**
 * The device's latency from a calibration (W12.2): `offsetsMs`, each tap
 * against the click it answered (positive: the tap came after). The median
 * once stray taps are dropped, with its spread. `null` under
 * `MIN_LATENCY_TAPS` kept taps, or when the hand was too uneven to say
 * (a spread over 40 ms is a person finding the beat, not a device).
 */
export function latencyEstimate(offsetsMs) {
  const { centre, spread, kept, dropped } = robustCentre(offsetsMs, { floor: 15 })
  if (kept < MIN_LATENCY_TAPS || !Number.isFinite(centre)) return null
  if (spread > 40 || Math.abs(centre) > LATENCY_LIMIT_MS) return { unsteady: true, kept, dropped, spread }
  return { latencyMs: Math.round(centre), spreadMs: spread, kept, dropped }
}

/**
 * The global nudge the reader's taps suggest (W12.4): `songTimes` are the
 * taps already placed on the song's own timeline, the latency taken out, and
 * `beats` the grid's beats (seconds). Taps that land after the beats say the
 * song's beats are later than the red lines, so the lines should move later:
 * the proposal is the median signed offset, the stray taps dropped, rounded to
 * a whole ms (the nudge's own step). `null` under `MIN_OFFSET_TAPS` kept taps.
 */
export function offsetProposal(songTimes, beats) {
  const offsets = offsetsToGrid(songTimes, beats)
  const { centre, spread, kept, dropped } = robustCentre(offsets, { floor: 15 })
  if (kept < MIN_OFFSET_TAPS || !Number.isFinite(centre)) return null
  return { nudgeMs: Math.round(centre), spreadMs: spread, kept, dropped }
}

// Reading `localStorage` itself can throw (blocked site data), so it is reached inside the try.
const local = (storage) => storage ?? globalThis.localStorage

/** The stored latency in ms, or 0 when there is none or it is not a sane number. */
export function readLatency(storage) {
  try {
    const raw = local(storage)?.getItem(LATENCY_KEY)
    const value = Number(raw)
    return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(value) && Math.abs(value) <= LATENCY_LIMIT_MS ? Math.round(value) : 0
  } catch {
    return 0
  }
}

/** Keeps `ms` as the latency, or forgets it when `ms` is 0 or null. */
export function writeLatency(ms, storage) {
  try {
    if (!ms) local(storage)?.removeItem(LATENCY_KEY)
    else local(storage)?.setItem(LATENCY_KEY, String(Math.max(-LATENCY_LIMIT_MS, Math.min(LATENCY_LIMIT_MS, Math.round(ms)))))
  } catch {
    // Private mode or blocked storage: the latency holds for this page only.
  }
}

/**
 * The player's listening options (this page's own key): the subdivision, its
 * volume (relative to the clicks') and whether the clicks are moved by the
 * latency. Each field validated on its own, so one broken value keeps the rest.
 */
export const LISTENING_KEY = 'overtone.player.listening'
export const DEFAULT_SUB_VOLUME = 0.6

export function readListening(storage) {
  const out = { subdivision: 1, subVolume: DEFAULT_SUB_VOLUME, shiftClicks: false }
  try {
    const stored = JSON.parse(local(storage)?.getItem(LISTENING_KEY) ?? '{}') ?? {}
    if ([1, 2, 3, 4].includes(stored.subdivision)) out.subdivision = stored.subdivision
    if (typeof stored.subVolume === 'number' && stored.subVolume >= 0 && stored.subVolume <= 1) out.subVolume = stored.subVolume
    if (typeof stored.shiftClicks === 'boolean') out.shiftClicks = stored.shiftClicks
  } catch {
    // Unreadable: the defaults.
  }
  return out
}

export function writeListening(options, storage) {
  try {
    local(storage)?.setItem(LISTENING_KEY, JSON.stringify(options))
  } catch {
    // Private mode or blocked storage: the options hold for this page only.
  }
}
