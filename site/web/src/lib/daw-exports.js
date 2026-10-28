/**
 * The tempo map for music software (W13.10), built in this browser from the
 * lines as the page has them, after the export options, like the games'
 * files (lib/game-formats.js). Tempo and meter only: no notes, no audio.
 *
 * **A Standard MIDI File** (`.mid`) is what every DAW reads, so it is the
 * one route that works everywhere:
 * - Format 1 with a single track, the conductor track: a track name, then a
 *   Time Signature meta event (FF 58) and a Set Tempo meta event (FF 51,
 *   microseconds per quarter note, a 24-bit integer) wherever the lines say,
 *   then End of Track. Division 960 ticks per quarter (`MIDI_PPQ`). The
 *   meter is osu!'s, beats of a quarter: n/4.
 * - Tick 0 is the audio's start. As in Clone Hero's .chart, the first line's
 *   grid is drawn back to its first downbeat at least half a bar in, and one
 *   lead-in bar from tick 0 takes exactly that long (its own tempo, between
 *   2/3 and 2 times the first line's). A downbeat on 0 needs no lead-in.
 * - Every event sits on a whole tick and every tempo is whole microseconds,
 *   so a change off the grid cannot land exactly. Its tick is the
 *   accumulated quarters × 960, rounded, and the tempo before it keeps its
 *   own value only when that lands the change within `MIDI_TOLERANCE_MS`;
 *   otherwise that span's tempo is fitted so it does. Each span is worked
 *   from where the file actually puts the previous change (the reader's
 *   arithmetic, not ours), so the error never accumulates: `midiTempoMap`
 *   reports the worst miss, under half a millisecond by construction (one
 *   tick is 0.42 ms at 150 BPM; a fitted tempo's rounding is microseconds).
 * - A Time Signature event at tick 0 and wherever the bar changes: a new
 *   meter, or a line that does not land on the running bar (osu! starts a bar
 *   at every red line; a DAW counts bars from the last signature).
 *
 * **Reaper** opens its own project files, which are text, so the Reaper file
 * is a small `.rpp` project rather than a list to paste. We chose the project
 * over the alternatives because it is the one text route that carries the
 * tempo: Reaper's region/marker manager imports markers from CSV but not
 * tempo, and it reads a MIDI file's tempo map too (the .mid above), but the
 * project also puts the song on a track and a marker at every red line. The
 * project holds:
 * - `TEMPO <bpm> <num> 4`, the project's starting tempo and meter;
 * - a `<TEMPOENVEX` block, the master tempo envelope, one point per change:
 *   `PT <seconds> <bpm> 1 [<timesig>]`, shape 1 (square: the tempo holds
 *   until the next point, as a red line does), the time signature packed as
 *   numerator + 65536 × denominator where the bar changes (4/4 is 262148).
 *   Times are seconds to 12 decimals and BPMs to 10, so nothing is rounded
 *   that a millisecond would notice; the same lead-in bar as the MIDI file
 *   starts the project;
 * - a `MARKER <n> <seconds> "<bpm> BPM" 0` at every red line;
 * - a track with the song as an item from 0, its file named as on the page,
 *   which Reaper looks for beside the project (save the .rpp next to it).
 *   A file whose type we do not know (not mp3, ogg, wav, flac or opus) gets
 *   no item.
 * We wrote this from Reaper's project format as we know it (Reaper reads
 *   projects with fields missing and fills its defaults); we have not opened
 *   the file in Reaper. Whether a time signature mid-bar starts a new measure
 *   there depends on Reaper's "allow partial measures", which we leave alone.
 *
 * **Ableton Live** has no text format for a tempo map, so we do not invent
 * one: the MIDI file is the route. Dragged into the Arrangement, a MIDI file
 * can bring its tempo and time signature changes in (Live asks, or does it
 * when its import option is on, depending on the version); the page says so.
 */
import { gameLines } from './game-formats.js'

export const MIDI_PPQ = 960
/** How far a MIDI tempo change may land from its time before the tempo before it is fitted. */
export const MIDI_TOLERANCE_MS = 0.25
const MAX_TEMPO = 0xffffff

const usOf = (bpm) => Math.max(1, Math.min(MAX_TEMPO, Math.round(60e6 / bpm)))
/** The time `ticks` take at `us` microseconds per quarter, in ms. */
const ticksMs = (ticks, us) => (ticks * us) / MIDI_PPQ / 1000

/**
 * Where the first line's grid is drawn back to: its first downbeat at least
 * half a bar into the audio (0 when a downbeat falls on 0 itself). `unitMs`
 * is a bar here, a beat or a section elsewhere.
 */
export function firstDownbeat(timeMs, unitMs) {
  const phase = ((timeMs % unitMs) + unitMs) % unitMs
  if (phase < 1e-6 || unitMs - phase < 1e-6) return 0
  return phase >= unitMs / 2 ? phase : phase + unitMs
}

/**
 * The conductor track's events: `{ events: [{ tick, kind: 'ts'|'tempo',
 * value }], report: { leadIn, fitted, worstMs } }`, `worstMs` the furthest
 * any line's tempo change lands from its time by the file's own arithmetic.
 */
export function midiTempoMap(lines) {
  const points = gameLines(lines)
  if (!points.length) throw new Error('No timing to export.')
  const first = points[0]
  const target0 = firstDownbeat(first.timeMs, first.meter * (60000 / first.bpm))
  const events = [{ tick: 0, kind: 'ts', value: first.meter }]
  const report = { leadIn: false, fitted: 0, worstMs: 0 }
  let tick = 0
  let at = 0
  if (target0 > 0) {
    const lead = usOf((first.meter * 60000) / target0)
    events.push({ tick: 0, kind: 'tempo', value: lead })
    tick = first.meter * MIDI_PPQ
    at = ticksMs(tick, lead)
    report.leadIn = true
  }
  report.worstMs = Math.abs(at - target0)

  let tsStart = 0
  let tsMeter = first.meter
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const own = usOf(p.bpm)
    if (i + 1 === points.length) {
      events.push({ tick, kind: 'tempo', value: own })
      break
    }
    const next = points[i + 1]
    const span = Math.max(1, Math.round(((next.timeMs - at) / (60000 / p.bpm)) * MIDI_PPQ))
    let value = own
    if (Math.abs(at + ticksMs(span, own) - next.timeMs) > MIDI_TOLERANCE_MS && next.timeMs > at) {
      value = Math.max(1, Math.min(MAX_TEMPO, Math.round(((next.timeMs - at) * 1000 * MIDI_PPQ) / span)))
      report.fitted++
    }
    events.push({ tick, kind: 'tempo', value })
    tick += span
    at += ticksMs(span, value)
    report.worstMs = Math.max(report.worstMs, Math.abs(at - next.timeMs))
    if (next.meter !== tsMeter || (tick - tsStart) % (tsMeter * MIDI_PPQ) !== 0) {
      events.push({ tick, kind: 'ts', value: next.meter })
      tsStart = tick
      tsMeter = next.meter
    }
  }
  // A meter before a tempo at the same tick; the same kind twice at one tick keeps the last.
  events.sort((a, b) => a.tick - b.tick || (a.kind === b.kind ? 0 : a.kind === 'ts' ? -1 : 1))
  const kept = events.filter((e, i) => !(events[i + 1] && events[i + 1].tick === e.tick && events[i + 1].kind === e.kind))
  return { events: kept, report }
}

/** A MIDI variable-length quantity: 7 bits a byte, most significant first, the high bit on all but the last. */
export function vlq(n) {
  const out = [n & 0x7f]
  let rest = n >>> 7
  while (rest > 0) {
    out.unshift((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  return out
}

const ascii = (text) => [...String(text)].map((ch) => (ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : 63))
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

/** The whole .mid as bytes: `{ bytes: Uint8Array, report }`. */
export function midiFile(lines, { name = 'Overtone tempo map' } = {}) {
  const { events, report } = midiTempoMap(lines)
  const body = []
  const title = ascii(name).slice(0, 120)
  body.push(0x00, 0xff, 0x03, ...vlq(title.length), ...title)
  let last = 0
  for (const e of events) {
    body.push(...vlq(e.tick - last))
    last = e.tick
    if (e.kind === 'ts') {
      // nn, dd as a power of two (2: a quarter), 24 MIDI clocks a click, 8 32nds a quarter.
      body.push(0xff, 0x58, 0x04, e.value, 2, 24, 8)
    } else {
      body.push(0xff, 0x51, 0x03, (e.value >> 16) & 0xff, (e.value >> 8) & 0xff, e.value & 0xff)
    }
  }
  body.push(0x00, 0xff, 0x2f, 0x00)
  const header = [...ascii('MThd'), ...u32(6), 0, 1, 0, 1, (MIDI_PPQ >> 8) & 0xff, MIDI_PPQ & 0xff]
  const track = [...ascii('MTrk'), ...u32(body.length), ...body]
  return { bytes: Uint8Array.from([...header, ...track]), report }
}

// ---------------------------------------------------------------------------
// Reaper
// ---------------------------------------------------------------------------

const REAPER_SOURCES = { mp3: 'MP3', ogg: 'VORBIS', wav: 'WAVE', flac: 'FLAC', opus: 'OPUS' }
const quote = (text) =>
  `"${String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/"/g, "'")
    .trim()}"`
const sec = (ms) => (ms / 1000).toFixed(12)
const bpmText = (bpm) => bpm.toFixed(10)
const trimBpm = (bpm) => String(Number(bpm.toFixed(3)))

/**
 * The tempo points for Reaper: `{ points: [{ ms, bpm, meter|null }], lines }`,
 * the lead-in bar first when there is one; `meter` set where the bar changes.
 * Every red line starts a bar in Reaper's count afterwards: it is on the
 * running bar, or it carries a signature that starts one.
 */
export function reaperPoints(lines) {
  const points = gameLines(lines)
  if (!points.length) throw new Error('No timing to export.')
  const first = points[0]
  const target0 = firstDownbeat(first.timeMs, first.meter * (60000 / first.bpm))
  const out = []
  if (target0 > 0) out.push({ ms: 0, bpm: (first.meter * 60000) / target0, meter: first.meter })
  // The first line's grid starts at its downbeat (the lead-in bar ends there); the line gets a marker where it is.
  out.push({ ms: target0, bpm: first.bpm, meter: target0 > 0 ? null : first.meter })
  let barStart = target0
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const p = points[i]
    const barMs = prev.meter * (60000 / prev.bpm)
    const bars = (p.timeMs - barStart) / barMs
    const onBar = Math.abs(bars - Math.round(bars)) * barMs < 1e-6
    out.push({ ms: p.timeMs, bpm: p.bpm, meter: p.meter !== prev.meter || !onBar ? p.meter : null })
    barStart = p.timeMs
  }
  return { points: out, lines: points }
}

/** A whole Reaper project: `{ text }`. `audioName` and `durationS` put the song on a track. */
export function reaperProject({ lines, audioName, durationS, title }) {
  const { points, lines: reds } = reaperPoints(lines)
  const first = reds[0]
  const rows = [
    '<REAPER_PROJECT 0.1 "6.0" 0',
    `  TITLE ${quote(title || 'Overtone tempo map')}`,
    `  TEMPO ${trimBpm(points[0].bpm)} ${first.meter} 4`,
    '  <TEMPOENVEX',
    '    ACT 1 -1',
    '    VIS 1 0 1',
    '    LANEHEIGHT 0 0',
    '    ARM 0',
    '    DEFSHAPE 1 -1 -1',
    ...points.map((p) => `    PT ${sec(p.ms)} ${bpmText(p.bpm)} 1${p.meter ? ` ${p.meter + 65536 * 4}` : ''}`),
    '  >',
    ...reds.map((p, i) => `  MARKER ${i + 1} ${sec(p.timeMs)} ${quote(`${trimBpm(p.bpm)} BPM${p.meter !== 4 ? ` ${p.meter}/4` : ''}`)} 0`),
  ]
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(audioName ?? '')?.[1]?.toLowerCase()
  const source = ext ? REAPER_SOURCES[ext] : null
  if (source) {
    const length = Number.isFinite(durationS) && durationS > 0 ? durationS : 600
    rows.push(
      '  <TRACK',
      `    NAME ${quote(audioName)}`,
      '    <ITEM',
      '      POSITION 0',
      `      LENGTH ${length.toFixed(6)}`,
      `      NAME ${quote(audioName)}`,
      `      <SOURCE ${source}`,
      `        FILE ${quote(audioName)}`,
      '      >',
      '    >',
      '  >',
    )
  }
  rows.push('>', '')
  return { text: rows.join('\n'), withAudio: Boolean(source) }
}
