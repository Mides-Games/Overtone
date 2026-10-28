import assert from 'node:assert/strict'
import { test } from 'node:test'

import { binaryToBytes, bytesToBinary, countHitObjects, parsePoint, patchOsu, patchOsuFile, snapHitObjects } from '../src/lib/osu-patch.js'
import { adjustLines } from '../src/lib/timing.js'

const result = {
  red_lines: [
    { time_ms: 400.127, bpm: 128, beat_length_ms: 468.75, meter: 4, meter_known: true },
    { time_ms: 30400.127, bpm: 142, beat_length_ms: 422.535211267606, meter: 4, meter_known: true },
  ],
  osu_timing: '// Overtone v3\r\n400,468.750000000000,4,1,0,100,1,0\r\n30400,422.535211267606,4,1,0,100,1,0',
}
const lines = adjustLines(result, { factor: 1, nudgeMs: 0 })

/** A small mapped .osu, CRLF, with a red line, greens, kiai and a volume change. */
const map = [
  'osu file format v14',
  '',
  '[General]',
  'AudioFilename: audio.mp3',
  '',
  '[Metadata]',
  'Title:Song',
  'TitleUnicode:Sóng',
  '',
  '[TimingPoints]',
  '398,468.75,4,2,1,70,1,0',
  '398,-100,4,2,1,70,0,0',
  '15398,-50,4,2,1,70,0,1',
  '30398,422.535211267606,4,2,1,70,1,0',
  '45000,-80,4,2,1,60,0,0',
  '',
  '',
  '[Colours]',
  'Combo1 : 255,0,0',
  '',
  '[HitObjects]',
  '256,192,398,1,0,0:0:0:0:',
  '256,192,866,1,0,0:0:0:0:',
  '',
].join('\r\n')

const section = (text) => text.slice(text.indexOf('[TimingPoints]'), text.indexOf('[Colours]'))

test('red lines are replaced, greens kept in place, a red line before a green one at the same time', () => {
  const { text, report } = patchOsu(map, lines)
  assert.equal(
    section(text),
    [
      '[TimingPoints]',
      '398,-100,4,2,1,70,0,0',
      '400,468.750000000000,4,2,1,70,1,0',
      '15398,-50,4,2,1,70,0,1',
      '30398,-100,4,2,1,70,0,0',
      '30400,422.535211267606,4,2,1,70,1,0',
      '45000,-80,4,2,1,60,0,0',
      '',
      '',
      '',
    ].join('\r\n'),
  )
  assert.deepEqual(report, { redRemoved: 2, redAdded: 2, greensKept: 3, greensBefore: 1, carried: 1, hitObjects: 2 })
})

test('every byte outside [TimingPoints] comes out identical, CRLF and accents included', () => {
  const { text } = patchOsu(map, lines)
  const at = map.indexOf('[TimingPoints]')
  assert.equal(text.slice(0, at), map.slice(0, at))
  assert.equal(text.slice(text.indexOf('[Colours]')), map.slice(map.indexOf('[Colours]')))
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/)
})

test('a removed red line that reset the velocity is carried by a green line; one moved a few ms is not', () => {
  // 30398 reset the slider velocity to 1x and turned kiai off after the -50 kiai green at 15398: the new
  // red line lands at 30400, so for 2 ms the green's 0.5x and kiai would run on. The carried green keeps both.
  const { text } = patchOsu(map, lines)
  assert.match(section(text), /\r\n15398,-50,4,2,1,70,0,1\r\n30398,-100,4,2,1,70,0,0\r\n30400,/)
  const plain = patchOsu(map.replace('15398,-50,4,2,1,70,0,1\r\n', ''), lines)
  assert.equal(plain.report.carried, 0)
  assert.doesNotMatch(section(plain.text), /30398/)
})

test('the new red lines take the hitsound state in force where they land, and kiai from it', () => {
  // Without the old red line at 30398, 30400 lands in the kiai green's span: sample set 2, index 1, volume 70, kiai on.
  const { text, report } = patchOsu(map.replace('30398,422.535211267606,4,2,1,70,1,0\r\n', ''), lines)
  assert.match(section(text), /\r\n15398,-50,4,2,1,70,0,1\r\n30400,422\.535211267606,4,2,1,70,1,1\r\n/)
  assert.equal(report.carried, 0)
})

test('a changed volume on a removed red line is carried even with no velocity change', () => {
  const two = map.replace('30398,422.535211267606,4,2,1,70,1,0', '30398,422.535211267606,4,2,1,40,1,0').replace('15398,-50,4,2,1,70,0,1\r\n', '')
  const shifted = adjustLines(result, { factor: 1, nudgeMs: 20 })
  const { text, report } = patchOsu(two, shifted)
  assert.equal(report.carried, 1)
  // The new line at 30420 also reads volume 40 from the old one before it.
  assert.match(section(text), /\r\n30398,-100,4,2,1,40,0,0\r\n30420,422\.535211267606,4,2,1,40,1,0\r\n/)
})

test('LF files stay LF, and a section at the end of the file without a final break keeps none', () => {
  const lf = 'osu file format v14\n\n[TimingPoints]\n0,500,4,1,0,100,1,0\n1000,-100,4,1,0,100,0,0'
  const { text } = patchOsu(lf, lines)
  assert.equal(text, 'osu file format v14\n\n[TimingPoints]\n400,468.750000000000,4,1,0,100,1,0\n1000,-100,4,1,0,100,0,0\n30400,422.535211267606,4,1,0,100,1,0')
})

test('green lines are kept in file order even out of time order', () => {
  const odd = 'osu file format v14\r\n[TimingPoints]\r\n5000,-90,4,1,0,100,0,0\r\n1000,-100,4,1,0,100,0,0\r\n'
  const { text } = patchOsu(odd, lines)
  assert.equal(text.split('\r\n').indexOf('5000,-90,4,1,0,100,0,0') < text.split('\r\n').indexOf('1000,-100,4,1,0,100,0,0'), true)
})

test('comments and an old two-field row are read; the row is a red line', () => {
  assert.equal(parsePoint('// a note'), null)
  assert.equal(parsePoint('   '), null)
  assert.equal(parsePoint('100,500').red, true)
  assert.equal(parsePoint('100,-100').red, false)
  const old = 'osu file format v3\r\n[TimingPoints]\r\n// keep me\r\n100,500\r\n'
  const { text, report } = patchOsu(old, lines)
  assert.equal(report.redRemoved, 1)
  assert.match(text, /\[TimingPoints\]\r\n\/\/ keep me\r\n400,/)
})

test('not an .osu, no [TimingPoints] or no lines: an error, never a guess', () => {
  assert.deepEqual(patchOsu('hello', lines), { error: 'notOsu' })
  assert.deepEqual(patchOsu('osu file format v14\r\n[General]\r\n', lines), { error: 'noTimingPoints' })
  assert.deepEqual(patchOsu(map, []), { error: 'noLines' })
  assert.equal(patchOsu('\xef\xbb\xbfosu file format v14\r\n[TimingPoints]\r\n', lines).report.redAdded, 2)
})

test('bytes that are not UTF-8 survive the round trip', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x80, 0x9f, 0xff, 0x00, 0x41])
  assert.deepEqual(binaryToBytes(bytesToBinary(bytes)), bytes)
})

test('the patched file from a File keeps its name and counts the hit objects', async () => {
  const bytes = binaryToBytes(map.replace('TitleUnicode:Sóng', 'TitleUnicode:S\xc3\xb3ng'))
  const file = { name: 'Band - Song (me) [Hard].osu', size: bytes.length, arrayBuffer: async () => bytes.buffer }
  const out = await patchOsuFile(file, lines)
  assert.equal(out.name, 'Band - Song (me) [Hard].osu')
  assert.equal(out.report.hitObjects, 2)
  const back = bytesToBinary(out.bytes)
  assert.ok(back.includes('TitleUnicode:S\xc3\xb3ng'))
  assert.equal(countHitObjects('osu file format v14\r\n[HitObjects]\r\n'), 0)
})

/** A map whose objects sit a few ms off a 500 ms grid from 1000 ms, LF, with a slider, a spinner and a hold. */
const offGrid = [
  'osu file format v14',
  '',
  '[TimingPoints]',
  '1003,500,4,2,0,80,1,0',
  '',
  '[HitObjects]',
  '256,192,1003,5,4,0:0:0:0:',
  '// a comment row stays',
  '100,100,1253,2,0,B|200:200,1,140,2|0,0:0|0:0,0:0:0:0:',
  '256,192,1500,1,0,0:0:0:0:',
  '256,192,2004,12,0,3497,0:0:0:0:',
  '64,192,4128,128,0,4870:0:0:0:0:',
  '',
].join('\n')
const grid = [{ timeMs: 1000, beatMs: 500, meter: 4 }]

test('snapping moves each object to the nearest tick and touches only its times', () => {
  const { text, report } = patchOsu(offGrid, grid, { snap: 4 })
  const objects = text.slice(text.indexOf('[HitObjects]'))
  assert.equal(
    objects,
    [
      '[HitObjects]',
      '256,192,1000,5,4,0:0:0:0:',
      '// a comment row stays',
      '100,100,1250,2,0,B|200:200,1,140,2|0,0:0|0:0,0:0:0:0:',
      '256,192,1500,1,0,0:0:0:0:',
      '256,192,2000,12,0,3500,0:0:0:0:',
      '64,192,4125,128,0,4875:0:0:0:0:',
      '',
    ].join('\n'),
  )
  // 1003 -> 1000 (3), 1253 -> 1250 (3), 2004/3497 -> 2000/3500 (4), 4128/4870 -> 4125/4875 (5); 1500 stays.
  assert.deepEqual(report.snap, { divisor: 4, total: 5, moved: 4, maxMs: 5, medianMs: 3.5, shared: 0 })
  assert.equal(report.hitObjects, 5)
  // Everything before [HitObjects] is what the timing patch alone gives, and without a snap no object moves.
  const alone = patchOsu(offGrid, grid).text
  assert.equal(text.slice(0, text.indexOf('[HitObjects]')), alone.slice(0, alone.indexOf('[HitObjects]')))
  assert.equal(alone.slice(alone.indexOf('[HitObjects]')), offGrid.slice(offGrid.indexOf('[HitObjects]')))
})

test('a coarse snap counts the objects it lands on one tick, and keeps an end after its start', () => {
  const { report } = patchOsu(offGrid, grid, { snap: 1 })
  // At 1/1, 1253 goes to 1500, where the next circle already was.
  assert.equal(report.snap.shared, 1)
  const spun = snapHitObjects('[HitObjects]\r\n0,0,1010,8,0,1150,0:0:0:0:\r\n', [{ time: 1000, beatLength: 500 }], 1)
  assert.equal(spun.text, '[HitObjects]\r\n0,0,1000,8,0,1140,0:0:0:0:\r\n', 'its end would snap onto its start: it keeps its length')
  assert.equal(snapHitObjects('osu file format v14\n', [{ time: 0, beatLength: 500 }], 4).report.total, 0)
})

test('a divisor osu! does not offer is no snap at all', () => {
  assert.equal(patchOsu(offGrid, grid, { snap: 5 }).report.snap, undefined)
})
