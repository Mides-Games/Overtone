/**
 * A ZIP archive built in the browser: a batch's timings (W3.15) and a song's
 * .osz. The entries are stored, not compressed: a `[TimingPoints]` block is a
 * few kilobytes and the audio is compressed already, and storing them keeps
 * this to a CRC and three headers instead of a deflate dependency. Names are
 * UTF-8 (flag bit 11). No ZIP64: the largest archive is one upload (MAX_UPLOAD_MB, 95 by default)
 * and its .osu.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** The MS-DOS time and date every entry header carries, in local time as unzip tools read it. */
const dosTime = (date) => ({
  time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
})

/** `name` made unique among `taken` (lower-cased), " (2)", " (3)" before its extension. */
const uniqueName = (name, taken) => {
  let unique = name
  for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = name.replace(/(\.[^.]*)?$/, ` (${n})$1`)
  taken.add(unique.toLowerCase())
  return unique
}

/**
 * The same stored archive, built one entry at a time into a Blob (W12.22, a
 * whole batch's .osz files): each entry's bytes become a Blob part as soon as
 * they are added, so the caller can let them go before building the next,
 * and the browser may keep large parts on disk. Nothing is held twice but the
 * entry being added. The bytes are identical to `zipStore`'s for the same
 * files and date.
 */
export class ZipWriter {
  constructor(date = new Date()) {
    this.stamp = dosTime(date)
    this.parts = []
    this.entries = []
    this.offset = 0
    this.taken = new Set()
    this.encoder = new TextEncoder()
  }

  /** Adds `data` (bytes) or `text` under `name`; returns the name it got. */
  add(name, { data = null, text = null } = {}) {
    const unique = uniqueName(name, this.taken)
    const bytes = data ?? this.encoder.encode(text ?? '')
    const e = { name: this.encoder.encode(unique), size: bytes.length, crc: crc32(bytes), offset: this.offset }
    const head = new Uint8Array(30 + e.name.length)
    const view = new DataView(head.buffer)
    view.setUint32(0, 0x04034b50, true)
    this.common(view, 4, e)
    head.set(e.name, 30)
    this.parts.push(head, new Blob([bytes]))
    this.entries.push(e)
    this.offset += head.length + e.size
    if (this.offset > 0xffffffff || this.entries.length > 0xffff) throw new Error('too large for a zip without zip64')
    return unique
  }

  /** The fields a local header and a central entry share, from "version needed" on, at `at`. */
  common(view, at, e) {
    const { time, date } = this.stamp
    const fields = [[2, 20], [2, 0x0800], [2, 0], [2, time], [2, date], [4, e.crc], [4, e.size], [4, e.size], [2, e.name.length], [2, 0]]
    for (const [width, value] of fields) {
      if (width === 2) view.setUint16(at, value, true)
      else view.setUint32(at, value, true)
      at += width
    }
  }

  /** The archive: every entry, then the central directory. */
  blob(type = 'application/zip') {
    const size = this.entries.reduce((sum, e) => sum + 46 + e.name.length, 22)
    const tail = new Uint8Array(size)
    const view = new DataView(tail.buffer)
    let at = 0
    for (const e of this.entries) {
      view.setUint32(at, 0x02014b50, true)
      view.setUint16(at + 4, 20, true)
      this.common(view, at + 6, e)
      // comment length, disk, internal and external attributes: zero; then the offset.
      view.setUint32(at + 42, e.offset, true)
      tail.set(e.name, at + 46)
      at += 46 + e.name.length
    }
    view.setUint32(at, 0x06054b50, true)
    view.setUint16(at + 8, this.entries.length, true)
    view.setUint16(at + 10, this.entries.length, true)
    view.setUint32(at + 12, at, true)
    view.setUint32(at + 16, this.offset, true)
    return new Blob([...this.parts, tail], { type })
  }
}

/**
 * `files` is `[{ name, text }]` or `[{ name, data }]` (bytes); returns the archive's bytes. Names repeated
 * within the batch get " (2)", " (3)" before their extension, so no entry
 * hides another when unpacked.
 */
export function zipStore(files, date = new Date()) {
  const encoder = new TextEncoder()
  const { time, date: day } = dosTime(date)
  const taken = new Set()
  const entries = files.map(({ name, text, data: raw }) => {
    let unique = name
    for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = name.replace(/(\.[^.]*)?$/, ` (${n})$1`)
    taken.add(unique.toLowerCase())
    const data = raw ?? encoder.encode(text)
    return { name: encoder.encode(unique), data, crc: crc32(data) }
  })

  const size = entries.reduce((sum, e) => sum + 30 + e.name.length + e.data.length + 46 + e.name.length, 22)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let at = 0
  const u16 = (value) => {
    view.setUint16(at, value, true)
    at += 2
  }
  const u32 = (value) => {
    view.setUint32(at, value, true)
    at += 4
  }
  const bytes = (value) => {
    out.set(value, at)
    at += value.length
  }
  /** The fields a local header and a central directory entry share, from "version needed" to the name's length. */
  const common = (e) => {
    u16(20) // version needed: 2.0
    u16(0x0800) // the name is UTF-8
    u16(0) // stored
    u16(time)
    u16(day)
    u32(e.crc)
    u32(e.data.length)
    u32(e.data.length)
    u16(e.name.length)
    u16(0) // no extra field
  }

  for (const e of entries) {
    e.offset = at
    u32(0x04034b50)
    common(e)
    bytes(e.name)
    bytes(e.data)
  }
  const directory = at
  for (const e of entries) {
    u32(0x02014b50)
    u16(20) // made by: 2.0, MS-DOS attributes
    common(e)
    u16(0) // no comment
    u16(0) // disk 0
    u16(0) // internal attributes
    u32(0) // external attributes
    u32(e.offset)
    bytes(e.name)
  }
  const directorySize = at - directory
  u32(0x06054b50)
  u16(0) // this disk
  u16(0) // the directory's disk
  u16(entries.length)
  u16(entries.length)
  u32(directorySize)
  u32(directory)
  u16(0) // no comment
  return out
}
