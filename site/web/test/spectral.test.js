import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readRecording, tempoFromEnvelope, onsetEnvelope } from '../src/lib/mic-tempo.js'
import { analyseSong, BANDS, bandBins, fft, FFT_SIZE, frameCount, HOP, specColumns, spectra, specRows, workingSignal } from '../src/lib/spectral.js'

/** A deterministic noise source in -1..1, so no test depends on Math.random. */
function noise(seed = 1) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 31 - 1
  }
}

/** Adds a decaying burst of the given sines at `at` seconds. */
function burst(out, rate, at, freqs, tau, gain = 0.5) {
  const start = Math.round(at * rate)
  const length = Math.round(tau * 6 * rate)
  for (let i = 0; i < length && start + i < out.length; i++) {
    const t = i / rate
    let v = 0
    for (const f of freqs) v += Math.sin(2 * Math.PI * f * t)
    out[start + i] += (gain * v * Math.exp(-t / tau)) / freqs.length
  }
}

/** A drum pattern at 22.05 kHz: kicks every half second, a snare on every second one, a hat every quarter. */
function pattern(seconds = 8, rate = 22050) {
  const out = new Float32Array(Math.round(seconds * rate))
  const kicks = []
  const snares = []
  const hats = []
  for (let at = 0.25; at < seconds - 0.5; at += 0.5) {
    burst(out, rate, at, [55, 62], 0.08, 0.8)
    kicks.push(at)
  }
  for (let at = 0.5; at < seconds - 0.5; at += 1) {
    burst(out, rate, at, [1500, 2300, 3100], 0.05, 0.5)
    snares.push(at)
  }
  for (let at = 0.375; at < seconds - 0.5; at += 0.25) {
    burst(out, rate, at, [7000, 8300, 9100], 0.02, 0.3)
    hats.push(at)
  }
  return { out, rate, kicks, snares, hats }
}

const near = (times, target, tolerance) => times.some((t) => Math.abs(t - target) <= tolerance)

test('the FFT finds a sine in its own bin, at half the size times its amplitude', () => {
  const n = 64
  const re = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 8 * i) / n))
  const im = new Float64Array(n)
  fft(re, im)
  const mags = Array.from(re, (r, i) => Math.hypot(r, im[i]))
  assert.ok(Math.abs(mags[8] - n / 2) < 1e-9)
  assert.ok(Math.abs(mags[n - 8] - n / 2) < 1e-9)
  assert.ok(mags.every((m, i) => i === 8 || i === n - 8 || m < 1e-9))
  assert.throws(() => fft(new Float64Array(6), new Float64Array(6)))
})

test('two frames per FFT give the same spectra as one frame at a time', () => {
  const next = noise(7)
  const samples = Float32Array.from({ length: 5000 }, () => next())
  const frames = frameCount(samples.length)
  const paired = []
  spectra(samples, 0, frames, (t, mag) => (paired[t] = Float64Array.from(mag)))
  // One at a time: each frame its own call, so it never has a partner.
  for (const t of [0, 1, 7, frames - 1]) {
    let single = null
    spectra(samples, t, t + 1, (_, mag) => (single = Float64Array.from(mag)))
    for (let k = 0; k < single.length; k++) assert.ok(Math.abs(single[k] - paired[t][k]) < 1e-9, `frame ${t} bin ${k}`)
  }
  assert.equal(paired.length, frames)
})

test('the working signal is the channels averaged and, at 44.1 kHz, halved in rate', () => {
  const left = Float32Array.from([1, 1, 0, 0, 1, 1])
  const right = Float32Array.from([0, 0, 0, 0, 1, 1])
  const { samples, rate } = workingSignal([left, right], 44100)
  assert.equal(rate, 22050)
  assert.deepEqual([...samples], [0.5, 0, 1])
  const same = workingSignal([left], 22050)
  assert.equal(same.rate, 22050)
  assert.equal(same.samples.length, 6)
})

test('band bins cover their band at the working rate, at least one bin each', () => {
  const hz = 22050 / FFT_SIZE
  for (const band of BANDS) {
    const [a, b] = bandBins(band.lo, band.hi, 22050)
    assert.ok(b > a)
    assert.ok(a * hz >= band.lo - hz && (b - 1) * hz <= Math.min(band.hi, 11025) + hz, band.key)
  }
  const rows = specRows(22050)
  assert.equal(rows.length, 80)
  for (let r = 1; r < rows.length; r++) assert.ok(rows[r][0] >= rows[r - 1][0])
})

test('each band hears its own instrument: kicks low, the snare in the middle, hats high', () => {
  const { out, rate, kicks, snares, hats } = pattern()
  const result = analyseSong(out, rate)
  const band = Object.fromEntries(result.bands.map((b) => [b.key, [...b.t]]))
  const tolerance = 0.025
  for (const at of kicks) assert.ok(near(band.low, at, tolerance), `kick at ${at}: ${band.low.slice(0, 6)}`)
  for (const at of snares) assert.ok(near(band.mid, at, tolerance), `snare at ${at}`)
  for (const at of hats) assert.ok(near(band.high, at, tolerance), `hat at ${at}`)
  // And not the others': every attack a band reports is one of its own instrument's, each heard once.
  for (const [key, own] of [['low', kicks], ['mid', snares], ['high', hats]]) {
    for (const at of band[key]) assert.ok(near(own, at, tolerance), `a ${key} attack at ${at} that is not its instrument's`)
    assert.equal(band[key].length, own.length, key)
  }
  for (const b of result.bands) assert.ok(b.w.every((w) => w >= 0 && w <= 100))
})

test('silence has no attacks and an empty spectrogram', () => {
  const result = analyseSong(new Float32Array(22050 * 2), 22050)
  for (const b of result.bands) assert.equal(b.t.length, 0)
  assert.equal(result.spectrogram.frames, frameCount(22050 * 2))
  assert.equal(result.frames, frameCount(22050 * 2, HOP))
})

test('a tone lights the spectrogram row of its frequency, and a view keeps the loudest frame per column', () => {
  const rate = 22050
  const tone = Float32Array.from({ length: rate * 2 }, (_, i) => (i > 1.2 * rate ? 0.5 * Math.sin((2 * Math.PI * 1000 * i) / rate) : 0))
  const { spectrogram, fps } = analyseSong(tone, rate)
  const rows = specRows(rate)
  const hz = rate / FFT_SIZE
  const frame = Math.round(1.6 * fps)
  const column = spectrogram.data.subarray(frame * spectrogram.rows, (frame + 1) * spectrogram.rows)
  const loudest = column.indexOf(Math.max(...column))
  const [a, b] = rows[loudest]
  assert.ok(a * hz <= 1000 + hz && b * hz >= 1000 - hz, `row ${loudest} spans ${a * hz}-${b * hz} Hz`)
  assert.equal(Math.max(...spectrogram.data.subarray(0, Math.round(0.5 * fps) * spectrogram.rows)), 0)
  // Two columns over the whole two seconds: the first (to 1 s) is silent, the second holds the tone.
  const cols = specColumns(spectrogram, fps, 0, 2, 2)
  assert.equal(cols.length, 2 * spectrogram.rows)
  assert.equal(Math.max(...cols.subarray(0, spectrogram.rows)) < 40, true)
  assert.equal(cols[spectrogram.rows + loudest], 255)
  // Zoomed in past a frame a column: each column the nearest frame.
  const fine = specColumns(spectrogram, fps, 1.6, 1.6 + 4 / fps, 16)
  assert.equal(fine[loudest], 255)
})

/** A click train: a short broadband tick on every beat, over a little noise. */
function clicks(bpm, seconds, rate = 44100, noiseLevel = 0.02) {
  const out = new Float32Array(Math.round(seconds * rate))
  const next = noise(3)
  for (let i = 0; i < out.length; i++) out[i] = noiseLevel * next()
  for (let at = 0.1; at < seconds; at += 60 / bpm) burst(out, rate, at, [180, 900, 2500, 5200], 0.012, 0.9)
  return out
}

test('the microphone reader hears a steady click within a BPM, with confidence', () => {
  for (const bpm of [128, 90, 174]) {
    const reading = readRecording([clicks(bpm, 10)], 44100)
    assert.equal(reading.kind, 'tempo', `${bpm}: ${JSON.stringify(reading)}`)
    assert.ok(Math.abs(reading.bpm - bpm) < 1, `${bpm} read as ${reading.bpm}`)
    assert.ok(reading.confidence >= 0.5, `${bpm} confidence ${reading.confidence}`)
  }
})

test('the octave neighbours are offered when they are in range', () => {
  const reading = readRecording([clicks(128, 10)], 44100)
  assert.ok(reading.alternatives.some((b) => Math.abs(b - 64) < 1))
})

test('white noise, silence and a short recording propose no tempo', () => {
  const next = noise(11)
  const white = Float32Array.from({ length: 44100 * 8 }, () => 0.3 * next())
  assert.equal(readRecording([white], 44100).kind, 'noPulse')
  assert.equal(readRecording([new Float32Array(44100 * 8)], 44100).kind, 'silent')
  assert.equal(readRecording([clicks(120, 2)], 44100).kind, 'short')
  // An envelope too short to correlate is no reading.
  assert.equal(tempoFromEnvelope(new Float32Array(10), 90), null)
})

test('the onset envelope peaks on the clicks', () => {
  const { env, fps } = onsetEnvelope([clicks(120, 5)], 44100)
  let best = 0
  for (let i = 1; i < env.length; i++) if (env[i] > env[best]) best = i
  const t = best / fps
  const phase = ((t - 0.1) % 0.5 + 0.5) % 0.5
  assert.ok(Math.min(phase, 0.5 - phase) < 0.03, `the loudest frame at ${t}`)
})
