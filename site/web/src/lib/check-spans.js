/**
 * "Check here" (W3.25): the spans of a result worth a listen before anything
 * else, read from what the engine already reported. Nothing here is a new
 * estimate; it gathers four signals the page already draws in different
 * places into one list, sorted by time:
 *
 * - **level**: a section the worker graded `check` or `medium`
 *   (worker/timing_result.py `_level`: confidence under 0.75, a loose fit or
 *   an engine warning make `check`; under 0.90, or the beat tracker's
 *   fallback, `medium`);
 * - **drift**: a section whose attacks' 90th-percentile distance from the
 *   grid (`drift_p90_ms`) is over `DRIFT_P90_MS`;
 * - **hint**: the engine's half- or double-time hints (`pulse_hints`);
 * - **swing**: the spans the swing lane found swung (`swing.spans`).
 *
 * Neighbouring sections flagged for the same reasons are one span: a tempo
 * ramp read as thirty short sections is one thing to listen to.
 */

/**
 * The drift past which a section is listed, in ms (90th percentile of each
 * attack's distance from the nearest 1/1-1/4 tick). Chosen from the data on
 * 2026-10-27 (docs/timeline.md): on the 34-file synthetic corpus, whose grids
 * are exact, every section's p90 is under 10 ms except the two built to be
 * hard (very-noisy-132 at 27 ms, swing-120 at 40 ms); on Corpus B's 20 hand-
 * timed songs, 28 of the 30 sections with a drift are over 20 ms and all 30
 * are graded `check` already. 20 ms keeps a clean grid off the list with
 * twice its margin. On dense real music the measure nears its ceiling (an
 * eighth of a beat: 34 ms at 222 BPM), so there it cannot tell a right grid
 * from a wrong one, and the level carries the warning.
 */
export const DRIFT_P90_MS = 20

/** The order reasons are listed in, most telling first. */
export const REASONS = ['check', 'medium', 'drift', 'hint', 'swing']

const sectionReasons = (section) => {
  const reasons = []
  if (section.level === 'check' || section.level === 'medium') reasons.push(section.level)
  if (typeof section.drift_p90_ms === 'number' && section.drift_p90_ms > DRIFT_P90_MS) reasons.push('drift')
  return reasons
}

/**
 * The spans of `result` to check, sorted by start: `{ key, startMs, endMs,
 * reasons, sections: [first, last] | null, driftP90Ms, factor, feel }`.
 * `driftP90Ms` is the worst p90 across a merged span; `factor` is a hint's
 * (0.5 half time, 2 double), `feel` a swing span's.
 */
export function checkSpans(result) {
  const out = []
  const sections = result?.sections ?? []
  let run = null
  sections.forEach((section, i) => {
    const reasons = sectionReasons(section)
    const same = run && run.reasons.join() === reasons.join() && run.sections[1] === i - 1 && Math.abs(run.endMs - section.start_ms) < 1
    if (reasons.length && same) {
      run.endMs = section.end_ms
      run.sections[1] = i
      if (section.drift_p90_ms > (run.driftP90Ms ?? -1)) run.driftP90Ms = section.drift_p90_ms
      return
    }
    if (run) out.push(run)
    run = reasons.length
      ? { key: `s${i}`, startMs: section.start_ms, endMs: section.end_ms, reasons, sections: [i, i], driftP90Ms: section.drift_p90_ms ?? null }
      : null
  })
  if (run) out.push(run)

  for (const hint of result?.pulse_hints ?? []) {
    if (!(hint.to_ms > hint.from_ms)) continue
    out.push({ key: `h${hint.boundary_ms}`, startMs: hint.from_ms, endMs: hint.to_ms, reasons: ['hint'], sections: null, factor: hint.factor })
  }
  for (const span of result?.swing?.spans ?? []) {
    if (!(span.end_ms > span.start_ms)) continue
    out.push({ key: `w${span.start_ms}`, startMs: span.start_ms, endMs: span.end_ms, reasons: ['swing'], sections: null, feel: span.feel ?? null })
  }

  const rank = (item) => REASONS.indexOf(item.reasons[0])
  return out.sort((a, b) => a.startMs - b.startMs || rank(a) - rank(b))
}
