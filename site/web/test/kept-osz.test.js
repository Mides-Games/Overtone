import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CAP_BYTES, capFor, createLibrary, formatSize, idbBackend, keptKey, keptOptions } from '../src/lib/kept-osz.js'

/**
 * lib/kept-osz.js: the .osz files this browser keeps to download again. The
 * library runs over its real IndexedDB wrapper, here on an in-memory stand-in
 * that keeps IndexedDB's shape (requests, transactions that commit whole or
 * not at all, a quota that refuses a put).
 */
function fakeIndexedDB({ quota = Infinity, failOpen = false, failWrites = false } = {}) {
  let stores = null
  const later = (fn) => setTimeout(fn, 0)
  const size = (value) => value?.size ?? value?.byteLength ?? 0
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore: (name, { keyPath } = {}) => stores.set(name, { keyPath, rows: new Map() }),
    transaction(names, mode) {
      const ops = []
      const tx = { error: null }
      const store = (name) => {
        const op = (run) => {
          const r = {}
          ops.push({ r, run: (staged) => run(staged.get(name)) })
          return r
        }
        return {
          get: (key) => op((s) => s.rows.get(key)),
          getAll: () => op((s) => [...s.rows.values()]),
          put: (value, key) =>
            op((s) => {
              if (mode !== 'readwrite') throw new Error('read-only')
              if (failWrites) throw Object.assign(new Error('blocked'), { name: 'UnknownError' })
              s.rows.set(s.keyPath ? value[s.keyPath] : key, value)
            }),
          delete: (key) => op((s) => s.rows.delete(key)),
        }
      }
      tx.objectStore = (name) => {
        if (![names].flat().includes(name)) throw new Error(`${name} is not in this transaction`)
        return store(name)
      }
      later(() => {
        // Staged on a copy, committed only if every request succeeds.
        const staged = new Map([...stores].map(([n, s]) => [n, { keyPath: s.keyPath, rows: new Map(s.rows) }]))
        for (const { r, run } of ops) {
          try {
            r.result = run(staged)
          } catch (error) {
            r.error = tx.error = error
            r.onerror?.()
            tx.onerror?.()
            return
          }
          r.onsuccess?.()
        }
        const used = [...(staged.get('bytes')?.rows.values() ?? [])].reduce((sum, v) => sum + size(v), 0)
        if (used > quota) {
          tx.error = Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
          tx.onabort?.()
          return
        }
        stores = staged
        tx.oncomplete?.()
      })
      return tx
    },
  }
  return {
    opened: 0,
    open() {
      const r = {}
      this.opened++
      later(() => {
        if (failOpen) {
          r.error = new Error('denied')
          return r.onerror?.()
        }
        r.result = db
        if (!stores) {
          stores = new Map()
          r.onupgradeneeded?.()
        }
        r.onsuccess?.()
      })
      return r
    },
  }
}

function fakeStorage({ quota = 10_000, persisted = false } = {}) {
  return {
    asked: 0,
    estimate: async () => ({ usage: 0, quota }),
    persisted: async () => persisted,
    persist() {
      this.asked++
      return Promise.resolve(true)
    },
  }
}

function setup({ idb = fakeIndexedDB(), storage = fakeStorage(), flag = false } = {}) {
  let clock = 1000
  let asked = flag
  const changes = []
  const library = createLibrary({
    backend: idbBackend(idb),
    storage,
    now: () => clock++,
    persistFlag: { get: () => asked, set: () => (asked = true) },
    onChange: () => changes.push(1),
  })
  return { library, storage, changes }
}

const osz = (n, fill = 1) => new Uint8Array(n).fill(fill)

test('a kept .osz comes back byte for byte, with what built it', async () => {
  const { library } = setup()
  const options = keptOptions({ adjustment: { factor: 2, nudgeMs: -3, edits: [{}, {}] }, oszOptions: { cover: true, difficulties: ['Easy'] } })
  const out = await library.keep({ source: 'analysis', id: 'a1', title: 'Song', artist: 'Band', name: 'Band - Song.osz', bytes: osz(100, 7), options })
  assert.deepEqual(out, { kept: true, evicted: [], reason: null })
  const meta = await library.find('analysis', 'a1')
  assert.equal(meta.key, 'analysis:a1')
  assert.equal(meta.size, 100)
  assert.equal(meta.title, 'Song')
  assert.deepEqual(meta.options, { factor: 2, nudgeMs: -3, edited: 2, export: null, osz: { cover: true, difficulties: ['Easy'] } })
  const { data } = await library.take('analysis:a1')
  assert.deepEqual(new Uint8Array(await data.arrayBuffer()), osz(100, 7))
})

test('building the same id again replaces it; another page with the same id is its own entry', async () => {
  const { library } = setup()
  await library.keep({ source: 'analysis', id: 'x', name: 'a.osz', bytes: osz(100) })
  await library.keep({ source: 'analysis', id: 'x', name: 'b.osz', bytes: osz(300) })
  await library.keep({ source: 'timing', id: 'x', name: 'c.osz', bytes: osz(50) })
  const { items, total } = await library.list()
  assert.deepEqual(items.map((i) => i.key).sort(), ['analysis:x', 'timing:x'])
  assert.equal(total, 350)
  assert.equal((await library.find('analysis', 'x')).name, 'b.osz')
})

test('the list is newest download first, and a download again moves it up', async () => {
  const { library } = setup()
  for (const id of ['a', 'b', 'c']) await library.keep({ source: 'analysis', id, name: `${id}.osz`, bytes: osz(10) })
  assert.deepEqual((await library.list()).items.map((i) => i.id), ['c', 'b', 'a'])
  await library.take('analysis:a')
  assert.deepEqual((await library.list()).items.map((i) => i.id), ['a', 'c', 'b'])
})

test('over the cap, the least recently downloaded go first, and are named', async () => {
  // Quota 1000: the cap is half, 500 bytes.
  const { library } = setup({ storage: fakeStorage({ quota: 1000 }) })
  for (const id of ['a', 'b', 'c']) await library.keep({ source: 'analysis', id, name: `${id}.osz`, bytes: osz(150) })
  await library.take('analysis:a') // a is now the most recent: b goes first
  const out = await library.keep({ source: 'timing', id: 'd', name: 'd.osz', bytes: osz(200) })
  assert.equal(out.kept, true)
  assert.deepEqual(out.evicted.map((e) => e.key), ['analysis:b'])
  const { items, total } = await library.list()
  assert.deepEqual(items.map((i) => i.id).sort(), ['a', 'c', 'd'])
  assert.equal(total, 500)
})

test('a file larger than the cap is not kept and nothing is evicted for it', async () => {
  const { library } = setup({ storage: fakeStorage({ quota: 1000 }) })
  await library.keep({ source: 'analysis', id: 'a', name: 'a.osz', bytes: osz(100) })
  const out = await library.keep({ source: 'analysis', id: 'big', name: 'big.osz', bytes: osz(501) })
  assert.deepEqual(out, { kept: false, evicted: [], reason: 'too-large' })
  assert.equal((await library.list()).items.length, 1)
})

test('the cap is 1 GB or half the quota, whichever is smaller', () => {
  assert.equal(capFor(null), CAP_BYTES)
  assert.equal(capFor(100e9), CAP_BYTES)
  assert.equal(capFor(1e9), 5e8)
})

test('out of quota under the cap: drops the oldest and tries again, else says quota', async () => {
  const idb = fakeIndexedDB({ quota: 250 })
  const { library } = setup({ idb, storage: fakeStorage({ quota: 1e9 }) })
  await library.keep({ source: 'analysis', id: 'a', name: 'a.osz', bytes: osz(100) })
  await library.keep({ source: 'analysis', id: 'b', name: 'b.osz', bytes: osz(100) })
  const out = await library.keep({ source: 'analysis', id: 'c', name: 'c.osz', bytes: osz(100) })
  assert.equal(out.kept, true)
  assert.deepEqual(out.evicted.map((e) => e.id), ['a'])
  const none = await library.keep({ source: 'analysis', id: 'huge', name: 'h.osz', bytes: osz(300) })
  assert.equal(none.kept, false)
  assert.equal(none.reason, 'quota')
  // The transaction that failed changed nothing more than the evictions it made room with.
  assert.deepEqual((await library.list()).items.map((i) => i.id), [])
})

test('the browser is asked to persist once, when the first file is kept', async () => {
  const { library, storage } = setup()
  assert.equal(storage.asked, 0)
  await library.keep({ source: 'analysis', id: 'a', name: 'a.osz', bytes: osz(10) })
  await library.keep({ source: 'analysis', id: 'b', name: 'b.osz', bytes: osz(10) })
  await library.clear()
  await library.keep({ source: 'analysis', id: 'c', name: 'c.osz', bytes: osz(10) })
  assert.equal(storage.asked, 1)
  const already = setup({ storage: fakeStorage({ persisted: true }) })
  await already.library.keep({ source: 'analysis', id: 'a', name: 'a.osz', bytes: osz(10) })
  assert.equal(already.storage.asked, 0)
})

test('delete one and delete all', async () => {
  const { library } = setup()
  for (const id of ['a', 'b', 'c']) await library.keep({ source: 'analysis', id, name: `${id}.osz`, bytes: osz(10) })
  assert.equal(await library.remove('analysis:b'), true)
  assert.deepEqual((await library.list()).items.map((i) => i.id), ['c', 'a'])
  assert.equal(await library.take('analysis:b'), null)
  assert.equal(await library.clear(), true)
  assert.deepEqual(await library.list(), { items: [], total: 0, available: true })
})

test('without IndexedDB nothing throws: keep says why, the rest answers empty', async () => {
  for (const idb of [undefined, fakeIndexedDB({ failOpen: true })]) {
    const { library } = setup({ idb: idb ?? null })
    assert.deepEqual(await library.keep({ source: 'analysis', id: 'a', name: 'a.osz', bytes: osz(10) }), { kept: false, evicted: [], reason: 'unavailable' })
    assert.deepEqual(await library.list(), { items: [], total: 0, available: false })
    assert.equal(await library.find('analysis', 'a'), null)
    assert.equal(await library.take('analysis:a'), null)
    assert.equal(await library.remove('analysis:a'), false)
    assert.equal(await library.clear(), false)
  }
})

test('a write the browser refuses is not kept, and the next one can still be', async () => {
  const { library } = setup({ idb: fakeIndexedDB({ failWrites: true }) })
  const out = await library.keep({ source: 'analysis', id: 'a', name: 'a.osz', bytes: osz(10) })
  assert.deepEqual(out, { kept: false, evicted: [], reason: 'unavailable' })
  assert.deepEqual((await library.list()).items, [])
})

test('an estimate that throws is no estimate, and the cap falls back to 1 GB', async () => {
  const storage = { estimate: () => Promise.reject(new Error('no')), persisted: () => Promise.reject(new Error('no')) }
  const { library } = setup({ storage })
  assert.equal(await library.estimate(), null)
  assert.equal(await library.cap(), CAP_BYTES)
  assert.equal((await library.keep({ source: 'timing', id: 't', name: 't.osz', bytes: osz(10) })).kept, true)
})

test('keys and sizes', () => {
  assert.equal(keptKey('timing', 'abc'), 'timing:abc')
  assert.equal(keptKey('anything else', 'abc'), 'analysis:abc')
  assert.equal(formatSize(640_000), '640 kB')
  assert.equal(formatSize(12_400_000), '12.4 MB')
  assert.equal(formatSize(1_250_000_000), '1.25 GB')
  assert.match(formatSize(12_400_000, 'fr'), /^12,4\s?Mo$/)
})
