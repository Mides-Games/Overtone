/**
 * The reader's own .osu with the timing put in (W3.20): its `[TimingPoints]`
 * red lines replaced by the result's, built in this browser. The server never
 * sees the file.
 *
 * CLAUDE.md rule 5 in spirit: every byte the reader did not ask to change
 * comes out identical. The file is read byte for byte (one char per byte, not
 * decoded), so a BOM, CRLF, mixed endings or text that is not UTF-8 survive;
 * only the body of `[TimingPoints]` is rebuilt, and inside it every green
 * line and comment is kept as its own bytes.
 *
 * What happens to what is already there:
 * - **Red lines** (uninherited) are removed; the result's take their place.
 * - **Green lines** (inherited) are kept, unchanged, in their order. One that
 *   now sits before the first red line is kept too: osu! reads it against the
 *   first red line, as it already does for anything before it. Deleting it
 *   would lose its slider velocity and hitsounds; the page counts them and
 *   says so.
 * - **What a removed red line also set.** A red line carries the hitsound
 *   state (sample set, custom index, volume, kiai) and resets the slider
 *   velocity to 1x. Where the new timing would change that at a removed red
 *   line's time (another volume, sample set or kiai, or a green line's
 *   velocity running on), a green line (`-100`, 1x) with that red line's own
 *   state is added there, so the map sounds and slides as before. Where
 *   nothing would change (the usual case: one red line moved a few ms), none.
 * - **Each new red line** takes the hitsound state that was in effect at its
 *   time (the last old point at or before it, else the first one), and kiai
 *   from it; never "omit first barline", which belonged to the old bar.
 * - **Hit objects** are not touched: moving them is out of scope. They may no
 *   longer sit on the new grid, and the page says so.
 */
import { roundHalfEven } from './timing.js'

/** Bytes to a string of one char per byte, and back: lossless, unlike any TextDecoder. */
export function bytesToBinary(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return out
}

export function binaryToBytes(text) {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return bytes
}

/** The default hitsound state, osu!'s for a new map: normal set, default index, volume 100. */
const DEFAULT_STATE = { sampleSet: '1', sampleIndex: '0', volume: '100', effects: 0 }

/**
 * A `[TimingPoints]` row read: `null` for anything that is not one (a blank,
 * a comment). Old formats with only `time,beatLength` count as red when the
 * beat length is positive, as osu! reads them.
 */
export function parsePoint(raw) {
  const row = raw.trim()
  if (!row || row.startsWith('//')) return null
  const f = row.split(',')
  const time = Number(f[0])
  const beatLength = Number(f[1])
  if (f.length < 2 || !Number.isFinite(time) || !Number.isFinite(beatLength)) return null
  const red = f.length > 6 ? f[6].trim() !== '0' : beatLength > 0
  return {
    raw,
    time,
    red,
    beatLength,
    meter: f[2]?.trim() || '4',
    state: {
      sampleSet: f[3]?.trim() || DEFAULT_STATE.sampleSet,
      sampleIndex: f[4]?.trim() || DEFAULT_STATE.sampleIndex,
      volume: f[5]?.trim() || DEFAULT_STATE.volume,
      effects: Number(f[7]) || 0,
    },
  }
}

/** The hitsound state in effect at `time`: the last point at or before it in file order, else the first. */
function stateAt(points, time) {
  let found = null
  for (const p of points) if (p.time <= time + 1e-9) found = p
  return (found ?? points[0])?.state ?? DEFAULT_STATE
}

/** By time; at the same time a red line first, as osu! orders them. */
const byTime = (a, b) => a.time - b.time || Number(b.red) - Number(a.red)

/** The point in force at `time` in a sorted timeline: the last at or before it, else the first. */
function effectiveAt(timeline, time) {
  let found = null
  for (const p of timeline) if (p.time <= time + 1e-9) found = p
  return found ?? timeline[0] ?? null
}

const sameSound = (a, b) => a.sampleSet === b.sampleSet && a.sampleIndex === b.sampleIndex && a.volume === b.volume && (a.effects & 1) === (b.effects & 1)

/** Where a section's header is, by its exact name, at the start of a line. */
function sectionAt(text, name) {
  const re = new RegExp(`(^|\\r\\n|\\n|\\r)\\[${name}\\][ \\t]*(?=\\r\\n|\\n|\\r|$)`)
  const m = re.exec(text)
  return m ? m.index + m[1].length : -1
}

/** The end of the section starting at `from`: the next line that opens with `[`, else the end of the file. */
function sectionEnd(text, from) {
  const re = /(\r\n|\n|\r)[ \t]*\[/g
  re.lastIndex = from
  const m = re.exec(text)
  return m ? m.index + m[1].length : text.length
}

/**
 * Patches `text` (a binary string, see `bytesToBinary`) with `lines` (the
 * page's red lines, `adjustLines`' shape). Returns `{ text, report }`, or
 * `{ error }`: 'notOsu' when the first line is not an osu! header,
 * 'noTimingPoints' when the file has no `[TimingPoints]`, 'noLines' when there
 * is nothing to put in.
 */
export function patchOsu(text, lines) {
  const body = text.replace(/^\xef\xbb\xbf/, '')
  if (!/^\s*osu file format v\d+/.test(body)) return { error: 'notOsu' }
  const usable = lines.filter((line) => line.beatMs > 0 && Number.isFinite(line.timeMs))
  if (!usable.length) return { error: 'noLines' }
  const header = sectionAt(text, 'TimingPoints')
  if (header < 0) return { error: 'noTimingPoints' }

  // The header line and its line break stay as they are; new rows take that break.
  const headerEnd = /\r\n|\n|\r/.exec(text.slice(header))
  if (!headerEnd) return { error: 'noTimingPoints' }
  const start = header + headerEnd.index + headerEnd[0].length
  const end = sectionEnd(text, header)
  const eol = headerEnd[0]

  // The section's rows, each with its own break; the trailing blanks before the next section kept apart.
  const rows = []
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g
  const sectionText = text.slice(start, end)
  for (let m = re.exec(sectionText); m && m.index < sectionText.length; m = re.exec(sectionText)) {
    rows.push({ raw: m[1], eol: m[2] })
    if (!m[2]) break
  }
  let tail = rows.length
  while (tail > 0 && rows[tail - 1].raw.trim() === '') tail--
  const trailing = rows.slice(tail)
  const kept = rows.slice(0, tail).map((row) => ({ ...row, point: parsePoint(row.raw) }))

  const points = kept.map((row) => row.point).filter(Boolean)
  const greens = points.filter((p) => !p.red)
  const reds = points.filter((p) => p.red)

  // The new red lines, as osu! writes them, with the state in effect where each lands.
  const added = usable.map((line) => {
    const time = roundHalfEven(line.timeMs)
    const s = stateAt(points, time)
    const state = { ...s, effects: s.effects & 1 }
    return { time, red: true, beatLength: line.beatMs, state, raw: `${time},${line.beatMs.toFixed(12)},${line.meter},${s.sampleSet},${s.sampleIndex},${s.volume},1,${state.effects}` }
  })

  // A removed red line's own state, carried by a green line where the new
  // timing would otherwise change it: hitsounds, kiai, or a slider velocity
  // the red line had reset to 1x.
  const timeline = [...added, ...greens].sort(byTime)
  const carried = []
  for (const red of [...reds].sort(byTime)) {
    const time = Math.round(red.time)
    const now = effectiveAt(timeline, time)
    const want = { ...red.state, effects: red.state.effects & 1 }
    const sameState = now && sameSound(now.state, want)
    const sameVelocity = now && (now.red || Math.abs(now.beatLength + 100) < 1e-9)
    if (sameState && sameVelocity) continue
    const s = want
    const green = { time, red: false, beatLength: -100, state: want, raw: `${time},-100,${red.meter},${s.sampleSet},${s.sampleIndex},${s.volume},0,${s.effects}` }
    carried.push(green)
    timeline.push(green)
    timeline.sort(byTime)
  }
  const inserts = [...added, ...carried].sort(byTime)

  // Merged by time into what stays: a red line before a green one at the same time, as osu! orders them.
  const out = []
  let next = 0
  for (const row of kept) {
    if (row.point?.red) continue
    if (row.point) while (next < inserts.length && inserts[next].time <= row.point.time + 1e-9) out.push({ raw: inserts[next++].raw, eol })
    out.push(row)
  }
  while (next < inserts.length) out.push({ raw: inserts[next++].raw, eol })

  // Every row ends with its own break; one that had none (the file's end) gets one when a row follows it.
  const all = [...out, ...trailing]
  const last = rows.length ? rows[rows.length - 1].eol : eol
  const section = all.map((row, i) => row.raw + (i + 1 < all.length ? row.eol || eol : last)).join('')
  const firstRed = added[0].time
  return {
    text: text.slice(0, start) + section + text.slice(end),
    report: {
      redRemoved: reds.length,
      redAdded: added.length,
      greensKept: greens.length,
      greensBefore: greens.filter((g) => g.time < firstRed).length,
      carried: carried.length,
      hitObjects: countHitObjects(text),
    },
  }
}

/** How many hit objects the file holds: the rows of `[HitObjects]`. */
export function countHitObjects(text) {
  const at = sectionAt(text, 'HitObjects')
  if (at < 0) return 0
  return text
    .slice(at, sectionEnd(text, at))
    .split(/\r\n|\n|\r/)
    .slice(1)
    .filter((row) => row.trim() && !row.trim().startsWith('//')).length
}

/** The patched file from the reader's `File`: `{ name, bytes, report }` or `{ error }`. */
export async function patchOsuFile(file, lines) {
  if (file.size > 16 * 1024 * 1024) return { error: 'tooBig' }
  const text = bytesToBinary(new Uint8Array(await file.arrayBuffer()))
  const patched = patchOsu(text, lines)
  if (patched.error) return patched
  return { name: file.name, bytes: binaryToBytes(patched.text), report: patched.report }
}
