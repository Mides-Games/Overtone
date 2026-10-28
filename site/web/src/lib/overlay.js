/**
 * The stream overlay's clock (W13.23): where in a published timing a song
 * that started at `t0` is now. Pure, so the page's frame loop and the tests
 * read the same numbers.
 *
 * The overlay cannot hear the stream. It only counts from a start time the
 * streamer gives it: a key pressed as the song starts, or `?t0=` in the URL
 * (epoch milliseconds), which a script or a stream deck can write. Whatever
 * the song really does after that, the overlay keeps the timing's grid.
 */

import { governing } from './timing.js'

/** The earliest and latest start the URL may give: a typo should not mean "started in 1970". */
const MIN_T0 = Date.UTC(2020, 0, 1)
const MAX_AHEAD_MS = 24 * 3600 * 1000
/** The most a nudge may move the clock, either way. */
export const MAX_NUDGE_MS = 5000
export const NUDGE_STEP_MS = 10

/** `t0` (epoch ms) and `nudge` (ms) from a query string. A missing or impossible `t0` is null. */
export function overlayParams(search, now = Date.now()) {
  const params = new URLSearchParams(search)
  const raw = params.get('t0')
  const t0 = raw !== null && /^\d{10,16}$/.test(raw.trim()) ? Number(raw.trim()) : null
  const nudgeRaw = Number(params.get('nudge'))
  return {
    t0: t0 !== null && t0 >= MIN_T0 && t0 <= now + MAX_AHEAD_MS ? t0 : null,
    nudgeMs: clampNudge(Number.isFinite(nudgeRaw) ? nudgeRaw : 0),
  }
}

export const clampNudge = (ms) => Math.max(-MAX_NUDGE_MS, Math.min(MAX_NUDGE_MS, Math.round(ms)))

/** The query string for a start and a nudge, so a reload (OBS refreshes sources) keeps the sync. */
export function overlaySearch(search, { t0, nudgeMs }) {
  const params = new URLSearchParams(search)
  if (t0 === null || t0 === undefined) params.delete('t0')
  else params.set('t0', String(Math.round(t0)))
  if (!nudgeMs) params.delete('nudge')
  else params.set('nudge', String(clampNudge(nudgeMs)))
  const text = params.toString()
  return text ? `?${text}` : ''
}

/**
 * The state of the song `songMs` milliseconds in, under `lines` (adjustLines'
 * shape: timeMs, bpm, beatMs, meter):
 *
 * - `phase`: 'waiting' (before 0, a count-in), 'intro' (before the first red
 *   line), 'playing', or 'ended' (past `durationMs`);
 * - `line`: the index of the red line in force (the first one before it);
 * - `beat`: the beat's number since that line (0 the line's first), and
 *   `barBeat` its place in the bar (0 is the downbeat); null outside 'playing';
 * - `key`: changes exactly when a new beat starts, for the pulse;
 * - `sinceBeatMs`: how long ago the beat started, for the pulse's decay.
 *
 * A line's beats stop where the next line starts, as the click track's do
 * (lib/timing.js clickGrid), so a line change resets the count.
 */
export function overlayState(lines, songMs, durationMs = Infinity) {
  const none = { line: 0, beat: null, barBeat: null, key: null, sinceBeatMs: null }
  if (!lines.length) return { phase: 'ended', ...none }
  if (songMs < 0) return { phase: 'waiting', ...none }
  if (songMs > durationMs) return { phase: 'ended', ...none, line: lines.length - 1 }
  if (songMs < lines[0].timeMs) return { phase: 'intro', ...none }
  const index = governing(lines, songMs / 1000)
  const line = lines[index]
  if (!(line.beatMs > 0)) return { phase: 'intro', ...none, line: index }
  // The 1e-6 keeps a beat that lands exactly on a frame from flickering back to the previous one.
  const beat = Math.floor((songMs - line.timeMs) / line.beatMs + 1e-6)
  return {
    phase: 'playing',
    line: index,
    beat,
    barBeat: ((beat % line.meter) + line.meter) % line.meter,
    key: `${index}:${beat}`,
    sinceBeatMs: songMs - (line.timeMs + beat * line.beatMs),
  }
}

/** The pulse's strength `sinceBeatMs` after a beat: 1 at the beat, fading to 0 within a third of a beat (at most 180 ms). */
export function pulseLevel(sinceBeatMs, beatMs) {
  if (sinceBeatMs === null || !(beatMs > 0)) return 0
  const span = Math.min(180, beatMs / 3)
  if (sinceBeatMs < 0 || sinceBeatMs >= span) return 0
  return 1 - sinceBeatMs / span
}

/** The overlay's address for a published timing. */
export const overlayPath = (id) => `/overlay/${id}`
