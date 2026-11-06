/** Friday Night Funkin': the legacy chart JSON, sections of 16 steps. */
import { field, songEndMs, spanLines, unitTimeline } from './common.js'

// ---------------------------------------------------------------------------
// Friday Night Funkin'
// ---------------------------------------------------------------------------

export const FNF_STEPS_PER_SECTION = 16

/**
 * The chart's sections: `{ sections: [{ steps, bpm, changeBPM }], bpm,
 * report: { leadIn, worstMs, odd } }`. A section is 16 steps (4 beats) at its
 * BPM; the song starts at the audio's start, so a lead-in section of the
 * first line's tempo (fitted to whole steps) reaches its first section's
 * start; a span that is not whole sections ends on an odd one (`cutSpan`).
 */
export function fnfSections(lines, { durationS } = {}) {
  const points = spanLines(lines)
  if (!points.length) throw new Error('No timing to export.')
  const first = points[0]
  const sectionMs = FNF_STEPS_PER_SECTION * (15000 / first.bpm)
  const phase = (((first.timeMs % sectionMs) + sectionMs) % sectionMs)
  const onZero = phase < 1e-6 || sectionMs - phase < 1e-6
  const target = onZero ? 0 : phase >= sectionMs / 2 ? phase : phase + sectionMs
  const anchored = [{ ...first, timeMs: target }, ...points.slice(1)]
  const { units, worstMs, odd } = unitTimeline(anchored, {
    startMs: 0,
    smallBeats: 0.25,
    full: FNF_STEPS_PER_SECTION,
    endMs: songEndMs(points, durationS),
    leadIn: target > 0 ? { endMs: target, bpm: first.bpm } : null,
  })
  const bpm = units[0].bpm
  let current = bpm
  const sections = units.map((u) => {
    const changeBPM = u.bpm !== current
    current = u.bpm
    return { steps: u.size, bpm: u.bpm, changeBPM }
  })
  return { sections, bpm, report: { leadIn: target > 0, worstMs, odd } }
}

/** The legacy chart JSON that the base game before 0.3 and Psych Engine read. `{ text, report }`. */
export function fnfFile({ title, lines, durationS }) {
  const { sections, bpm, report } = fnfSections(lines, { durationS })
  const chart = {
    song: {
      song: field(title),
      notes: sections.map((s) => ({
        lengthInSteps: s.steps,
        sectionBeats: s.steps / 4,
        typeOfSection: 0,
        mustHitSection: true,
        changeBPM: s.changeBPM,
        bpm: s.bpm,
        altAnim: false,
        sectionNotes: [],
      })),
      bpm,
      needsVoices: false,
      speed: 1,
      player1: 'bf',
      player2: 'dad',
      gfVersion: 'gf',
      stage: 'stage',
      validScore: true,
    },
  }
  return { text: `${JSON.stringify(chart)}\n`, report: { ...report, sections: sections.length } }
}
