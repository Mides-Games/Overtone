/** Beat Saber: a v3 difficulty file of BPM events. */
import { roundTo, spanLines, writtenBeats } from './common.js'

// ---------------------------------------------------------------------------
// Beat Saber
// ---------------------------------------------------------------------------

export const BEAT_SABER_VERSION = '3.3.0'

/**
 * Beat Saber's v3 `bpmEvents`: `{ events: [{ b, m }], infoBpm, report: {
 * leadIn, worstMs } }`. Beat 0 is the audio's start; a lead-in beat reaches
 * the first line's first beat at least half a beat in; each change's beat is
 * accumulated through the tempi (`writtenBeats`). An event whose BPM is the
 * one before it (a meter change alone: Beat Saber has no meter) is left out.
 */
export function beatSaberBpmEvents(lines) {
  const points = spanLines(lines)
  if (!points.length) throw new Error('No timing to export.')
  const first = points[0]
  const beat0 = 60000 / first.bpm
  const phase = (((first.timeMs % beat0) + beat0) % beat0)
  const onZero = phase < 1e-6 || beat0 - phase < 1e-6
  const target = onZero ? 0 : phase >= beat0 / 2 ? phase : phase + beat0
  const anchors = []
  if (target > 0) anchors.push({ timeMs: 0, bpm: 60000 / target })
  anchors.push({ timeMs: target, bpm: first.bpm }, ...points.slice(1))
  const { beats, bpms, worstMs } = writtenBeats(anchors)
  const events = []
  beats.forEach((b, i) => {
    if (events.length && events.at(-1).m === bpms[i]) return
    events.push({ b, m: bpms[i] })
  })
  return { events, infoBpm: roundTo(first.bpm), report: { leadIn: target > 0, worstMs } }
}

/** A v3 difficulty file: the BPM events and every other list empty. `{ text, report }`. */
export function beatSaberFile({ lines }) {
  const { events, infoBpm, report } = beatSaberBpmEvents(lines)
  const map = {
    version: BEAT_SABER_VERSION,
    bpmEvents: events,
    rotationEvents: [],
    colorNotes: [],
    bombNotes: [],
    obstacles: [],
    sliders: [],
    burstSliders: [],
    waypoints: [],
    basicBeatmapEvents: [],
    colorBoostBeatmapEvents: [],
    lightColorEventBoxGroups: [],
    lightRotationEventBoxGroups: [],
    lightTranslationEventBoxGroups: [],
    basicEventTypesWithKeywords: { d: [] },
    useNormalEventsAsCompatibleEvents: false,
  }
  return { text: `${JSON.stringify(map, null, 2)}\n`, report: { ...report, infoBpm } }
}
