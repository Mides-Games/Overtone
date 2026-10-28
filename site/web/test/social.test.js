import assert from 'node:assert/strict'
import { test } from 'node:test'

import { beatmapLink, BADGES, formatAt, parseAt, ratingLabel, sortedQuery, userPath } from '../src/lib/social.js'

/**
 * Social v2's pure parts (W6, W13.15, W13.18): the times a comment points
 * at, the beatmap links a use may carry, and the list orders' query strings.
 */

test('a comment time reads as m:ss and back, and anything else is not a time', () => {
  assert.equal(formatAt(0), '0:00')
  assert.equal(formatAt(42_000), '0:42')
  assert.equal(formatAt(83_999), '1:23')
  assert.equal(formatAt(3_723_000), '1:02:03')
  assert.equal(parseAt(''), null)
  assert.equal(parseAt('  '), null)
  assert.equal(parseAt('1:23'), 83_000)
  assert.equal(parseAt('01:02:03'), 3_723_000)
  assert.equal(parseAt('42'), 42_000)
  assert.equal(parseAt('42.5'), 42_500)
  assert.equal(parseAt('1:23.5'), 83_500)
  for (const bad of ['1:60', 'a:bc', '1::2', '1:2:3:4', '-5', '1.5:20', '1:2x']) assert.ok(Number.isNaN(parseAt(bad)), bad)
  // What formatAt writes, parseAt reads back to the second.
  for (const ms of [0, 59_000, 61_000, 3_600_000, 5_999_000]) assert.equal(parseAt(formatAt(ms)), ms)
})

test('a beatmap link is accepted only as an osu.ppy.sh beatmapset, in the form the server keeps', () => {
  assert.equal(beatmapLink('https://osu.ppy.sh/beatmapsets/123'), 'https://osu.ppy.sh/beatmapsets/123')
  assert.equal(beatmapLink('http://www.osu.ppy.sh/beatmapsets/0123/'), 'https://osu.ppy.sh/beatmapsets/123')
  assert.equal(beatmapLink('https://osu.ppy.sh/beatmapsets/9#fruits/10'), 'https://osu.ppy.sh/beatmapsets/9#fruits/10')
  assert.equal(beatmapLink('https://osu.ppy.sh/s/77'), 'https://osu.ppy.sh/beatmapsets/77')
  for (const bad of ['', 'javascript:alert(1)', 'https://osu.ppy.sh.evil.example/beatmapsets/1', 'https://osu.ppy.sh/users/1', 'https://osu.ppy.sh/beatmapsets/1?a=b', 'https://osu.ppy.sh/beatmapsets/0']) {
    assert.equal(beatmapLink(bad), null, bad)
  }
})

test('the list orders go in the query string only when they are not the default', () => {
  assert.equal(sortedQuery({ sort: 'new' }), '')
  assert.equal(sortedQuery({ sort: 'rated' }), '?sort=rated')
  assert.equal(sortedQuery({ sort: 'used', q: 'daft' }, { cursor: 'o24' }), '?q=daft&cursor=o24&sort=used')
  assert.equal(sortedQuery({ sort: 'loudest' }), '')
  assert.equal(ratingLabel(null), '–')
  assert.equal(ratingLabel(4), '4')
  assert.equal(ratingLabel(4.5), '4.5')
  assert.equal(ratingLabel(4.25), '4.25')
  assert.equal(userPath('a b'), '/u/a%20b')
  assert.equal(new Set(BADGES).size, BADGES.length)
})
