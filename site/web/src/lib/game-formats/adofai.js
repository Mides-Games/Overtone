/** A Dance of Fire and Ice (.adofai): a straight path, SetSpeed by BPM. */
import { field, notBeforeZero, songEndMs, spanLines, unitTimeline } from './common.js'

// ---------------------------------------------------------------------------
// A Dance of Fire and Ice
// ---------------------------------------------------------------------------

/**
 * The level's tiles and speeds: `{ offset, bpm, tiles, actions: [{ floor,
 * bpm }], report: { worstMs, odd } }`. Tile 0 is at `offset` (whole ms);
 * every tile is one beat on a straight path; a SetSpeed on a floor sets the
 * tempo from that tile on.
 */
export function adofaiTimeline(lines, { durationS } = {}) {
  const points = spanLines(lines)
  if (!points.length) throw new Error('No timing to export.')
  const startMs = notBeforeZero(points[0])
  const offset = Math.round(startMs)
  const { units, starts, worstMs, odd } = unitTimeline(points, { startMs: offset, smallBeats: 1, full: 1, endMs: songEndMs(points, durationS) })
  const actions = []
  let current = units[0]?.bpm
  units.forEach((u, floor) => {
    if (floor > 0 && u.bpm !== current) actions.push({ floor, bpm: u.bpm })
    current = u.bpm
  })
  return { offset, bpm: units[0].bpm, tiles: units.length, starts, actions, report: { worstMs: Math.max(worstMs, Math.abs(offset - startMs)), odd } }
}

export const ADOFAI_VERSION = 13

/** A whole .adofai: a straight path of one-beat tiles, SetSpeed by BPM, no decorations. `{ text, report }`. */
export function adofaiFile({ title, artist, creator, audioName, lines, durationS }) {
  const { offset, bpm, tiles, actions, report } = adofaiTimeline(lines, { durationS })
  const level = {
    // One angle per tile after the first, 0 (to the right) for each: a straight line, a beat a tile.
    angleData: Array.from({ length: tiles }, () => 0),
    settings: {
      version: ADOFAI_VERSION,
      artist: field(artist),
      song: field(title),
      author: field(creator),
      levelDesc: 'Timing from Overtone: tiles and speeds only. Check it by ear.',
      levelTags: 'overtone',
      songFilename: field(audioName),
      bpm,
      volume: 100,
      offset,
      pitch: 100,
      hitsound: 'Kick',
      hitsoundVolume: 100,
      countdownTicks: 4,
    },
    actions: actions.map((a) => ({ floor: a.floor, eventType: 'SetSpeed', speedType: 'Bpm', beatsPerMinute: a.bpm, bpmMultiplier: 1 })),
    decorations: [],
  }
  // The angles on one line, as the editor writes them: a tile a line would make a long song thousands of lines.
  const text = JSON.stringify(level, null, 2).replace(/"angleData": \[[^\]]*\]/, `"angleData": [${level.angleData.join(', ')}]`)
  return { text: `${text}\n`, report: { ...report, tiles } }
}
