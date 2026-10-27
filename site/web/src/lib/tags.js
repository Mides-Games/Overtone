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
  let offset = 0
  for (let step = 0; step < MAX_STEPS && offset + 8 <= file.size; step++) {
    const head = await read(file, offset, offset + 16)
    const box = header(head, 0, file.size - offset)
    if (!box) return null
    if (box.type === 'moov') {
      if (box.size > MOOV_MAX) return null
      return ilst(await read(file, offset + box.header, offset + box.size))
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

function ilst(moov) {
  const udta = child(moov, 'udta')
  const meta = udta && child(udta, 'meta')
  if (!meta || meta.length < 4) return null
  // `meta` is a full box (4 bytes of version and flags) in ISO files, a plain one in old QuickTime.
  const list = child(meta.subarray(4), 'ilst') ?? child(meta, 'ilst')
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
