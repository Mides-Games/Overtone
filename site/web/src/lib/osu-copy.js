/**
 * Copying red lines as osu! holds them (W12.24): one line, or a stretch of
 * them, as `[TimingPoints]` rows ready to paste into that section of an
 * .osu, the way a mapper copies timing points between difficulties in the
 * editor.
 *
 * The rows are the same ones the page's whole-block copy and the .osz write
 * (lib/timing.js `timingText`): unadjusted, the engine's own rows as it wrote
 * them (its beat length to 12 decimals); adjusted, rebuilt from the lines as
 * the reader has them. No section header and no comment line: what is pasted
 * is rows, and osu! sorts its timing points by time on save.
 */
import { roundHalfEven } from './timing.js'

/** The engine's `[TimingPoints]` rows, one per red line, or null when they do not line up one to one. */
function engineRows(result) {
  const rows = String(result?.osu_timing ?? '')
    .split(/\r?\n/)
    .filter((row) => row && !row.startsWith('//') && row !== '[TimingPoints]')
  return rows.length === (result?.red_lines ?? []).length ? rows : null
}

/** One red line as an uninherited timing point: time, beat length, meter, sample set 1, index 0, volume 100, uninherited, no effects. */
export const rowOf = (line) => `${roundHalfEven(line.timeMs)},${line.beatMs.toFixed(12)},${line.meter},1,0,100,1,0`

/**
 * The rows of `positions` (indexes into `lines`, in any order), sorted by
 * time, CRLF as .osu files are, with a trailing line break so a paste ends on
 * a new line. Empty when nothing is picked.
 */
export function timingRows(result, lines, adjustment = { factor: 1, nudgeMs: 0 }, positions = lines.map((_, i) => i)) {
  const adjusted = adjustment.factor !== 1 || adjustment.nudgeMs !== 0
  const written = adjusted ? null : engineRows(result)
  const picked = [...new Set(positions)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < lines.length)
    .sort((a, b) => lines[a].timeMs - lines[b].timeMs || a - b)
  if (!picked.length) return ''
  return `${picked.map((i) => written?.[lines[i].index] ?? rowOf(lines[i])).join('\r\n')}\r\n`
}

/**
 * The selection after a click on row `i`: a plain click toggles it; with
 * Shift, every row from the last one clicked (`anchor`) to `i` takes the
 * clicked row's new state, as a stretch in a list does.
 */
export function toggleSelection(selection, i, { shift = false, anchor = null } = {}) {
  const next = new Set(selection)
  const on = !selection.has(i)
  if (shift && anchor !== null && anchor !== i) {
    const [a, b] = anchor < i ? [anchor, i] : [i, anchor]
    for (let k = a; k <= b; k++) {
      if (on) next.add(k)
      else next.delete(k)
    }
  } else if (on) next.add(i)
  else next.delete(i)
  return next
}
