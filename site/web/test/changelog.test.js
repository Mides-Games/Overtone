import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inline, LIMIT, parseTimeline, readChangelog } from '../scripts/changelog.mjs'

const SAMPLE = `# Timeline

Intro text that is not an entry.

---

## Unreleased — 2026-10-27 · The newest thing

### Changed

- One bullet with \`code\` and a [link](https://example.com/a)
  wrapped over two lines.
- A relative [the web platform](16-web-platform.md) link stays text.

### Fixed

- Not in the changelog.

---

## v0.2.0-alpha — 2026-10-20 · An older release

### Changed

A paragraph without a bullet.

- **Bold** words.

---

## Something else entirely

### Changed

- Belongs to no entry.
`

test('entries keep their version, date, title and only their Changed bullets', () => {
  const entries = parseTimeline(SAMPLE)
  assert.deepEqual(
    entries.map((e) => [e.version, e.date, e.title, e.changed.length]),
    [
      ['Unreleased', '2026-10-27', 'The newest thing', 2],
      ['v0.2.0-alpha', '2026-10-20', 'An older release', 2],
    ],
  )
  assert.deepEqual(entries[0].changed[0], [
    { t: 'text', v: 'One bullet with ' },
    { t: 'code', v: 'code' },
    { t: 'text', v: ' and a ' },
    { t: 'link', v: 'link', href: 'https://example.com/a' },
    { t: 'text', v: ' wrapped over two lines.' },
  ])
  assert.deepEqual(entries[0].changed[1], [{ t: 'text', v: 'A relative the web platform link stays text.' }])
  assert.deepEqual(entries[1].changed, [[{ t: 'text', v: 'A paragraph without a bullet.' }], [{ t: 'strong', v: 'Bold' }, { t: 'text', v: ' words.' }]])
  assert.equal(parseTimeline(SAMPLE, { limit: 1 }).length, 1)
})

test('nothing in the timeline can become markup or a script link', () => {
  const tokens = inline('<img src=x onerror=alert(1)> [click](javascript:alert%281%29) [data](data:text/html,x) `<b>`')
  assert.deepEqual(tokens, [
    { t: 'text', v: '<img src=x onerror=alert(1)> click data ' },
    { t: 'code', v: '<b>' },
  ])
  assert.ok(tokens.every((tok) => ['text', 'code', 'strong', 'link'].includes(tok.t)))
})

test('the real timeline gives the latest entries, newest first, each with a date', () => {
  const entries = readChangelog()
  assert.ok(entries.length > 0 && entries.length <= LIMIT)
  for (const entry of entries) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(entry.title)
    for (const bullet of entry.changed) {
      for (const tok of bullet) if (tok.t === 'link') assert.match(tok.href, /^https?:\/\//)
    }
  }
  const dates = entries.map((e) => e.date)
  assert.deepEqual(dates, [...dates].sort().reverse())
})
