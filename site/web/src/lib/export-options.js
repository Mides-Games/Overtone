/**
 * The export options (W12.8): how the red lines are written out, never how
 * they are heard. They apply to the .osz, the reader's own .osu, the copied
 * `[TimingPoints]` and the other games' files; not to the clicks, the page,
 * the CSV or the JSON, which show the timing as the reader has it.
 *
 * - `offsetDecimals` (0-3): decimals of a millisecond in the formats that
 *   take them (Quaver's StartTime, StepMania's #OFFSET). osu! reads whole
 *   milliseconds, so its files always round; Clone Hero counts in ticks.
 * - `bpmDecimals` (null or 0-3): every BPM rounded to that many decimals, the
 *   beat length then 60000 / BPM. The offsets stay, so the grid walks off by
 *   the end of each line: `bpmRoundingDrift` says how far, and the page shows it.
 * - `firstLineOnly`: only the first red line, for a song the reader wants on
 *   one tempo (the rest of the song then runs on its grid, unchecked).
 * - `globalOffsetMs` (whole ms, ±1000): added to every line on the way out.
 *   It is kept apart from the nudge on purpose: the nudge is a correction the
 *   reader hears in the clicks; this is a target's own convention (a game's,
 *   a pack's, a reader's setup), which the clicks must not follow or it would
 *   be heard as a mistake. Remembered across songs, unlike the nudge, so the
 *   page always says when it is on.
 *
 * Remembered in this browser under `overtone.exports`; every stored value is
 * read defensively and falls back to its default.
 */

export const STORAGE_KEY = 'overtone.exports'
export const GLOBAL_OFFSET_LIMIT = 1000

export const DEFAULT_EXPORT_OPTIONS = Object.freeze({
  offsetDecimals: 3,
  bpmDecimals: null,
  firstLineOnly: false,
  globalOffsetMs: 0,
})

const decimals = (value, fallback) => (Number.isInteger(value) && value >= 0 && value <= 3 ? value : fallback)

/** Options from anything (a stored object, a partial update): every field checked, every bad one its default. */
export function cleanOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {}
  const offset = Math.round(Number(o.globalOffsetMs))
  return {
    offsetDecimals: decimals(o.offsetDecimals, DEFAULT_EXPORT_OPTIONS.offsetDecimals),
    bpmDecimals: o.bpmDecimals === null ? null : decimals(o.bpmDecimals, DEFAULT_EXPORT_OPTIONS.bpmDecimals),
    firstLineOnly: o.firstLineOnly === true,
    globalOffsetMs: Number.isFinite(offset) ? Math.max(-GLOBAL_OFFSET_LIMIT, Math.min(GLOBAL_OFFSET_LIMIT, offset)) : 0,
  }
}

export function loadOptions(storage = globalThis.localStorage) {
  try {
    const text = storage?.getItem(STORAGE_KEY)
    return text ? cleanOptions(JSON.parse(text)) : { ...DEFAULT_EXPORT_OPTIONS }
  } catch {
    return { ...DEFAULT_EXPORT_OPTIONS }
  }
}

export function saveOptions(options, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(cleanOptions(options)))
  } catch {
    // A private window or blocked storage: the options hold for this page only.
  }
}

/** Whether the options change the lines written (offset decimals change only how they are spelled). */
export const changesLines = (options) =>
  Boolean(options) && (options.bpmDecimals !== null || options.firstLineOnly || options.globalOffsetMs !== 0)

/** BPM rounded to `n` decimals, as it is then written: the value its decimal spelling reads back as. */
export const roundBpm = (bpm, n) => Number(bpm.toFixed(n))

/**
 * The lines as they are written: `adjustLines`' shape in, the same shape out.
 * `index` still points into the result's lists.
 */
export function exportLines(lines, options = DEFAULT_EXPORT_OPTIONS) {
  const o = cleanOptions(options)
  const picked = o.firstLineOnly ? lines.slice(0, 1) : lines
  return picked.map((line) => {
    const out = { ...line, timeMs: line.timeMs + o.globalOffsetMs }
    if (o.bpmDecimals !== null && line.beatMs > 0) {
      const bpm = roundBpm(60000 / line.beatMs, o.bpmDecimals)
      if (bpm > 0) Object.assign(out, { bpm, beatMs: 60000 / bpm })
    }
    return out
  })
}

/**
 * How far the rounded BPM walks the grid off the reader's, in ms: per line,
 * the last beat before the next line (the last line: before `durationMs`),
 * the worst of them. `{ worstMs, line }`, `line` the index in `lines`.
 * Zero with no rounding.
 */
export function bpmRoundingDrift(lines, options, durationMs) {
  const o = cleanOptions(options)
  if (o.bpmDecimals === null) return { worstMs: 0, line: 0 }
  const picked = o.firstLineOnly ? lines.slice(0, 1) : lines
  let worst = { worstMs: 0, line: 0 }
  picked.forEach((line, i) => {
    if (!(line.beatMs > 0)) return
    const end = i + 1 < picked.length ? picked[i + 1].timeMs : Math.max(durationMs || 0, line.timeMs)
    const rounded = 60000 / roundBpm(60000 / line.beatMs, o.bpmDecimals)
    const beats = Math.max(0, Math.floor((end - line.timeMs) / line.beatMs - 1e-9))
    const drift = beats * Math.abs(rounded - line.beatMs)
    if (drift > worst.worstMs) worst = { worstMs: drift, line: i }
  })
  return worst
}

/** A short English note of the options in force, for a file's comment line ('' when none change the lines). */
export function optionsNote(options) {
  const o = cleanOptions(options)
  const parts = []
  if (o.bpmDecimals !== null) parts.push(`BPM rounded to ${o.bpmDecimals} decimal${o.bpmDecimals === 1 ? '' : 's'}`)
  if (o.firstLineOnly) parts.push('first red line only')
  if (o.globalOffsetMs) parts.push(`${o.globalOffsetMs > 0 ? '+' : ''}${o.globalOffsetMs} ms export offset`)
  return parts.join(', ')
}

/**
 * The page's one copy of the options: every export control reads the same
 * object, so the .osz button and the panel inside "More downloads" never
 * disagree. Loaded on first read, saved on every change.
 */
let current = null
const listeners = new Set()

export const exportOptionsStore = {
  get() {
    if (!current) current = loadOptions()
    return current
  },
  set(patch) {
    const base = exportOptionsStore.get()
    current = cleanOptions({ ...base, ...(typeof patch === 'function' ? patch(base) : patch) })
    saveOptions(current)
    listeners.forEach((fn) => fn())
  },
  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}
