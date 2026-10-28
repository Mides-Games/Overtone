import assert from 'node:assert/strict'
import { test } from 'node:test'

import { countdown, limitOf, nextUtcMidnight } from '../src/lib/limits.js'
import { createUnreadStore, notificationLink, notificationMessage, POLL_MS, pollDelay, MAX_BACKOFF_MS } from '../src/lib/notifications.js'
import { commentMarks, MARK_TEXT } from '../src/lib/social.js'
import { offVote } from '../src/lib/votes.js'

/**
 * W13.14 votes, W13.15 marks on the map, W13.17 the bell and W13.20 the
 * limit notices: the pure parts the pages are made of.
 */

const ID = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

test('an "off" vote reads the form as the API will, and names the field that is wrong', () => {
  assert.deepEqual(offVote({ bpm: '', offset: '' }), { body: { verdict: 'off' }, correction: false })
  assert.deepEqual(offVote({ bpm: '127,5', offset: '-20', trainingOk: true }, 60), {
    body: { verdict: 'off', proposedBpm: 127.5, proposedOffsetMs: -20, trainingOk: true },
    correction: true,
  })
  // The permission means nothing without a correction, so it is not sent.
  assert.deepEqual(offVote({ trainingOk: true }).body, { verdict: 'off' })
  assert.deepEqual(offVote({ bpm: '19' }), { error: 'bpm' })
  assert.deepEqual(offVote({ bpm: '12a' }), { error: 'bpm' })
  assert.deepEqual(offVote({ bpm: '1e3' }), { error: 'bpm' })
  assert.deepEqual(offVote({ offset: '1.5' }), { error: 'offset' })
  assert.deepEqual(offVote({ offset: '60001' }, 60), { error: 'offset' })
  assert.deepEqual(offVote({ offset: '-10001' }, 60), { error: 'offset' })
})

test('timed comments become marks: inside the song, not hidden, in order, their text on one short line', () => {
  const long = 'word '.repeat(40)
  const marks = commentMarks(
    [
      { id: '2', atMs: 5000, body: 'second\nline', author: { username: 'b' } },
      { id: '1', atMs: 1000, body: long, author: null },
      { id: '3', atMs: null, body: 'untimed' },
      { id: '4', atMs: 99_000, body: 'past the end' },
      { id: '5', atMs: 2000, body: 'hidden', hidden: true },
    ],
    60,
  )
  assert.deepEqual(marks.map((m) => m.id), ['1', '2'])
  assert.equal(marks[1].text, 'second line')
  assert.equal(marks[0].author, null)
  assert.equal([...marks[0].text].length, MARK_TEXT)
  assert.ok(marks[0].text.endsWith('…'))
  assert.deepEqual(commentMarks(null), [])
})

test('each kind of notification leads to its page, and nowhere for a payload it does not know', () => {
  assert.equal(notificationLink({ kind: 'comment', payload: { timing: ID, comment: OTHER } }), `/t/${ID}#comment-${OTHER}`)
  assert.equal(notificationLink({ kind: 'comment', payload: { timing: ID, comment: 'x' } }), `/t/${ID}`)
  assert.equal(notificationLink({ kind: 'vote', payload: { timing: ID } }), `/t/${ID}`)
  assert.equal(notificationLink({ kind: 'use', payload: { timing: '../admin' } }), null)
  assert.equal(notificationLink({ kind: 'analysis', payload: { analysis: ID } }), `/analyze/${ID}`)
  assert.equal(notificationLink({ kind: 'suggestion', payload: { suggestion: ID } }), `/community#suggestion-${ID}`)
  assert.equal(notificationLink({ kind: 'suggestion', payload: {} }), '/community')
  assert.equal(notificationLink({ kind: 'mystery', payload: {} }), null)
  assert.equal(notificationLink(null), null)
})

test('a notification is written from its own payload, and a plain vote names nobody', () => {
  assert.deepEqual(notificationMessage({ kind: 'vote', payload: { verdict: 'off', title: 'Song' } }, 'Untitled'), {
    key: 'notifications.text.voteOff',
    values: { title: 'Song' },
  })
  assert.equal(notificationMessage({ kind: 'vote', payload: { verdict: 'on', mapper: 'm', title: 'S' } }, 'U').key, 'notifications.text.verified')
  assert.deepEqual(notificationMessage({ kind: 'comment', payload: { user: 'c' } }, 'Untitled').values, { user: 'c', title: 'Untitled' })
  assert.equal(notificationMessage({ kind: 'analysis', payload: { status: 'weird', name: 'n' } }, 'U').key, 'notifications.text.analysis.done')
  assert.equal(notificationMessage({ kind: 'suggestion', payload: { to: 'planned' } }, 'U').state, 'planned')
  assert.equal(notificationMessage({ kind: '?' }, 'U').key, 'notifications.text.unknown')
})

test('the bell polls once a minute when seen, never when hidden, and backs off after failures', () => {
  assert.equal(pollDelay(), POLL_MS)
  assert.equal(pollDelay({ hidden: true }), null)
  assert.equal(pollDelay({ failures: 1 }), 2 * POLL_MS)
  assert.equal(pollDelay({ failures: 3 }), 8 * POLL_MS)
  assert.equal(pollDelay({ failures: 30 }), MAX_BACKOFF_MS)
})

test('one unread count for the bell and the page, told only when it changes', () => {
  const store = createUnreadStore()
  let told = 0
  const stop = store.subscribe(() => {
    told += 1
  })
  store.set(3)
  store.set(3)
  store.set(-1)
  stop()
  store.set(5)
  assert.equal(told, 2)
  assert.equal(store.get(), 5)
})

test('a limit refusal counts down from the server\'s seconds, not the visitor\'s clock', () => {
  const at = 1_000_000
  const quota = limitOf({ code: 'QUOTA_EXCEEDED', details: { limit: 5, scope: 'anonymous', retryAfterS: 90, resetAt: '1999-01-01T00:00:00Z' } }, at)
  assert.deepEqual(quota, { code: 'QUOTA_EXCEEDED', frees: 'reset', deadline: at + 90_000, limit: 5, scope: 'anonymous', pending: null })
  assert.equal(countdown(quota.deadline, at), '1:30')
  assert.equal(countdown(at + 3_725_000, at), '1:02:05')
  assert.equal(countdown(at - 5, at), '0:00')
  // An API from before W13.20 sent no time: the next midnight UTC by this clock.
  const old = limitOf({ code: 'CACHE_LIMIT', details: { limit: 100, scope: 'account' } }, Date.UTC(2026, 9, 27, 23, 0))
  assert.equal(old.deadline, Date.UTC(2026, 9, 28))
  assert.equal(nextUtcMidnight(Date.UTC(2026, 11, 31, 12)), Date.UTC(2027, 0, 1))
  assert.deepEqual(limitOf({ code: 'PENDING_LIMIT', details: { limit: 3, scope: 'account', pending: 3, frees: 'finish' } }), {
    code: 'PENDING_LIMIT', frees: 'finish', deadline: null, limit: 3, scope: 'account', pending: 3,
  })
  assert.equal(limitOf({ code: 'RATE_LIMITED' }), null)
  assert.equal(limitOf(null), null)
})
