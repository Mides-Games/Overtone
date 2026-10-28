#!/usr/bin/env node
/**
 * What the result page's bands and spectrogram (W13.6, W13.7) cost for a
 * six-minute song, measured on the same code the worker runs:
 *
 *   node site/web/scripts/spectral-cost.mjs [minutes]
 *
 * The song is synthetic (a drum pattern over noise, stereo 44.1 kHz): the
 * work depends on the length, not on what is playing. Prints the downmix,
 * the analysis (bands and spectrogram in one pass), one view of the
 * spectrogram, and the memory the result holds. Node's V8 is the browser's,
 * so these are close to a desktop Chrome's; a phone is slower, and the page
 * shows its progress while it works.
 */
import { performance } from 'node:perf_hooks'

import { analyseSong, specColumns, workingSignal } from '../src/lib/spectral.js'

const minutes = Number(process.argv[2] ?? 6)
const rate = 44100
const n = Math.round(minutes * 60 * rate)
let seed = 1
const noise = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 31 - 1)
const left = new Float32Array(n)
const right = new Float32Array(n)
for (let i = 0; i < n; i++) {
  const t = i / rate
  const beat = t % 0.5
  const v = 0.05 * noise() + (beat < 0.3 ? 0.6 * Math.sin(2 * Math.PI * 55 * beat) * Math.exp(-beat / 0.08) : 0)
  left[i] = v
  right[i] = v
}

const time = (label, fn) => {
  const t0 = performance.now()
  const out = fn()
  console.log(`${label.padEnd(34)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms`)
  return out
}

console.log(`${minutes} min of stereo ${rate} Hz`)
const { samples, rate: working } = time('downmix to mono, half rate', () => workingSignal([left, right], rate))
const result = time('bands and spectrogram (one pass)', () => analyseSong(samples, working))
time('a 1200-column view, whole song', () => specColumns(result.spectrogram, result.fps, 0, result.durationS, 1200))
time('a 1200-column view, 10 s', () => specColumns(result.spectrogram, result.fps, 60, 70, 1200))
const kb = (result.spectrogram.data.byteLength + result.bands.reduce((s, b) => s + b.t.byteLength + b.w.byteLength, 0)) / 1024
console.log(`${result.frames} frames, ${result.bands.map((b) => `${b.key} ${b.t.length}`).join(', ')} attacks; holds ${(kb / 1024).toFixed(1)} MB`)
