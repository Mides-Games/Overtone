/** Clone Hero (notes.chart): ticks at 192 per beat, milli-BPM tempo changes. */
import { CHART_RESOLUTION, CHART_TOLERANCE_MS, field, gameLines } from './common.js'

// ---------------------------------------------------------------------------
// Clone Hero
// ---------------------------------------------------------------------------

const MS_PER_MINUTE_MILLI = 60000 * 1000

/** The time a span of ticks takes at `milliBpm`, in ms. */
const ticksMs = (ticks, milliBpm) => ((ticks / CHART_RESOLUTION) * MS_PER_MINUTE_MILLI) / milliBpm

/**
 * The `[SyncTrack]` events: `{ events: [{ tick, kind: 'TS'|'B', value }],
 * report: { leadIn, fitted, worstMs } }`, `worstMs` the furthest a line's
 * tempo marker lands from its own time by the game's arithmetic.
 */
export function chartSyncTrack(lines) {
  const points = gameLines(lines)
  if (!points.length) throw new Error('No timing to export.')
  const R = CHART_RESOLUTION
  const first = points[0]
  const firstBeat = 60000 / first.bpm
  const barMs = first.meter * firstBeat
  const events = []
  const report = { leadIn: false, fitted: 0, worstMs: 0 }

  // The first line's first downbeat at least half a bar in: a lead-in bar from tick 0 reaches it.
  const phase = (((first.timeMs % barMs) + barMs) % barMs)
  const onZero = phase < 1e-6 || barMs - phase < 1e-6
  const target0 = onZero ? 0 : phase >= barMs / 2 ? phase : phase + barMs
  let tick = 0
  let at = 0
  events.push({ tick: 0, kind: 'TS', value: first.meter })
  if (!onZero) {
    const lead = Math.round((first.meter * MS_PER_MINUTE_MILLI) / target0)
    events.push({ tick: 0, kind: 'B', value: lead })
    tick = first.meter * R
    at = ticksMs(tick, lead)
    report.leadIn = true
  }
  report.worstMs = Math.abs(at - target0)

  // Each line's marker: its tick from the beats since the last one, at the game's own time for that tick.
  let tsStart = 0
  let tsMeter = first.meter
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const own = Math.round(p.bpm * 1000)
    if (i + 1 === points.length) {
      events.push({ tick, kind: 'B', value: own })
      break
    }
    const next = points[i + 1]
    const span = Math.max(1, Math.round(((next.timeMs - at) / (60000 / p.bpm)) * R))
    let value = own
    if (Math.abs(at + ticksMs(span, own) - next.timeMs) > CHART_TOLERANCE_MS && next.timeMs > at) {
      value = Math.round((((span / R) * MS_PER_MINUTE_MILLI) / (next.timeMs - at)))
      report.fitted++
    }
    events.push({ tick, kind: 'B', value })
    tick += span
    at += ticksMs(span, value)
    report.worstMs = Math.max(report.worstMs, Math.abs(at - next.timeMs))
    // osu! starts a bar at every red line; Clone Hero counts bars from the last TS.
    if (next.meter !== tsMeter || (tick - tsStart) % (tsMeter * R) !== 0) {
      events.push({ tick, kind: 'TS', value: next.meter })
      tsStart = tick
      tsMeter = next.meter
    }
  }
  // TS before B at the same tick, as Moonscraper writes them.
  events.sort((a, b) => a.tick - b.tick || (a.kind === b.kind ? 0 : a.kind === 'TS' ? -1 : 1))
  return { events, report }
}

const chartString = (text) => `"${field(text).replace(/"/g, "'")}"`

/** A whole notes.chart: `[Song]`, `[SyncTrack]`, an empty `[Events]`, no note tracks. CRLF. `{ text, report }`. */
export function chartFile({ title, artist, creator, audioName, lines }) {
  const { events, report } = chartSyncTrack(lines)
  const text = [
    '[Song]',
    '{',
    `  Name = ${chartString(title)}`,
    `  Artist = ${chartString(artist)}`,
    `  Charter = ${chartString(creator)}`,
    '  Offset = 0',
    `  Resolution = ${CHART_RESOLUTION}`,
    '  Player2 = bass',
    '  Difficulty = 0',
    '  PreviewStart = 0',
    '  PreviewEnd = 0',
    '  MediaType = "cd"',
    `  MusicStream = ${chartString(audioName)}`,
    '}',
    '[SyncTrack]',
    '{',
    ...events.map((e) => `  ${e.tick} = ${e.kind} ${e.value}`),
    '}',
    '[Events]',
    '{',
    '}',
    '',
  ].join('\r\n')
  return { text, report }
}
