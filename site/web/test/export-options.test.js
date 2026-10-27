import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  bpmRoundingDrift,
  changesLines,
  cleanOptions,
  DEFAULT_EXPORT_OPTIONS,
  exportLines,
  loadOptions,
  optionsNote,
  saveOptions,
  STORAGE_KEY,
} from '../src/lib/export-options.js'
import { osuFile } from '../src/lib/osz.js'
import { adjustLines, timingText } from '../src/lib/timing.js'

const result = {
  duration_s: 60,
  red_lines: [
    { time_ms: 400.127, bpm: 128.0049, beat_length_ms: 60000 / 128.0049, meter: 4, meter_known: true },
    { time_ms: 30400.127, bpm: 142, beat_length_ms: 422.535211267606, meter: 3, meter_known: true },
  ],
  osu_timing: `// Overtone v3\r\n400,${(60000 / 128.0049).toFixed(12)},4,1,0,100,1,0\r\n30400,422.535211267606,3,1,0,100,1,0`,
}
const unadjusted = { factor: 1, nudgeMs: 0 }
const lines = adjustLines(result, unadjusted)

/** A Storage stand-in. */
function memoryStorage(initial = {}) {
  const data = { ...initial }
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => (data[k] = String(v)), data }
}

test('stored options are read defensively: anything bad is its default', () => {
  assert.deepEqual(loadOptions(memoryStorage()), DEFAULT_EXPORT_OPTIONS)
  assert.deepEqual(loadOptions(memoryStorage({ [STORAGE_KEY]: '{not json' })), DEFAULT_EXPORT_OPTIONS)
  assert.deepEqual(loadOptions({ getItem: () => { throw new Error('blocked') } }), DEFAULT_EXPORT_OPTIONS)
  assert.deepEqual(
    cleanOptions({ offsetDecimals: 9, bpmDecimals: 1.5, firstLineOnly: 'yes', globalOffsetMs: 99999 }),
    { offsetDecimals: 3, bpmDecimals: null, firstLineOnly: false, globalOffsetMs: 1000 },
  )
  assert.equal(cleanOptions({ globalOffsetMs: 'x' }).globalOffsetMs, 0)
  const storage = memoryStorage()
  saveOptions({ offsetDecimals: 1, bpmDecimals: 2, firstLineOnly: true, globalOffsetMs: -9.4 }, storage)
  assert.deepEqual(loadOptions(storage), { offsetDecimals: 1, bpmDecimals: 2, firstLineOnly: true, globalOffsetMs: -9 })
  assert.doesNotThrow(() => saveOptions(DEFAULT_EXPORT_OPTIONS, { setItem: () => { throw new Error('full') } }))
})

test('the options shape the written lines: rounded BPM, first line only, an added offset', () => {
  assert.deepEqual(exportLines(lines, DEFAULT_EXPORT_OPTIONS), lines)
  assert.equal(changesLines(DEFAULT_EXPORT_OPTIONS), false)
  assert.equal(changesLines({ ...DEFAULT_EXPORT_OPTIONS, offsetDecimals: 0 }), false)
  const out = exportLines(lines, { bpmDecimals: 2, firstLineOnly: false, globalOffsetMs: 9 })
  assert.equal(out[0].bpm, 128)
  assert.equal(out[0].beatMs, 468.75)
  assert.equal(out[0].timeMs, 409.127)
  assert.equal(out[1].meter, 3)
  assert.equal(exportLines(lines, { firstLineOnly: true }).length, 1)
  assert.equal(optionsNote({ bpmDecimals: 2, firstLineOnly: true, globalOffsetMs: 9 }), 'BPM rounded to 2 decimals, first red line only, +9 ms export offset')
})

test('the drift of a rounded BPM is counted to the last beat before the next line or the song end', () => {
  assert.deepEqual(bpmRoundingDrift(lines, DEFAULT_EXPORT_OPTIONS, 60000), { worstMs: 0, line: 0 })
  const drift = bpmRoundingDrift(lines, { bpmDecimals: 2 }, 60000)
  // Line 0: 128.0049 -> 128; 30000 ms of it is 64 whole beats at 468.732... ms.
  const beat = 60000 / 128.0049
  const expected = Math.floor(30000 / beat) * (468.75 - beat)
  assert.ok(Math.abs(drift.worstMs - expected) < 1e-9)
  assert.equal(drift.line, 0)
  // First line only: it runs to the song's end.
  const first = bpmRoundingDrift(lines, { bpmDecimals: 2, firstLineOnly: true }, 60000)
  assert.ok(Math.abs(first.worstMs - Math.floor((60000 - 400.127) / beat) * (468.75 - beat)) < 1e-9)
})

test('the copied block and the .osz say the options and carry whole ms', () => {
  const options = { offsetDecimals: 3, bpmDecimals: 2, firstLineOnly: true, globalOffsetMs: 9 }
  const text = timingText(result, exportLines(lines, options), unadjusted, options)
  assert.equal(
    text,
    '[TimingPoints]\r\n// Overtone v3\r\n// Exported on the Overtone site (BPM rounded to 2 decimals, first red line only, +9 ms export offset): check it by ear\r\n409,468.750000000000,4,1,0,100,1,0\r\n',
  )
  // No options: the engine's rows, as before.
  assert.equal(timingText(result, lines, unadjusted, DEFAULT_EXPORT_OPTIONS), timingText(result))
  const osu = osuFile({ title: 'S', artist: 'A', creator: 'c', audioName: 'audio.mp3', lines: exportLines(lines, options), result, adjustment: unadjusted, options })
  assert.match(osu, /\[TimingPoints\]\r\n409,468.750000000000,4,1,0,100,1,0\r\n/)
  // An adjustment and options together: both named.
  const both = timingText(result, exportLines(adjustLines(result, { factor: 2, nudgeMs: 0 }), { globalOffsetMs: -5 }), { factor: 2, nudgeMs: 0 }, { globalOffsetMs: -5 })
  assert.match(both, /Adjusted on the Overtone site \(x2, -5 ms export offset\)/)
})
