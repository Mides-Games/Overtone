/**
 * A whole batch at once (W12.22): the same adjustment (×2 / ÷2, a nudge) on
 * every song of the Analyze page's batch, and every song's .osz in one zip.
 *
 * Everything is built in the browser from what the page holds: the results
 * the cards polled and the files the person picked (lib/session-audio.js
 * keeps them for the session; the server never had them back, ADR-W4).
 *
 * Memory: a .osz is the song plus a few kilobytes, so the batch's zip is
 * about the batch's audio. It is built one song at a time into a ZipWriter
 * (lib/zip.js), whose parts are Blobs: only one song's bytes are in the
 * page's memory at once (its file read, then its .osz), and the browser may
 * keep the finished parts on disk. The whole batch is capped at
 * BATCH_OSZ_MAX_BYTES of audio, and the page says so before it starts.
 */
import { exportLines } from './export-options.js'
import { buildOsz } from './osz.js'
import { adjustLines, downloadName, timingText } from './timing.js'
import { ZipWriter } from './zip.js'

/** The most audio one "all as .osz" zip carries: well inside a zip without zip64 (4 GiB) and a phone's patience. */
export const BATCH_OSZ_MAX_BYTES = 1024 * 1_048_576

export const NO_ADJUSTMENT = Object.freeze({ factor: 1, nudgeMs: 0 })

/** The lines a song of the batch is written with: the batch's adjustment, then the export options. */
export const batchLines = (result, adjustment = NO_ADJUSTMENT, options = null) => {
  const lines = adjustLines(result, adjustment)
  return options ? exportLines(lines, options) : lines
}

/**
 * The batch's `timing.txt` files (W3.15), each with the batch's adjustment
 * and the export options, as the result page writes one song's.
 * `items` are `{ file, status, result }`; only the finished ones count.
 */
export const batchTimingFiles = (items, adjustment = NO_ADJUSTMENT, options = null) =>
  items
    .filter((item) => item.status === 'done' && item.result)
    .map((item) => ({
      name: downloadName(item.file.name, 'timing.txt'),
      text: timingText(item.result, batchLines(item.result, adjustment, options), adjustment, options),
    }))

/** What "all as .osz" would take: the finished songs with their files, their audio in bytes, and whether it fits. */
export function oszPlan(items, max = BATCH_OSZ_MAX_BYTES) {
  const songs = items.filter((item) => item.status === 'done' && item.result && item.file)
  const bytes = songs.reduce((sum, item) => sum + (item.file.size ?? 0), 0)
  return { songs, bytes, fits: songs.length > 0 && bytes <= max }
}

/**
 * Every finished song's .osz in one zip, one at a time. `onProgress(done,
 * total)` after each, and `onBuilt({ item, analysis, name, bytes })` with
 * each song's own .osz as it goes in (the page keeps it to download again,
 * lib/kept-osz.js). Returns `{ blob, failed }`, `failed` the file names
 * whose .osz could not be built (they are left out, the rest go on).
 */
export async function batchOsz(items, { adjustment = NO_ADJUSTMENT, options = null, creator = null, onProgress = () => {}, onBuilt = () => {}, build = buildOsz } = {}) {
  const plan = oszPlan(items)
  if (!plan.fits) throw new Error(plan.songs.length ? 'too large' : 'nothing to build')
  const zip = new ZipWriter()
  const failed = []
  let done = 0
  for (const item of plan.songs) {
    try {
      const analysis = { ...item.analysis, result: item.result, filename: item.analysis?.filename ?? item.file.name }
      const { name, bytes } = await build({
        file: item.file, analysis, lines: batchLines(item.result, adjustment, options), adjustment, options, creator,
      })
      zip.add(name, { data: bytes })
      try {
        // Awaited, so only one song's bytes are held at once, as before.
        await onBuilt({ item, analysis, name, bytes })
      } catch {
        // Keeping a copy is a convenience: it never stops the batch.
      }
    } catch {
      failed.push(item.file.name)
    }
    onProgress(++done, plan.songs.length)
  }
  return { blob: zip.blob(), failed }
}
