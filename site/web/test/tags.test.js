import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readCover, readTags, sniffImage } from '../src/lib/tags.js'

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

// Covers (W12.9). The "images" are their magic bytes and a counter: the reader
// only sniffs the kind, it never decodes a picture.

const fakeJpeg = (n = 40, seed = 1) => concat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), new Uint8Array(n).map((_, i) => (i * seed + 7) & 0xff))
const fakePng = (n = 40) => concat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), new Uint8Array(n).fill(0x42))
const fakeGif = () => concat(latin1('GIF89a'), new Uint8Array(30))
const be32 = (n) => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}
const le32 = (n) => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, true)
  return out
}
const syncsafe = (n) => new Uint8Array([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])

/** An ID3v2 tag of raw frames, `flags` in its header. */
const id3 = (version, frames, flags = 0) => concat(new Uint8Array([0x49, 0x44, 0x33, version, 0, flags]), syncsafe(frames.length), frames)
const frame = (version, id, body, format = 0) =>
  concat(latin1(id), version === 4 ? syncsafe(body.length) : be32(body.length), new Uint8Array([0, format]), body)
/** APIC: encoding 0 (Latin-1) or 1 (UTF-16 with a BOM). */
const apicBody = (type, image, { encoding = 0, description = '' } = {}) => {
  const desc =
    encoding === 1
      ? concat(new Uint8Array([0xff, 0xfe]), Uint8Array.from([...description].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])), new Uint8Array(2))
      : concat(latin1(description), new Uint8Array(1))
  return concat(new Uint8Array([encoding]), latin1('image/jpeg'), new Uint8Array([0, type]), desc, image)
}
/** ID3 unsynchronisation, the simple way: a zero after every FF. */
const unsync = (bytes) => Uint8Array.from([...bytes].flatMap((b) => (b === 0xff ? [0xff, 0] : [b])))

/** The FLAC picture structure, as a PICTURE block and as Ogg's base64 comment both carry it. */
const flacPictureBytes = (type, image) =>
  concat(be32(type), be32(10), latin1('image/jpeg'), be32(4), latin1('desc'), new Uint8Array(16), be32(image.length), image)

test('an MP3 cover is the front cover of its APIC frames', async () => {
  const front = fakeJpeg(60, 3)
  const tag = id3(3, concat(frame(3, 'TIT2', concat(new Uint8Array(1), latin1('x'))), frame(3, 'APIC', apicBody(0, fakePng())), frame(3, 'APIC', apicBody(3, front, { description: 'front' }))))
  const cover = await readCover(file(concat(tag, new Uint8Array(500))))
  assert.equal(cover.ext, 'jpg')
  assert.equal(cover.mime, 'image/jpeg')
  assert.deepEqual(cover.bytes, front)
})

test('an ID3v2.4 cover with a UTF-16 description and a data length indicator is read', async () => {
  const image = fakePng(30)
  // "A" in UTF-16LE is 41 00: the reader must not take its zero for the end.
  const body = apicBody(3, image, { encoding: 1, description: 'A€' })
  const tag = id3(4, frame(4, 'APIC', concat(syncsafe(body.length), body), 0x01))
  const cover = await readCover(file(tag))
  assert.equal(cover.ext, 'png')
  assert.deepEqual(cover.bytes, image)
})

test('an unsynchronised ID3 tag gives its cover back as it was', async () => {
  const image = fakeJpeg(50, 5) // FF D8 FF E0: every FF gains a zero when unsynchronised
  const v3 = id3(3, unsync(frame(3, 'APIC', apicBody(3, image))), 0x80)
  assert.deepEqual((await readCover(file(v3))).bytes, image)
  const v4 = id3(4, frame(4, 'APIC', unsync(apicBody(3, image)), 0x02))
  assert.deepEqual((await readCover(file(v4))).bytes, image)
})

test('an M4A cover is the first picture in covr, past an mdat', async () => {
  const image = fakePng(70)
  const covr = box('covr', box('data', be32(14), new Uint8Array(4), image), box('data', be32(13), new Uint8Array(4), fakeJpeg()))
  const bytes = concat(ftyp, mdat(300 * 1024), moov(item('©nam', 'Cover'), covr))
  const cover = await readCover(file(bytes))
  assert.equal(cover.ext, 'png')
  assert.deepEqual(cover.bytes, image)
})

test('a FLAC cover is its PICTURE block, after the stream info', async () => {
  const image = fakeJpeg(80, 9)
  const block = (type, body, last = false) => concat(new Uint8Array([(last ? 0x80 : 0) | type, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff]), body)
  const picture = flacPictureBytes(3, image)
  const bytes = concat(latin1('fLaC'), block(0, new Uint8Array(34)), block(1, new Uint8Array(100)), block(6, picture, true), new Uint8Array(200))
  const cover = await readCover(file(bytes))
  assert.equal(cover.ext, 'jpg')
  assert.deepEqual(cover.bytes, image)
})

/** Ogg pages: each packet's bytes split in 255-byte segments; `cut` ends a page early, mid-packet. */
function ogg(packets, { cut = Infinity, serial = 7 } = {}) {
  const pages = []
  let sequence = 0
  const page = (lacing, body) =>
    concat(latin1('OggS'), new Uint8Array([0, 0]), new Uint8Array(8), le32(serial), le32(sequence++), new Uint8Array(4), new Uint8Array([lacing.length]), Uint8Array.from(lacing), body)
  for (const packet of packets) {
    let lacing = []
    let start = 0
    let at = 0
    for (let left = packet.length; ; left -= 255) {
      lacing.push(Math.min(255, left))
      at += Math.min(255, left)
      if (left < 255) break
      if (lacing.length === cut || lacing.length === 255) {
        pages.push(page(lacing, packet.subarray(start, at)))
        lacing = []
        start = at
      }
    }
    pages.push(page(lacing, packet.subarray(start, at)))
  }
  return concat(...pages)
}
const comments = (prefix, list) =>
  concat(prefix, le32(6), latin1('vendor'), le32(list.length), ...list.map((c) => concat(le32(c.length), c)))
const pictureComment = (key, image, type = 3) => latin1(`${key}=${Buffer.from(flacPictureBytes(type, image)).toString('base64')}`)

test('an Opus cover is its base64 METADATA_BLOCK_PICTURE, across pages', async () => {
  const image = fakeJpeg(900, 11)
  const tags = comments(latin1('OpusTags'), [utf8('TITLE=Opus'), pictureComment('METADATA_BLOCK_PICTURE', image)])
  const head = concat(latin1('OpusHead'), new Uint8Array(11))
  const bytes = ogg([head, tags, new Uint8Array(300)], { cut: 2 })
  assert.ok(tags.length > 3 * 255, 'the comment packet spans pages')
  const cover = await readCover(file(bytes))
  assert.equal(cover.ext, 'jpg')
  assert.deepEqual(cover.bytes, image)
})

test('an Ogg Vorbis cover is read, the key in any case, the front cover first', async () => {
  const image = fakePng(200)
  const tags = comments(concat(new Uint8Array([3]), latin1('vorbis')), [
    pictureComment('metadata_block_picture', fakeJpeg(), 4),
    pictureComment('Metadata_Block_Picture', image, 3),
  ])
  const bytes = ogg([concat(new Uint8Array([1]), latin1('vorbis'), new Uint8Array(23)), tags])
  assert.deepEqual((await readCover(file(bytes))).bytes, image)
})

test('no cover, a cover osu! cannot show, or garbage is null', async () => {
  assert.equal(await readCover(file(concat(id3Tag('T', 'A'), new Uint8Array(100)))), null)
  assert.equal(await readCover(file(id3(3, frame(3, 'APIC', apicBody(3, fakeGif()))))), null)
  assert.equal(await readCover(file(wave(fmt, data(100)))), null)
  assert.equal(await readCover(file(concat(ftyp, moov(item('©nam', 'x'))))), null)
  assert.equal(await readCover(file(latin1('fLaC'))), null)
  // A picture block that claims more bytes than it has, a cut Ogg page, bad base64.
  const short = concat(latin1('fLaC'), new Uint8Array([0x86, 0, 1, 0]), flacPictureBytes(3, fakeJpeg()).subarray(0, 50))
  assert.equal(await readCover(file(short)), null)
  const tags = comments(latin1('OpusTags'), [latin1('METADATA_BLOCK_PICTURE=***not base64***')])
  assert.equal(await readCover(file(ogg([latin1('OpusHead'), tags]))), null)
  assert.equal(await readCover(file(ogg([latin1('OpusHead'), tags]).subarray(0, 60))), null)
  assert.equal(await readCover(file(new Uint8Array(0))), null)
})

test('sniffImage tells JPEG and PNG apart and refuses the rest', () => {
  assert.deepEqual(sniffImage(fakeJpeg()), { ext: 'jpg', mime: 'image/jpeg' })
  assert.deepEqual(sniffImage(fakePng()), { ext: 'png', mime: 'image/png' })
  assert.equal(sniffImage(fakeGif()), null)
  assert.equal(sniffImage(new Uint8Array(3)), null)
})
