import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildOsz, mapTags, mergeRows, osuFile, songNames } from '../src/lib/osz.js'
import { kiaiRows } from '../src/lib/osz-suggest.js'
import { adjustLines } from '../src/lib/timing.js'
import { crc32 } from '../src/lib/zip.js'

const result = {
  red_lines: [
    { time_ms: 400.127, bpm: 128, beat_length_ms: 468.75, meter: 4, meter_known: true },
    { time_ms: 30400.127, bpm: 142, beat_length_ms: 422.535211267606, meter: 4, meter_known: true },
  ],
  osu_timing: '// Overtone v3\r\n400,468.750000000000,4,1,0,100,1,0\r\n30400,422.535211267606,4,1,0,100,1,0',
}
const unadjusted = { factor: 1, nudgeMs: 0 }

/** The entries of a stored ZIP, read back from its local headers. */
function entries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = []
  for (let at = 0; view.getUint32(at, true) === 0x04034b50; ) {
    const size = view.getUint32(at + 18, true)
    const nameLength = view.getUint16(at + 26, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength))
    const data = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size)
    out.push({ name, data, crc: view.getUint32(at + 14, true) })
    at += 30 + nameLength + size
  }
  return out
}

test('the .osu holds the engine rows as its red lines, no comments and no notes', () => {
  const text = osuFile({ title: 'Song', artist: 'Band', creator: 'someone', audioName: 'audio.mp3', lines: adjustLines(result, unadjusted), result, adjustment: unadjusted })
  assert.ok(text.startsWith('osu file format v14\r\n'))
  assert.match(text, /\r\nAudioFilename: audio\.mp3\r\n/)
  assert.match(text, /\r\n\[TimingPoints\]\r\n400,468\.750000000000,4,1,0,100,1,0\r\n30400,422\.535211267606,4,1,0,100,1,0\r\n\r\n\r\n\[HitObjects\]\r\n$/)
  assert.doesNotMatch(text.slice(text.indexOf('[TimingPoints]')), /\/\//)
  assert.match(text, /\r\nCreator:someone\r\nVersion:Timing\r\n/)
})

test('an adjusted timing goes into the .osu as the reader has it', () => {
  const adjustment = { factor: 2, nudgeMs: 5 }
  const text = osuFile({ title: 'S', artist: 'A', creator: '', audioName: 'audio.ogg', lines: adjustLines(result, adjustment), result, adjustment })
  assert.match(text, /\r\n405,234\.375000000000,4,1,0,100,1,0\r\n30405,211\.267605633803,4,1,0,100,1,0\r\n/)
  assert.match(text, /\r\nCreator:Overtone\r\n/)
})

test('non-ASCII titles keep their own spelling in the Unicode fields', () => {
  const text = osuFile({ title: 'Café ★ 夜', artist: 'Ñandú', creator: 'x', audioName: 'audio.mp3', lines: [], result: { red_lines: [], osu_timing: '' }, adjustment: unadjusted })
  assert.match(text, /\r\nTitle:Cafe\r\nTitleUnicode:Café ★ 夜\r\nArtist:Nandu\r\nArtistUnicode:Ñandú\r\n/)
})

test('names come from the tags, else from "Artist - Title" in the file name', () => {
  assert.deepEqual(songNames({ tagTitle: 'T', tagArtist: 'A', filename: 'x.mp3' }), { title: 'T', artist: 'A' })
  assert.deepEqual(songNames({ filename: 'Some Band - Some Song.mp3' }), { title: 'Some Song', artist: 'Some Band' })
  assert.deepEqual(songNames({ filename: 'track01.wav' }), { title: 'track01', artist: 'Unknown' })
})

test('the .osz carries the audio byte for byte and the .osu beside it', async () => {
  const audio = new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff)
  const file = new File([audio], 'Some Band - Some Song.MP3')
  const analysis = { filename: 'Some Band - Some Song.MP3', result }
  const { name, bytes } = await buildOsz({ file, analysis, lines: adjustLines(result, unadjusted), adjustment: unadjusted, creator: 'me' })
  assert.equal(name, 'Some Band - Some Song.osz')
  const [first, second] = entries(bytes)
  assert.equal(first.name, 'audio.mp3')
  assert.deepEqual(first.data, audio)
  assert.equal(first.crc, crc32(audio))
  assert.equal(second.name, 'Some Band - Some Song (me) [Timing].osu')
  assert.match(new TextDecoder().decode(second.data), /AudioFilename: audio\.mp3\r\n/)
})

test('a file name osu! could not write is cleaned', async () => {
  const file = new File([new Uint8Array(4)], 'a.ogg')
  const analysis = { filename: 'a.ogg', tagTitle: 'Why? / How: "now"', tagArtist: 'A|B', result }
  const { name, bytes } = await buildOsz({ file, analysis, lines: adjustLines(result, unadjusted), adjustment: unadjusted })
  assert.equal(name, 'AB - Why How now.osz')
  assert.equal(entries(bytes)[1].name, 'AB - Why How now (Overtone) [Timing].osu')
})

test('without extras the .osu keeps no preview, no lead-in and no background', () => {
  const text = osuFile({ title: 'S', artist: 'A', creator: 'x', audioName: 'audio.mp3', lines: adjustLines(result, unadjusted), result, adjustment: unadjusted })
  assert.match(text, /\r\nAudioLeadIn: 0\r\nPreviewTime: -1\r\n/)
  assert.match(text, /\r\n\[Events\]\r\n\/\/Background and Video events\r\n\/\/Break Periods\r\n/)
})

test('the extras go where osu! reads them: preview, lead-in, the background event, kiai greens', () => {
  const lines = adjustLines(result, unadjusted)
  const greens = kiaiRows([{ startMs: 400.127, endMs: 9775.127 }, { startMs: 20087.627, endMs: 40000 }], lines, 60000)
  const text = osuFile({ title: 'S', artist: 'A', creator: 'x', audioName: 'audio.mp3', lines, result, adjustment: unadjusted, previewMs: 30400.4, leadInMs: 1600, background: 'bg.jpg', greens })
  assert.match(text, /\r\nAudioLeadIn: 1600\r\nPreviewTime: 30400\r\n/)
  assert.match(text, /\r\n\/\/Background and Video events\r\n0,0,"bg\.jpg",0,0\r\n\/\/Break Periods\r\n/)
  const points = text.slice(text.indexOf('[TimingPoints]')).split('\r\n').slice(1, 8)
  assert.deepEqual(points, [
    '400,468.750000000000,4,1,0,100,1,0',
    '400,-100,4,1,0,100,0,1',
    '9775,-100,4,1,0,100,0,0',
    '20088,-100,4,1,0,100,0,1',
    '30400,422.535211267606,4,1,0,100,1,0',
    '30400,-100,4,1,0,100,0,1',
    '40000,-100,4,1,0,100,0,0',
  ])
})

test('every .osu carries the overtone tags, and keeps the ones it is given', () => {
  const base = { title: 'S', artist: 'A', creator: 'x', audioName: 'audio.mp3', lines: [], result: { red_lines: [], osu_timing: '' }, adjustment: unadjusted }
  assert.match(osuFile(base), /\r\nTags:overtone overtone_timings\r\n/)
  assert.match(osuFile({ ...base, tags: 'anime  Overtone\nop' }), /\r\nTags:overtone overtone_timings anime op\r\n/)
  assert.equal(mapTags(['tv size', 'overtone_timings']), 'overtone overtone_timings tv size')
})

test('the .osz built for download carries the tags too', async () => {
  const file = new File([new Uint8Array(4)], 'a.mp3')
  const { bytes } = await buildOsz({ file, analysis: { filename: 'a.mp3', result }, lines: adjustLines(result, unadjusted), adjustment: unadjusted })
  assert.match(new TextDecoder().decode(entries(bytes)[1].data), /\r\nTags:overtone overtone_timings\r\n/)
})

test('red rows come before green ones at the same ms, each kept in its order', () => {
  const merged = mergeRows(['0,500,4,1,0,100,1,0', '1000,400,4,1,0,100,1,0'], [
    { timeMs: 1000, row: 'g1' },
    { timeMs: 500, row: 'g0' },
    { timeMs: 1000, row: 'g2' },
  ])
  assert.deepEqual(merged, ['0,500,4,1,0,100,1,0', 'g0', '1000,400,4,1,0,100,1,0', 'g1', 'g2'])
})

test('a cover goes into the .osz as bg.<ext>, byte for byte', async () => {
  const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const file = new File([new Uint8Array(10)], 'a.ogg')
  const analysis = { filename: 'a.ogg', result }
  const lines = adjustLines(result, unadjusted)
  const { bytes } = await buildOsz({ file, analysis, lines, adjustment: unadjusted, extras: { cover: { ext: 'png', bytes: image }, previewMs: 1000 } })
  const all = entries(bytes)
  assert.deepEqual(all.map((e) => e.name), ['audio.ogg', 'Unknown - a (Overtone) [Timing].osu', 'bg.png'])
  assert.deepEqual(all[2].data, image)
  assert.equal(all[2].crc, crc32(image))
  const osu = new TextDecoder().decode(all[1].data)
  assert.match(osu, /\r\n0,0,"bg\.png",0,0\r\n/)
  assert.match(osu, /\r\nPreviewTime: 1000\r\n/)
  // A cover of a kind osu! cannot show is left out rather than written.
  const odd = await buildOsz({ file, analysis, lines, adjustment: unadjusted, extras: { cover: { ext: 'gif', bytes: image } } })
  assert.equal(entries(odd.bytes).length, 2)
})

test('the W13 options: mode, keys, divisor and breaks in the .osu', () => {
  const lines = adjustLines(result, unadjusted)
  const base = { title: 'S', artist: 'A', creator: 'x', audioName: 'audio.mp3', lines, result, adjustment: unadjusted }
  const plain = osuFile(base)
  assert.match(plain, /\r\nMode: 0\r\n/)
  assert.match(plain, /\r\nBeatDivisor: 4\r\n/)
  assert.match(plain, /\r\nHPDrainRate:5\r\nCircleSize:4\r\nOverallDifficulty:5\r\nApproachRate:5\r\n/)
  const mania = osuFile({ ...base, mode: 3, keys: 7, beatDivisor: 3, breaks: [{ startMs: 10200, endMs: 15550 }] })
  assert.match(mania, /\r\nMode: 3\r\n/)
  assert.match(mania, /\r\nCircleSize:7\r\n/)
  assert.match(mania, /\r\nBeatDivisor: 3\r\n/)
  assert.match(mania, /\r\n\/\/Break Periods\r\n2,10200,15550\r\n\r\n\[TimingPoints\]/)
  assert.match(osuFile({ ...base, mode: 9, beatDivisor: 5 }), /\r\nMode: 0\r\n[\s\S]*\r\nBeatDivisor: 4\r\n/, 'out of range falls back to the defaults')
})

test('the .osz holds the chosen difficulties and the test map beside the Timing one', async () => {
  const file = new File([new Uint8Array(10)], 'a.ogg')
  const analysis = { filename: 'Band - Song.ogg', result: { ...result, duration_s: 3 } }
  const lines = adjustLines(result, unadjusted)
  const extras = { difficulties: ['Hard', 'Easy', 'Nope'], testSub: 1, mode: 1 }
  const { bytes } = await buildOsz({ file, analysis, lines, adjustment: unadjusted, creator: 'me', extras })
  const all = entries(bytes)
  assert.deepEqual(
    all.map((e) => e.name),
    ['audio.ogg', 'Band - Song (me) [Timing].osu', 'Band - Song (me) [Easy].osu', 'Band - Song (me) [Hard].osu', 'Band - Song (me) [Overtone test (1-1)].osu'],
  )
  const [timing, easy, , testMap] = all.slice(1).map((e) => new TextDecoder().decode(e.data))
  assert.match(easy, /\r\nVersion:Easy\r\nSource:/)
  assert.match(easy, /\r\nHPDrainRate:2\r\nCircleSize:3\r\n/)
  assert.match(easy, /\r\nMode: 1\r\n/)
  assert.equal(timing.slice(timing.indexOf('[TimingPoints]')), easy.slice(easy.indexOf('[TimingPoints]')), 'the same timing, no objects')
  assert.match(testMap, /\r\nVersion:Overtone test \(1\/1\)\r\n/)
  // 400 ms to 3000 ms at 468.75 ms: 400, 868.75, 1337.5, 1806.25, 2275, 2743.75, rounded half to even.
  const objects = testMap.slice(testMap.indexOf('[HitObjects]\r\n') + 14).split('\r\n').filter(Boolean)
  assert.deepEqual(objects.map((row) => Number(row.split(',')[2])), [400, 869, 1338, 1806, 2275, 2744])
  assert.equal(objects[0].split(',')[4], '4', 'the bar starts with a finish')
})
