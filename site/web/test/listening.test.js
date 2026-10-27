import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  addTap,
  compareTempo,
  DEFAULT_SUB_VOLUME,
  LATENCY_KEY,
  LISTENING_KEY,
  readListening,
  writeListening,
  latencyEstimate,
  median,
  offsetProposal,
  offsetsToGrid,
  readLatency,
  robustCentre,
  TAP_GAP_MS,
  TAP_KEEP,
  tapTempo,
  writeLatency,
} from '../src/lib/listening.js'
import { adjustLines, BAR, BEAT, clickGrid, SUB } from '../src/lib/timing.js'

/** A little deterministic jitter, so the tests do not depend on Math.random. */
const jitter = (i, size) => (((i * 7919) % 13) / 12 - 0.5) * 2 * size

test('the median takes the middle, or the mean of the two middles', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.ok(Number.isNaN(median([])))
})

test('a robust centre drops the stray value and keeps a steady hand whole', () => {
  const r = robustCentre([10, 11, 9, 10, 12, 10, 80])
  assert.equal(r.kept, 6)
  assert.equal(r.dropped, 1)
  assert.equal(r.centre, 10)
  // All equal but one 2 ms off: the MAD is 0, the floor keeps the near one.
  const steady = robustCentre([5, 5, 5, 5, 7], { floor: 15 })
  assert.equal(steady.kept, 5)
})

test('taps start a new run after a pause, ignore repeats and keep the last ones', () => {
  let taps = []
  for (let i = 0; i < 30; i++) taps = addTap(taps, 1000 + i * 500)
  assert.equal(taps.length, TAP_KEEP)
  assert.equal(taps[taps.length - 1], 1000 + 29 * 500)
  assert.equal(addTap(taps, taps[taps.length - 1]), taps) // auto-repeat, same stamp
  assert.deepEqual(addTap(taps, taps[taps.length - 1] + TAP_GAP_MS + 1), [taps[taps.length - 1] + TAP_GAP_MS + 1])
})

test('tap tempo reads 128 BPM through a hand 10 ms uneven and one missed tap', () => {
  const beat = 60000 / 128
  const taps = []
  for (let i = 0; i < 16; i++) if (i !== 9) taps.push(i * beat + jitter(i, 10))
  const reading = tapTempo(taps)
  assert.ok(Math.abs(reading.bpm - 128) < 1.5, `bpm ${reading.bpm}`)
  assert.ok(reading.spreadBpm < 6, `spread ${reading.spreadBpm}`)
  assert.equal(reading.taps, 15)
  assert.equal(tapTempo([0, 500, 1000]), null) // under four taps
})

test('a tapped tempo is compared with the result: match, double, half or neither', () => {
  assert.equal(compareTempo(128.9, 128).kind, 'match')
  assert.equal(compareTempo(255, 128).kind, 'double')
  assert.equal(compareTempo(64.5, 128).kind, 'half')
  const odd = compareTempo(192, 128)
  assert.equal(odd.kind, 'other')
  assert.equal(odd.ratio, 1.5)
  assert.equal(compareTempo(0, 128), null)
})

test('offsets to a grid are signed, against the nearest beat either side', () => {
  const grid = Float64Array.from([1, 1.5, 2, 2.5])
  assert.deepEqual(
    offsetsToGrid([0.98, 1.52, 2.24, 3], grid).map((v) => Math.round(v)),
    [-20, 20, 240, 500],
  )
})

test('the latency is the median offset with stray taps dropped, refused when the hand wanders', () => {
  const offsets = Array.from({ length: 16 }, (_, i) => 42 + jitter(i, 8))
  offsets[3] = 260 // a tap on the wrong click
  const reading = latencyEstimate(offsets)
  assert.equal(reading.latencyMs, Math.round(median(offsets.filter((v) => v < 100))))
  assert.ok(Math.abs(reading.latencyMs - 42) <= 4, `latency ${reading.latencyMs}`)
  assert.equal(reading.dropped, 1)
  assert.equal(latencyEstimate([40, 41, 42]), null) // too few
  const wild = latencyEstimate(Array.from({ length: 16 }, (_, i) => (i % 2 ? 120 : -120) + jitter(i, 5)))
  assert.equal(wild.unsteady, true)
})

test('taps late against the grid propose a later offset, rounded to a whole ms', () => {
  const lines = adjustLines({ red_lines: [{ time_ms: 500, bpm: 120, beat_length_ms: 500, meter: 4 }] })
  const beats = clickGrid(lines, 30).t
  // The song's beats sit 23 ms after the lines; the taps follow the song.
  const taps = Array.from({ length: 12 }, (_, i) => 2 + i * 0.5 + 0.023 + jitter(i, 0.006))
  taps.push(9.2) // a tap that missed
  const proposal = offsetProposal(taps, beats)
  assert.ok(Math.abs(proposal.nudgeMs - 23) <= 2, `nudge ${proposal.nudgeMs}`)
  assert.equal(proposal.kept, 12)
  assert.equal(proposal.dropped, 1)
  assert.equal(offsetProposal(taps.slice(0, 5), beats), null)
})

test('the stored latency is read defensively and forgotten at zero', () => {
  const store = new Map()
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }
  assert.equal(readLatency(storage), 0)
  writeLatency(37.6, storage)
  assert.equal(store.get(LATENCY_KEY), '38')
  assert.equal(readLatency(storage), 38)
  store.set(LATENCY_KEY, 'loud')
  assert.equal(readLatency(storage), 0)
  store.set(LATENCY_KEY, '9000')
  assert.equal(readLatency(storage), 0)
  writeLatency(0, storage)
  assert.equal(store.has(LATENCY_KEY), false)
  const broken = { getItem: () => { throw new Error('blocked') } }
  assert.equal(readLatency(broken), 0)
})

test('the listening options keep each valid field and default the rest', () => {
  const store = new Map()
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }
  assert.deepEqual(readListening(storage), { subdivision: 1, subVolume: DEFAULT_SUB_VOLUME, shiftClicks: false })
  writeListening({ subdivision: 3, subVolume: 0.25, shiftClicks: true }, storage)
  assert.deepEqual(readListening(storage), { subdivision: 3, subVolume: 0.25, shiftClicks: true })
  store.set(LISTENING_KEY, JSON.stringify({ subdivision: 7, subVolume: 4, shiftClicks: 'yes' }))
  assert.deepEqual(readListening(storage), { subdivision: 1, subVolume: DEFAULT_SUB_VOLUME, shiftClicks: false })
  store.set(LISTENING_KEY, '{not json')
  assert.equal(readListening(storage).subdivision, 1)
})

test('subdivisions add quieter clicks between beats, inside each line, as the engine counts them', () => {
  const lines = adjustLines({
    red_lines: [
      { time_ms: 0, bpm: 120, beat_length_ms: 500, meter: 3 },
      { time_ms: 3000, bpm: 60, beat_length_ms: 1000, meter: 4 },
    ],
  })
  const plain = clickGrid(lines, 5)
  const halves = clickGrid(lines, 5, { subdivision: 2 })
  const beats = [...halves.t].filter((_, i) => halves.level[i] !== SUB)
  assert.deepEqual(beats, [...plain.t]) // the beats are unchanged
  assert.deepEqual([...halves.t.slice(0, 4)], [0, 0.25, 0.5, 0.75])
  assert.deepEqual([...halves.level.slice(0, 7)], [BAR, SUB, BEAT, SUB, BEAT, SUB, BAR])
  // No subdivision crosses into the next line: the last before 3 s is 2.75.
  const i = [...halves.t].indexOf(3)
  assert.equal(halves.t[i - 1], 2.75)
  assert.equal(halves.level[i], BAR)
  const thirds = clickGrid(lines, 5, { subdivision: 3 })
  assert.ok(Math.abs(thirds.t[1] - 0.5 / 3) < 1e-12)
  assert.equal([...thirds.level].filter((l) => l === SUB).length, 2 * [...thirds.level].filter((l) => l !== SUB).length - 2)
  // An unknown subdivision falls back to none.
  assert.deepEqual([...clickGrid(lines, 5, { subdivision: 5 }).t], [...plain.t])
})
