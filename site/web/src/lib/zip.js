/**
 * A ZIP archive built in the browser (W3.15), for a batch's timings. The
 * entries are stored, not compressed: a `[TimingPoints]` block is a few
 * kilobytes, and storing them keeps this to a CRC and three headers instead
 * of a deflate dependency. Names are UTF-8 (flag bit 11). No ZIP64: a batch
 * is at most 50 files of a few kilobytes each.
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

/**
 * `files` is `[{ name, text }]`; returns the archive's bytes. Names repeated
 * within the batch get " (2)", " (3)" before their extension, so no entry
 * hides another when unpacked.
 */
export function zipStore(files, date = new Date()) {
  const encoder = new TextEncoder()
  const { time, date: day } = dosTime(date)
  const taken = new Set()
  const entries = files.map(({ name, text }) => {
    let unique = name
    for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = name.replace(/(\.[^.]*)?$/, ` (${n})$1`)
    taken.add(unique.toLowerCase())
    const data = encoder.encode(text)
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
