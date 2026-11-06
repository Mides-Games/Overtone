/** Rhythm Doctor (.rdlevel): the song, its tempo and bars, no rows. */
import { field, notBeforeZero, roundTo, spanLines, writtenBeats } from './common.js'

// ---------------------------------------------------------------------------
// Rhythm Doctor
// ---------------------------------------------------------------------------

export const RHYTHM_DOCTOR_VERSION = 55

/**
 * The level's timing events: `{ offset, bpm, events: [{ bar, beat, type,
 * value }], report: { worstMs, meterLost } }`. Bar 1 beat 1 is the first line,
 * `offset` ms into the audio (whole ms); later beats are accumulated through
 * the tempi (`writtenBeats`) and named by bar and beat (both from 1) in bars of
 * the running `crotchetsPerBar`, which changes only at a bar's start.
 */
export function rhythmDoctorTimeline(lines) {
  const points = spanLines(lines)
  if (!points.length) throw new Error('No timing to export.')
  const startMs = notBeforeZero(points[0])
  const offset = Math.round(startMs)
  const { beats, bpms, worstMs } = writtenBeats([{ timeMs: offset, bpm: points[0].bpm }, ...points.slice(1)])
  const events = [{ bar: 1, beat: 1, type: 'SetCrotchetsPerBar', value: points[0].meter }]
  let segBeat = 0
  let segBar = 1
  let cpb = points[0].meter
  let meterLost = 0
  const where = (b) => {
    const into = b - segBeat
    let bars = Math.floor(into / cpb + 1e-9)
    let beat = roundTo(into - bars * cpb)
    if (beat >= cpb - 1e-9) {
      bars += 1
      beat = 0
    }
    return { bar: segBar + bars, beat: roundTo(beat + 1) }
  }
  for (let i = 1; i < points.length; i++) {
    const at = where(beats[i])
    if (points[i].meter !== cpb) {
      if (Math.abs(at.beat - 1) < 1e-6) {
        events.push({ ...at, type: 'SetCrotchetsPerBar', value: points[i].meter })
        segBeat = beats[i]
        segBar = at.bar
        cpb = points[i].meter
      } else meterLost++
    }
    if (bpms[i] !== bpms[i - 1]) events.push({ ...at, type: 'SetBeatsPerMinute', value: bpms[i] })
  }
  return { offset, bpm: bpms[0], events, report: { worstMs: Math.max(worstMs, Math.abs(offset - startMs)), meterLost } }
}

/** A whole .rdlevel: the song, its tempo and bars, no rows. `{ text, report }`. */
export function rhythmDoctorFile({ title, artist, creator, audioName, lines }) {
  const { offset, bpm, events, report } = rhythmDoctorTimeline(lines)
  const actions = [
    { bar: 1, beat: 1, y: 0, type: 'PlaySong', filename: field(audioName), volume: 100, pitch: 100, pan: 0, offset, bpm, loop: false },
    ...events.map((e) =>
      e.type === 'SetCrotchetsPerBar'
        ? { bar: e.bar, beat: e.beat, y: 0, type: e.type, crotchetsPerBar: e.value, visualBeatMultiplier: 1 }
        : { bar: e.bar, beat: e.beat, y: 0, type: e.type, beatsPerMinute: e.value },
    ),
  ]
  const level = {
    settings: {
      version: RHYTHM_DOCTOR_VERSION,
      artist: field(artist),
      song: field(title),
      author: field(creator),
      description: 'Timing from Overtone: tempo and bars only. Check it by ear.',
      tags: 'overtone',
    },
    rows: [],
    decorations: [],
    actions,
    conditionals: [],
    bookmarks: [],
  }
  return { text: `${JSON.stringify(level, null, 2)}\n`, report }
}
