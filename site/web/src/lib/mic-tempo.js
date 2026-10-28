/**
 * A tempo from a few seconds of microphone (W13.12): the onset envelope of
 * what the browser heard, its autocorrelation, and the period that best
 * explains it, with a confidence and the octave neighbours it could also be.
 *
 * A quick check, not the engine: no octave model, no sections, no offset. A
 * steady song through a speaker into a laptop's microphone reads within about
 * a BPM; a room, a voice or a song that changes tempo reads worse, and the
 * page says so. White noise and silence come back as no reading at all.
 */
import { bandBins, fluxReader, FFT_SIZE, frameCount, HOP, quantile, spectra, workingSignal } from './spectral.js'

export const MIN_BPM = 60
export const MAX_BPM = 200
/** The tempo the search leans towards when two octaves explain the envelope almost equally. */
const PRIOR_BPM = 120
/** Under this, the page proposes nothing: the envelope has no steady pulse. */
export const MIN_CONFIDENCE = 0.25
/** At least this much audio before a reading means anything. */
export const MIN_SECONDS = 4

/**
 * The onset envelope of `channels` (Float32Arrays at `sampleRate`): the
 * full band's spectral flux, 30 Hz to 8 kHz, one value per hop. Returns
 * `{ env: Float32Array, fps, rms }`; `rms` is the signal's level, so the
 * page can tell silence from a song with no pulse.
 */
export function onsetEnvelope(channels, sampleRate) {
  const { samples, rate } = workingSignal(channels, sampleRate)
  const frames = frameCount(samples.length, HOP)
  const range = bandBins(30, 8000, rate, FFT_SIZE)
  const flux = fluxReader([range], frames, FFT_SIZE / 2 + 1)
  spectra(samples, 0, frames, (_, mag) => flux.push(mag))
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return { env: flux.out[0], fps: rate / HOP, rms: samples.length ? Math.sqrt(sum / samples.length) : 0 }
}

/** `env`'s autocorrelation at lag `l` frames (fractional: linear between neighbours), over the overlap. */
function acfAt(x, l) {
  const i = Math.floor(l)
  const f = l - i
  const at = (lag) => {
    let s = 0
    for (let k = 0; k + lag < x.length; k++) s += x[k] * x[k + lag]
    return s / Math.max(1, x.length - lag)
  }
  return f === 0 ? at(i) : (1 - f) * at(i) + f * at(i + 1)
}

/**
 * The tempo of an onset envelope `env` at `fps` frames a second.
 *
 * The envelope, less its mean, is correlated with itself; a candidate period
 * scores the mean correlation at its first four multiples (a steady pulse
 * lines up again a beat, two, three and four beats later; noise does not),
 * nudged gently towards 120 BPM so a half or a double that scores the same
 * loses. The best whole-frame lag is then refined in twentieths of a frame.
 *
 * Returns null when there is no envelope to read, else
 * `{ bpm, confidence (0..1), alternatives: [half, double] in range, steady: confidence ≥ MIN_CONFIDENCE }`.
 * Confidence is the winning score over the zero-lag energy, less the median
 * score of all candidates: how far the pulse stands above the envelope's background.
 */
export function tempoFromEnvelope(env, fps, { minBpm = MIN_BPM, maxBpm = MAX_BPM } = {}) {
  const n = env.length
  if (n < fps * 2) return null
  // Smoothed over about 30 ms: a click is a frame or two wide, and a period
  // that falls between two frames would otherwise miss its own peaks.
  const smooth = new Float64Array(n)
  for (let i = 0; i < n; i++) smooth[i] = 0.25 * (env[i - 1] ?? env[i]) + 0.5 * env[i] + 0.25 * (env[i + 1] ?? env[i])
  let mean = 0
  for (let i = 0; i < n; i++) mean += smooth[i]
  mean /= n
  const x = new Float64Array(n)
  let energy = 0
  for (let i = 0; i < n; i++) {
    x[i] = smooth[i] - mean
    energy += x[i] * x[i]
  }
  energy /= n
  if (!(energy > 1e-12)) return null
  const minLag = Math.max(2, Math.floor((60 * fps) / maxBpm))
  const maxLag = Math.ceil((60 * fps) / minBpm)
  const multiples = (lag) => {
    let s = 0
    let k = 0
    for (let m = 1; m <= 4 && m * lag < n - fps; m++, k++) s += acfAt(x, m * lag)
    return k ? s / k / energy : 0
  }
  /** The best fractional lag within half a frame of `whole`, and its score. */
  const refine = (whole) => {
    let lag = whole
    let raw = multiples(whole)
    for (let l = whole - 0.5; l <= whole + 0.5; l += 0.05) {
      if (l < minLag - 0.5 || l > maxLag + 0.5) continue
      const s = multiples(l)
      if (s > raw) {
        raw = s
        lag = l
      }
    }
    return { lag, raw }
  }
  const prior = (lag) => {
    const octaves = Math.log2((60 * fps) / lag / PRIOR_BPM)
    return Math.exp(-0.5 * (octaves / 1.5) ** 2)
  }
  const scores = []
  let best = -1
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    const raw = multiples(lag)
    scores.push(raw)
    const s = raw * (0.85 + 0.15 * prior(lag))
    if (s > bestScore) {
      bestScore = s
      best = lag
    }
  }
  let { lag, raw } = refine(best)
  // A steady pulse also lines up at twice its period, as well or nearly: when
  // the faster octave explains the envelope almost as well, it is the pulse.
  // (A song really at the slower tempo scores about half at the faster one.)
  const faster = lag / 2
  if (faster >= minLag - 0.5) {
    const other = refine(Math.round(faster))
    if (other.raw >= 0.8 * raw) ({ lag, raw } = other)
  }
  const background = quantile(scores, 0.5)
  const confidence = Math.max(0, Math.min(1, (raw - Math.max(0, background)) / (1 - Math.max(0, background))))
  const bpm = (60 * fps) / lag
  const alternatives = [bpm / 2, bpm * 2].filter((b) => b >= minBpm * 0.75 && b <= maxBpm * 1.25)
  return { bpm, confidence, alternatives, steady: confidence >= MIN_CONFIDENCE }
}

/**
 * The whole reading of a recording: `{ kind: 'short' | 'silent' | 'noPulse' | 'tempo', ... }`.
 * `silent` under about -50 dBFS RMS; `noPulse` when the envelope has no
 * steady period; `tempo` carries `bpm`, `confidence` and `alternatives`.
 */
export function readRecording(channels, sampleRate) {
  const seconds = channels.length ? channels[0].length / sampleRate : 0
  if (seconds < MIN_SECONDS) return { kind: 'short', seconds }
  const { env, fps, rms } = onsetEnvelope(channels, sampleRate)
  if (rms < 0.003) return { kind: 'silent', seconds }
  const tempo = tempoFromEnvelope(env, fps)
  if (!tempo || !tempo.steady) return { kind: 'noPulse', seconds, confidence: tempo?.confidence ?? 0 }
  return { kind: 'tempo', seconds, bpm: tempo.bpm, confidence: tempo.confidence, alternatives: tempo.alternatives }
}
