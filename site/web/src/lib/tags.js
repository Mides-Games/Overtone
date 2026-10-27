/**
 * The title and artist an audio file names itself by, read in the browser so
 * the public queue can show "Artist - Title" (W3.8) without the server
 * parsing anything. Only the head of the file is read: ID3v2 for MP3, Vorbis
 * comments for OGG, Opus and FLAC. Anything else, or a tag this does not
 * understand, is `{ title: null, artist: null }`, and the queue falls back to
 * the file name. Never throws.
 */
const HEAD_BYTES = 256 * 1024

export async function readTags(file) {
  const none = { title: null, artist: null }
  try {
    const bytes = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer())
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return id3(bytes) ?? none
    return vorbis(bytes) ?? none
  } catch {
    return none
  }
}

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
