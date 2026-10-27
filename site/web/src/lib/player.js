/**
 * The result page's player: the song the reader picked, decoded in this
 * browser, with the red lines' clicks mixed over it (ADR-W4: the server
 * never keeps or serves audio; nothing here talks to it).
 *
 * Ported from the desktop app's Timing view (app/app.js, `pb*`): one
 * AudioContext, the song through its own gain, the clicks through another,
 * scheduled a little ahead on the context's clock so they stay on the beat
 * whatever the page's main thread is doing. A slower or faster rate resamples
 * the song, so its pitch moves with it and every attack stays exactly at
 * t / rate; the clicks are placed at t / rate too and keep their own pitch.
 *
 * Imperative on purpose: React reads `snapshot` (useSyncExternalStore) for the
 * controls, and the canvas asks `heardPosition()` once a frame.
 */
import { lowerBound } from './timing.js'

const LOOKAHEAD_S = 0.15
const TICK_MS = 25
const LEAD_S = 0.06
/** The desktop app's and the WAV export's tones: [Hz, gain] for 2 a bar's first beat, 1 a beat. */
export const TONES = { 2: [2093, 1], 1: [1568, 0.7], 0: [1318.5, 0.4] }

/**
 * One click on `ctx` at `when` (context seconds) into `destination`: a sine at
 * the level's tone, an 8 ms exponential decay, 45 ms long. The player and the
 * click-track WAV (lib/click-track.js) both call this, so what is downloaded
 * is what was heard.
 */
export function scheduleClick(ctx, destination, when, level) {
  const osc = ctx.createOscillator()
  const env = ctx.createGain()
  const [freq, gain] = TONES[level] ?? TONES[1]
  osc.frequency.value = freq
  env.gain.setValueAtTime(gain, when)
  env.gain.setTargetAtTime(0.0001, when, 0.008)
  osc.connect(env)
  env.connect(destination)
  osc.start(when)
  osc.stop(when + 0.045)
}

let shared = null
/**
 * The song and click volumes, and whether the clicks are on, kept in this
 * browser so the next timing opens as the reader left the last one. A
 * convenience only: storage that is blocked or full falls back to the defaults.
 */
const VOLUMES_KEY = 'overtone.player.volumes'

/** Where the song and the clicks start until the reader moves them (owner's call, 2026-10-27). */
export const DEFAULT_VOLUME = 0.2

const unit = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined)

function savedVolumes() {
  try {
    const stored = JSON.parse(localStorage.getItem(VOLUMES_KEY) ?? '{}') ?? {}
    return { song: unit(stored.song), click: unit(stored.click), clicksOn: typeof stored.clicksOn === 'boolean' ? stored.clicksOn : undefined }
  } catch {
    return {}
  }
}

function saveVolumes(volumes) {
  try {
    localStorage.setItem(VOLUMES_KEY, JSON.stringify(volumes))
  } catch {
    // Private mode or blocked storage: the volume holds for this page only.
  }
}

/** The page's one AudioContext, made on first use (decoding needs one; playing resumes it). */
export function audioContext() {
  if (!shared) {
    const Context = window.AudioContext || window.webkitAudioContext
    shared = new Context({ latencyHint: 'interactive' })
  }
  return shared
}

export class Player {
  constructor() {
    this.buffer = null
    this.grid = { t: new Float64Array(0), level: new Uint8Array(0) }
    this.sections = []
    this.source = null
    this.playing = false
    this.startCtx = 0
    this.startPos = 0
    this.pos = 0
    this.sched = 0
    this.timer = 0
    this.loop = null // the span playing in a loop now, seconds
    this.range = null // the span the reader drew, seconds
    this.loopOn = false
    this.rate = 1
    const saved = savedVolumes()
    // 20 % to start: most people keep the browser and the system at full
    // volume, where 80 % of a mastered song (and 60 % of the clicks) was loud.
    this.songVolume = saved.song ?? DEFAULT_VOLUME
    this.clickVolume = saved.click ?? DEFAULT_VOLUME
    this.clicksOn = saved.clicksOn ?? true
    this.listeners = new Set()
    this.snapshot = this.#snap()
  }

  #snap() {
    return {
      ready: Boolean(this.buffer),
      playing: this.playing,
      rate: this.rate,
      loopOn: this.loopOn,
      range: this.range,
      songVolume: this.songVolume,
      clickVolume: this.clickVolume,
      clicksOn: this.clicksOn,
    }
  }

  #emit() {
    this.snapshot = this.#snap()
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.snapshot

  #buses() {
    const ctx = audioContext()
    if (!this.songBus) {
      this.songBus = ctx.createGain()
      this.songBus.connect(ctx.destination)
    }
    if (!this.clickBus) {
      this.clickBus = ctx.createGain()
      this.clickBus.connect(ctx.destination)
    }
    this.songBus.gain.value = this.songVolume
    this.clickBus.gain.value = this.clicksOn ? this.clickVolume : 0
    return ctx
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0
  }

  setBuffer(buffer) {
    this.stop()
    this.buffer = buffer
    this.pos = 0
    this.#emit()
  }

  /** The clicks to play: `clickGrid`'s output. Takes effect from the next scheduled window. */
  setGrid(grid) {
    this.grid = grid
  }

  /** The red lines' spans, seconds, for "loop the section under the playhead". */
  setSections(sections) {
    this.sections = sections
  }

  setVolumes({ song = this.songVolume, click = this.clickVolume, clicksOn = this.clicksOn } = {}) {
    this.songVolume = song
    this.clickVolume = click
    this.clicksOn = clicksOn
    saveVolumes({ song, click, clicksOn })
    if (this.songBus) this.#buses()
    this.#emit()
  }

  setRate(rate) {
    this.rate = rate
    if (this.playing) this.play(this.position())
    else this.#emit()
  }

  /** The reader's loop span (seconds) or null; turning one on turns looping on. */
  setRange(range) {
    this.range = range && range.b - range.a >= 0.05 ? range : null
    if (this.range) this.loopOn = true
    if (this.playing) this.play(this.range ? this.range.a : this.position())
    else {
      if (this.range) this.pos = this.range.a
      this.#emit()
    }
  }

  setLoopOn(on) {
    this.loopOn = on
    if (this.playing) this.play(this.position())
    else this.#emit()
  }

  #loopFor(pos) {
    const end = this.duration
    if (this.range) return { a: Math.max(0, this.range.a), b: Math.min(this.range.b, end) }
    // No drawn range: the section under the playhead, from its red line to the next.
    const section = this.sections.find((s) => pos >= s.a && pos < s.b) ?? this.sections[0]
    if (!section) return null
    const span = { a: Math.max(0, section.a), b: Math.min(section.b, end) }
    return span.b - span.a > 0.05 ? span : null
  }

  /** Song position `elapsed` context seconds after the start, at the rate, folded into the loop. */
  #songAt(elapsed) {
    const ahead = elapsed * this.rate
    if (!this.loop) return this.startPos + ahead
    const { a, b } = this.loop
    const length = b - a
    return a + ((((this.startPos - a + ahead) % length) + length) % length)
  }

  /** Where the song is in the schedule (what is being handed to the speakers now). */
  position() {
    if (!this.playing) return this.pos
    return this.#songAt(Math.max(0, audioContext().currentTime - this.startCtx))
  }

  /** Where the song is as it is heard: the context's output timestamp, latency included. */
  heardPosition() {
    if (!this.playing) return this.pos
    const ctx = audioContext()
    let now = ctx.currentTime - (ctx.outputLatency || 0)
    const stamp = ctx.getOutputTimestamp?.()
    if (stamp && stamp.contextTime > 0 && stamp.performanceTime > 0) {
      now = stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000
    }
    return this.#songAt(Math.max(0, now - this.startCtx))
  }

  #click(when, level) {
    scheduleClick(audioContext(), this.clickBus, when, level)
  }

  #tick = () => {
    if (!this.playing) return
    const ctx = audioContext()
    const { t, level } = this.grid
    const until = ctx.currentTime - this.startCtx + LOOKAHEAD_S
    while (this.sched < until) {
      const s0 = this.#songAt(this.sched)
      // Up to the loop's end at most, so a window never spans the wrap.
      const room = this.loop ? (this.loop.b - s0) / this.rate : Infinity
      const length = Math.min(until - this.sched, room)
      if (this.clicksOn) {
        for (let i = lowerBound(t, s0); i < t.length && t[i] < s0 + length * this.rate; i++) {
          this.#click(this.startCtx + this.sched + (t[i] - s0) / this.rate, level[i])
        }
      }
      this.sched += length > 1e-9 ? length : 1e-6
    }
    if (!this.loop && this.position() >= this.duration) {
      this.stop()
      this.pos = 0
      this.#emit()
    }
  }

  /** Plays from `from` (seconds; else where it stopped). `loop`, when given, replaces the range and the loop switch first. */
  async play(from, loop) {
    if (!this.buffer) return
    if (loop) {
      this.range = loop.range && loop.range.b - loop.range.a >= 0.05 ? loop.range : null
      this.loopOn = Boolean(loop.loopOn)
    }
    const ctx = this.#buses()
    if (ctx.state === 'suspended') await ctx.resume()
    this.#halt()
    let pos = Math.min(Math.max(0, from ?? this.pos), Math.max(0, this.duration - 0.01))
    this.loop = this.loopOn ? this.#loopFor(pos) : null
    if (this.loop && (pos < this.loop.a || pos >= this.loop.b)) pos = this.loop.a
    const source = ctx.createBufferSource()
    source.buffer = this.buffer
    if (this.loop) {
      source.loop = true
      source.loopStart = this.loop.a
      source.loopEnd = this.loop.b
    }
    source.playbackRate.value = this.rate
    source.connect(this.songBus)
    this.startCtx = ctx.currentTime + LEAD_S
    this.startPos = pos
    this.sched = 0
    source.start(this.startCtx, pos)
    this.source = source
    this.playing = true
    this.#tick()
    this.timer = setInterval(this.#tick, TICK_MS)
    this.#emit()
  }

  /** Stops the song and every click already handed to the context. */
  #halt() {
    if (!this.playing) return
    this.pos = this.position()
    this.playing = false
    clearInterval(this.timer)
    try {
      this.source.stop()
    } catch {
      // already stopped
    }
    this.source = null
    if (this.clickBus) {
      this.clickBus.disconnect()
      this.clickBus = null
      this.#buses()
    }
  }

  stop() {
    this.#halt()
    this.#emit()
  }

  toggle() {
    if (this.playing) this.stop()
    else this.play()
  }

  seek(pos) {
    const to = Math.min(Math.max(0, pos), this.duration || pos)
    if (this.playing) this.play(to)
    else {
      this.pos = to
      this.#emit()
    }
  }

  destroy() {
    this.#halt()
    this.listeners.clear()
    for (const bus of [this.songBus, this.clickBus]) bus?.disconnect()
    this.songBus = null
    this.clickBus = null
  }
}
