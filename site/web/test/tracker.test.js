import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  alertFor,
  batchEnded,
  cleanName,
  createTracker,
  pollDelay,
  readSaved,
  readSettings,
  SESSION_KEY,
  SETTINGS_KEY,
  songFinished,
  trayTitle,
} from '../src/lib/tracker.js'

/**
 * The tray's store (W3.22) and its notice rules (W3.23), driven with a fake
 * clock, fake timers, a fake API and in-memory storage: no browser, no React.
 */
const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const C = 'c'.repeat(32)

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), data }
}

/** A tracker over a scripted API: `answers[id]` is the next reading (or an Error with `status`). */
function harness({ session = memoryStorage(), local = memoryStorage(), hidden = false } = {}) {
  let clock = 0
  let timers = []
  let nextId = 1
  const answers = {}
  const calls = []
  const env = { hidden }
  const tracker = createTracker({
    load: (id) => {
      calls.push({ id, at: clock })
      const answer = answers[id]
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    },
    session,
    local,
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { id: nextId++, at: clock + ms, fn }
      timers.push(timer)
      return timer.id
    },
    clearTimer: (id) => {
      timers = timers.filter((timer) => timer.id !== id)
    },
    hidden: () => env.hidden,
  })
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  /** Moves the clock forward, running every timer that falls due, and lets the reads settle. */
  async function advance(ms) {
    const end = clock + ms
    await flush()
    for (;;) {
      const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers = timers.filter((timer) => timer !== due)
      clock = due.at
      due.fn()
      await flush()
    }
    clock = end
  }
  return { tracker, answers, calls, advance, flush, env, session, local, pending: () => timers.length }
}

const notFound = () => Object.assign(new Error('gone'), { status: 404 })

test('the poll starts at a second and slows with age, queue place, company, failures and a hidden tab', () => {
  assert.equal(pollDelay({ age: 0 }), 1000)
  assert.equal(pollDelay({ age: 30_000 }), 2000)
  assert.equal(pollDelay({ age: 120_000 }), 3000)
  assert.equal(pollDelay({ age: 0, position: 3 }), 1000)
  assert.equal(pollDelay({ age: 0, position: 5 }), 5000)
  assert.equal(pollDelay({ age: 0, position: 40 }), 10_000)
  // Ten songs at once stay near two requests a second together.
  assert.equal(pollDelay({ age: 0, count: 10 }), 5000)
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((failures) => pollDelay({ failures })), [3000, 6000, 12_000, 24_000, 30_000, 30_000])
  assert.equal(pollDelay({ age: 0, hidden: true }), 15_000)
  assert.equal(pollDelay({ failures: 9, hidden: true }), 30_000)
})

test('a song is announced once, when it goes from in flight to an answer', () => {
  assert.equal(songFinished('queued', 'done'), true)
  assert.equal(songFinished('running', 'refused'), true)
  assert.equal(songFinished(null, 'failed'), true)
  assert.equal(songFinished('done', 'done'), false)
  assert.equal(songFinished('queued', 'running'), false)
  // Cancelled or gone was the person's own doing, or not news.
  assert.equal(songFinished('queued', 'cancelled'), false)
  assert.equal(songFinished('running', 'gone'), false)
})

test('a batch ends only when sealed, two songs or more, all finished, and only once', () => {
  const sealed = { sealed: true, announced: false }
  assert.deepEqual(batchEnded(sealed, ['done', 'refused', 'gone']), { total: 3, finished: 3, done: 1, complete: true })
  assert.equal(batchEnded(sealed, ['done', 'queued']), null)
  assert.equal(batchEnded(sealed, ['done']), null)
  assert.equal(batchEnded({ sealed: false, announced: false }, ['done', 'done']), null)
  assert.equal(batchEnded({ sealed: true, announced: true }, ['done', 'done']), null)
  assert.equal(batchEnded(sealed, ['done', null]), null)
})

test('a notice notifies only if wanted, granted and unseen; a song inside a batch makes no sound', () => {
  const song = { kind: 'song', id: A, status: 'done', batch: null }
  const on = { notify: true, sound: true }
  assert.deepEqual(alertFor(song, { settings: on, permission: 'granted', visible: false }), { notify: true, sound: true, tag: `overtone-${A}` })
  assert.equal(alertFor(song, { settings: on, permission: 'granted', visible: true }).notify, false)
  for (const permission of ['default', 'denied', 'unsupported']) {
    assert.equal(alertFor(song, { settings: on, permission, visible: false }).notify, false, permission)
  }
  assert.deepEqual(alertFor(song, { settings: { notify: false, sound: false }, permission: 'granted', visible: false }), {
    notify: false,
    sound: false,
    tag: `overtone-${A}`,
  })
  const member = { ...song, batch: 'b1' }
  assert.deepEqual(alertFor(member, { settings: on, permission: 'granted', visible: false }), { notify: true, sound: false, tag: 'overtone-batch-b1' })
  const batch = { kind: 'batch', batch: 'b1', done: 2, total: 2 }
  assert.deepEqual(alertFor(batch, { settings: on, permission: 'granted', visible: false }), { notify: true, sound: true, tag: 'overtone-batch-b1' })
})

test('the title counts what is in flight, and is the page’s own otherwise', () => {
  assert.equal(trayTitle(3, '3 in progress', 'Overtone'), '3 in progress · Overtone')
  assert.equal(trayTitle(0, '0 in progress', 'Overtone'), 'Overtone')
})

test('saved state is read back defensively', () => {
  const empty = { entries: [], batches: {}, notices: [] }
  for (const raw of [null, '', 'not json', '42', '[]', '{"v":2,"entries":[]}']) assert.deepEqual(readSaved(raw), empty, String(raw))
  const saved = readSaved(
    JSON.stringify({
      v: 1,
      entries: [
        { id: A, name: 'song‮.mp3', batch: 'b1', status: 'running', at: 5 },
        { id: '../../etc', name: 'x', status: 'done' },
        { id: B, name: 7, batch: 'NOT A BATCH', status: 'exploded', at: 'yesterday' },
      ],
      batches: { b1: { sealed: false, announced: false, expected: 4 }, orphan: { sealed: true }, '<script>': {} },
      notices: [
        { kind: 'song', id: A, status: 'done', name: 'n', seq: 3, at: 1 },
        { kind: 'song', id: A, status: 'cancelled', seq: 2 },
        { kind: 'batch', batch: 'b1', done: 1, total: 2, seq: 1, at: 1 },
        { kind: 'other' },
      ],
    }),
  )
  assert.deepEqual(saved.entries, [
    { id: A, name: 'song.mp3', batch: 'b1', status: 'running', at: 5 },
    { id: B, name: '7', batch: null, status: null, at: 0 },
  ])
  // A reload ends the upload loop: the batch is sealed; one with no song left is dropped.
  assert.deepEqual(saved.batches, { b1: { sealed: true, announced: false, expected: 0 } })
  assert.deepEqual(
    saved.notices.map((notice) => notice.seq),
    [3, 1],
  )
  assert.deepEqual(readSettings('{"sound":true,"notify":"yes"}'), { sound: true, notify: false })
  assert.deepEqual(readSettings('garbage'), { sound: false, notify: false })
  assert.equal(cleanName('a\u0000b‏c'), 'abc')
  assert.equal(cleanName('x'.repeat(500)).length, 200)
})

test('a tracked song is polled until it finishes, then left alone, and announced once', async () => {
  const h = harness()
  h.answers[A] = { id: A, status: 'queued', position: 1, filename: 'one.mp3' }
  h.tracker.track(A, 'one.mp3', { status: 'queued' })
  await h.advance(0)
  assert.equal(h.calls.length, 1)
  await h.advance(1000)
  assert.equal(h.calls.length, 2)
  h.answers[A] = { id: A, status: 'running', progress: 0.5, stage: 'attacks' }
  await h.advance(1000)
  assert.equal(h.tracker.getSnapshot().entries[0].status, 'running')
  assert.equal(h.tracker.getSnapshot().live[A].data.progress, 0.5)
  assert.equal(h.tracker.getSnapshot().count, 1)
  h.answers[A] = { id: A, status: 'done', result: { bpm: 120 } }
  await h.advance(1000)
  const snapshot = h.tracker.getSnapshot()
  assert.equal(snapshot.entries[0].status, 'done')
  assert.equal(snapshot.count, 0)
  assert.equal(snapshot.notices.length, 1)
  assert.equal(snapshot.notices[0].name, 'one.mp3')
  const before = h.calls.length
  await h.advance(60_000)
  assert.equal(h.calls.length, before, 'no read after the end')
  assert.equal(h.pending(), 0)
})

test('a page watching a tracked song does not add a second poll', async () => {
  const h = harness()
  h.answers[A] = { id: A, status: 'queued', position: 1 }
  h.tracker.track(A, 'one.mp3', { status: 'queued' })
  const stopCard = h.tracker.watch(A)
  const stopPage = h.tracker.watch(A)
  await h.advance(10_000)
  // 0, 1, 2, … 10 s: one read a second, not two or three.
  assert.ok(h.calls.length <= 11, `${h.calls.length} reads`)
  stopCard()
  stopPage()
})

test('a watched song that is not tracked is read until final, and once more only if unknown', async () => {
  const h = harness()
  h.answers[A] = { id: A, status: 'done', result: {} }
  const stop = h.tracker.watch(A)
  await h.advance(10_000)
  assert.equal(h.calls.length, 1)
  assert.equal(h.tracker.getSnapshot().entries.length, 0, 'watching is not tracking')
  stop()
  h.answers[B] = Object.assign(new Error('no'), { status: 500 })
  const stopB = h.tracker.watch(B)
  await h.advance(0)
  assert.equal(h.tracker.getSnapshot().live[B].error, 'network')
  await h.advance(3000)
  assert.equal(h.calls.filter((call) => call.id === B).length, 2, 'retried after the backoff')
  stopB()
  await h.advance(60_000)
  assert.equal(h.calls.filter((call) => call.id === B).length, 2, 'nobody watching: no more reads')
})

test('a hidden tab slows down, and catches up the moment it is shown', async () => {
  const h = harness({ hidden: true })
  h.answers[A] = { id: A, status: 'queued', position: 1 }
  h.tracker.track(A, 'one.mp3', { status: 'queued' })
  await h.advance(14_000)
  assert.equal(h.calls.length, 1)
  h.env.hidden = false
  h.tracker.visibilityChanged()
  await h.advance(0)
  assert.equal(h.calls.length, 2)
})

test('a 404 marks a tracked song gone, without a notice', async () => {
  const h = harness()
  h.answers[A] = notFound()
  h.tracker.track(A, 'one.mp3', { status: 'queued' })
  await h.advance(0)
  assert.equal(h.tracker.getSnapshot().entries[0].status, 'gone')
  assert.equal(h.tracker.getSnapshot().notices.length, 0)
  assert.equal(h.pending(), 0)
})

test('a batch is announced once all its songs finish, counting the unsent ones until it is sealed', async () => {
  const h = harness()
  h.tracker.beginBatch('b1', 3)
  assert.equal(h.tracker.getSnapshot().count, 3)
  // A cached song answers at once; the other two are still to upload.
  h.answers[A] = { id: A, status: 'done' }
  h.tracker.track(A, 'a.mp3', { batch: 'b1', status: 'done' })
  assert.equal(h.tracker.getSnapshot().count, 2)
  h.answers[B] = { id: B, status: 'queued', position: 1 }
  h.tracker.track(B, 'b.mp3', { batch: 'b1', status: 'queued' })
  // The third upload was refused: the loop ends with two songs in the batch.
  h.tracker.endBatch('b1')
  assert.equal(h.tracker.getSnapshot().count, 1)
  assert.equal(h.tracker.getSnapshot().notices.length, 0)
  h.answers[B] = { id: B, status: 'done' }
  await h.advance(2000)
  const kinds = h.tracker.getSnapshot().notices.map((notice) => notice.kind)
  assert.deepEqual(kinds, ['batch', 'song'])
  assert.deepEqual(
    (({ done, total }) => ({ done, total }))(h.tracker.getSnapshot().notices[0]),
    { done: 2, total: 2 },
  )
  h.tracker.endBatch('b1')
  assert.equal(h.tracker.getSnapshot().notices.length, 2, 'never twice')
})

test('cancelling stops the poll, says nothing, and can finish a batch', async () => {
  const h = harness()
  h.tracker.beginBatch('b2', 2)
  h.answers[A] = { id: A, status: 'done' }
  h.answers[B] = { id: B, status: 'queued', position: 2 }
  h.tracker.track(A, 'a.mp3', { batch: 'b2', status: 'done' })
  h.tracker.track(B, 'b.mp3', { batch: 'b2', status: 'queued' })
  h.tracker.endBatch('b2')
  await h.advance(0)
  h.tracker.cancelled(B)
  const reads = h.calls.length
  await h.advance(30_000)
  assert.equal(h.calls.length, reads)
  const notices = h.tracker.getSnapshot().notices
  assert.deepEqual(notices.map((notice) => notice.kind), ['batch'])
  assert.equal(notices[0].done, 1)
})

test('a reload finds the songs in flight and goes on reading them; the settings survive too', async () => {
  const session = memoryStorage()
  const local = memoryStorage()
  const first = harness({ session, local })
  first.tracker.track(A, 'a.mp3', { status: 'queued' })
  first.tracker.track(C, 'c.mp3', { status: 'done' })
  first.tracker.setSettings({ sound: true, notify: true, evil: true })
  assert.deepEqual(JSON.parse(local.data.get(SETTINGS_KEY)), { sound: true, notify: true })

  const second = harness({ session, local })
  second.answers[A] = { id: A, status: 'done' }
  assert.deepEqual(
    second.tracker.getSnapshot().entries.map((entry) => [entry.id, entry.status]),
    [
      [C, 'done'],
      [A, 'queued'],
    ],
  )
  assert.deepEqual(second.tracker.getSnapshot().settings, { sound: true, notify: true })
  second.tracker.start()
  await second.advance(0)
  assert.deepEqual(second.calls.map((call) => call.id), [A], 'only the one still in flight is read')
  assert.equal(second.tracker.getSnapshot().notices.length, 1, 'it finished while the page reloaded: still announced')
  assert.ok(session.data.get(SESSION_KEY).includes('"v":1'))
})

test('blocked storage leaves a working tray that forgets on reload', async () => {
  const throwing = {
    getItem() {
      throw new Error('SecurityError')
    },
    setItem() {
      throw new Error('SecurityError')
    },
  }
  const h = harness({ session: throwing, local: throwing })
  h.answers[A] = { id: A, status: 'queued' }
  h.tracker.track(A, 'a.mp3', { status: 'queued' })
  h.tracker.setSettings({ sound: true })
  await h.advance(0)
  assert.equal(h.tracker.getSnapshot().entries.length, 1)
  assert.equal(h.tracker.getSnapshot().settings.sound, true)
})

test('dismissing keeps a song in flight, and the oldest finished go first past fifty', () => {
  const h = harness()
  h.tracker.track(A, 'a.mp3', { status: 'queued' })
  h.tracker.dismiss(A)
  assert.equal(h.tracker.getSnapshot().entries.length, 1, 'cancel it first')
  h.tracker.track(B, 'b.mp3', { status: 'done' })
  h.tracker.dismiss(B)
  assert.deepEqual(h.tracker.getSnapshot().entries.map((entry) => entry.id), [A])
  for (let i = 0; i < 60; i++) h.tracker.track(i.toString(16).padStart(32, 'd'), `${i}.mp3`, { status: 'done' })
  const entries = h.tracker.getSnapshot().entries
  assert.equal(entries.length, 50)
  assert.ok(entries.some((entry) => entry.id === A), 'the one in flight stays')
  h.tracker.clearFinished()
  assert.deepEqual(h.tracker.getSnapshot().entries.map((entry) => entry.id), [A])
  h.tracker.track('not an id', 'x')
  assert.equal(h.tracker.getSnapshot().entries.length, 1)
})
