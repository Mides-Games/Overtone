/**
 * The red lines for other rhythm games (W12.7), built in this browser from the
 * lines as the page has them (adjusted or not) after the export options.
 * Timing only: no notes, no charts. Overtone has no notes for these games, and
 * timing is the part that transfers. The reader opens the file in the game's
 * editor and charts on it.
 *
 * Where the v3 engine has an exporter (python/overtone.py
 * `quaver_timing_text`, `stepmania_timing_text`), the timing text here is
 * the same, character for character but the comment line: the same numbers,
 * the same rounding (Python's half-to-even on exact ties, see `fixed`), the
 * same separators. Clone Hero has no v3 exporter.
 *
 * What each format says, and what it does with a tempo change:
 *
 * **Quaver (.qua)** is YAML. Each timing point carries an absolute
 * `StartTime` in ms (a float) and a `Bpm`, as a red line does, and each one
 * starts its own grid at its StartTime, as osu! does. So nothing accumulates
 * and a change off the previous grid costs nothing: the conversion is a
 * change of spelling. Meter: Quaver's `Signature` is an enum of Quadruple
 * (4/4, the default, left out) and Triple (3/4), as far as we know it; any
 * other meter is written as 4/4 and the page says so. Quaver may refuse to
 * play a map with no notes; the file is for its editor.
 *
 * **StepMania (.sm, .ssc)** counts beats, not ms. Beat 0 is the first red
 * line, and `#OFFSET` is where it sits, in seconds and negated: a first beat
 * 1.234 s into the audio is `#OFFSET:-1.234000;`. Each later change is a
 * `beat=bpm` pair in `#BPMS`, its beat ACCUMULATED through the tempi before
 * it: beat_i = beat_(i-1) + (t_i - t_(i-1)) / (60000 / bpm_(i-1)). A change
 * 30 s into a 150 BPM song is beat 75, not second 30. A change off the old
 * grid gives a fractional beat, which is written as it is (6 decimals, as v3
 * does). But StepMania stores a change on a row, 48 to the beat (its
 * ROWS_PER_BEAT), so on loading it moves the change to the nearest 1/48 of a
 * beat, and every beat after it moves with it, accumulating through later
 * changes. `stepmaniaRowShift` measures that from what the file says and the
 * page shows it when it reaches half a millisecond; we do not bend the BPMs to
 * hide it, which would make the file disagree with v3's. (We read this rounding
 * from StepMania 5's loader as we know it; we have not opened a file in it.)
 * `.sm` has no time signatures, so a meter other than 4/4 is lost there; `.ssc`
 * (StepMania 5) has `#TIMESIGNATURES` as `beat=numerator=denominator`, written
 * at the first line and wherever the bar changes: a new meter, or a line that
 * does not land on the running bar (osu! starts a bar at every red line;
 * StepMania counts bars from the last signature).
 *
 * **Etterna** reads StepMania's files; it has no timing format of its own that
 * we know of. The page offers the `.sm` for it rather than inventing one.
 *
 * **Clone Hero (.chart)** counts ticks: `Resolution = 192` per beat (a quarter
 * note), tempo as `tick = B <BPM x 1000>`, an integer (milli-BPM), meter as
 * `tick = TS <numerator>` (the denominator's log2 would follow; 4 is the
 * default and left out). Every position is a whole tick, so:
 * - **The start.** Tick 0 is the audio's start. `[Song] Offset` is written as
 *   0: Moonscraper (the editor Clone Hero charts are made in) treats that
 *   field as legacy as far as we know, and the games have not all read it the
 *   same way, so we do not lean on it. Instead the first line's grid is drawn
 *   back to its first downbeat at least half a bar in, and one lead-in bar from
 *   tick 0 takes exactly that long (its own BPM, between 2/3 and 2 times the
 *   first line's). When a downbeat falls on 0 itself, there is no lead-in.
 * - **A change off the grid.** Its tick is the accumulated beats x 192,
 *   rounded. Rounding alone would move the change up to half a tick, and every
 *   later one with it, so the section before it keeps its own BPM only when
 *   that lands the change within `CHART_TOLERANCE_MS` of its time; otherwise
 *   that section's BPM is fitted (to the milli-BPM) so it does. The game's own
 *   arithmetic is followed throughout, so the error never accumulates.
 *   `chartSyncTrack` reports how many sections were fitted and the worst miss.
 * - **Bars**, as in `.ssc`: a `TS` at tick 0 and wherever the bar changes.
 * The audio is named `song.<ext>` in the file, the name Clone Hero looks for.
 *
 * The four after them (W13.11) are JSON. We wrote each from its format as the
 * community documents it and as we know the games' loaders; we have opened
 * none of them in its game or editor, and each paragraph says where we are
 * least sure. Numbers are written to `JSON_DECIMALS` (6), and every position
 * is worked from where the file puts the change before it (`writtenBeats`,
 * `unitTimeline`), so a rounding moves one change by a hair and never
 * accumulates. Tests: test/game-formats-more.test.js, against hand-made
 * files in test/fixtures/games and read back by each game's arithmetic.
 *
 * **Beat Saber** gets a **v3** difficulty file (`"version": "3.3.0"`), named
 * `ExpertStandard.dat`: `bpmEvents: [{ b, m }]`, `b` the beat and `m` the BPM
 * from that beat on, and every other v3 list empty. We chose v3 over v2
 * because v2 has no official BPM event of its own (the editors kept them in
 * `_customData._BPMChanges`, and a late v2 used event type 100), while v3's
 * `bpmEvents` are the game's; v4 drops them for an audio file's BPM data,
 * which editors convert from v3. The beats are accumulated through the tempi,
 * as StepMania's are: a change at beat b after a BPM m holds from there on.
 * Beat 0 is the audio's start (Info.dat's `_songTimeOffset` is not used by the
 * game as far as we know, so we do not lean on it), so as in Clone Hero a
 * lead-in reaches the first line's grid: one beat from 0 to its first beat at
 * least half a beat in, its own BPM (2/3 to 2 times the first line's). Beats
 * are not whole, so nothing is fitted. A BPM event that repeats the one
 * before (a meter change alone: Beat Saber has no meter) is left out. Info.dat
 * is the editor's: the page names the BPM to give it (the first line's),
 * which is what the game's note jump distance reads.
 *
 * **A Dance of Fire and Ice** (`.adofai`, settings version 13) is a path of
 * tiles: with every `angleData` entry 0 the path is straight and each move is
 * one beat at the current speed. `settings.offset` is the time of tile 0 in
 * whole ms (as we understand it: the first tile is the first beat; if the
 * editor shows it a beat late, move the offset by one beat), `settings.bpm`
 * the first speed, and a `SetSpeed` action (`speedType: "Bpm"`,
 * `beatsPerMinute`) on a floor sets the speed from that tile on. A change
 * must sit on a tile, so a span that is not whole beats ends on one **odd
 * tile**: whole beats at the span's own BPM, then one tile of 0.5 to 1.5
 * beats whose BPM is set so the next line lands on its tile (two SetSpeeds:
 * the odd tile's and the line's). The grid stays the song's everywhere but in
 * that tile. Angled tiles could give a fractional beat instead, but which way
 * an angle counts is easy to get backwards untested, and a wrong guess there
 * would be silent; a speed is not. The tiles run to the song's end. A first
 * line before the audio is drawn forward by whole beats.
 *
 * **Friday Night Funkin'** gets the legacy chart JSON that the game before
 * 0.3 and Psych Engine read (`{ song: { song, bpm, notes: [sections] } }`;
 * 0.3's own format is two files, and its editor imports this one, as far as
 * we know). A section is 16 steps (4 beats); a section with `changeBPM: true`
 * sets `bpm` from its start, and the game adds the sections' steps up from the
 * audio's start. Sections carry `lengthInSteps` (the old game's) and
 * `sectionBeats` (Psych's), so a section may be shorter. Changes sit on
 * section starts, so: a lead-in from 0 of whole steps at the first line's BPM
 * (fitted so it ends on the first line's first section, which is at least
 * half a section in), and a span that is not whole sections ends on an odd
 * section of the nearest whole steps, fitted the same way when keeping the
 * span's BPM would miss the next line by more than `ODD_TOLERANCE_MS`.
 *
 * **Rhythm Doctor** (`.rdlevel`, settings version 55) places events by bar and
 * beat, both from 1. `PlaySong` at bar 1 beat 1 carries the song's `bpm` and
 * `offset` (whole ms: where bar 1 beat 1 is in the audio, the first line);
 * `SetBeatsPerMinute` (`beatsPerMinute`) changes the tempo at a later beat,
 * fractional when the change is off the grid; `SetCrotchetsPerBar` sets the
 * bar's length (Rhythm Doctor's default is 8) from a bar's first beat, so it
 * is written at bar 1 and at a new meter that starts a bar. A new meter in the
 * middle of a running bar is not written and the page counts it. The events
 * carry `y: 0`, the editor's row. How finely Rhythm Doctor stores a beat we do
 * not know; we write 6 decimals.
 */
import { songNames } from './osz.js'
import { roundHalfEven } from './timing.js'

/** StepMania's decimals for beats and BPMs (v3's STEPMANIA_DECIMALS). */
export const STEPMANIA_DECIMALS = 6
/** StepMania's rows per beat: where a tempo change can sit. */
export const STEPMANIA_ROWS_PER_BEAT = 48
export const CHART_RESOLUTION = 192
/** How far a .chart tempo change may land from its time before the BPM before it is fitted. */
export const CHART_TOLERANCE_MS = 0.5

const COMMENT = 'Generated by the Overtone site: timing only, no notes'

/**
 * Python's f"{x:.{d}f}": the double's exact value rounded to `d` decimals,
 * an exact tie to even (JavaScript's toFixed takes it away from zero), and
 * no "-0".
 */
export function fixed(x, d) {
  let out = x.toFixed(d)
  const extra = 60
  const exact = x.toFixed(Math.min(100, d + extra))
  if (/^50*$/.test(exact.slice(-extra)) && Number(out.replace('.', '').slice(-1)) % 2 === 1) {
    out = exact.slice(0, -extra).replace(/\.$/, '')
  }
  return /^-0(\.0*)?$/.test(out) ? out.slice(1) : out
}

/** `fixed` with trailing zeros (and a trailing point) dropped, as v3 writes Quaver's Bpm. */
const trimmed = (x, d) => fixed(x, d).replace(/0+$/, '').replace(/\.$/, '')

/**
 * The lines a game file is written from: finite, a positive beat, in time
 * order, BPM as the beat length implies it (the grid osu! plays), meter kept.
 */
export function gameLines(lines) {
  return lines
    .filter((line) => Number.isFinite(line.timeMs) && line.beatMs > 0 && Number.isFinite(line.beatMs))
    .map((line) => ({ timeMs: line.timeMs, bpm: 60000 / line.beatMs, meter: Math.max(1, Math.min(16, Math.round(line.meter) || 4)) }))
    .sort((a, b) => a.timeMs - b.timeMs)
}

/** One line of text for a file field: no breaks, no control or bidi characters. */
const field = (text) =>
  String(text ?? '')
    .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// ---------------------------------------------------------------------------
// Quaver
// ---------------------------------------------------------------------------

/**
 * The `TimingPoints:` block, v3's `quaver_timing_text` with a meter: whole ms
 * at 0 decimals (half to even), else that many; the BPM to 6 decimals, trailing
 * zeros dropped; `Signature: Triple` on a 3/4 line.
 */
export function quaverTimingText(lines, { offsetDecimals = 0 } = {}) {
  const points = gameLines(lines)
  if (!points.length) throw new Error('No timing to export.')
  const rows = [`# ${COMMENT}`, 'TimingPoints:']
  for (const p of points) {
    rows.push(`- StartTime: ${offsetDecimals > 0 ? fixed(p.timeMs, offsetDecimals) : String(roundHalfEven(p.timeMs) + 0)}`)
    rows.push(`  Bpm: ${trimmed(p.bpm, 6)}`)
    if (p.meter === 3) rows.push('  Signature: Triple')
  }
  return `${rows.join('\n')}\n`
}

const yamlString = (text) => `'${field(text).replace(/'/g, "''")}'`

/** A whole .qua: a 4K map's metadata, the timing points, no notes. `{ text, report }`. */
export function quaFile({ title, artist, creator, audioName, lines, offsetDecimals }) {
  const timing = quaverTimingText(lines, { offsetDecimals }).split('\n').slice(1).join('\n')
  const points = gameLines(lines)
  const text = [
    `# ${COMMENT}`,
    `AudioFile: ${yamlString(audioName)}`,
    'SongPreviewTime: 0',
    "BackgroundFile: ''",
    'MapId: -1',
    'MapSetId: -1',
    'Mode: Keys4',
    `Title: ${yamlString(title)}`,
    `Artist: ${yamlString(artist)}`,
    "Source: ''",
    "Tags: 'overtone'",
    `Creator: ${yamlString(creator)}`,
    "DifficultyName: 'Timing'",
    "Description: 'Timing from Overtone: red lines only, no notes. Check it by ear.'",
    'BPMDoesNotAffectScrollVelocity: true',
    'InitialScrollVelocity: 1',
    'EditorLayers: []',
    'CustomAudioSamples: []',
    'SoundEffects: []',
    timing.trimEnd(),
    'SliderVelocities: []',
    'HitObjects: []',
    '',
  ].join('\n')
  return { text, report: { meterLost: points.filter((p) => p.meter !== 3 && p.meter !== 4).length } }
}

// ---------------------------------------------------------------------------
// StepMania
// ---------------------------------------------------------------------------

/** Beat 0 at the first line; each later line's beat accumulated through the tempi before it. */
export function stepmaniaBeats(points) {
  const beats = [0]
  for (let i = 1; i < points.length; i++) {
    beats.push(beats[i - 1] + (points[i].timeMs - points[i - 1].timeMs) / (60000 / points[i - 1].bpm))
  }
  return beats
}

/**
 * v3's `stepmania_timing_text`: `#OFFSET` (negated, seconds) and `#BPMS`.
 * `offsetDecimals` are of a ms, so the offset gets 3 more in seconds (3 is
 * v3's default of 6); beats and BPMs always 6.
 */
export function stepmaniaTimingText(lines, { offsetDecimals = 3 } = {}) {
  const points = gameLines(lines)
  if (!points.length) throw new Error('No timing to export.')
  const beats = stepmaniaBeats(points)
  const pairs = points.map((p, i) => `${fixed(beats[i], STEPMANIA_DECIMALS)}=${fixed(p.bpm, STEPMANIA_DECIMALS)}`)
  return `// ${COMMENT}\n#OFFSET:${fixed(-points[0].timeMs / 1000, offsetDecimals + 3)};\n#BPMS:${pairs.join('\n,')};\n`
}

/**
 * How far StepMania moves the changes when it puts them on its rows: the
 * file's own beats and BPMs, read back as written, each change's beat rounded
 * to 1/48, and the times that gives against the lines'. `{ worstMs, moved }`,
 * `moved` the changes off by more than 0.05 ms.
 */
export function stepmaniaRowShift(lines) {
  const points = gameLines(lines)
  const beats = stepmaniaBeats(points).map((b) => Number(fixed(b, STEPMANIA_DECIMALS)))
  const bpms = points.map((p) => Number(fixed(p.bpm, STEPMANIA_DECIMALS)))
  let time = points[0]?.timeMs ?? 0
  let worstMs = 0
  let moved = 0
  for (let i = 1; i < points.length; i++) {
    const rows = Math.round(beats[i] * STEPMANIA_ROWS_PER_BEAT) - Math.round(beats[i - 1] * STEPMANIA_ROWS_PER_BEAT)
    time += (rows / STEPMANIA_ROWS_PER_BEAT) * (60000 / bpms[i - 1])
    const off = Math.abs(time - points[i].timeMs)
    worstMs = Math.max(worstMs, off)
    if (off > 0.05) moved++
  }
  return { worstMs, moved }
}

/** The beats where the bar changes: the first line, a new meter, or a line off the running bar (on rows). */
function barChanges(points, beats, unitsPerBeat) {
  const out = []
  let start = 0
  let meter = 0
  points.forEach((p, i) => {
    const unit = Math.round(beats[i] * unitsPerBeat)
    if (i === 0 || p.meter !== meter || (unit - start) % (meter * unitsPerBeat) !== 0) {
      out.push({ index: i, unit, meter: p.meter })
      start = unit
      meter = p.meter
    }
  })
  return out
}

/** Text for a StepMania tag: its separators and escapes taken out. */
const smField = (text) => field(text).replace(/[#:;\\]/g, '').replace(/\/\//g, '/')

/** A whole .sm (`kind` 'sm') or .ssc ('ssc'): the song's tags and the timing, no #NOTES. `{ text, report }`. */
export function stepmaniaFile({ kind = 'sm', title, artist, creator, audioName, lines, offsetDecimals }) {
  const timing = stepmaniaTimingText(lines, { offsetDecimals })
  const points = gameLines(lines)
  const tags = timing.split('\n').filter((row) => row.startsWith('#') || row.startsWith(','))
  const out = [`// ${COMMENT}`]
  if (kind === 'ssc') out.push('#VERSION:0.83;')
  out.push(
    `#TITLE:${smField(title)};`,
    '#SUBTITLE:;',
    `#ARTIST:${smField(artist)};`,
    '#TITLETRANSLIT:;',
    '#SUBTITLETRANSLIT:;',
    '#ARTISTTRANSLIT:;',
    '#GENRE:;',
    `#CREDIT:${smField(creator)};`,
    '#BANNER:;',
    '#BACKGROUND:;',
    '#CDTITLE:;',
    `#MUSIC:${smField(audioName)};`,
    ...tags,
    '#STOPS:;',
  )
  if (kind === 'ssc') {
    const beats = stepmaniaBeats(points)
    const changes = barChanges(points, beats, STEPMANIA_ROWS_PER_BEAT)
    out.push(
      '#DELAYS:;',
      '#WARPS:;',
      `#TIMESIGNATURES:${changes.map((c) => `${fixed(beats[c.index], STEPMANIA_DECIMALS)}=${c.meter}=4`).join('\n,')};`,
    )
  }
  out.push('')
  const shift = stepmaniaRowShift(lines)
  return {
    text: out.join('\n'),
    report: { ...shift, meterLost: kind === 'sm' && points.some((p) => p.meter !== 4) },
  }
}

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

// ---------------------------------------------------------------------------
// What the games after W13.11 share
// ---------------------------------------------------------------------------

/** How far a change may land from its time before the span before it gets an odd unit (ADOFAI, FNF). */
export const ODD_TOLERANCE_MS = 0.5
/** The decimals a beat or a BPM is written with in the JSON formats. */
export const JSON_DECIMALS = 6
/** No game file grows past this many tiles or sections, whatever the song's length says. */
const MAX_UNITS = 20000

const roundTo = (x, d = JSON_DECIMALS) => Number(fixed(x, d))

/**
 * Beats accumulated through the tempi, as a game that counts beats reads
 * them: `anchors[0]` is beat 0, at a time the file states exactly; each later
 * anchor's beat is worked from where the file puts the one before it (its
 * written beat and BPM), then rounded to `decimals`. So a rounding moves one
 * change by a hair and never the ones after it. `{ beats, bpms, times,
 * worstMs }`, `times` where the file puts each anchor.
 */
export function writtenBeats(anchors, decimals = JSON_DECIMALS) {
  const bpms = anchors.map((a) => roundTo(a.bpm, decimals))
  const beats = [0]
  const times = [anchors[0].timeMs]
  let worstMs = 0
  for (let i = 1; i < anchors.length; i++) {
    const beat = roundTo(beats[i - 1] + ((anchors[i].timeMs - times[i - 1]) * bpms[i - 1]) / 60000, decimals)
    const time = times[i - 1] + ((beat - beats[i - 1]) * 60000) / bpms[i - 1]
    beats.push(beat)
    times.push(time)
    worstMs = Math.max(worstMs, Math.abs(time - anchors[i].timeMs))
  }
  return { beats, bpms, times, worstMs }
}

/**
 * A span cut into whole units (tiles of a beat, sections of steps) at its own
 * BPM, for a game where a change can only sit on a unit's edge: `{ units:
 * [{ size, bpm }], endMs }`. `size` is in the game's smallest unit (a beat
 * for ADOFAI, a step for FNF), `full` the size of a whole unit. The span's
 * own grid runs from its start; the last unit is the odd one: its size is the
 * nearest whole number of small units to what is left, and its BPM is fitted
 * so it ends on the change when keeping the span's own would miss by more than
 * `ODD_TOLERANCE_MS`. `oddFirst` puts the odd unit first instead (a lead-in,
 * whose grid must end on the first line, not start there).
 */
function cutSpan({ startMs, endMs, bpm, smallBeats, full, oddFirst = false }) {
  const wanted = roundTo(bpm)
  const smallMs = (smallBeats * 60000) / wanted
  const span = endMs - startMs
  const small = span / smallMs
  let whole = Math.floor(small / full)
  let odd = Math.round(small - whole * full)
  // Less than half a small unit left: the last whole unit takes it.
  if (odd === 0 && whole > 0) {
    whole -= 1
    odd = full
  }
  odd = Math.max(1, odd)
  whole = Math.min(whole, MAX_UNITS)
  const units = Array.from({ length: whole }, () => ({ size: full, bpm: wanted }))
  const restMs = span - whole * full * smallMs
  const fitted = restMs > 0 && Math.abs(odd * smallMs - restMs) > ODD_TOLERANCE_MS
  const oddUnit = { size: odd, bpm: fitted ? roundTo((odd * smallBeats * 60000) / restMs) : wanted }
  if (oddFirst) units.unshift(oddUnit)
  else units.push(oddUnit)
  return units
}

/** The time a unit takes in the file: `size` small units of `smallBeats` beats at its BPM. */
const unitMs = (unit, smallBeats) => (unit.size * smallBeats * 60000) / unit.bpm

/**
 * Units from `startMs` through every line, each span cut by `cutSpan`, and the
 * last line's grid on to `endMs`. `{ units, starts, worstMs, odd }`: `starts`
 * the unit index each line begins at, `odd` how many spans needed a fitted unit.
 */
function unitTimeline(points, { startMs, smallBeats, full, endMs, leadIn = null }) {
  const units = []
  const starts = []
  let at = startMs
  let worstMs = 0
  let odd = 0
  const push = (list) => {
    for (const u of list) {
      units.push(u)
      at += unitMs(u, smallBeats)
    }
  }
  if (leadIn) {
    const list = cutSpan({ startMs: at, endMs: leadIn.endMs, bpm: leadIn.bpm, smallBeats, full, oddFirst: true })
    // A fitted lead-in is not a tempo change of the song's: `odd` counts the spans between lines only.
    push(list)
    worstMs = Math.abs(at - leadIn.endMs)
  }
  points.forEach((p, i) => {
    starts.push(units.length)
    const next = points[i + 1]
    const fullMs = (full * smallBeats * 60000) / p.bpm
    if (!next) {
      const left = Math.max(1, Math.ceil((endMs - at) / fullMs))
      push(Array.from({ length: Math.min(left, MAX_UNITS - units.length) }, () => ({ size: full, bpm: roundTo(p.bpm) })))
      return
    }
    const list = cutSpan({ startMs: at, endMs: next.timeMs, bpm: p.bpm, smallBeats, full })
    if (list.at(-1).bpm !== roundTo(p.bpm)) odd++
    push(list)
    worstMs = Math.max(worstMs, Math.abs(at - next.timeMs))
  })
  return { units, starts, worstMs, odd }
}

/** The song's end in ms, or a minute past the last line when the page does not know it. */
const songEndMs = (points, durationS) => (Number.isFinite(durationS) && durationS > 0 ? durationS * 1000 : points.at(-1).timeMs + 60000)

/**
 * `gameLines` with two lines at one time made one, the later in the list
 * winning (osu! plays the last of them): a span of nothing cannot be cut.
 */
const spanLines = (lines) => {
  const points = gameLines(lines)
  return points.filter((p, i) => !points[i + 1] || points[i + 1].timeMs - p.timeMs > 1e-6)
}

/** The first line's time moved on by whole beats until it is not before the audio (a game cannot start before it). */
const notBeforeZero = (p) => (p.timeMs >= 0 ? p.timeMs : p.timeMs + Math.ceil(-p.timeMs / (60000 / p.bpm)) * (60000 / p.bpm))

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

// ---------------------------------------------------------------------------
// The page's entry point
// ---------------------------------------------------------------------------

/** The formats the page offers, in order. Etterna rides on the .sm. */
export const GAME_FORMATS = [
  { id: 'qua', ext: 'qua', game: 'Quaver' },
  { id: 'sm', ext: 'sm', game: 'StepMania · Etterna' },
  { id: 'ssc', ext: 'ssc', game: 'StepMania 5' },
  { id: 'chart', ext: 'chart', game: 'Clone Hero' },
  { id: 'beatsaber', ext: 'dat', game: 'Beat Saber' },
  { id: 'adofai', ext: 'adofai', game: 'A Dance of Fire and Ice' },
  { id: 'fnf', ext: 'json', game: "Friday Night Funkin'" },
  { id: 'rdlevel', ext: 'rdlevel', game: 'Rhythm Doctor' },
]

/**
 * One game's file for the page: `{ name, text, report }`. `lines` are the
 * export's (after `exportLines`); `analysis` names the song and its audio,
 * `durationS` its length (how many tiles or sections the last line gets).
 */
export function gameFile(kind, { analysis, lines, offsetDecimals = 3, creator, durationS }) {
  const { title, artist } = songNames({ ...analysis, filename: analysis?.filename })
  const audio = String(analysis?.filename ?? 'audio.mp3')
  const ext = (/\.[A-Za-z0-9]{1,5}$/.exec(audio)?.[0] ?? '.mp3').toLowerCase()
  const who = field(creator) || 'Overtone'
  const stem = audio
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._ -]+/g, '')
    .trim()
    .slice(0, 80) || 'overtone'
  const base = { title, artist, creator: who, lines, offsetDecimals, durationS: durationS ?? analysis?.result?.duration_s }
  if (kind === 'qua') return { name: `${stem}.qua`, ...quaFile({ ...base, audioName: audio }) }
  if (kind === 'sm' || kind === 'ssc') return { name: `${stem}.${kind}`, ...stepmaniaFile({ ...base, kind, audioName: audio }) }
  if (kind === 'chart') return { name: 'notes.chart', ...chartFile({ ...base, audioName: `song${ext}` }) }
  // Beat Saber finds a difficulty by the name Info.dat gives it; ExpertStandard.dat is the editors' usual one for Expert.
  if (kind === 'beatsaber') return { name: 'ExpertStandard.dat', ...beatSaberFile(base) }
  if (kind === 'adofai') return { name: `${stem}.adofai`, ...adofaiFile({ ...base, audioName: audio }) }
  // FNF looks a chart up by the song's folder name, lower case with dashes.
  if (kind === 'fnf') return { name: `${stem.toLowerCase().replace(/[\s._-]+/g, '-').replace(/^-+|-+$/g, '') || 'overtone'}.json`, ...fnfFile(base) }
  if (kind === 'rdlevel') return { name: `${stem}.rdlevel`, ...rhythmDoctorFile({ ...base, audioName: audio }) }
  throw new Error(`Unknown format: ${kind}`)
}
