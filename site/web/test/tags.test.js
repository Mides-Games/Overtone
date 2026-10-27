import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readTags } from '../src/lib/tags.js'

// Every fixture is built here, a few bytes long: no song from anyone's library.

const utf8 = (text) => new TextEncoder().encode(text)
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const part of parts) {
    out.set(part, i)
    i += part.length
  }
  return out
}
const latin1 = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0))

// MP4: big-endian 32-bit size, then the type.
const box = (type, ...children) => {
  const body = concat(...children)
  const head = new Uint8Array(8)
  new DataView(head.buffer).setUint32(0, 8 + body.length)
  head.set(latin1(type), 4)
  return concat(head, body)
}
const fullBox = (type, ...children) => box(type, new Uint8Array(4), ...children)
const item = (type, value) => {
  const flags = new Uint8Array(8)
  new DataView(flags.buffer).setUint32(0, 1)
  return box(type, box('data', flags, utf8(value)))
}
const ftyp = box('ftyp', latin1('M4A '), new Uint8Array(4), latin1('M4A isom'))
const moov = (...items) =>
  box('moov', box('mvhd', new Uint8Array(100)), box('udta', fullBox('meta', box('hdlr', new Uint8Array(25)), box('ilst', ...items))))
const mdat = (size) => box('mdat', new Uint8Array(size))

// RIFF: little-endian 32-bit size, padded to even.
const chunk = (id, ...parts) => {
  const body = concat(...parts)
  const head = new Uint8Array(8)
  head.set(latin1(id))
  new DataView(head.buffer).setUint32(4, body.length, true)
  return concat(head, body, new Uint8Array(body.length & 1))
}
const wave = (...chunks) => chunk('RIFF', latin1('WAVE'), ...chunks)
const fmt = chunk('fmt ', new Uint8Array(16))
const data = (size) => chunk('data', new Uint8Array(size))
const infoList = (title, artist) =>
  chunk('LIST', latin1('INFO'), chunk('INAM', title, new Uint8Array(1)), chunk('IART', artist, new Uint8Array(1)))

// ID3v2.3 with TIT2 and TPE1, ISO-8859-1.
const id3Tag = (title, artist) => {
  const frame = (id, value) => {
    const body = concat(new Uint8Array([0]), latin1(value))
    const head = new Uint8Array(10)
    head.set(latin1(id))
    new DataView(head.buffer).setUint32(4, body.length)
    return concat(head, body)
  }
  const frames = concat(frame('TIT2', title), frame('TPE1', artist))
  const n = frames.length
  const head = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
  return concat(head, frames)
}

const file = (bytes) => new Blob([bytes])
const none = { title: null, artist: null }

test('an M4A with moov before mdat names its title and artist', async () => {
  const bytes = concat(ftyp, moov(item('©nam', 'Night Drive'), item('©ART', 'Kana')), mdat(1024))
  assert.deepEqual(await readTags(file(bytes)), { title: 'Night Drive', artist: 'Kana' })
})

test('an M4A with moov after an mdat past the head is still read', async () => {
  const bytes = concat(ftyp, mdat(300 * 1024), moov(item('©ART', 'Kana'), item('©nam', 'Tōkyō')))
  assert.deepEqual(await readTags(file(bytes)), { title: 'Tōkyō', artist: 'Kana' })
})

test('an M4A with a 64-bit mdat size is walked past', async () => {
  const head = new Uint8Array(16)
  const view = new DataView(head.buffer)
  view.setUint32(0, 1)
  head.set(latin1('mdat'), 4)
  view.setBigUint64(8, 16n + 64n)
  const bytes = concat(ftyp, head, new Uint8Array(64), moov(item('©nam', 'Wide')))
  assert.deepEqual(await readTags(file(bytes)), { title: 'Wide', artist: null })
})

test('an untagged M4A is nothing', async () => {
  const bytes = concat(ftyp, box('moov', box('mvhd', new Uint8Array(100))), mdat(64))
  assert.deepEqual(await readTags(file(bytes)), none)
})

test('a WAV with LIST/INFO before data names its title and artist', async () => {
  const bytes = wave(fmt, infoList(latin1('Rain'), latin1('Mori')), data(1000))
  assert.deepEqual(await readTags(file(bytes)), { title: 'Rain', artist: 'Mori' })
})

test('a WAV with LIST/INFO after a long data chunk is still read', async () => {
  const bytes = wave(fmt, data(300 * 1024 + 1), infoList(latin1('Late'), latin1('Odd')))
  assert.deepEqual(await readTags(file(bytes)), { title: 'Late', artist: 'Odd' })
})

test('a WAV INFO string in UTF-8 keeps its accents', async () => {
  const bytes = wave(fmt, data(10), infoList(utf8('Canción de cuna'), utf8('Ñandú')))
  assert.deepEqual(await readTags(file(bytes)), { title: 'Canción de cuna', artist: 'Ñandú' })
})

test('a WAV INFO string that is not UTF-8 is read as Latin-1', async () => {
  const bytes = wave(fmt, data(10), infoList(latin1('Canción'), latin1('Björk')))
  assert.deepEqual(await readTags(file(bytes)), { title: 'Canción', artist: 'Björk' })
})

test('a WAV with an id3 chunk is read through the ID3 parser', async () => {
  const bytes = wave(fmt, data(10), chunk('id3 ', id3Tag('Echo', 'Vale')))
  assert.deepEqual(await readTags(file(bytes)), { title: 'Echo', artist: 'Vale' })
})

test('an untagged WAV is nothing', async () => {
  assert.deepEqual(await readTags(file(wave(fmt, data(100)))), none)
})

test('garbage sizes end cleanly instead of throwing', async () => {
  const short = new Uint8Array(8)
  new DataView(short.buffer).setUint32(0, 3)
  short.set(latin1('junk'), 4)
  assert.deepEqual(await readTags(file(concat(ftyp, short))), none)
  const huge = new Uint8Array(8)
  new DataView(huge.buffer).setUint32(0, 0xfffffff0)
  huge.set(latin1('moov'), 4)
  assert.deepEqual(await readTags(file(concat(ftyp, huge))), none)
  const broken = concat(ftyp, moov(item('©nam', 'Cut'))).subarray(0, ftyp.length + 40)
  assert.deepEqual(await readTags(file(broken)), none)
  const wav = wave(fmt, chunk('LIST', latin1('INFO'), chunk('INAM', latin1('Half'))))
  new DataView(wav.buffer).setUint32(wav.length - 8, 0xffff, true)
  // A string cut by the end of the file is read as far as it goes.
  assert.deepEqual(await readTags(file(wav.subarray(0, wav.length - 2))), { title: 'Ha', artist: null })
  assert.deepEqual(await readTags(file(latin1('RIFF\u0000\u0000\u0000\u0000WAVE'))), none)
})

test('an MP3 with ID3v2 still names its title and artist', async () => {
  const bytes = concat(id3Tag('Old Path', 'Mp3'), new Uint8Array(100))
  assert.deepEqual(await readTags(file(bytes)), { title: 'Old Path', artist: 'Mp3' })
})

test('Vorbis comments still name the title and artist', async () => {
  const comment = (text) => {
    const body = utf8(text)
    const head = new Uint8Array(4)
    new DataView(head.buffer).setUint32(0, body.length, true)
    return concat(head, body)
  }
  const bytes = concat(latin1('fLaC'), new Uint8Array(40), comment('TITLE=Flac Song'), comment('ARTIST=Lossless'))
  assert.deepEqual(await readTags(file(bytes)), { title: 'Flac Song', artist: 'Lossless' })
})
