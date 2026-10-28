/**
 * The click track as a WAV, rendered in this browser (W3.20): the clicks the
 * page plays, alone at the song's length or mixed over the reader's own song
 * (ADR-W4: the song never leaves the page). An OfflineAudioContext renders
 * faster than real time, and the same `scheduleClick` the player uses makes
 * every click, so the file holds what the reader heard.
 */
import { DEFAULT_VOLUME, scheduleClick } from './player.js'
import { DEFAULT_SUB_VOLUME } from './listening.js'
import { lowerBound, SUB } from './timing.js'
import { encodeWav } from './wav.js'

/**
 * The longest track rendered: ten minutes, below the site's own analysis
 * limit (MAX_AUDIO_SECONDS, 900 s by default) on purpose. Ten minutes of 16-bit stereo at 48 kHz is 115 MB, about
 * as much as a browser tab should hand to a download in one piece.
 */
export const MAX_TRACK_SECONDS = 600
/** The clicks-only track's rate: CD audio, mono. */
export const CLICK_RATE = 44_100
/** How often the render stops to say how far it got, in rendered seconds. */
const PROGRESS_EVERY_S = 10

/**
 * What a render will hold: its length (the song's, capped) and the clicks
 * inside it, as `{ seconds, capped, t, level }`. A click whose 45 ms tail
 * would run past the end is still kept: the render cuts it.
 */
export function clickTrackPlan(grid, durationS, cap = MAX_TRACK_SECONDS) {
  const seconds = Math.min(Math.max(durationS || 0, 0), cap)
  const end = lowerBound(grid.t, seconds + 1e-9)
  return { seconds, capped: durationS > cap, t: grid.t.subarray(0, end), level: grid.level.subarray(0, end) }
}

/**
 * Renders the track and returns the WAV's bytes. `buffer` is the decoded song
 * (an AudioBuffer) to mix under the clicks, or null for the clicks alone;
 * `songVolume` and `clickVolume` are the player's, so the mix sounds as the
 * page does; `subVolume` is the subdivisions' share of the clicks', when the
 * grid holds any (W12.6). The latency the player may move its clicks by is
 * never applied here: a file is played elsewhere, on other hardware.
 * `onProgress` gets 0..1 every ten rendered seconds.
 */
export async function renderClickTrack({ grid, durationS, buffer = null, songVolume = DEFAULT_VOLUME, clickVolume = DEFAULT_VOLUME, subVolume = DEFAULT_SUB_VOLUME, onProgress }) {
  const plan = clickTrackPlan(grid, buffer ? Math.min(durationS || buffer.duration, buffer.duration) : durationS)
  const rate = buffer ? buffer.sampleRate : CLICK_RATE
  const channels = buffer ? Math.min(2, buffer.numberOfChannels) : 1
  const frames = Math.max(1, Math.ceil(plan.seconds * rate))
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext
  const ctx = new Offline(channels, frames, rate)

  const clicks = ctx.createGain()
  clicks.gain.value = buffer ? clickVolume : 1
  clicks.connect(ctx.destination)
  const subs = ctx.createGain()
  subs.gain.value = subVolume
  subs.connect(clicks)
  for (let i = 0; i < plan.t.length; i++) scheduleClick(ctx, plan.level[i] === SUB ? subs : clicks, plan.t[i], plan.level[i])
  if (buffer) {
    const song = ctx.createGain()
    song.gain.value = songVolume
    song.connect(ctx.destination)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(song)
    source.start(0)
  }

  // Stops every few seconds of rendered audio to report, then goes on.
  if (onProgress && typeof ctx.suspend === 'function') {
    for (let s = PROGRESS_EVERY_S; s < plan.seconds; s += PROGRESS_EVERY_S) {
      const at = s
      ctx.suspend(at).then(() => {
        onProgress(at / plan.seconds)
        ctx.resume()
      })
    }
  }
  const rendered = await ctx.startRendering()
  onProgress?.(1)
  const data = Array.from({ length: rendered.numberOfChannels }, (_, c) => rendered.getChannelData(c))
  return { bytes: encodeWav(data, rendered.sampleRate), capped: plan.capped, seconds: plan.seconds }
}
