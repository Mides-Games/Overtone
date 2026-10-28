import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MIDI_PPQ, firstDownbeat, midiFile, midiTempoMap, reaperProject, vlq } from '../src/lib/daw-exports.js'

/** The fixture of game-formats.test.js: 150 BPM 4/4, a change off the grid to 140 in 3/4, back to 4/4. */
const B2 = 1234.567 + 75 * 400 + 151.3
const B3 = B2 + (60 * 60000) / 140
const lines = [
  { timeMs: 1234.567, beatMs: 60000 / 150, meter: 4 },
  { timeMs: B2, beatMs: 60000 / 140, meter: 3 },
  { timeMs: B3, beatMs: 60000 / 140, meter: 4 },
]

/**
 * A Standard MIDI File read back by the spec, independently of the writer:
 * the header, each track's events with their absolute ticks, and the time of
 * each tick through the tempo map (500000 µs a quarter until the first tempo).
 */
function parseMidi(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at, n) => String.fromCharCode(...bytes.slice(at, at + n))
  assert.equal(text(0, 4), 'MThd')
  assert.equal(view.getUint32(4), 6)
  const header = { format: view.getUint16(8), tracks: view.getUint16(10), division: view.getUint16(12) }
  let at = 14
  const tracks = []
  for (let k = 0; k < header.tracks; k++) {
    assert.equal(text(at, 4), 'MTrk')
    const end = at + 8 + view.getUint32(at + 4)
    at += 8
    let tick = 0
    const events = []
    const readVlq = () => {
      let n = 0
      for (;;) {
        const b = bytes[at++]
        n = n * 128 + (b & 0x7f)
        if (!(b & 0x80)) return n
      }
    }
    while (at < end) {
      tick += readVlq()
      const status = bytes[at++]
      assert.equal(status, 0xff, 'only meta events in a conductor track')
      const type = bytes[at++]
      const len = readVlq()
      const data = bytes.slice(at, at + len)
      at += len
      events.push({ tick, type, data })
    }
    assert.equal(at, end, 'the track length matches its events')
    tracks.push(events)
  }
  assert.equal(at, bytes.length)
  return { header, tracks }
}

/** ms at `tick` through the tempo events (Set Tempo, FF 51), as a sequencer computes it. */
function tickToMs(events, tick, ppq) {
  const tempos = events.filter((e) => e.type === 0x51).map((e) => ({ tick: e.tick, us: (e.data[0] << 16) | (e.data[1] << 8) | e.data[2] }))
  let ms = 0
  let from = 0
  let us = 500000
  for (const t of tempos) {
    if (t.tick >= tick) break
    ms += ((t.tick - from) * us) / ppq / 1000
    from = t.tick
    us = t.us
  }
  return ms + ((tick - from) * us) / ppq / 1000
}

test('variable-length quantities as the spec’s examples', () => {
  assert.deepEqual(vlq(0), [0x00])
  assert.deepEqual(vlq(0x40), [0x40])
  assert.deepEqual(vlq(0x7f), [0x7f])
  assert.deepEqual(vlq(0x80), [0x81, 0x00])
  assert.deepEqual(vlq(0x2000), [0xc0, 0x00])
  assert.deepEqual(vlq(0x3fff), [0xff, 0x7f])
  assert.deepEqual(vlq(0x4000), [0x81, 0x80, 0x00])
  assert.deepEqual(vlq(0x0fffffff), [0xff, 0xff, 0xff, 0x7f])
})

test('the first downbeat at least half a unit in, or 0 on the grid', () => {
  assert.equal(firstDownbeat(1600, 1600), 0)
  assert.equal(firstDownbeat(0, 1600), 0)
  assert.equal(firstDownbeat(1000, 1600), 1000)
  assert.equal(firstDownbeat(1234.567, 1600), 1234.567)
  assert.ok(Math.abs(firstDownbeat(500, 1600) - 2100) < 1e-9)
  assert.ok(Math.abs(firstDownbeat(-200, 1600) - 1400) < 1e-9)
})

test('MIDI: format 1, one conductor track, PPQ 960, every red line within 0.5 ms read back', () => {
  const { bytes, report } = midiFile(lines)
  const { header, tracks } = parseMidi(bytes)
  assert.deepEqual(header, { format: 1, tracks: 1, division: MIDI_PPQ })
  const [events] = tracks
  assert.equal(events[0].type, 0x03) // track name first
  assert.equal(events.at(-1).type, 0x2f) // end of track last
  assert.equal(events.at(-1).data.length, 0)

  // Time signatures: 4/4 at 0, 3/4 at the change, 4/4 at the last line.
  const ts = events.filter((e) => e.type === 0x58)
  assert.deepEqual(
    ts.map((e) => [...e.data]),
    [
      [4, 2, 24, 8],
      [3, 2, 24, 8],
      [4, 2, 24, 8],
    ],
  )
  assert.equal(ts[0].tick, 0)

  // Each red line: a tempo event at the time the line has, by the file's own arithmetic.
  const tempos = events.filter((e) => e.type === 0x51)
  assert.ok(report.leadIn, '1234.567 ms is not on a bar from 0: a lead-in bar')
  assert.equal(tempos[0].tick, 0)
  const lineTempos = tempos.slice(1)
  assert.equal(lineTempos.length, 3)
  // The first line's grid is drawn back to its downbeat: 1234.567 ms is a whole bar after the lead-in.
  const firstAt = tickToMs(events, lineTempos[0].tick, MIDI_PPQ)
  const bars = (1234.567 - firstAt) / 1600
  assert.ok(Math.abs(bars - Math.round(bars)) * 1600 < 0.5, `first line ${firstAt} ms`)
  let worst = Math.abs(1234.567 - firstAt - Math.round(bars) * 1600)
  for (const [i, line] of lines.slice(1).entries()) {
    const ms = tickToMs(events, lineTempos[i + 1].tick, MIDI_PPQ)
    worst = Math.max(worst, Math.abs(ms - line.timeMs))
  }
  assert.ok(worst < 0.5, `worst ${worst} ms`)
  assert.ok(report.worstMs < 0.5 && Math.abs(report.worstMs - worst) < 1e-6, `${report.worstMs} vs ${worst}`)
  // The 3/4 at 140 tempo: 428571 µs a quarter, and the last line's tempo is its own.
  assert.equal((lineTempos[2].data[0] << 16) | (lineTempos[2].data[1] << 8) | lineTempos[2].data[2], 428571)
})

test('MIDI: no drift over a long song with many changes off the grid', () => {
  // 40 changes, each a whole number of beats plus a fraction, tempi with decimals.
  const many = []
  let t = 333.333
  for (let i = 0; i < 40; i++) {
    const bpm = 120 + ((i * 37) % 90) + 0.123 * i
    many.push({ timeMs: t, beatMs: 60000 / bpm, meter: i % 7 === 3 ? 3 : 4 })
    t += (16 + (i % 5)) * (60000 / bpm) + 37.77 * ((i % 3) - 1) + 0.371
  }
  const { bytes, report } = midiFile(many)
  const [events] = parseMidi(bytes).tracks
  const tempos = events.filter((e) => e.type === 0x51)
  const lineTempos = report.leadIn ? tempos.slice(1) : tempos
  // Two lines' events may merge only if they share a tick; here none do.
  assert.equal(lineTempos.length, many.length)
  let worst = 0
  for (let i = 1; i < many.length; i++) worst = Math.max(worst, Math.abs(tickToMs(events, lineTempos[i].tick, MIDI_PPQ) - many[i].timeMs))
  assert.ok(worst < 0.5, `worst ${worst} ms`)
  assert.ok(report.worstMs < 0.5)
})

test('MIDI: a first line on the grid from 0 needs no lead-in, and the tempo is whole microseconds', () => {
  const { events, report } = midiTempoMap([{ timeMs: 1600, beatMs: 400, meter: 4 }])
  assert.equal(report.leadIn, false)
  assert.deepEqual(events, [
    { tick: 0, kind: 'ts', value: 4 },
    { tick: 0, kind: 'tempo', value: 400000 },
  ])
  assert.throws(() => midiTempoMap([]), /No timing/)
})

test('Reaper: a project with the tempo envelope, a marker per red line and the song on a track', () => {
  const { text, withAudio } = reaperProject({ lines, audioName: 'My "Song".mp3', durationS: 123.5, title: 'Song' })
  assert.ok(withAudio)
  assert.match(text, /^<REAPER_PROJECT 0\.1 "6\.0" 0\n/)
  assert.ok(text.endsWith('>\n'))
  // Balanced blocks.
  const opens = text.split('\n').filter((l) => /^\s*</.test(l)).length
  const closes = text.split('\n').filter((l) => /^\s*>$/.test(l)).length
  assert.equal(opens, closes)
  const pts = [...text.matchAll(/^ {4}PT (\S+) (\S+) 1(?: (\d+))?$/gm)].map((m) => ({ s: Number(m[1]), bpm: Number(m[2]), sig: m[3] ? Number(m[3]) : null }))
  // Lead-in bar from 0, the first line's downbeat, the 3/4 change, the 4/4 return.
  assert.equal(pts.length, 4)
  assert.equal(pts[0].s, 0)
  assert.equal(pts[0].sig, 4 + 65536 * 4)
  assert.ok(Math.abs(pts[0].bpm - (4 * 60000) / 1234.567) < 1e-6)
  assert.ok(Math.abs(pts[1].s * 1000 - 1234.567) < 1e-6)
  assert.equal(pts[1].sig, null)
  assert.ok(Math.abs(pts[2].s * 1000 - B2) < 1e-6)
  assert.ok(Math.abs(pts[2].bpm - 140) < 1e-9)
  assert.equal(pts[2].sig, 3 + 65536 * 4)
  assert.equal(pts[3].sig, 4 + 65536 * 4)
  const markers = [...text.matchAll(/^ {2}MARKER (\d+) (\S+) "([^"]*)" 0$/gm)]
  assert.deepEqual(
    markers.map((m) => m[3]),
    ['150 BPM', '140 BPM 3/4', '140 BPM'],
  )
  assert.match(text, /<SOURCE MP3\n {8}FILE "My 'Song'\.mp3"\n/)
  assert.match(text, /LENGTH 123\.500000/)
  // A file type Reaper's source we do not know: no item.
  assert.equal(reaperProject({ lines, audioName: 'x.m4a' }).withAudio, false)
})
