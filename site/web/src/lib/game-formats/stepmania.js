/** StepMania (.sm, .ssc): beats accumulated through the tempi, #OFFSET negated. */
import { COMMENT, field, fixed, gameLines, STEPMANIA_DECIMALS, STEPMANIA_ROWS_PER_BEAT } from './common.js'

// ---------------------------------------------------------------------------
// StepMania
// ---------------------------------------------------------------------------

/** Beat 0 at the first line; each later line's beat accumulated through the tempi before it. */
export function stepmaniaBeats(points) {
  const beats = [0]
  for (let i = 1; i < points.length; i++) {
    beats.push(beats[i - 1] + (points[i].timeMs - points[i - 1].timeMs) / (60000 / points[i - 1].bpm))
  }
  return beats
}

/**
 * v3's `stepmania_timing_text`: `#OFFSET` (negated, seconds) and `#BPMS`.
 * `offsetDecimals` are of a ms, so the offset gets 3 more in seconds (3 is
 * v3's default of 6); beats and BPMs always 6.
 */
export function stepmaniaTimingText(lines, { offsetDecimals = 3 } = {}) {
  const points = gameLines(lines)
  if (!points.length) throw new Error('No timing to export.')
  const beats = stepmaniaBeats(points)
  const pairs = points.map((p, i) => `${fixed(beats[i], STEPMANIA_DECIMALS)}=${fixed(p.bpm, STEPMANIA_DECIMALS)}`)
  return `// ${COMMENT}\n#OFFSET:${fixed(-points[0].timeMs / 1000, offsetDecimals + 3)};\n#BPMS:${pairs.join('\n,')};\n`
}

/**
 * How far StepMania moves the changes when it puts them on its rows: the
 * file's own beats and BPMs, read back as written, each change's beat rounded
 * to 1/48, and the times that gives against the lines'. `{ worstMs, moved }`,
 * `moved` the changes off by more than 0.05 ms.
 */
export function stepmaniaRowShift(lines) {
  const points = gameLines(lines)
  const beats = stepmaniaBeats(points).map((b) => Number(fixed(b, STEPMANIA_DECIMALS)))
  const bpms = points.map((p) => Number(fixed(p.bpm, STEPMANIA_DECIMALS)))
  let time = points[0]?.timeMs ?? 0
  let worstMs = 0
  let moved = 0
  for (let i = 1; i < points.length; i++) {
    const rows = Math.round(beats[i] * STEPMANIA_ROWS_PER_BEAT) - Math.round(beats[i - 1] * STEPMANIA_ROWS_PER_BEAT)
    time += (rows / STEPMANIA_ROWS_PER_BEAT) * (60000 / bpms[i - 1])
    const off = Math.abs(time - points[i].timeMs)
    worstMs = Math.max(worstMs, off)
    if (off > 0.05) moved++
  }
  return { worstMs, moved }
}

/** The beats where the bar changes: the first line, a new meter, or a line off the running bar (on rows). */
function barChanges(points, beats, unitsPerBeat) {
  const out = []
  let start = 0
  let meter = 0
  points.forEach((p, i) => {
    const unit = Math.round(beats[i] * unitsPerBeat)
    if (i === 0 || p.meter !== meter || (unit - start) % (meter * unitsPerBeat) !== 0) {
      out.push({ index: i, unit, meter: p.meter })
      start = unit
      meter = p.meter
    }
  })
  return out
}

/** Text for a StepMania tag: its separators and escapes taken out. */
const smField = (text) => field(text).replace(/[#:;\\]/g, '').replace(/\/\//g, '/')

/** A whole .sm (`kind` 'sm') or .ssc ('ssc'): the song's tags and the timing, no #NOTES. `{ text, report }`. */
export function stepmaniaFile({ kind = 'sm', title, artist, creator, audioName, lines, offsetDecimals }) {
  const timing = stepmaniaTimingText(lines, { offsetDecimals })
  const points = gameLines(lines)
  const tags = timing.split('\n').filter((row) => row.startsWith('#') || row.startsWith(','))
  const out = [`// ${COMMENT}`]
  if (kind === 'ssc') out.push('#VERSION:0.83;')
  out.push(
    `#TITLE:${smField(title)};`,
    '#SUBTITLE:;',
    `#ARTIST:${smField(artist)};`,
    '#TITLETRANSLIT:;',
    '#SUBTITLETRANSLIT:;',
    '#ARTISTTRANSLIT:;',
    '#GENRE:;',
    `#CREDIT:${smField(creator)};`,
    '#BANNER:;',
    '#BACKGROUND:;',
    '#CDTITLE:;',
    `#MUSIC:${smField(audioName)};`,
    ...tags,
    '#STOPS:;',
  )
  if (kind === 'ssc') {
    const beats = stepmaniaBeats(points)
    const changes = barChanges(points, beats, STEPMANIA_ROWS_PER_BEAT)
    out.push(
      '#DELAYS:;',
      '#WARPS:;',
      `#TIMESIGNATURES:${changes.map((c) => `${fixed(beats[c.index], STEPMANIA_DECIMALS)}=${c.meter}=4`).join('\n,')};`,
    )
  }
  out.push('')
  const shift = stepmaniaRowShift(lines)
  return {
    text: out.join('\n'),
    report: { ...shift, meterLost: kind === 'sm' && points.some((p) => p.meter !== 4) },
  }
}
