import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildOsz, osuFile, songNames } from '../src/lib/osz.js'
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
