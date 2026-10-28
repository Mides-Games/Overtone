/**
 * The song's spectrum, in the browser (W13.6, W13.7, W13.12): an FFT, the
 * short-time spectra of a mono signal, three bands' attacks and a log-frequency
 * spectrogram. Pure functions of arrays, so node:test runs them on synthetic
 * signals and the worker (spectral.worker.js) runs the very same code off the
 * page's main thread.
 *
 * Nothing here is the engine. The engine's onsets (the accent ticks on the
 * map) are what the grid was fitted to; these are a second, coarser look at
 * the same audio, for the reader's eye: which band carries the pulse.
 */

/** The STFT's window and hop at the working rate (about 22 kHz): 46 ms and 11.6 ms. */
export const FFT_SIZE = 1024
export const HOP = 256

/**
 * The three bands, in Hz: where a kick, a snare's crack and a cymbal usually
 * sit. A band is a range of frequencies, not an instrument: a bass line lands
 * in the low one and a voice in the middle one, and the page says so.
 */
export const BANDS = [
  { key: 'low', lo: 30, hi: 150 },
  { key: 'mid', lo: 200, hi: 4000 },
  { key: 'high', lo: 5000, hi: 11000 },
]

/** The spectrogram's rows, log-spaced over this range, and the dB it spans under its loudest cell. */
export const SPEC_ROWS = 80
export const SPEC_LO_HZ = 40
export const SPEC_HI_HZ = 11000
export const SPEC_RANGE_DB = 72

const tables = new Map()

/** Bit reversal and twiddles for an `n`-point FFT, built once per size. */
function table(n) {
  let t = tables.get(n)
  if (t) return t
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size ${n} is not a power of two`)
  const rev = new Uint32Array(n)
  const bits = Math.log2(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  const cos = new Float64Array(n / 2)
  const sin = new Float64Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n)
    sin[i] = Math.sin((-2 * Math.PI * i) / n)
  }
  t = { rev, cos, sin }
  tables.set(n, t)
  return t
}

/** In-place radix-2 FFT of `re` + i·`im` (same power-of-two length). */
export function fft(re, im) {
  const n = re.length
  const { rev, cos, sin } = table(n)
  for (let i = 0; i < n; i++) {
    const j = rev[i]
    if (j > i) {
      let x = re[i]
      re[i] = re[j]
      re[j] = x
      x = im[i]
      im[i] = im[j]
      im[j] = x
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const step = n / size
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]
        const wi = sin[k * step]
        const a = start + k
        const b = a + half
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
}

export function hann(n) {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return w
}

/**
 * The working signal: `channels` averaged to mono and, at 32 kHz and over,
 * halved in rate by averaging pairs (a gentle low-pass: it nulls the old
 * Nyquist). Nothing above 11 kHz is read, so half the samples do the same
 * work in half the time. Returns `{ samples, rate }`.
 */
export function workingSignal(channels, sampleRate) {
  const factor = sampleRate >= 32000 ? 2 : 1
  const length = channels.length ? channels[0].length : 0
  const n = Math.floor(length / factor)
  const out = new Float32Array(n)
  downmixInto(out, channels, factor, 0, n)
  return { samples: out, rate: sampleRate / factor }
}

/** Fills `out[from..to)` from `channels`, `factor` source samples per output sample: lets a caller do it in chunks. */
export function downmixInto(out, channels, factor, from, to) {
  const scale = 1 / (channels.length * factor)
  const length = channels[0]?.length ?? 0
  out.fill(0, from, to)
  for (const ch of channels) {
    for (let i = from; i < to; i++) {
      const j = i * factor
      let sum = ch[j]
      for (let k = 1; k < factor && j + k < length; k++) sum += ch[j + k]
      out[i] += sum
    }
  }
  for (let i = from; i < to; i++) out[i] *= scale
}

/** How many centred frames a signal of `length` samples has at `hop`. */
export const frameCount = (length, hop = HOP) => (length > 0 ? Math.floor(length / hop) + 1 : 0)

/** Frame `t`'s centre in seconds: frames are centred (the first on sample 0), so a frame's time is its middle. */
export const frameTime = (t, rate, hop = HOP) => (t * hop) / rate

/**
 * Magnitude spectra of frames `[from, to)` of `samples`, two frames per
 * complex FFT (one in the real part, one in the imaginary, split after by
 * symmetry): half the FFTs a frame at a time would take. `onFrame(t, mag)`
 * gets a reused Float64Array of `size / 2 + 1` bins; copy what you keep.
 */
export function spectra(samples, from, to, onFrame, { size = FFT_SIZE, hop = HOP, window = null } = {}) {
  const w = window ?? hann(size)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const bins = size / 2 + 1
  const magA = new Float64Array(bins)
  const magB = new Float64Array(bins)
  const half = size / 2
  // Scaled so a full-scale sine reads about 0.5 whatever the size: the log compression then means the same at any size.
  const norm = 2 / size
  const fill = (buf, t) => {
    const start = t * hop - half
    for (let i = 0; i < size; i++) {
      const j = start + i
      buf[i] = j >= 0 && j < samples.length ? samples[j] * w[i] : 0
    }
  }
  for (let t = from; t < to; t += 2) {
    const pair = t + 1 < to
    fill(re, t)
    if (pair) fill(im, t + 1)
    else im.fill(0)
    fft(re, im)
    for (let k = 0; k < bins; k++) {
      const m = (size - k) % size
      // X = (Z[k] + conj Z[N-k]) / 2 ; Y = (Z[k] - conj Z[N-k]) / 2i
      const xr = (re[k] + re[m]) / 2
      const xi = (im[k] - im[m]) / 2
      magA[k] = Math.sqrt(xr * xr + xi * xi) * norm
      if (pair) {
        const yr = (im[k] + im[m]) / 2
        const yi = (re[m] - re[k]) / 2
        magB[k] = Math.sqrt(yr * yr + yi * yi) * norm
      }
    }
    onFrame(t, magA)
    if (pair) onFrame(t + 1, magB)
  }
}

/** The FFT bins `[a, b)` a band of `lo`..`hi` Hz covers at `rate`; at least one bin. */
export function bandBins(lo, hi, rate, size = FFT_SIZE) {
  const hz = rate / size
  const top = Math.floor(size / 2)
  const a = Math.min(top, Math.max(1, Math.ceil(lo / hz)))
  const b = Math.min(top + 1, Math.max(a + 1, Math.floor(Math.min(hi, rate / 2) / hz) + 1))
  return [a, b]
}

/** Log compression of a magnitude, as onset detectors use it: steady on loud and quiet passages alike. */
const GAMMA = 100
const compress = (m) => Math.log1p(GAMMA * m)

/**
 * A spectral-flux reader: per frame, the rise of each bin's compressed
 * magnitude summed over each range of `ranges` (bins), divided by its width.
 * `push(mag)` returns nothing; the fluxes land in `out[r][t]`.
 */
export function fluxReader(ranges, frames, bins) {
  let prev = new Float64Array(bins)
  let cur = new Float64Array(bins)
  // Only the bins some range reads are compressed: a log per bin is most of the cost.
  const lo = Math.min(...ranges.map((r) => r[0]))
  const hi = Math.max(...ranges.map((r) => r[1]))
  const out = ranges.map(() => new Float32Array(frames))
  let t = 0
  return {
    out,
    push(mag) {
      for (let k = lo; k < hi; k++) cur[k] = compress(mag[k])
      for (let r = 0; r < ranges.length; r++) {
        const [a, b] = ranges[r]
        let sum = 0
        if (t > 0) for (let k = a; k < b; k++) if (cur[k] > prev[k]) sum += cur[k] - prev[k]
        out[r][t] = sum / (b - a)
      }
      ;[prev, cur] = [cur, prev]
      t++
    },
  }
}

/** The `q` quantile (0..1) of `values`, copied and sorted; NaN when empty. */
export function quantile(values, q) {
  if (!values.length) return Number.NaN
  const sorted = Float64Array.from(values).sort()
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]
}

/**
 * Attacks in one band's flux: a frame that is the highest within ±35 ms,
 * stands `delta` (a fifth of the loud end) over the mean of the 100 ms around it, and comes at least
 * 50 ms after the last one kept. `delta` and each attack's strength are
 * relative to the band's own loud end (its 99th percentile), so a quiet band
 * still shows its pattern; a band with no flux at all shows nothing.
 * Returns `{ t: Float64Array seconds, w: Uint8Array 0..100 }`.
 */
export function pickAttacks(flux, rate, hop = HOP, { minGapS = 0.05, localS = 0.035, meanS = 0.1, delta = 0.2 } = {}) {
  const n = flux.length
  const top = quantile(flux, 0.99)
  if (!(top > 1e-6)) return { t: new Float64Array(0), w: new Uint8Array(0) }
  const fps = rate / hop
  const local = Math.max(1, Math.round(localS * fps))
  const mean = Math.max(1, Math.round(meanS * fps))
  const floor = delta * top
  // A running sum gives each frame its neighbourhood's mean in one pass.
  const sums = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) sums[i + 1] = sums[i] + flux[i]
  const times = []
  const weights = []
  let last = -Infinity
  for (let i = 0; i < n; i++) {
    const v = flux[i]
    if (v < floor) continue
    const a = Math.max(0, i - mean)
    const b = Math.min(n, i + mean + 1)
    if (v < (sums[b] - sums[a]) / (b - a) + floor) continue
    let peak = true
    for (let j = Math.max(0, i - local); j <= Math.min(n - 1, i + local) && peak; j++) {
      if (flux[j] > v || (flux[j] === v && j < i)) peak = false
    }
    if (!peak) continue
    const s = frameTime(i, rate, hop)
    if (s - last < minGapS) continue
    last = s
    times.push(s)
    weights.push(Math.round(100 * Math.min(1, v / top)))
  }
  return { t: Float64Array.from(times), w: Uint8Array.from(weights) }
}

/** The spectrogram's rows as FFT bin ranges: log-spaced, each at least one bin. */
export function specRows(rate, size = FFT_SIZE, rows = SPEC_ROWS, lo = SPEC_LO_HZ, hi = SPEC_HI_HZ) {
  const top = Math.min(hi, rate / 2)
  const hz = rate / size
  const out = []
  for (let r = 0; r < rows; r++) {
    const f0 = lo * (top / lo) ** (r / rows)
    const f1 = lo * (top / lo) ** ((r + 1) / rows)
    const a = Math.min(size / 2, Math.max(1, Math.round(f0 / hz)))
    const b = Math.min(size / 2 + 1, Math.max(a + 1, Math.round(f1 / hz)))
    out.push([a, b])
  }
  return out
}

/**
 * The song's bands and spectrogram, a chunk of frames at a time:
 * `analyser.step(frames)` does up to that many and returns the fraction done;
 * `analyser.result()` then gives
 *
 *   { rate, hop, fps, frames, durationS,
 *     bands: [{ key, t, w }],                        // attacks per band
 *     spectrogram: { rows, frames, data: Uint8Array } } // frame-major, row 0 the lowest
 *
 * The spectrogram's cells are dB under the loudest cell, `SPEC_RANGE_DB` deep, as 0..255.
 */
export function songAnalyser(samples, rate, { size = FFT_SIZE, hop = HOP } = {}) {
  const frames = frameCount(samples.length, hop)
  const bins = size / 2 + 1
  const ranges = BANDS.map((band) => bandBins(band.lo, band.hi, rate, size))
  const flux = fluxReader(ranges, frames, bins)
  const rows = specRows(rate, size)
  const db = new Float32Array(frames * rows.length)
  let peakDb = -Infinity
  const window = hann(size)
  let done = 0
  const onFrame = (t, mag) => {
    flux.push(mag)
    const base = t * rows.length
    for (let r = 0; r < rows.length; r++) {
      const [a, b] = rows[r]
      let m = 0
      for (let k = a; k < b; k++) if (mag[k] > m) m = mag[k]
      const v = 20 * Math.log10(m + 1e-9)
      db[base + r] = v
      if (v > peakDb) peakDb = v
    }
  }
  return {
    frames,
    step(count) {
      const to = Math.min(frames, done + Math.max(2, count))
      spectra(samples, done, to, onFrame, { size, hop, window })
      done = to
      return frames ? done / frames : 1
    },
    result() {
      const data = new Uint8Array(db.length)
      const floorDb = peakDb - SPEC_RANGE_DB
      for (let i = 0; i < db.length; i++) data[i] = Math.round(255 * Math.min(1, Math.max(0, (db[i] - floorDb) / SPEC_RANGE_DB)))
      return {
        rate,
        hop,
        fps: rate / hop,
        frames,
        durationS: samples.length / rate,
        bands: BANDS.map((band, i) => ({ key: band.key, ...pickAttacks(flux.out[i], rate, hop) })),
        spectrogram: { rows: rows.length, frames, data },
      }
    },
  }
}

/** The whole analysis at once (tests and the measurement script); the worker steps it. */
export function analyseSong(samples, rate, options) {
  const analyser = songAnalyser(samples, rate, options)
  analyser.step(analyser.frames)
  return analyser.result()
}

/**
 * The spectrogram's columns for a view: `columns` columns over seconds
 * `[a, b)`, each the loudest of the frames it covers (or the nearest frame
 * when zoomed in past one frame a column). Returns a Uint8Array, column-major
 * (`columns × rows`), for the page to paint.
 */
export function specColumns(spec, fps, a, b, columns) {
  const { rows, frames, data } = spec
  const out = new Uint8Array(columns * rows)
  const per = ((b - a) * fps) / columns
  for (let c = 0; c < columns; c++) {
    const f0 = (a * fps) + c * per
    let i0 = Math.floor(f0)
    let i1 = Math.max(i0 + 1, Math.floor(f0 + per))
    if (per < 1) i0 = Math.round(f0 + per / 2)
    if (per < 1) i1 = i0 + 1
    i0 = Math.max(0, i0)
    i1 = Math.min(frames, i1)
    const base = c * rows
    for (let i = i0; i < i1; i++) {
      const src = i * rows
      for (let r = 0; r < rows; r++) if (data[src + r] > out[base + r]) out[base + r] = data[src + r]
    }
  }
  return out
}
