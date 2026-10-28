/**
 * Suggestions for the .osz (W12.9): where osu!'s song select should start
 * the preview, whether the map wants an audio lead-in, and where kiai time
 * could go. Read from the song as the browser decoded it for the waveform and
 * from the red lines as the reader has them, so every suggestion sits on a bar
 * of the timing they will export.
 *
 * None of these is a measurement of the timing, and the page says so: they
 * are a mapper's choices, guessed from loudness, to be checked in the editor.
 * Pure functions on arrays, no Web Audio, so node:test runs them.
 */
import { roundHalfEven } from './timing.js'

/** The loudness frame: 50 ms, fine enough to land on a bar, coarse enough to be cheap. */
export const FRAME_S = 0.05

/**
 * Mean square per `frameS` of the song, the channels averaged: a six-minute
 * song is 7200 numbers. `channels` are Float32Arrays of equal length.
 */
export function energyFrames(channels, sampleRate, frameS = FRAME_S) {
  const length = channels[0]?.length ?? 0
  const hop = Math.max(1, Math.round(sampleRate * frameS))
  const n = Math.ceil(length / hop)
  const out = new Float32Array(n)
  for (const channel of channels) {
    for (let f = 0; f < n; f++) {
      let sum = 0
      const end = Math.min(length, (f + 1) * hop)
      for (let i = f * hop; i < end; i++) sum += channel[i] * channel[i]
      out[f] += sum / (end - f * hop) / channels.length
    }
  }
  return out
}

/**
 * Every bar start the lines imply, in ms, up to `durationMs`: each line's bars
 * from its offset up to the next line (a red line restarts the bar in osu!),
 * and the first line's bars carried back to the song's start, as osu! reads
 * anything before the first red line against it. `{ ms, line, meter }`, sorted.
 */
export function barStarts(lines, durationMs) {
  const bars = []
  lines.forEach((line, i) => {
    const bar = line.beatMs * line.meter
    if (!(bar > 0) || !Number.isFinite(line.timeMs)) return
    const end = i + 1 < lines.length ? lines[i + 1].timeMs : durationMs
    let k = i === 0 ? -Math.floor(line.timeMs / bar) : 0
    for (let steps = 0; steps < 100_000; steps++, k++) {
      const ms = line.timeMs + k * bar
      if (ms >= end - 1e-6 || ms > durationMs) break
      if (ms >= -1e-6) bars.push({ ms: Math.max(0, ms), line: i, meter: line.meter })
    }
  })
  return bars
}

/** The bar start nearest `ms`, or `ms` itself when there is none. */
function nearestBar(bars, ms) {
  let best = null
  for (const bar of bars) if (best === null || Math.abs(bar.ms - ms) < Math.abs(best - ms)) best = bar.ms
  return best ?? ms
}

/**
 * `PreviewTime`, in whole ms: the start of the loudest `windowS` of the song
 * (the highest mean energy over any window), moved back to where that loud
 * stretch begins (the earliest start still within 5 % of the best, so a long
 * chorus previews from its top, not from wherever its loudest 15 s happen to
 * start), then snapped to the nearest bar start. A song shorter than the
 * window previews from its first bar. Null without frames.
 */
export function previewTime({ frames, frameS = FRAME_S, lines, durationMs, windowS = 15 }) {
  if (!frames?.length) return null
  const bars = barStarts(lines, durationMs)
  const w = Math.round(windowS / frameS)
  if (frames.length <= w) return Math.round(bars[0]?.ms ?? 0)
  const prefix = new Float64Array(frames.length + 1)
  for (let i = 0; i < frames.length; i++) prefix[i + 1] = prefix[i] + frames[i]
  const mean = (s) => (prefix[s + w] - prefix[s]) / w
  let best = 0
  for (let s = 1; s + w <= frames.length; s++) if (mean(s) > mean(best)) best = s
  if (!(mean(best) > 0)) return null // silence has no loudest stretch
  let start = best
  while (start > 0 && mean(start - 1) >= 0.95 * mean(best)) start--
  return Math.round(nearestBar(bars, start * frameS * 1000))
}

/**
 * The lead-in rule. osu! itself waits before the first object only as long as
 * its approach needs, so a map whose music (and first red line) starts at once
 * drops the player in with no beat to settle on. Our rule, written down in
 * docs/site.md: when the first sound, the earlier of the first red line and
 * the first attack the engine heard, is under LEAD_MIN_MS from the start,
 * suggest an `AudioLeadIn` that brings it to LEAD_TARGET_MS, in steps of
 * 100 ms. `{ firstMs, leadInMs }`, `leadInMs` 0 when none is needed; null
 * with nothing to go on.
 */
export const LEAD_MIN_MS = 1500
export const LEAD_TARGET_MS = 2000

export function leadIn({ lines, firstAttackMs = null }) {
  const candidates = [lines[0]?.timeMs, firstAttackMs].filter((ms) => Number.isFinite(ms))
  if (!candidates.length) return null
  const firstMs = Math.max(0, Math.min(...candidates))
  if (firstMs >= LEAD_MIN_MS) return { firstMs, leadInMs: 0 }
  return { firstMs, leadInMs: Math.ceil((LEAD_TARGET_MS - firstMs) / 100) * 100 }
}

/**
 * Kiai suggestions: the bars clearly louder than the rest of the song.
 *
 * Each bar's level is the RMS of its frames, in dB. A bar is hot when it sits
 * above the midpoint between the song's median bar and its 95th-percentile
 * bar, and only when that gap is at least `minSpreadDb`: a song mastered flat
 * has no chorus that loudness can find, and gets no suggestion rather than a
 * random one. Hot bars are joined across gaps of up to `gapBars`, runs shorter
 * than `minBars` are dropped, and the `maxSections` loudest runs (by their
 * summed excess over the threshold) are kept, in time order. Every bound is a
 * bar start, so a run is `{ startMs, endMs, bars }` with `endMs` the start of
 * the bar after it (or the song's end).
 */
export function kiaiSections({
  frames,
  frameS = FRAME_S,
  lines,
  durationMs,
  minSpreadDb = 3,
  gapBars = 1,
  minBars = 4,
  maxSections = 3,
}) {
  if (!frames?.length || !lines.length) return []
  // Only bars from the first red line on: kiai before the timing starts means nothing.
  const bars = barStarts(lines, durationMs).filter((bar) => bar.ms >= lines[0].timeMs - 1e-6)
  const levels = bars.map((bar, i) => {
    const end = i + 1 < bars.length ? bars[i + 1].ms : durationMs
    const a = Math.floor(bar.ms / 1000 / frameS)
    const b = Math.min(frames.length, Math.ceil(end / 1000 / frameS))
    // A bar cut short by the song's end (under half its frames) is not judged.
    const full = (lines[bar.line].beatMs * bar.meter) / 1000 / frameS
    if (b - a < Math.max(1, full / 2)) return null
    let sum = 0
    for (let f = a; f < b; f++) sum += frames[f]
    const mean = sum / (b - a)
    return mean > 0 ? 10 * Math.log10(mean) : null
  })
  const known = levels.filter((db) => db !== null).sort((x, y) => x - y)
  if (known.length < minBars * 2) return []
  const at = (q) => known[Math.min(known.length - 1, Math.floor(q * (known.length - 1)))]
  const median = at(0.5)
  const high = at(0.95)
  if (high - median < minSpreadDb) return []
  const threshold = (median + high) / 2
  const hot = levels.map((db) => db !== null && db >= threshold)

  const runs = []
  let run = null
  hot.forEach((isHot, i) => {
    if (isHot) {
      if (run && i - run.last - 1 <= gapBars) run.last = i
      else runs.push((run = { first: i, last: i }))
    }
  })
  return runs
    .filter((r) => r.last - r.first + 1 >= minBars)
    .map((r) => {
      let score = 0
      for (let i = r.first; i <= r.last; i++) if (levels[i] !== null) score += Math.max(0, levels[i] - threshold)
      const endMs = r.last + 1 < bars.length ? bars[r.last + 1].ms : durationMs
      return { startMs: bars[r.first].ms, endMs, bars: r.last - r.first + 1, score }
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, maxSections)
    .sort((x, y) => x.startMs - y.startMs)
    .map(({ score, ...section }) => section)
}

/**
 * The green lines that make `sections` kiai, as `{ timeMs, row }` in whole ms:
 * an inherited point (`-100`, so the slider velocity stays 1×, effects 1) at
 * each start, and one with effects 0 at each end that is not the song's end.
 * A red line carries its own effects (0 in the exports), so one that falls
 * inside a kiai section would end it there: it gets a kiai green line at its
 * own time, which osu! reads after the red one.
 */
export function kiaiRows(sections, lines, durationMs) {
  const meterAt = (ms) => {
    let meter = lines[0]?.meter ?? 4
    for (const line of lines) if (line.timeMs <= ms + 1e-6) meter = line.meter
    return meter
  }
  const row = (ms, on) => {
    const timeMs = roundHalfEven(ms)
    return { timeMs, row: `${timeMs},-100,${meterAt(ms)},1,0,100,0,${on ? 1 : 0}` }
  }
  const out = []
  for (const section of sections) {
    out.push(row(section.startMs, true))
    for (const line of lines) if (line.timeMs > section.startMs + 0.5 && line.timeMs < section.endMs - 0.5) out.push(row(line.timeMs, true))
    // Ending on a red line needs nothing: the red line already turns kiai off.
    const onRed = lines.some((line) => Math.abs(line.timeMs - section.endMs) < 0.5)
    if (section.endMs < durationMs - 0.5 && !onRed) out.push(row(section.endMs, false))
  }
  return out.sort((a, b) => a.timeMs - b.timeMs)
}
