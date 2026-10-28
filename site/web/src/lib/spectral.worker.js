/**
 * The spectral worker (W13.6, W13.7, W13.12): lib/spectral.js and
 * lib/mic-tempo.js off the page's main thread. One message in, progress and
 * one result out:
 *
 *   { kind: 'song', id, samples: Float32Array, rate }  -> { id, progress } ..., { id, result }
 *   { kind: 'mic', id, channels: [Float32Array], rate } -> { id, result }
 *
 * The arrays come transferred, not copied. A song is worked a chunk of frames
 * at a time, so its progress reaches the page while it runs.
 */
import { readRecording } from './mic-tempo.js'
import { songAnalyser } from './spectral.js'

const CHUNK_FRAMES = 2048

self.onmessage = (event) => {
  const { kind, id } = event.data
  try {
    if (kind === 'song') {
      const { samples, rate } = event.data
      const analyser = songAnalyser(samples, rate)
      const started = performance.now()
      let done = 0
      while (done < 1) {
        done = analyser.step(CHUNK_FRAMES)
        self.postMessage({ id, progress: done })
      }
      const result = analyser.result()
      result.ms = Math.round(performance.now() - started)
      const transfer = [result.spectrogram.data.buffer, ...result.bands.flatMap((b) => [b.t.buffer, b.w.buffer])]
      self.postMessage({ id, result }, transfer)
    } else if (kind === 'mic') {
      self.postMessage({ id, result: readRecording(event.data.channels, event.data.rate) })
    }
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) })
  }
}
