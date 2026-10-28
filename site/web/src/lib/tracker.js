import { batchProgress } from './batch.js'

/**
 * The analyses this tab follows (W3.22) and the notices they leave (W3.23),
 * in one store that every page reads: the Analyze page's cards, the result
 * page and the tray all see the same reading, and each id is polled once
 * however many of them show it.
 *
 * No React and no browser globals in here: the storage, the clock, the
 * timers and the request are handed in, so the tests drive all of it with a
 * fake clock (`test/tracker.test.js`). `lib/tracking.js` builds the one
 * instance the site uses.
 *
 * What is kept, and where:
 * - the ids being followed, their names and last status, the batches and the
 *   inbox go to sessionStorage: a reload of this tab finds them again, and a
 *   second tab does not poll and notify the same songs twice;
 * - the two settings (sound, notifications) go to localStorage, since they
 *   are the person's preference rather than this tab's work.
 * Both are read back defensively: anything that is not exactly the shape
 * written is dropped, and blocked storage simply means nothing is kept.
 * Nothing here leaves the browser except the GETs the result page always made.
 */

const ID = /^[0-9a-f]{32}$/
const BATCH = /^[a-z0-9-]{1,40}$/
export const IN_FLIGHT = ['queued', 'running']
/** `gone` is a 404 on something this tab followed: cancelled from another page, or removed. */
export const FINISHED = ['done', 'refused', 'failed', 'cancelled', 'gone']
const STATUSES = [...IN_FLIGHT, ...FINISHED]
/** A song that ended with an answer worth announcing; cancelled and gone were the person's own doing. */
const ANNOUNCED = ['done', 'refused', 'failed']
const MAX_ENTRIES = 50
const MAX_NOTICES = 20
const MAX_NAME = 200
export const SESSION_KEY = 'overtone.tray'
export const SETTINGS_KEY = 'overtone.traySettings'

export const isFinished = (status) => FINISHED.includes(status)
const inFlight = (status) => !isFinished(status)

/** Control and bidi characters out, as the API's `cleanTag` does: a name is shown, never obeyed. */
export const cleanName = (name) =>
  String(name ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .trim()
    .slice(0, MAX_NAME)

/**
 * How long to wait before the next read of one analysis, in ms.
 *
 * - Fresh, it is read every second, then every two, then every three: a song
 *   usually spends its first seconds moving, then the queue holds it.
 * - Far back in the queue nothing changes quickly: past third place, one more
 *   second per place, up to ten.
 * - The API allows 300 requests a minute per address, the whole site
 *   included, so all of this tab's polls together stay near two a second: with
 *   `count` ids in flight, each waits at least `count` × 500 ms.
 * - A failed read backs off: 3, 6, 12, 24, then 30 s.
 * - A hidden tab slows to one read every 15 s; it catches up when shown.
 */
export function pollDelay({ age = 0, failures = 0, hidden = false, position = null, count = 1 } = {}) {
  let delay = age < 20_000 ? 1000 : age < 60_000 ? 2000 : 3000
  if (position > 3) delay = Math.max(delay, Math.min(10_000, 3000 + (position - 3) * 1000))
  delay = Math.max(delay, count * 500)
  if (failures > 0) delay = Math.max(delay, Math.min(30_000, 3000 * 2 ** (failures - 1)))
  if (hidden) delay = Math.max(delay, 15_000)
  return delay
}

/** Whether a reading that went from `before` to `after` is a finished song to announce. */
export const songFinished = (before, after) => (before === null || IN_FLIGHT.includes(before)) && ANNOUNCED.includes(after)

/**
 * Whether a batch has just ended: the upload loop that filled it is over
 * (`sealed`), it was not announced yet, it holds two songs or more, and every
 * one of them is finished. One song alone has its own notice.
 */
export function batchEnded(batch, statuses) {
  if (!batch?.sealed || batch.announced) return null
  const progress = batchProgress(statuses.map((status) => (status === 'gone' ? 'cancelled' : (status ?? 'queued'))))
  return progress.complete ? progress : null
}

/**
 * What a new notice sets off. The inbox always gets it. A browser
 * notification only when the person turned them on, the browser granted it,
 * and they are not looking at this tab (the tray already says it there). A
 * song inside a batch replaces the batch's one notification instead of
 * stacking another (`tag`), and makes no sound: ten chimes for ten songs is
 * noise, the batch's end chimes once.
 */
export function alertFor(notice, { settings, permission, visible }) {
  const inBatch = notice.kind === 'song' && Boolean(notice.batch)
  return {
    notify: Boolean(settings.notify && permission === 'granted' && !visible),
    sound: Boolean(settings.sound && !inBatch),
    tag: notice.batch ? `overtone-batch-${notice.batch}` : `overtone-${notice.id}`,
  }
}

/** The tab's title: "3 in progress · Overtone" while anything is, else the page's own. */
export const trayTitle = (count, label, base) => (count > 0 ? `${label} · ${base}` : base)

/** The saved session, checked field by field; anything else is an empty tray. */
export function readSaved(raw) {
  const empty = { entries: [], batches: {}, notices: [] }
  let data
  try {
    data = JSON.parse(raw ?? 'null')
  } catch {
    return empty
  }
  if (!data || typeof data !== 'object' || data.v !== 1) return empty
  const batchId = (value) => (typeof value === 'string' && BATCH.test(value) ? value : null)
  const time = (value) => (Number.isFinite(value) ? value : 0)
  const entries = (Array.isArray(data.entries) ? data.entries : [])
    .filter((entry) => ID.test(entry?.id ?? ''))
    .slice(0, MAX_ENTRIES)
    .map((entry) => ({
      id: entry.id,
      name: cleanName(entry.name),
      batch: batchId(entry.batch),
      status: STATUSES.includes(entry.status) ? entry.status : null,
      at: time(entry.at),
    }))
  const batches = {}
  for (const [id, batch] of Object.entries(data.batches && typeof data.batches === 'object' ? data.batches : {})) {
    // A reload ends the upload loop that was filling a batch: what it holds now is all it will hold.
    if (batchId(id) && entries.some((entry) => entry.batch === id)) batches[id] = { sealed: true, announced: batch?.announced === true, expected: 0 }
  }
  const notices = (Array.isArray(data.notices) ? data.notices : [])
    .filter((notice) => (notice?.kind === 'song' && ID.test(notice.id ?? '') && ANNOUNCED.includes(notice.status)) || (notice?.kind === 'batch' && batchId(notice.batch)))
    .slice(0, MAX_NOTICES)
    .map((notice) =>
      notice.kind === 'song'
        ? { kind: 'song', seq: time(notice.seq), at: time(notice.at), id: notice.id, name: cleanName(notice.name), status: notice.status, batch: batchId(notice.batch) }
        : { kind: 'batch', seq: time(notice.seq), at: time(notice.at), batch: notice.batch, done: time(notice.done), total: time(notice.total) },
    )
  return { entries, batches, notices }
}

export function readSettings(raw) {
  try {
    const data = JSON.parse(raw ?? 'null')
    return { sound: data?.sound === true, notify: data?.notify === true }
  } catch {
    return { sound: false, notify: false }
  }
}

const read = (storage, key) => {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}
const write = (storage, key, value) => {
  try {
    storage?.setItem(key, value)
  } catch {
    // Storage blocked or full: the tray still works, it just forgets on reload.
  }
}

/**
 * The store. `load(id)` resolves to the API's view of one analysis or rejects
 * with an error whose `status` is 404 when it does not exist (or is not ours).
 * `subscribe` and `getSnapshot` are what `useSyncExternalStore` wants; the
 * snapshot is a new object on every change and the same one otherwise.
 */
export function createTracker({ load, session = null, local = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, hidden = () => false }) {
  const saved = readSaved(read(session, SESSION_KEY))
  let entries = saved.entries
  let batches = saved.batches
  let notices = saved.notices
  let settings = readSettings(read(local, SETTINGS_KEY))
  /** id → `{ data, error }`: the last reading of every id polled, tracked or only watched. Memory only. */
  let live = {}
  let seq = notices.reduce((max, notice) => Math.max(max, notice.seq), 0)
  const polls = new Map()
  const watchers = new Map()
  const listeners = new Set()
  let snapshot = null

  const entryOf = (id) => entries.find((entry) => entry.id === id)
  const waiting = () =>
    entries.filter((entry) => inFlight(entry.status)).length +
    Object.entries(batches)
      .filter(([, batch]) => !batch.sealed)
      .reduce((sum, [id, batch]) => sum + Math.max(0, batch.expected - entries.filter((entry) => entry.batch === id).length), 0)

  function emit() {
    // A batch with none of its songs left is forgotten.
    batches = Object.fromEntries(Object.entries(batches).filter(([id, batch]) => !batch.sealed || entries.some((entry) => entry.batch === id)))
    snapshot = { entries, batches, notices, settings, live, count: waiting() }
    write(
      session,
      SESSION_KEY,
      JSON.stringify({ v: 1, entries: entries.map(({ id, name, batch, status, at }) => ({ id, name, batch, status, at })), batches, notices }),
    )
    for (const listener of listeners) listener()
  }

  function notice(fields) {
    seq += 1
    notices = [{ ...fields, seq, at: now() }, ...notices].slice(0, MAX_NOTICES)
  }

  function checkBatch(id) {
    if (!id || !batches[id]) return
    const ended = batchEnded(batches[id], entries.filter((entry) => entry.batch === id).map((entry) => entry.status))
    if (!ended) return
    batches = { ...batches, [id]: { ...batches[id], announced: true } }
    notice({ kind: 'batch', batch: id, done: ended.done, total: ended.total })
  }

  /** Whether `id` should keep being read: followed and unfinished, or on screen and not final yet. */
  function wanted(id) {
    const entry = entryOf(id)
    if (entry && inFlight(entry.status)) return true
    if (!watchers.get(id)) return false
    const reading = live[id]
    if (reading?.error === 'notFound') return false
    if (entry && isFinished(entry.status) && reading?.data) return false
    return !reading?.data || IN_FLIGHT.includes(reading.data.status)
  }

  function schedule(id) {
    const poll = polls.get(id)
    if (!poll) return
    if (!wanted(id)) {
      clearTimer(poll.timer)
      polls.delete(id)
      return
    }
    const count = [...polls.keys()].filter(wanted).length
    const delay = pollDelay({ age: now() - poll.started, failures: poll.failures, hidden: hidden(), position: live[id]?.data?.position ?? null, count })
    poll.timer = setTimer(() => run(id), delay)
  }

  function run(id) {
    const poll = polls.get(id)
    if (!poll) return
    poll.timer = null
    poll.busy = true
    Promise.resolve()
      .then(() => load(id))
      .then(
        (data) => {
          poll.failures = 0
          apply(id, data)
        },
        (error) => {
          if (error?.status === 404) return gone(id)
          poll.failures += 1
          live = { ...live, [id]: { data: live[id]?.data ?? null, error: 'network' } }
          emit()
        },
      )
      .finally(() => {
        poll.busy = false
        schedule(id)
      })
  }

  function ensure(id) {
    if (!wanted(id)) return
    if (!polls.has(id)) polls.set(id, { timer: null, busy: false, failures: 0, started: now() })
    const poll = polls.get(id)
    if (!poll.busy && poll.timer === null) run(id)
  }

  function apply(id, data) {
    live = { ...live, [id]: { data, error: null } }
    const entry = entryOf(id)
    if (entry) {
      const status = STATUSES.includes(data?.status) ? data.status : entry.status
      const next = { ...entry, status, name: entry.name || cleanName(data?.filename) }
      entries = entries.map((other) => (other.id === id ? next : other))
      if (songFinished(entry.status, status)) notice({ kind: 'song', id, name: next.name, status, batch: entry.batch })
      if (isFinished(status)) checkBatch(entry.batch)
    }
    emit()
  }

  function gone(id) {
    live = { ...live, [id]: { data: live[id]?.data ?? null, error: 'notFound' } }
    const entry = entryOf(id)
    if (entry && entry.status !== 'cancelled') {
      entries = entries.map((other) => (other.id === id ? { ...other, status: 'gone' } : other))
      checkBatch(entry.batch)
    }
    emit()
  }

  function trim() {
    while (entries.length > MAX_ENTRIES) {
      // The oldest finished one goes first; only if every one is in flight does the oldest of all.
      const finished = entries.findLastIndex((entry) => isFinished(entry.status))
      entries = entries.filter((_, i) => i !== (finished >= 0 ? finished : entries.length - 1))
    }
  }

  const api = {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,

    /** Starts reading every saved id that was still in flight. */
    start() {
      for (const entry of entries) ensure(entry.id)
    },

    /** Follows one of the visitor's analyses; `status` is what its upload answered. Newest first. */
    track(id, name, { batch = null, status = null } = {}) {
      if (!ID.test(id ?? '')) return
      const existing = entryOf(id)
      const fields = {
        name: cleanName(name) || existing?.name || '',
        batch: batch && BATCH.test(batch) ? batch : (existing?.batch ?? null),
        status: STATUSES.includes(status) ? status : (existing?.status ?? null),
      }
      entries = existing
        ? entries.map((entry) => (entry.id === id ? { ...entry, ...fields } : entry))
        : [{ id, ...fields, at: now() }, ...entries]
      trim()
      if (isFinished(fields.status)) checkBatch(fields.batch)
      emit()
      ensure(id)
    },

    /** A batch of `expected` uploads begins: until `endBatch`, the ones not sent yet count as in progress. */
    beginBatch(id, expected) {
      if (!BATCH.test(id ?? '')) return
      batches = { ...batches, [id]: { sealed: false, announced: false, expected: Math.max(0, Math.floor(expected) || 0) } }
      emit()
    },

    /** The upload loop is over: what the batch holds now is all it will hold. */
    endBatch(id) {
      if (!batches[id]) return
      batches = { ...batches, [id]: { ...batches[id], sealed: true } }
      checkBatch(id)
      emit()
    },

    /**
     * A page shows `id` (the result page, a card): read it until it is final.
     * Returns the function that stops watching. An analysis already followed
     * is not read a second time.
     */
    watch(id) {
      if (!ID.test(id ?? '')) return () => {}
      watchers.set(id, (watchers.get(id) ?? 0) + 1)
      ensure(id)
      return () => {
        const left = (watchers.get(id) ?? 1) - 1
        if (left > 0) watchers.set(id, left)
        else watchers.delete(id)
        const poll = polls.get(id)
        if (poll && !poll.busy && !wanted(id)) {
          clearTimer(poll.timer)
          polls.delete(id)
        }
      }
    },

    /**
     * Something the page changed on the server and already knows the answer
     * of (publishing, W3.27): merged into the reading every viewer of `id`
     * shows, without asking the API again. Nothing to merge into, nothing done.
     */
    patch(id, fields) {
      if (!live[id]?.data || !fields || typeof fields !== 'object') return
      live = { ...live, [id]: { ...live[id], data: { ...live[id].data, ...fields } } }
      emit()
    },

    /** The visitor cancelled it (CancelButton): it is final, and no notice is due. */
    cancelled(id) {
      const entry = entryOf(id)
      if (live[id]?.data) live = { ...live, [id]: { ...live[id], data: { ...live[id].data, status: 'cancelled' } } }
      if (entry) {
        entries = entries.map((other) => (other.id === id ? { ...other, status: 'cancelled' } : other))
        checkBatch(entry.batch)
      }
      const poll = polls.get(id)
      if (poll && !poll.busy) {
        clearTimer(poll.timer)
        polls.delete(id)
      }
      emit()
    },

    /** Takes a finished song off the tray. One still in flight stays: cancel it first. */
    dismiss(id) {
      const entry = entryOf(id)
      if (!entry || inFlight(entry.status)) return
      entries = entries.filter((other) => other.id !== id)
      if (!watchers.get(id)) {
        const { [id]: _, ...rest } = live
        live = rest
      }
      emit()
    },

    clearFinished() {
      entries = entries.filter((entry) => inFlight(entry.status))
      emit()
    },

    clearNotices() {
      notices = []
      emit()
    },

    setSettings(patch) {
      settings = { ...settings, ...Object.fromEntries(Object.entries(patch).filter(([key]) => key === 'sound' || key === 'notify').map(([k, v]) => [k, v === true])) }
      write(local, SETTINGS_KEY, JSON.stringify(settings))
      emit()
    },

    /** The tab was shown or hidden: shown, every waiting read happens now instead of at its slow hidden pace. */
    visibilityChanged() {
      if (hidden()) return
      for (const [id, poll] of polls) {
        if (poll.busy || poll.timer === null) continue
        clearTimer(poll.timer)
        poll.timer = null
        run(id)
      }
    },
  }
  emit()
  return api
}
