import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BATCH_OSZ_MAX_BYTES, batchOsz, batchTimingFiles, oszPlan } from '../src/lib/batch-export.js'
import { timingText } from '../src/lib/timing.js'
import { ZipWriter, zipStore } from '../src/lib/zip.js'

const result = (bpm) => ({
  duration_s: 60,
  red_lines: [{ time_ms: 100, bpm, beat_length_ms: 60_000 / bpm, meter: 4, meter_known: true }],
  sections: [{ level: 'high', confidence: 0.9 }],
  osu_timing: `100,${(60_000 / bpm).toFixed(12)},4,1,0,100,1,0`,
})
const file = (name, size = 10) => ({ name, size, arrayBuffer: async () => new Uint8Array(size).buffer })
const items = [
  { file: file('a.mp3'), status: 'done', result: result(120) },
  { file: file('b.mp3'), status: 'done', result: result(150) },
  { file: file('c.mp3'), status: 'failed', result: null },
  { file: file('d.mp3'), status: 'queued', result: null },
]

test('the streaming zip writes the same bytes as the one-piece zip', async () => {
  const date = new Date(2026, 9, 27, 12, 30, 10)
  const files = [{ name: 'x.txt', text: 'hello' }, { name: 'X.txt', text: 'again' }, { name: 'song.osz', data: new Uint8Array([1, 2, 3, 250]) }]
  const writer = new ZipWriter(date)
  for (const f of files) writer.add(f.name, f)
  const streamed = new Uint8Array(await writer.blob().arrayBuffer())
  assert.deepEqual(streamed, zipStore(files, date))
  assert.equal(writer.blob().type, 'application/zip')
})

test('the batch timings carry the batch adjustment and the export options, finished songs only', () => {
  const plain = batchTimingFiles(items)
  assert.deepEqual(plain.map((f) => f.name), ['a-timing.txt', 'b-timing.txt'])
  assert.equal(plain[0].text, timingText(items[0].result))
  const doubled = batchTimingFiles(items, { factor: 2, nudgeMs: -3 }, { offsetDecimals: 3, bpmDecimals: null, firstLineOnly: false, globalOffsetMs: 0 })
  assert.match(doubled[0].text, /Adjusted on the Overtone site \(x2, -3 ms\)/)
  assert.match(doubled[0].text, /^97,250\.000000000000,4,/m)
  assert.match(doubled[1].text, /^97,200\.000000000000,4,/m)
  const offset = batchTimingFiles(items, undefined, { offsetDecimals: 3, bpmDecimals: null, firstLineOnly: false, globalOffsetMs: 20 })
  assert.match(offset[0].text, /^120,500\.000000000000,4,/m)
})

test('the .osz plan counts finished songs with files and refuses a batch over the cap', () => {
  const plan = oszPlan(items)
  assert.equal(plan.songs.length, 2)
  assert.equal(plan.bytes, 20)
  assert.equal(plan.fits, true)
  assert.equal(oszPlan([{ ...items[0], file: file('big.wav', BATCH_OSZ_MAX_BYTES + 1) }]).fits, false)
  assert.equal(oszPlan(items.slice(2)).fits, false)
})

test('every .osz is built one at a time with the batch adjustment, and a failure leaves only that song out', async () => {
  const calls = []
  const progress = []
  const build = async ({ file: f, lines, adjustment, creator }) => {
    calls.push({ name: f.name, bpm: lines[0].bpm, adjustment, creator })
    if (f.name === 'b.mp3') throw new Error('cannot read')
    return { name: `${f.name}.osz`, bytes: new Uint8Array([7, 7]) }
  }
  const { blob, failed } = await batchOsz(items, { adjustment: { factor: 0.5, nudgeMs: 0 }, creator: 'mapper', build, onProgress: (d, n) => progress.push(`${d}/${n}`) })
  assert.deepEqual(calls.map((c) => [c.name, c.bpm, c.creator]), [['a.mp3', 60, 'mapper'], ['b.mp3', 75, 'mapper']])
  assert.deepEqual(failed, ['b.mp3'])
  assert.deepEqual(progress, ['1/2', '2/2'])
  const bytes = new Uint8Array(await blob.arrayBuffer())
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50)
  assert.ok(new TextDecoder().decode(bytes).includes('a.mp3.osz'))
  assert.ok(!new TextDecoder().decode(bytes).includes('b.mp3.osz'))
  await assert.rejects(batchOsz(items.slice(2), { build }), /nothing to build/)
})

test('each built .osz is handed over to be kept, and a keeper that throws never stops the batch', async () => {
  const build = async ({ file: f }) => ({ name: `${f.name}.osz`, bytes: new Uint8Array([1, 2, 3]) })
  const kept = []
  const { failed } = await batchOsz(items, {
    build,
    onBuilt: async ({ item, name, bytes }) => {
      kept.push([item.file.name, name, bytes.length])
      throw new Error('storage blocked')
    },
  })
  assert.deepEqual(kept, [['a.mp3', 'a.mp3.osz', 3], ['b.mp3', 'b.mp3.osz', 3]])
  assert.deepEqual(failed, [])
})
