/**
 * The audio a result page plays, held in this browser for the session only
 * (ADR-W4: the server never keeps or serves audio).
 *
 * The Analyze form hands each file it sends here under its analysis id, so
 * the result page opens with the song ready. Reopened later (a reload, the
 * recent list, another day) the page has only the timing: it asks for the
 * file again and checks its SHA-1 against the analysis's before it lines the
 * song up with the red lines. Nothing here is written to storage or sent.
 */
import { audioContext } from './player.js'

const held = new Map() // analysis id -> File, known to be that analysis's audio
const decoded = new Map() // analysis id -> Promise<{ buffer, peaks }>

/** Keeps `file` as the audio of analysis `id` for this session. */
export function holdAudio(id, file) {
  if (id && file) held.set(id, file)
}

export const heldAudio = (id) => held.get(id) ?? null

/** The file's SHA-1 in hex, read in the browser (SubtleCrypto). */
export async function sha1Hex(file) {
  const digest = await crypto.subtle.digest('SHA-1', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Lets the page paint between chunks of a long loop. A message rather than a
 * timer: a background tab clamps nested timers to a second each, and a
 * six-minute song then took tens of seconds to draw.
 */
const breathe = () =>
  new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => resolve()
    channel.port2.postMessage(null)
  })

/**
 * Min/max of every `bin` samples of the decoded song, both channels, scaled
 * to its loudest sample: a column of the waveform then reduces a few bins,
 * not thousands of samples. A coarser copy (×16) serves the zoomed-out view
 * and the overview. Built in chunks so a six-minute song does not stall the page.
 */
async function buildPeaks(buffer, bin = 256) {
  const channels = []
  for (let c = 0; c < Math.min(buffer.numberOfChannels, 2); c++) channels.push(buffer.getChannelData(c))
  const n = Math.ceil(buffer.length / bin)
  const min = new Float32Array(n)
  const max = new Float32Array(n)
  const chunk = 2048 // about 12 ms of work for a stereo 44.1 kHz song
  for (let start = 0; start < n; start += chunk) {
    const stop = Math.min(n, start + chunk)
    for (let i = start; i < stop; i++) {
      let lo = 0
      let hi = 0
      const end = Math.min(buffer.length, (i + 1) * bin)
      for (const ch of channels) {
        for (let j = i * bin; j < end; j++) {
          const v = ch[j]
          if (v < lo) lo = v
          else if (v > hi) hi = v
        }
      }
      min[i] = lo
      max[i] = hi
    }
    await breathe()
  }
  let peak = 1e-9
  for (let i = 0; i < n; i++) peak = Math.max(peak, -min[i], max[i])
  for (let i = 0; i < n; i++) {
    min[i] /= peak
    max[i] /= peak
  }
  const fold = 16
  const m = Math.ceil(n / fold)
  const coarseMin = new Float32Array(m)
  const coarseMax = new Float32Array(m)
  for (let i = 0; i < m; i++) {
    let lo = 0
    let hi = 0
    for (let j = i * fold; j < Math.min(n, (i + 1) * fold); j++) {
      if (min[j] < lo) lo = min[j]
      if (max[j] > hi) hi = max[j]
    }
    coarseMin[i] = lo
    coarseMax[i] = hi
  }
  return {
    secondsPerBin: bin / buffer.sampleRate,
    min,
    max,
    coarse: { secondsPerBin: (bin * fold) / buffer.sampleRate, min: coarseMin, max: coarseMax },
  }
}

/** The song of analysis `id` decoded, with its peaks; kept while it is the last one decoded. */
export function decodeHeld(id) {
  if (!decoded.has(id)) {
    const file = held.get(id)
    if (!file) return Promise.reject(new Error('no file'))
    // One decoded song at a time: six minutes of stereo float is about 130 MB.
    // The files stay held, so going back decodes again in a second or so.
    decoded.clear()
    const work = (async () => {
      const buffer = await audioContext().decodeAudioData(await file.arrayBuffer())
      return { buffer, peaks: await buildPeaks(buffer) }
    })()
    // A failed decode can be tried again with another file.
    work.catch(() => decoded.delete(id))
    decoded.set(id, work)
  }
  return decoded.get(id)
}
