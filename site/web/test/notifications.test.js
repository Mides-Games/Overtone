import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  applyChange,
  iconOf,
  KIND_ICON,
  KINDS,
  notificationLink,
  notificationMessage,
  optimisticUnread,
  relativeParts,
  relativeTime,
} from '../src/lib/notifications.js'

// The icon set's names, read from its source (a .jsx file node cannot import).
const ICONS = [...readFileSync(new URL('../src/components/ui/Icon.jsx', import.meta.url), 'utf8').matchAll(/^  '?([a-z-]+)'?: [(<]/gm)].map((m) => m[1])

/**
 * The notification panel (W13.17's second pass): where a click leads, what a
 * staff notification says, "3 min ago" in two languages, and the count the
 * bell shows before the server answers.
 */

const ID = 'a'.repeat(32)

test("the API's target leads, but only to a path on this site", () => {
  assert.equal(notificationLink({ kind: 'vote', payload: {}, target: { kind: 'timing', id: ID, path: `/t/${ID}` } }), `/t/${ID}`)
  assert.equal(notificationLink({ kind: 'staff', target: { kind: 'staff', id: null, path: '/staff' } }), '/staff')
  // A target that is not a same-site path is ignored for the payload's own link.
  for (const path of ['//evil.example/x', 'https://evil.example', 'javascript:alert(1)', '/t/a b', ' /t/x', 7]) {
    assert.equal(notificationLink({ kind: 'vote', payload: { timing: ID }, target: { path } }), `/t/${ID}`, String(path))
    assert.equal(notificationLink({ kind: 'mystery', target: { path } }), null, String(path))
  }
  assert.equal(notificationLink({ kind: 'staff', payload: {} }), '/staff')
})

test('a staff notification names the kind of thing reported, never who', () => {
  assert.deepEqual(notificationMessage({ kind: 'staff', payload: { item: 'report', kind: 'review' } }, 'U'), { key: 'notifications.text.staff.report.review', values: {} })
  assert.equal(notificationMessage({ kind: 'staff', payload: { item: 'report', kind: 'other' } }, 'U').key, 'notifications.text.staff.report.item')
  assert.deepEqual(notificationMessage({ kind: 'staff', payload: { item: 'correction', title: 'Song' } }, 'U'), {
    key: 'notifications.text.staff.correction',
    values: { title: 'Song' },
  })
})

test('every kind has an icon the set draws, and a mapper\'s confirmation its own', () => {
  for (const kind of KINDS) assert.ok(ICONS.includes(KIND_ICON[kind]), kind)
  assert.equal(iconOf({ kind: 'vote', payload: { mapper: 'm' } }), 'trophy')
  assert.equal(iconOf({ kind: 'vote', payload: {} }), 'star')
  assert.ok(ICONS.includes(iconOf({ kind: '?' })))
})

test('how long ago: the largest whole unit, and never in the future', () => {
  const now = Date.parse('2026-10-28T12:00:00Z')
  const ago = (ms) => relativeParts(new Date(now - ms), now)
  assert.deepEqual(ago(10_000), { value: 0, unit: 'minute' })
  assert.deepEqual(ago(-90_000), { value: 0, unit: 'minute' }, 'a clock ahead of the server is "now"')
  assert.deepEqual(ago(3 * 60_000 + 59_000), { value: -3, unit: 'minute' })
  assert.deepEqual(ago(2 * 3_600_000), { value: -2, unit: 'hour' })
  assert.deepEqual(ago(26 * 3_600_000), { value: -1, unit: 'day' })
  assert.deepEqual(ago(15 * 86_400_000), { value: -2, unit: 'week' })
  assert.deepEqual(ago(70 * 86_400_000), { value: -2, unit: 'month' })
  assert.deepEqual(ago(800 * 86_400_000), { value: -2, unit: 'year' })
  const three = new Date(now - 3 * 60_000)
  assert.match(relativeTime(three, 'en', now), /3 min\.? ago/)
  assert.match(relativeTime(three, 'es', now), /hace 3 min/)
  assert.equal(relativeTime(new Date(now - 26 * 3_600_000), 'en', now), 'yesterday')
})

test('the bell moves before the server answers, by what the change does to unread ones', () => {
  const items = [
    { id: 'a', read: false },
    { id: 'b', read: true },
    { id: 'c', read: false },
  ]
  assert.equal(optimisticUnread(5, items, { read: ['a', 'b'] }), 4, 'b was read already')
  assert.equal(optimisticUnread(5, items, { unread: ['a', 'b'] }), 6, 'a was unread already')
  assert.equal(optimisticUnread(5, items, { remove: ['c'] }), 4)
  assert.equal(optimisticUnread(5, items, { remove: ['b'] }), 5)
  assert.equal(optimisticUnread(5, items, { allRead: true }), 0)
  assert.equal(optimisticUnread(5, items, { removeRead: true }), 5)
  assert.equal(optimisticUnread(0, items, { read: ['a'] }), 0, 'never below nothing')
  assert.equal(optimisticUnread(3, null, { read: ['zz'] }), 3, 'ids it cannot see change nothing yet')

  assert.deepEqual(applyChange(items, { read: ['a'] }).map((n) => n.read), [true, true, false])
  assert.deepEqual(applyChange(items, { unread: ['b'] }).map((n) => n.read), [false, false, false])
  assert.deepEqual(applyChange(items, { remove: ['a', 'c'] }).map((n) => n.id), ['b'])
  assert.deepEqual(applyChange(items, { removeRead: true }).map((n) => n.id), ['a', 'c'])
  assert.ok(applyChange(items, { allRead: true }).every((n) => n.read))
  assert.equal(applyChange(null, { allRead: true }), null)
})
