import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32 as zlibCrc32 } from 'node:zlib'

import * as server from '../../api/src/utils/upload.js'
import { batchFiles, downloadName, timingText } from '../src/lib/timing.js'
import { crc32, zipStore } from '../src/lib/zip.js'

/**
 * Reads an archive back the way an unzip tool does: from the end-of-central-
 * directory record, through the directory, to each local header and its data.
 */
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length - 22
  assert.equal(view.getUint32(end, true), 0x06054b50, 'end of central directory')
  const count = view.getUint16(end + 10, true)
  const size = view.getUint32(end + 12, true)
  let at = view.getUint32(end + 16, true)
  assert.equal(at + size, end, 'the directory ends where the end record starts')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const files = []
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, 'central directory entry')
    assert.equal(view.getUint16(at + 10, true), 0, 'stored')
    const crc = view.getUint32(at + 16, true)
    const length = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const offset = view.getUint32(at + 42, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    assert.equal(view.getUint32(offset, true), 0x04034b50, 'local header')
    assert.equal(view.getUint32(offset + 14, true), crc, 'local and central CRCs agree')
    const data = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + length)
    assert.equal(zlibCrc32(data), crc, `CRC of ${name}`)
    files.push({ name, text: decoder.decode(data) })
    at += 46 + nameLength
  }
  return files
}

test('the CRC is the standard CRC-32', () => {
  const data = new TextEncoder().encode('123456789')
  assert.equal(crc32(data), 0xcbf43926)
  assert.equal(crc32(data), zlibCrc32(data))
  assert.equal(crc32(new Uint8Array()), 0)
})

test('an archive reads back with every name, every byte and every CRC', () => {
  const files = [
    { name: 'Song A-timing.txt', text: '[TimingPoints]\r\n10,500,4,2,0,100,1,0\r\n' },
    { name: 'Canción ñ-timing.txt', text: 'x'.repeat(5000) },
  ]
  assert.deepEqual(unzip(zipStore(files, new Date(2026, 9, 27, 12, 30, 10))), files)
})

test('a repeated name gets a number, so no entry hides another', () => {
  const names = unzip(zipStore([
    { name: 'a-timing.txt', text: '1' },
    { name: 'a-timing.txt', text: '2' },
    { name: 'A-timing.txt', text: '3' },
  ])).map((f) => f.name)
  assert.deepEqual(names, ['a-timing.txt', 'a-timing (2).txt', 'A-timing (3).txt'])
})

test('an empty batch is still a valid archive', () => {
  assert.deepEqual(unzip(zipStore([])), [])
})

test('the timing file is the one the API serves, byte for byte', () => {
  const result = { osu_timing: '10,500,4,2,0,100,1,0\n2010,400,4,2,0,100,1,0\n' }
  assert.equal(timingText(result), server.timingText(result))
  for (const name of ['My Song.mp3', 'ÿ weird/../name.ogg', '', null]) {
    assert.equal(downloadName(name, 'timing.txt'), server.downloadName(name, 'timing.txt'))
  }
})

test('the batch archive holds the songs that have a timing, and only those', () => {
  const result = { osu_timing: '10,500,4,2,0,100,1,0' }
  const items = [
    { file: { name: 'one.mp3' }, status: 'done', result },
    { file: { name: 'two.mp3' }, status: 'refused', result: { osu_timing: '' } },
    { file: { name: 'three.mp3' }, status: 'running' },
    { file: { name: 'four.mp3' }, upload: { kind: 'ready' } },
  ]
  assert.deepEqual(batchFiles(items).map((f) => f.name), ['one-timing.txt'])
})
