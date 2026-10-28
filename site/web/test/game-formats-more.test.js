import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { GAME_FORMATS, adofaiTimeline, beatSaberBpmEvents, fnfSections, gameFile, rhythmDoctorTimeline, writtenBeats } from '../src/lib/game-formats.js'

/**
 * The games added in W13.11: Beat Saber, A Dance of Fire and Ice, Friday Night
 * Funkin' and Rhythm Doctor. Two kinds of check: each file against a reference
 * written by hand from the format's rules (test/fixtures/games, compared as
 * parsed JSON), and each file read back by its own game's arithmetic, written
 * here independently of the writer, on lines with changes off the grid.
 */
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/games/${name}`, import.meta.url), 'utf8'))

/**
 * The reference lines: 150 BPM from 1234 ms, a change to 140 BPM 10.25 beats
 * later (5334 ms). 1234 is 34 ms past a beat from 0 (a lead-in where the game
 * counts from the audio's start); 10.25 beats is not whole (an odd tile or
 * section where the game needs whole ones). An 8 s song.
 */
const reference = [
  { timeMs: 1234, beatMs: 400, meter: 4 },
  { timeMs: 1234 + 10.25 * 400, beatMs: 60000 / 140, meter: 4 },
]
const analysis = { filename: 'Artist - Song.ogg', result: { duration_s: 8 } }
const made = (kind) => JSON.parse(gameFile(kind, { analysis, lines: reference, creator: 'mapper' }).text)

/** game-formats.test.js's lines: a change off the grid into 3/4, then 4/4 at the same tempo. */
const B2 = 1234.567 + 75 * 400 + 151.3
const B3 = B2 + (60 * 60000) / 140
const hard = [
  { timeMs: 1234.567, beatMs: 60000 / 150, meter: 4 },
  { timeMs: B2, beatMs: 60000 / 140, meter: 3 },
  { timeMs: B3, beatMs: 60000 / 140, meter: 4 },
]
/** Many changes, decimals everywhere, a first line before the audio. */
const many = (() => {
  const out = []
  let t = -123.456
  for (let i = 0; i < 25; i++) {
    const bpm = 100 + ((i * 41) % 120) + 0.0371 * i
    out.push({ timeMs: t, beatMs: 60000 / bpm, meter: i % 5 === 2 ? 3 : 4 })
    t += (8 + (i % 7)) * (60000 / bpm) + 29.3 * ((i % 3) - 1) + 0.77
  }
  return out
})()

test('the four games are offered after the first four', () => {
  assert.deepEqual(
    GAME_FORMATS.map((f) => f.id),
    ['qua', 'sm', 'ssc', 'chart', 'beatsaber', 'adofai', 'fnf', 'rdlevel'],
  )
  assert.equal(gameFile('beatsaber', { analysis, lines: reference }).name, 'ExpertStandard.dat')
  assert.equal(gameFile('adofai', { analysis, lines: reference }).name, 'Artist - Song.adofai')
  assert.equal(gameFile('fnf', { analysis, lines: reference }).name, 'artist-song.json')
  assert.equal(gameFile('rdlevel', { analysis, lines: reference }).name, 'Artist - Song.rdlevel')
})

test('each file matches its hand-made reference', () => {
  assert.deepEqual(made('beatsaber'), fixture('ExpertStandard.dat'))
  assert.deepEqual(made('adofai'), fixture('reference.adofai'))
  assert.deepEqual(made('fnf'), fixture('reference-fnf.json'))
  assert.deepEqual(made('rdlevel'), fixture('reference.rdlevel'))
})

test('written beats follow the reader: a rounding moves one change, never the ones after it', () => {
  const anchors = [
    { timeMs: 0, bpm: 150 },
    { timeMs: 1000.0000004, bpm: 133.3333333 },
    { timeMs: 99999.9999996, bpm: 151 },
  ]
  const { beats, worstMs } = writtenBeats(anchors)
  assert.equal(beats[1], 2.5)
  assert.ok(worstMs < 1e-3)
})

// ---------------------------------------------------------------------------
// Read back by each game's own arithmetic
// ---------------------------------------------------------------------------

/** A beat timeline read as a game reads it: `[{ b, bpm }]` from beat 0 at `zeroMs`. */
const beatClock = (events, zeroMs = 0) => ({
  time(beat) {
    // Before beat 0 (a first line a rounding put a hair before the file's zero): the first tempo, backwards.
    if (beat < 0) return zeroMs + (beat * 60000) / events[0].bpm
    let ms = zeroMs
    for (let i = 0; i < events.length; i++) {
      const end = Math.min(beat, events[i + 1]?.b ?? Infinity)
      if (end <= events[i].b) break
      ms += ((end - events[i].b) * 60000) / events[i].bpm
    }
    return ms
  },
  beat(ms) {
    let lo = -16
    let hi = 1e6
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2
      if (this.time(mid) < ms) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  },
})

/** Every line's own beats, a few each, land on the reader's beats within half a millisecond. */
function linesOnClock(clock, lines) {
  for (const [i, line] of lines.entries()) {
    if (line.timeMs < 0) continue
    const x = clock.beat(line.timeMs)
    assert.ok(Math.abs(clock.time(x) - line.timeMs) < 1e-6)
    const next = lines[i + 1]?.timeMs ?? line.timeMs + 10 * line.beatMs
    for (let k = 1; line.timeMs + k * line.beatMs < next - 1; k++) {
      const off = clock.time(x + k) - (line.timeMs + k * line.beatMs)
      assert.ok(Math.abs(off) < 0.5, `line ${i} beat ${k}: ${off} ms`)
    }
  }
}

test('Beat Saber read back: every line’s beats on the game’s beats, a lead-in to a whole beat', () => {
  for (const lines of [reference, hard, many]) {
    const { events, report } = beatSaberBpmEvents(lines)
    assert.equal(events[0].b, 0)
    for (let i = 1; i < events.length; i++) assert.ok(events[i].b > events[i - 1].b && events[i].m !== events[i - 1].m)
    const clock = beatClock(events.map((e) => ({ b: e.b, bpm: e.m })))
    linesOnClock(clock, lines)
    // The first line that is in the audio sits on a whole beat.
    const first = lines.find((l) => l.timeMs >= 0)
    const x = clock.beat(first.timeMs)
    if (first === lines[0]) assert.ok(Math.abs(x - Math.round(x)) * lines[0].beatMs < 0.5, `first line at beat ${x}`)
    assert.ok(report.worstMs < 0.01)
  }
  // A first line on the grid from 0: no lead-in.
  assert.deepEqual(beatSaberBpmEvents([{ timeMs: 800, beatMs: 400, meter: 4 }]).events, [{ b: 0, m: 150 }])
})

test('ADOFAI read back: a tile on every line, whole beats of its BPM until the odd tile before the next', () => {
  for (const lines of [reference, hard, many]) {
    const { offset, bpm, tiles, actions, starts, report } = adofaiTimeline(lines, { durationS: 400 })
    assert.equal(offset, Math.round(offset))
    // Floor k's time: tile 0 at the offset, each move at the speed set on or before its floor.
    const speeds = new Map(actions.map((a) => [a.floor, a.bpm]))
    const floors = [offset]
    let now = bpm
    for (let k = 0; k < tiles; k++) {
      now = speeds.get(k) ?? now
      floors.push(floors[k] + 60000 / now)
    }
    for (const [i, line] of lines.entries()) {
      if (line.timeMs < 0) continue
      const k = starts[i]
      assert.ok(Math.abs(floors[k] - line.timeMs) < 0.5, `line ${i} at floor ${k}: ${floors[k] - line.timeMs} ms`)
      const end = starts[i + 1] ?? tiles
      for (let j = k + 1; j < end - 1; j++) assert.ok(Math.abs(floors[j] - floors[j - 1] - line.beatMs) < 1e-3)
    }
    assert.ok(report.worstMs < 0.5)
    assert.ok(floors.at(-1) >= 400000 - 1, 'the tiles run to the song’s end')
  }
})

test('FNF read back: sections from the audio’s start, every line on a section’s start', () => {
  for (const lines of [reference, hard, many]) {
    const { sections, bpm, report } = fnfSections(lines, { durationS: 400 })
    assert.equal(bpm, sections[0].bpm)
    // Each section's start: the steps before it at their sections' BPMs; a change only when changeBPM says so.
    const starts = [0]
    let now = bpm
    for (const [j, s] of sections.entries()) {
      if (s.changeBPM) now = s.bpm
      else assert.equal(s.bpm, now, `section ${j} changes without changeBPM`)
      starts.push(starts[j] + s.steps * (15000 / now))
    }
    for (const [i, line] of lines.entries()) {
      if (line.timeMs < 0) continue
      const hit = starts.findIndex((ms) => Math.abs(ms - line.timeMs) < 0.5)
      assert.ok(hit >= 0, `no section starts at line ${i} (${line.timeMs} ms)`)
      assert.ok(Math.abs(sections[hit].bpm - 60000 / line.beatMs) < 1e-5 || sections[hit].steps < 16)
    }
    for (const s of sections) assert.ok(Number.isInteger(s.steps) && s.steps >= 1 && s.steps <= 24)
    assert.ok(report.worstMs < 0.5)
  }
})

test('Rhythm Doctor read back: bar and beat through the bar lengths, then the tempi', () => {
  for (const lines of [reference, hard, many]) {
    const { offset, bpm, events, report } = rhythmDoctorTimeline(lines)
    // Bars to beats: each SetCrotchetsPerBar sits on a bar's first beat and sets the bars after it.
    const cpbs = events.filter((e) => e.type === 'SetCrotchetsPerBar')
    for (const e of cpbs) assert.equal(e.beat, 1)
    const toBeat = ({ bar, beat }) => {
      let total = 0
      let fromBar = 1
      let cpb = 8
      for (const c of cpbs) {
        if (c.bar > bar) break
        total += (c.bar - fromBar) * cpb
        fromBar = c.bar
        cpb = c.value
      }
      return total + (bar - fromBar) * cpb + (beat - 1)
    }
    const tempos = [{ b: 0, bpm }, ...events.filter((e) => e.type === 'SetBeatsPerMinute').map((e) => ({ b: toBeat(e), bpm: e.value }))]
    for (const e of events) assert.ok(e.beat >= 1 && e.beat < (cpbs.findLast((c) => c.bar <= e.bar)?.value ?? 8) + 1)
    const clock = beatClock(tempos, offset)
    linesOnClock(clock, lines)
    assert.ok(report.worstMs <= 0.5)
  }
  // The hard lines: 3/4 at the change cannot start a bar there (75.378 beats in), so it is counted, not written.
  const { report, events } = rhythmDoctorTimeline(hard)
  assert.equal(events.filter((e) => e.type === 'SetCrotchetsPerBar').length, 1)
  assert.equal(report.meterLost, 1)
})
