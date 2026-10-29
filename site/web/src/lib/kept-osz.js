/**
 * The .osz files this browser built, kept on this device so they can be
 * downloaded again after the page is gone (owner's request, 2026-10-29).
 *
 * The .osz is built here from the visitor's own audio (lib/osz.js), and the
 * server never keeps that audio (ADR-W4): once the page is left the file is
 * gone, and so was the .osz. Keeping the built archive on the server was
 * rejected (docs/timeline.md): it would break the promise that the audio is
 * deleted after analysis, redistribute other people's music through someone
 * else's timing, and fill a 2 GB disk. So the exact bytes that were
 * downloaded are kept in this browser's IndexedDB, and only those: the
 * zipped .osz, never the audio on its own.
 *
 * One entry per page and id (`analysis:<id>` or `timing:<id>`): building it
 * again, with the same options or others, replaces it, since the newest build
 * is the one the visitor wanted and every copy is a whole song. Each entry
 * records which options built it (`options`), to say so beside it.
 *
 * Space: the library is capped at CAP_BYTES or half the origin's quota,
 * whichever is smaller, and makes room by dropping the entries downloaded
 * least recently. The browser is asked once, when the first file is kept, to
 * make the storage persistent (`navigator.storage.persist()`), so it is not
 * cleared under disk pressure without asking.
 *
 * Nothing here may break a download: IndexedDB missing (some private modes),
 * blocked, or out of quota makes `keep` answer `{ kept: false, reason }`,
 * and every other call answers empty. The bytes are split from the list
 * (two object stores), so listing never reads a song.
 */

export const DB_NAME = 'overtone-kept-osz'
export const DB_VERSION = 1
const META = 'meta'
const BYTES = 'bytes'

/**
 * The most the library keeps: 1 GB, about a hundred songs of 10 MB. Enough to
 * find last month's maps again, small next to a desktop browser's quota for a
 * site (Chrome grants up to 60 % of the disk, Firefox up to 10 %), and it says
 * plainly on the privacy page what the site may hold on a phone.
 */
export const CAP_BYTES = 1_000_000_000
/** And never more than this share of what the browser grants the site, leaving room for the rest of it. */
export const QUOTA_SHARE = 0.5

const PERSIST_KEY = 'overtone.keptOsz.persistAsked'
export const OSZ_TYPE = 'application/x-osu-beatmap-archive'

/** An entry's key: the page it came from and that page's id. */
export const keptKey = (source, id) => `${source === 'timing' ? 'timing' : 'analysis'}:${id}`

const request = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

const finished = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('aborted'))
  })

/**
 * The two object stores behind a tiny promise API: `list()` the entries
 * without their bytes, `get(key)`, `bytes(key)`, `put(meta, data)` both in
 * one transaction, `touch(meta)` the entry alone, `remove(keys)`.
 */
export function idbBackend(factory = globalThis.indexedDB) {
  let opening = null
  const open = () =>
    (opening ??= new Promise((resolve, reject) => {
      if (!factory) throw new Error('IndexedDB is not available')
      const r = factory.open(DB_NAME, DB_VERSION)
      r.onupgradeneeded = () => {
        const db = r.result
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' })
        if (!db.objectStoreNames.contains(BYTES)) db.createObjectStore(BYTES)
      }
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
      r.onblocked = () => reject(new Error('IndexedDB is blocked'))
    }).catch((error) => {
      opening = null
      throw error
    }))

  async function read(store, fn) {
    const db = await open()
    return request(fn(db.transaction(store, 'readonly').objectStore(store)))
  }
  async function write(stores, fn) {
    const db = await open()
    const tx = db.transaction(stores, 'readwrite')
    const done = finished(tx)
    fn(tx)
    await done
  }
  return {
    list: () => read(META, (s) => s.getAll()),
    get: async (key) => (await read(META, (s) => s.get(key))) ?? null,
    bytes: async (key) => (await read(BYTES, (s) => s.get(key))) ?? null,
    put: (meta, data) =>
      write([META, BYTES], (tx) => {
        tx.objectStore(META).put(meta)
        tx.objectStore(BYTES).put(data, meta.key)
      }),
    touch: (meta) => write([META], (tx) => tx.objectStore(META).put(meta)),
    remove: (keys) =>
      write([META, BYTES], (tx) => {
        for (const key of keys) {
          tx.objectStore(META).delete(key)
          tx.objectStore(BYTES).delete(key)
        }
      }),
  }
}

/** Least recently downloaded first: the order entries are dropped in. */
const byLeastRecent = (a, b) => (a.usedAt ?? a.createdAt) - (b.usedAt ?? b.createdAt)

/** The cap for a quota (bytes, or null when the browser does not say). */
export const capFor = (quota) => (Number.isFinite(quota) && quota > 0 ? Math.min(CAP_BYTES, Math.floor(quota * QUOTA_SHARE)) : CAP_BYTES)

const isQuota = (error) => error?.name === 'QuotaExceededError' || error?.code === 22

function defaultFlag() {
  return {
    get() {
      try {
        return globalThis.localStorage?.getItem(PERSIST_KEY) === '1'
      } catch {
        return false
      }
    },
    set() {
      try {
        globalThis.localStorage?.setItem(PERSIST_KEY, '1')
      } catch {
        // Storage blocked: the browser may be asked again next time, nothing worse.
      }
    },
  }
}

/**
 * The library over a backend. `storage` is `navigator.storage` (or a stand-in
 * with `estimate`, `persisted`, `persist`), `now` the clock, `persistFlag`
 * where "already asked" is remembered.
 */
export function createLibrary({ backend = idbBackend(), storage = globalThis.navigator?.storage, now = Date.now, persistFlag = defaultFlag(), onChange = () => {} } = {}) {
  async function estimate() {
    try {
      const e = await storage?.estimate?.()
      return e && Number.isFinite(e.quota) ? { usage: e.usage ?? 0, quota: e.quota } : null
    } catch {
      return null
    }
  }

  async function askPersist() {
    if (persistFlag.get()) return
    persistFlag.set()
    try {
      if (await storage?.persisted?.()) return
      await storage?.persist?.()
    } catch {
      // A browser without the API, or one that refuses: the files stay best-effort.
    }
  }

  async function list() {
    try {
      const items = (await backend.list()) ?? []
      items.sort((a, b) => (b.usedAt ?? b.createdAt) - (a.usedAt ?? a.createdAt))
      return { items, total: items.reduce((sum, item) => sum + (item.size ?? 0), 0), available: true }
    } catch {
      return { items: [], total: 0, available: false }
    }
  }

  /**
   * Keeps one built .osz: `{ source, id, title, artist, name, bytes, options }`.
   * Returns `{ kept, evicted, reason }`: `evicted` the entries dropped to make
   * room, `reason` why it was not kept ('unavailable', 'too-large', 'quota').
   */
  async function keep({ source, id, title = null, artist = null, name, bytes, options = null }) {
    const key = keptKey(source, id)
    const size = bytes?.byteLength ?? bytes?.size ?? 0
    let entries
    try {
      entries = (await backend.list()) ?? []
    } catch {
      return { kept: false, evicted: [], reason: 'unavailable' }
    }
    const cap = capFor((await estimate())?.quota)
    if (size > cap) return { kept: false, evicted: [], reason: 'too-large' }
    const others = entries.filter((e) => e.key !== key).sort(byLeastRecent)
    let total = others.reduce((sum, e) => sum + (e.size ?? 0), 0)
    const evicted = []
    while (others.length && total + size > cap) {
      const out = others.shift()
      total -= out.size ?? 0
      evicted.push(out)
    }
    const at = now()
    const meta = {
      key,
      source: source === 'timing' ? 'timing' : 'analysis',
      id: String(id),
      title,
      artist,
      name,
      size,
      options,
      createdAt: at,
      usedAt: at,
    }
    const data = typeof Blob === 'function' && !(bytes instanceof Blob) ? new Blob([bytes], { type: OSZ_TYPE }) : bytes
    try {
      if (evicted.length) await backend.remove(evicted.map((e) => e.key))
      // Out of quota with room left under the cap (another tab, the rest of the site): drop the oldest and try again.
      for (;;) {
        try {
          await backend.put(meta, data)
          break
        } catch (error) {
          if (!isQuota(error) || !others.length) throw error
          const out = others.shift()
          await backend.remove([out.key])
          evicted.push(out)
        }
      }
    } catch (error) {
      onChange()
      return { kept: false, evicted, reason: isQuota(error) ? 'quota' : 'unavailable' }
    }
    if (!entries.length || entries.every((e) => e.key === key)) await askPersist()
    onChange()
    return { kept: true, evicted, reason: null }
  }

  /** The entry for a page's id, or null. */
  async function find(source, id) {
    try {
      return await backend.get(keptKey(source, id))
    } catch {
      return null
    }
  }

  /** An entry's bytes, its download time moved to now. Null when it is gone or unreadable. */
  async function take(key) {
    try {
      const meta = await backend.get(key)
      const data = meta && (await backend.bytes(key))
      if (!data) return null
      try {
        await backend.touch({ ...meta, usedAt: now() })
      } catch {
        // The order of eviction stays as it was; the download still goes.
      }
      onChange()
      return { meta, data }
    } catch {
      return null
    }
  }

  async function remove(key) {
    try {
      await backend.remove([key])
      onChange()
      return true
    } catch {
      return false
    }
  }

  async function clear() {
    try {
      const items = (await backend.list()) ?? []
      await backend.remove(items.map((e) => e.key))
      onChange()
      return true
    } catch {
      return false
    }
  }

  return { keep, list, find, take, remove, clear, estimate, cap: async () => capFor((await estimate())?.quota) }
}

/* The page's one library, over this browser's IndexedDB; built on first use, never on page load. */
export const KEPT_EVENT = 'overtone:kept-osz'
let shared = null
export function keptLibrary() {
  shared ??= createLibrary({
    onChange: () => {
      try {
        globalThis.dispatchEvent?.(new Event(KEPT_EVENT))
      } catch {
        // No window (a test): nobody is listening.
      }
    },
  })
  return shared
}

/** Download a kept entry again. Resolves true when the file went to the browser. */
export async function downloadKept(key, save) {
  const found = await keptLibrary().take(key)
  if (!found) return false
  save(found.data, found.meta.name, OSZ_TYPE)
  return true
}

/** What was used to build an entry, kept beside it: the adjustment, the export options and the .osz options. */
export function keptOptions({ adjustment = null, exportOptions = null, oszOptions = null } = {}) {
  return {
    factor: adjustment?.factor ?? 1,
    nudgeMs: adjustment?.nudgeMs ?? 0,
    edited: adjustment?.edits?.length ?? 0,
    export: exportOptions ? { ...exportOptions } : null,
    osz: oszOptions ? { ...oszOptions, difficulties: [...(oszOptions.difficulties ?? [])] } : null,
  }
}

/** Bytes as "12.4 MB" / "640 kB" in units of 1000, in the reader's language ("12,4 Mo", "12,4 МБ"). */
export function formatSize(bytes, language = 'en') {
  const n = Number(bytes) || 0
  const [value, unit, digits] = n >= 1e9 ? [n / 1e9, 'gigabyte', 2] : n >= 1e6 ? [n / 1e6, 'megabyte', 1] : [Math.max(1, Math.round(n / 1e3)), 'kilobyte', 0]
  try {
    return new Intl.NumberFormat(language, { style: 'unit', unit, maximumFractionDigits: digits }).format(value)
  } catch {
    return `${value.toFixed(digits)} ${{ gigabyte: 'GB', megabyte: 'MB', kilobyte: 'kB' }[unit]}`
  }
}
