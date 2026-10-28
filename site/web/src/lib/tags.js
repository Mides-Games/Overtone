/**
 * The title and artist an audio file names itself by, read in the browser so
 * the public queue can show "Artist - Title" (W3.8) without the server
 * parsing anything. Read: ID3v2 for MP3, Vorbis comments for OGG, Opus and
 * FLAC (both from the head of the file), the `©nam`/`©ART` atoms of MP4/M4A
 * and the `LIST/INFO` (or `id3 `) chunk of WAV (both found by walking the
 * file's boxes or chunks, since they often sit after the audio). Anything
 * else, or a tag this does not understand, is `{ title: null, artist: null }`,
 * and the queue falls back to the file name. Never throws.
 */
const HEAD_BYTES = 256 * 1024
// A `moov` or a tag chunk bigger than this is skipped rather than read whole.
const MOOV_MAX = 8 * 1024 * 1024
const CHUNK_MAX = 1024 * 1024
// A garbage file of tiny boxes must not turn into thousands of reads.
const MAX_STEPS = 512

export async function readTags(file) {
  const none = { title: null, artist: null }
  try {
    const bytes = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer())
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return id3(bytes) ?? none
    if (ascii(bytes, 4, 8) === 'ftyp') return (await mp4(file)) ?? none
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return (await wav(file)) ?? none
    return vorbis(bytes) ?? none
  } catch {
    return none
  }
}

const ascii = (bytes, start, end) => String.fromCharCode(...bytes.subarray(start, end))
const read = async (file, start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer())
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const clean = (value) => {
  const text = (value ?? '').replace(/\u0000+$/g, '').replace(/[\u0000-\u001f]/g, '').trim()
  return text ? text.slice(0, 200) : null
}

/** ID3v2.3 and v2.4: the TIT2 and TPE1 text frames. */
function id3(bytes) {
  const version = bytes[3]
  if (version !== 3 && version !== 4) return null
  const syncsafe = (i) => (bytes[i] << 21) | (bytes[i + 1] << 14) | (bytes[i + 2] << 7) | bytes[i + 3]
  const end = Math.min(bytes.length, 10 + syncsafe(6))
  const found = {}
  let i = 10
  while (i + 10 <= end) {
    const id = String.fromCharCode(...bytes.subarray(i, i + 4))
    if (!/^[A-Z0-9]{4}$/.test(id)) break
    const size =
      version === 4 ? syncsafe(i + 4) : ((bytes[i + 4] << 24) | (bytes[i + 5] << 16) | (bytes[i + 6] << 8) | bytes[i + 7]) >>> 0
    const body = bytes.subarray(i + 10, Math.min(end, i + 10 + size))
    if (id === 'TIT2' || id === 'TPE1') found[id] = clean(text(body))
    i += 10 + size
  }
  return { title: found.TIT2 ?? null, artist: found.TPE1 ?? null }
}

function text(body) {
  if (!body.length) return ''
  const encoding = body[0]
  const data = body.subarray(1)
  if (encoding === 1) return new TextDecoder('utf-16').decode(data)
  if (encoding === 2) return new TextDecoder('utf-16be').decode(data)
  if (encoding === 3) return new TextDecoder('utf-8').decode(data)
  return new TextDecoder('latin1').decode(data)
}

/**
 * Vorbis comments: each is a little-endian length and `KEY=value` in UTF-8.
 * Found by looking for the key, which works the same in an Ogg page and a
 * FLAC metadata block, and checked against the length before it.
 */
function vorbis(bytes) {
  const decoder = new TextDecoder('utf-8')
  const field = (key) => {
    const needle = new TextEncoder().encode(`${key}=`)
    outer: for (let i = 4; i + needle.length <= bytes.length; i++) {
      for (let k = 0; k < needle.length; k++) {
        const b = bytes[i + k]
        // Keys are ASCII and case-insensitive.
        if ((b | 0x20) !== (needle[k] | 0x20) && b !== needle[k]) continue outer
      }
      const length = (bytes[i - 4] | (bytes[i - 3] << 8) | (bytes[i - 2] << 16) | (bytes[i - 1] << 24)) >>> 0
      if (length <= needle.length || length > 4096 || i + length > bytes.length) continue
      return clean(decoder.decode(bytes.subarray(i + needle.length, i + length)))
    }
    return null
  }
  const title = field('TITLE')
  const artist = field('ARTIST')
  return title || artist ? { title, artist } : null
}

/**
 * MP4/M4A: `moov > udta > meta > ilst > ©nam | ©ART > data`. The top-level
 * boxes are walked by their headers alone, because an encoder that writes
 * `moov` last puts it behind the whole `mdat`, far past the head.
 */
async function mp4(file) {
  const found = await moov(file, MOOV_MAX)
  return found && ilst(found)
}

/** The body of the top-level `moov` box, or null past `max` bytes or when there is none. */
async function moov(file, max) {
  let offset = 0
  for (let step = 0; step < MAX_STEPS && offset + 8 <= file.size; step++) {
    const head = await read(file, offset, offset + 16)
    const box = header(head, 0, file.size - offset)
    if (!box) return null
    if (box.type === 'moov') {
      if (box.size > max) return null
      return read(file, offset + box.header, offset + box.size)
    }
    offset += box.size
  }
  return null
}

/** A box header: 32-bit size, or 1 for a 64-bit size after the type, or 0 for "to the end". */
function header(bytes, i, room) {
  if (i + 8 > bytes.length) return null
  let size = view(bytes).getUint32(i)
  let length = 8
  if (size === 1) {
    if (i + 16 > bytes.length) return null
    size = Number(view(bytes).getBigUint64(i + 8))
    length = 16
  } else if (size === 0) {
    size = room
  }
  if (size < length) return null
  return { type: ascii(bytes, i + 4, i + 8), size, header: length }
}

function child(bytes, type) {
  let i = 0
  while (i + 8 <= bytes.length) {
    const box = header(bytes, i, bytes.length - i)
    if (!box || i + box.size > bytes.length) return null
    if (box.type === type) return bytes.subarray(i + box.header, i + box.size)
    i += box.size
  }
  return null
}

/** `moov > udta > meta > ilst`, or null. */
function itemList(moovBody) {
  const udta = child(moovBody, 'udta')
  const meta = udta && child(udta, 'meta')
  if (!meta || meta.length < 4) return null
  // `meta` is a full box (4 bytes of version and flags) in ISO files, a plain one in old QuickTime.
  return child(meta.subarray(4), 'ilst') ?? child(meta, 'ilst')
}

function ilst(moovBody) {
  const list = itemList(moovBody)
  if (!list) return null
  const value = (type) => {
    const item = child(list, type)
    const data = item && child(item, 'data')
    if (!data || data.length < 8) return null
    // 4 bytes of type (1 is UTF-8, 2 UTF-16) and 4 of locale, then the value.
    const kind = view(data).getUint32(0) & 0xffffff
    return clean(new TextDecoder(kind === 2 ? 'utf-16be' : 'utf-8').decode(data.subarray(8)))
  }
  const title = value('©nam')
  const artist = value('©ART')
  return title || artist ? { title, artist } : null
}

/**
 * WAV: a `LIST` chunk of type `INFO` (`INAM` title, `IART` artist) or an
 * `id3 ` chunk holding an ID3v2 tag. The chunks are walked by their headers,
 * because tagging tools usually append them after `data`.
 */
async function wav(file) {
  const found = { title: null, artist: null }
  let offset = 12
  for (let step = 0; step < MAX_STEPS && offset + 8 <= file.size; step++) {
    const head = await read(file, offset, offset + 8)
    const id = ascii(head, 0, 4)
    const size = view(head).getUint32(4, true)
    const body = offset + 8
    if ((id === 'LIST' || id === 'id3 ' || id === 'ID3 ') && size <= CHUNK_MAX) {
      const bytes = await read(file, body, body + size)
      let tags = null
      if (id === 'LIST' && ascii(bytes, 0, 4) === 'INFO') tags = info(bytes.subarray(4))
      else if (id !== 'LIST' && ascii(bytes, 0, 3) === 'ID3') tags = id3(bytes)
      found.title ??= tags?.title ?? null
      found.artist ??= tags?.artist ?? null
    }
    // Chunks are padded to an even length.
    offset = body + size + (size & 1)
  }
  return found.title || found.artist ? found : null
}

function info(bytes) {
  const found = {}
  let i = 0
  while (i + 8 <= bytes.length) {
    const id = ascii(bytes, i, i + 4)
    const size = view(bytes).getUint32(i + 4, true)
    const body = bytes.subarray(i + 8, Math.min(bytes.length, i + 8 + size))
    if (id === 'INAM' || id === 'IART') found[id] = clean(riffText(body))
    i += 8 + size + (size & 1)
  }
  return { title: found.INAM ?? null, artist: found.IART ?? null }
}

/** INFO strings have no declared encoding: UTF-8 when they are valid UTF-8, else Latin-1. */
function riffText(body) {
  const end = body.indexOf(0)
  const data = end < 0 ? body : body.subarray(0, end)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return new TextDecoder('latin1').decode(data)
  }
}

/*
 * The cover (W12.9): the picture the file carries in its own tags, for the
 * .osz's background. Read: ID3v2.3/2.4 `APIC` (MP3), the MP4 `covr` atom
 * (M4A), FLAC's `PICTURE` metadata block and the base64
 * `METADATA_BLOCK_PICTURE` comment of Ogg Vorbis and Opus. The front cover
 * (picture type 3) wins over any other picture. Only JPEG and PNG are kept,
 * told apart by their own first bytes rather than the declared MIME type:
 * those are what osu! shows as a background. Read in the browser, never sent.
 */
// A cover is rarely over a megabyte; a tag this big is skipped, not read.
const COVER_MAX = 16 * 1024 * 1024
// Base64 is a third longer than the picture it holds.
const OGG_MAX = Math.ceil((COVER_MAX * 4) / 3) + 64 * 1024
const FRONT_COVER = 3

/**
 * `{ ext: 'jpg' | 'png', mime, bytes }` of the file's cover, or null when it
 * has none this reads, or when it is not a JPEG or a PNG. Never throws.
 */
export async function readCover(file) {
  try {
    const head = await read(file, 0, 12)
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return await id3Cover(file)
    if (ascii(head, 4, 8) === 'ftyp') return await mp4Cover(file)
    if (ascii(head, 0, 4) === 'fLaC') return await flacCover(file)
    if (ascii(head, 0, 4) === 'OggS') return await oggCover(file)
    return null
  } catch {
    return null
  }
}

/** The image's own kind from its magic bytes: JPEG and PNG only. */
export function sniffImage(bytes) {
  if (!bytes || bytes.length < 8) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (png.every((b, i) => bytes[i] === b)) return { ext: 'png', mime: 'image/png' }
  return null
}

/** Of `{ type, data }` pictures, the front cover, else the first; as a cover, or null. */
function pick(pictures) {
  const usable = pictures.filter((p) => sniffImage(p.data))
  const best = usable.find((p) => p.type === FRONT_COVER) ?? usable[0]
  if (!best) return null
  // A copy: a view would keep the whole tag's buffer alive.
  return { ...sniffImage(best.data), bytes: best.data.slice() }
}

/** ID3's unsynchronisation undone: every `FF 00` back to `FF`. */
function resync(bytes) {
  const out = new Uint8Array(bytes.length)
  let n = 0
  for (let i = 0; i < bytes.length; i++) {
    out[n++] = bytes[i]
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++
  }
  return out.subarray(0, n)
}

/** ID3v2.3 and v2.4 `APIC` frames, read from the whole tag (the head may not hold it). */
async function id3Cover(file) {
  const head = await read(file, 0, 10)
  const version = head[3]
  if (version !== 3 && version !== 4) return null
  const syncsafe = (b, i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3]
  const size = syncsafe(head, 6)
  if (size > COVER_MAX) return null
  const flags = head[5]
  let body = await read(file, 10, 10 + size)
  // v2.3 unsynchronises the whole tag; v2.4 marks each frame.
  if (version === 3 && flags & 0x80) body = resync(body)
  let i = 0
  if (flags & 0x40) i = version === 4 ? syncsafe(body, 0) : 4 + view(body).getUint32(0)
  const pictures = []
  for (let step = 0; step < MAX_STEPS * 4 && i + 10 <= body.length; step++) {
    const id = ascii(body, i, i + 4)
    if (!/^[A-Z0-9]{4}$/.test(id)) break
    const frameSize = version === 4 ? syncsafe(body, i + 4) : view(body).getUint32(i + 4)
    const format = body[i + 9]
    let data = body.subarray(i + 10, Math.min(body.length, i + 10 + frameSize))
    i += 10 + frameSize
    if (id !== 'APIC') continue
    // Compressed or encrypted frames are left alone (v2.3: 0x80 and 0x40; v2.4: 0x08 and 0x04).
    if (version === 3 ? format & 0xc0 : format & 0x0c) continue
    if (version === 4) {
      if (format & 0x01) data = data.subarray(4) // a data length indicator
      if (format & 0x02 || flags & 0x80) data = resync(data)
    }
    const picture = apic(data)
    if (picture) pictures.push(picture)
  }
  return pick(pictures)
}

/** APIC: encoding, MIME (Latin-1, NUL-ended), picture type, description (NUL-ended in its encoding), image. */
function apic(data) {
  const wide = data[0] === 1 || data[0] === 2
  let i = data.indexOf(0, 1)
  if (i < 0) return null
  const type = data[i + 1]
  i += 2
  const start = i
  if (wide) {
    // A UTF-16 NUL is two zero bytes on a character boundary.
    while (i + 1 < data.length && !(data[i] === 0 && data[i + 1] === 0 && (i - start) % 2 === 0)) i++
    i += 2
  } else {
    while (i < data.length && data[i] !== 0) i++
    i += 1
  }
  return i < data.length ? { type, data: data.subarray(i) } : null
}

/** MP4 `moov > udta > meta > ilst > covr > data`: 4 bytes of type, 4 of locale, then the image. */
async function mp4Cover(file) {
  const found = await moov(file, COVER_MAX)
  const list = found && itemList(found)
  const covr = list && child(list, 'covr')
  if (!covr) return null
  const pictures = []
  let i = 0
  while (i + 8 <= covr.length && pictures.length < 8) {
    const box = header(covr, i, covr.length - i)
    if (!box || i + box.size > covr.length) break
    // MP4 has no picture types: every covr picture is a front cover, the first one wins.
    if (box.type === 'data' && box.size >= box.header + 8) {
      pictures.push({ type: FRONT_COVER, data: covr.subarray(i + box.header + 8, i + box.size) })
    }
    i += box.size
  }
  return pick(pictures)
}

/** FLAC's metadata blocks, walked by their headers; type 6 is a picture. */
async function flacCover(file) {
  const pictures = []
  let offset = 4
  for (let step = 0; step < MAX_STEPS && offset + 4 <= file.size; step++) {
    const head = await read(file, offset, offset + 4)
    const last = head[0] & 0x80
    const type = head[0] & 0x7f
    const length = (head[1] << 16) | (head[2] << 8) | head[3]
    if (type === 6 && length <= COVER_MAX) {
      const picture = flacPicture(await read(file, offset + 4, offset + 4 + length))
      if (picture) pictures.push(picture)
    }
    if (last || type === 127) break
    offset += 4 + length
  }
  return pick(pictures)
}

/** The FLAC picture structure (also the base64 payload of Ogg's METADATA_BLOCK_PICTURE), big-endian. */
function flacPicture(bytes) {
  if (bytes.length < 32) return null
  const v = view(bytes)
  const type = v.getUint32(0)
  let i = 4
  i += 4 + v.getUint32(i) // MIME
  if (i + 4 > bytes.length) return null
  i += 4 + v.getUint32(i) // description
  i += 16 // width, height, depth, colours
  if (i + 4 > bytes.length) return null
  const length = v.getUint32(i)
  i += 4
  if (i + length > bytes.length) return null
  return { type, data: bytes.subarray(i, i + length) }
}

/**
 * Ogg Vorbis and Opus: the second packet of the first stream holds the
 * comments (`\x03vorbis` or `OpusTags`), and a picture is the comment
 * `METADATA_BLOCK_PICTURE=<base64>`. A packet with a cover spans many pages,
 * so it is put back together from the pages' segments first.
 */
async function oggCover(file) {
  const packet = await oggPacket(file, 1)
  if (!packet) return null
  let i
  if (packet[0] === 3 && ascii(packet, 1, 7) === 'vorbis') i = 7
  else if (ascii(packet, 0, 8) === 'OpusTags') i = 8
  else return null
  return pick(commentPictures(packet, i))
}

/** Pictures from a Vorbis comment list at `i`: vendor, count, then `KEY=value` strings, little-endian lengths. */
function commentPictures(packet, i) {
  const v = view(packet)
  if (i + 4 > packet.length) return []
  i += 4 + v.getUint32(i, true)
  if (i + 4 > packet.length) return []
  const count = v.getUint32(i, true)
  i += 4
  const key = 'METADATA_BLOCK_PICTURE='
  const pictures = []
  for (let k = 0; k < count && i + 4 <= packet.length; k++) {
    const length = v.getUint32(i, true)
    const start = i + 4
    i = start + length
    if (i > packet.length) break
    if (length <= key.length || ascii(packet, start, start + key.length).toUpperCase() !== key) continue
    try {
      const text = new TextDecoder('latin1').decode(packet.subarray(start + key.length, i))
      const binary = atob(text.replace(/\s+/g, ''))
      const picture = flacPicture(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
      if (picture) pictures.push(picture)
    } catch {
      // Not base64: the next comment may still be a picture.
    }
  }
  return pictures
}

/** Packet `index` (from 0) of the file's first logical stream, or null past OGG_MAX bytes. */
async function oggPacket(file, index) {
  let offset = 0
  let serial = null
  let packet = 0
  const parts = []
  let size = 0
  for (let step = 0; step < MAX_STEPS * 4 && offset + 27 <= file.size; step++) {
    const head = await read(file, offset, offset + 27)
    if (ascii(head, 0, 4) !== 'OggS') return null
    const segments = head[26]
    const table = await read(file, offset + 27, offset + 27 + segments)
    const pageSerial = view(head).getUint32(14, true)
    serial ??= pageSerial
    const start = offset + 27 + segments
    offset = start + table.reduce((n, s) => n + s, 0)
    if (pageSerial !== serial) continue
    const body = await read(file, start, offset)
    let at = 0
    for (const lacing of table) {
      if (packet === index) {
        parts.push(body.subarray(at, at + lacing))
        size += lacing
        if (size > OGG_MAX) return null
      }
      at += lacing
      // A lacing value under 255 ends the packet.
      if (lacing < 255 && packet++ === index) {
        const out = new Uint8Array(size)
        let n = 0
        for (const part of parts) {
          out.set(part, n)
          n += part.length
        }
        return out
      }
    }
  }
  return null
}
