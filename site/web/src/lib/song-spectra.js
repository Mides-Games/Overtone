/**
 * The page's side of the spectral worker (spectral.worker.js): the decoded
 * song handed over as one mono signal at the working rate, its bands and
 * spectrogram back, kept per analysis for the session (W13.6, W13.7); and a
 * microphone recording's tempo (W13.12). Nothing here is sent anywhere.
 *
 * The downmix is the one step on the main thread (the AudioBuffer lives
 * here), and it runs in slices with a breath between, so a six-minute song
 * never holds the page for more than a few milliseconds at a time.
 */
import { downmixInto } from './spectral.js'

const LAYERS_KEY = 'overtone.map.layers'

/**
 * Which optional lanes the reader keeps on, in this browser (a convenience:
 * blocked storage falls back to the defaults). The bands start on, since they
 * cost the page nothing but a worker's second; the spectrogram starts off, as
 * the roadmap asks, being the heavier read.
 */
export function readLayers() {
  try {
    const stored = JSON.parse(localStorage.getItem(LAYERS_KEY) ?? '{}') ?? {}
    return { bands: typeof stored.bands === 'boolean' ? stored.bands : true, spectrogram: stored.spectrogram === true }
  } catch {
    return { bands: true, spectrogram: false }
  }
}

export function writeLayers(layers) {
  try {
    localStorage.setItem(LAYERS_KEY, JSON.stringify({ bands: Boolean(layers.bands), spectrogram: Boolean(layers.spectrogram) }))
  } catch {
    // Blocked storage: the choice holds for this page.
  }
}

/** The analyses kept: a six-minute song's is about 2.4 MB. */
const KEEP = 4
const results = new Map() // analysis id -> Promise<result>
const progress = new Map() // analysis id -> Set<(fraction) => void>
const pending = new Map() // message id -> { resolve, reject, onProgress }
let worker = null
let nextId = 1

function spectralWorker() {
  if (!worker) {
    worker = new Worker(new URL('./spectral.worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (event) => {
      const { id, progress: done, result, error } = event.data
      const job = pending.get(id)
      if (!job) return
      if (done !== undefined) return job.onProgress?.(done)
      pending.delete(id)
      if (error) job.reject(new Error(error))
      else job.resolve(result)
    }
    worker.onerror = (event) => {
      for (const job of pending.values()) job.reject(new Error(event.message || 'worker failed'))
      pending.clear()
      worker = null
    }
  }
  return worker
}

function ask(message, transfer, onProgress) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress })
    spectralWorker().postMessage({ ...message, id }, transfer)
  })
}

/** A breath for the page: a message, not a timer, which a background tab would clamp to a second. */
const breathe = () =>
  new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => resolve()
    channel.port2.postMessage(null)
  })

const SLICE = 1 << 19 // output samples per slice: a few milliseconds

/** The song as one mono signal at the working rate, built in slices. */
async function workingSignalOf(buffer) {
  const factor = buffer.sampleRate >= 32000 ? 2 : 1
  const channels = []
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c))
  const n = Math.floor(buffer.length / factor)
  const out = new Float32Array(n)
  for (let from = 0; from < n; from += SLICE) {
    downmixInto(out, channels, factor, from, Math.min(n, from + SLICE))
    await breathe()
  }
  return { samples: out, rate: buffer.sampleRate / factor }
}

/**
 * The bands and spectrogram of analysis `id`'s decoded song (`buffer`), from
 * the cache or the worker. `onProgress(fraction)` hears the work as it goes,
 * for whoever asked while it runs. Measured: see `scripts/spectral-cost.mjs`.
 */
export function songSpectra(id, buffer, onProgress) {
  if (onProgress) {
    if (!progress.has(id)) progress.set(id, new Set())
    progress.get(id).add(onProgress)
  }
  if (!results.has(id)) {
    if (results.size >= KEEP) results.delete(results.keys().next().value)
    const started = performance.now()
    const work = (async () => {
      const { samples, rate } = await workingSignalOf(buffer)
      const result = await ask({ kind: 'song', samples, rate }, [samples.buffer], (done) => {
        for (const listener of progress.get(id) ?? []) listener(done)
      })
      // The whole wait as the reader sees it, downmix and hand-over included.
      result.totalMs = Math.round(performance.now() - started)
      return result
    })()
    work.catch(() => results.delete(id)).finally(() => progress.delete(id))
    results.set(id, work)
  }
  return results.get(id)
}

/** Stops hearing the progress of `id` (a component that unmounts). */
export function forgetProgress(id, onProgress) {
  progress.get(id)?.delete(onProgress)
}

/** A microphone recording's reading (lib/mic-tempo.js `readRecording`), from the worker. */
export function micTempo(channels, rate) {
  return ask({ kind: 'mic', channels, rate }, channels.map((c) => c.buffer))
}
