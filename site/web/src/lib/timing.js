/**
 * The files the API serves for one analysis, built from the result the page
 * already holds, so a batch can be zipped without another request (W3.15).
 * They match `site/api/src/utils/upload.js` byte for byte.
 */

/** The `[TimingPoints]` block as an .osu file writes it, CRLF included. */
export const timingText = (result) => {
  const lines = String(result?.osu_timing ?? '').split(/\r?\n/).filter(Boolean)
  return `[TimingPoints]\r\n${lines.join('\r\n')}\r\n`
}

/** A filename for a download, ASCII only: `<song>-timing.txt`. */
export const downloadName = (filename, suffix) => {
  const stem = (filename ?? 'overtone').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._ -]+/g, '').trim().slice(0, 80)
  return `${stem || 'overtone'}-${suffix}`
}

/** The archive of a batch: one `timing.txt` per song that has a timing. */
export const batchFiles = (items) =>
  items.filter((item) => item.status === 'done' && item.result).map((item) => ({ name: downloadName(item.file.name, 'timing.txt'), text: timingText(item.result) }))
