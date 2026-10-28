/**
 * The front page's example analysis (components/TimingStrip.jsx): a made-up
 * song of four red lines, timed the way osu! times one, and the arithmetic
 * the strip draws and plays it with. Pure, so the tests reach it.
 *
 * Each red line is an uninherited timing point: an offset in whole ms, a BPM,
 * `beatLength = 60000 / BPM` and a meter. A line runs for whole bars, and the
 * next one starts where those bars end, rounded to the ms as a mapper's offset
 * would be, so every red line sits on a downbeat of the grid the strip draws.
 */

/** The example: two tempo changes, a bar of 3/4 and a slower outro. */
export const EXAMPLE_SPEC = [
  { bpm: 174, meter: 4, bars: 3, confidence: 0.97 },
  { bpm: 186, meter: 4, bars: 3, confidence: 0.93 },
  { bpm: 186, meter: 3, bars: 2, confidence: 0.84 },
  { bpm: 160, meter: 4, bars: 2, confidence: 0.71 },
]

/** Where the first red line falls, in ms from the start of the audio. */
export const EXAMPLE_OFFSET = 1284

/**
 * The level a confidence reads as, with the thresholds the worker uses
 * (docs/site.md, timing-result v1): 0.90 and up is high, 0.75 medium, below
 * that check by ear.
 */
export const levelOf = (confidence) => (confidence >= 0.9 ? 'high' : confidence >= 0.75 ? 'medium' : 'check')

/** `spec` laid end to end from `offset`: each line with its offset, beat length, end and level. */
export function buildLines(spec = EXAMPLE_SPEC, offset = EXAMPLE_OFFSET) {
  const lines = []
  let at = Math.round(offset)
  for (const { bpm, meter, bars, confidence } of spec) {
    const beatLength = 60000 / bpm
    const end = Math.round(at + bars * meter * beatLength)
    lines.push({ offset: at, bpm, beatLength, meter, bars, end, confidence, level: levelOf(confidence) })
    at = end
  }
  return lines
}

/** The span the example covers: the first offset to the last line's end. */
export const spanOf = (lines) => ({ start: lines[0].offset, end: lines[lines.length - 1].end })

/**
 * Every beat of the grid, as osu! draws it: each line's beats from its offset
 * up to, not onto, the next line's. `bar` marks a downbeat on the line's meter.
 */
export function gridOf(lines) {
  const beats = []
  for (const [index, line] of lines.entries()) {
    const count = line.bars * line.meter
    for (let i = 0; i < count; i++) beats.push({ time: line.offset + i * line.beatLength, bar: i % line.meter === 0, line: index })
  }
  return beats
}

/** The playhead's time, `elapsed` ms after it started, looping over the span. */
export function loopTime(lines, elapsed) {
  const { start, end } = spanOf(lines)
  const length = end - start
  const e = Number.isFinite(elapsed) ? elapsed : 0
  return start + (((e % length) + length) % length)
}

/** The index of the red line in force at `time`: the last one at or before it (the first before any). */
export function activeIndex(lines, time) {
  let index = 0
  for (let i = 0; i < lines.length; i++) if (lines[i].offset <= time) index = i
  return index
}

/** Bar and beat (both from 1) of `time` under its line, as an editor's counter reads it. */
export function barBeat(lines, time) {
  const line = lines[activeIndex(lines, time)]
  const beats = Math.max(0, Math.floor((time - line.offset) / line.beatLength + 1e-9))
  return { bar: Math.floor(beats / line.meter) + 1, beat: (beats % line.meter) + 1 }
}

/** The figures the strip shows for one line, formatted as the result page shows them. */
export const readoutsOf = (line) => ({
  bpm: line.bpm.toFixed(2),
  offset: String(line.offset),
  meter: `${line.meter}/4`,
  confidence: line.confidence.toFixed(2),
})

/**
 * The line as a `[TimingPoints]` row: time, beatLength, meter, sample set,
 * sample index, volume, uninherited, effects. The beat length is written to
 * twelve decimals, as osu! writes it.
 */
export const osuRow = (line) => `${line.offset},${Number(line.beatLength.toFixed(12))},${line.meter},2,0,60,1,0`

/** The step a reduced-motion strip takes: one red line every `every` ms, never a sweep. */
export const steppedIndex = (lines, elapsed, every = 4000) => Math.floor(Math.max(0, elapsed) / every) % lines.length
