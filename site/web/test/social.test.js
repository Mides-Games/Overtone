import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ABOUT_MAX, LINK_KINDS as API_LINK_KINDS, NAME_MAX, SHOWCASE_MAX } from '../../api/src/utils/profile.js'
import {
  beatmapLink,
  BADGES,
  formatAt,
  LINK_KINDS,
  move,
  parseAt,
  PROFILE_LIMITS,
  profileUrl,
  ratingLabel,
  sortedQuery,
  userPath,
} from '../src/lib/social.js'

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

test('the showcase moves one place at a time and never off its ends; the link kinds are the API\'s', () => {
  assert.deepEqual(move(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c'])
  assert.deepEqual(move(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b'])
  const list = ['a', 'b']
  assert.equal(move(list, 0, -1), list)
  assert.equal(move(list, 1, 1), list)
  assert.equal(move(list, 5, 1), list)
  assert.deepEqual(LINK_KINDS, API_LINK_KINDS)
  assert.equal(PROFILE_LIMITS.about, ABOUT_MAX)
  assert.equal(PROFILE_LIMITS.displayName, NAME_MAX)
  assert.equal(PROFILE_LIMITS.showcase, SHOWCASE_MAX)
  // The profile link is this site's own origin, whatever the username holds.
  assert.equal(profileUrl('a/b?c', 'https://overtone.example'), 'https://overtone.example/u/a%2Fb%3Fc')
  assert.ok(BADGES.includes('ranked-mapper'))
})
