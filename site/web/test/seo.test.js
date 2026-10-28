import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * robots.txt and sitemap.xml are static (W10.3), so this keeps them honest
 * against the routes in src/App.jsx: every public page is in the sitemap,
 * nothing private is, and the manifest's icons exist.
 */
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const app = read('../src/App.jsx')
const sitemap = read('../public/sitemap.xml')
const robots = read('../public/robots.txt')

/**
 * Pages nobody should land on from a search: a result is its uploader's, sign-in is a step,
 * and a comparison (W12.11) is two ids in the query, whose page depends on who asks;
 * the settings are this browser's own, with nothing to find (W12.15). And the pages with
 * an id in their path (a timing, a timer's profile, a collection, W6): public, but with no
 * fixed URL a static sitemap could list.
 */
const PRIVATE = ['analyze/:id', 'history', 'compare', 't/:id', 'u/:username', 'c/:id', 'login', 'login/callback', 'profile', 'link/osu', 'settings', 'settings/tokens', 'embed/:id', '*']

const routes = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1])
const listed = [...sitemap.matchAll(/<loc>https:\/\/[^/]+(\/[^<]*)<\/loc>/g)].map((m) => m[1])

test('the sitemap lists the home page and every public route, and nothing else', () => {
  const pub = ['/', ...routes.filter((r) => !PRIVATE.includes(r)).map((r) => `/${r}`)]
  assert.deepEqual([...listed].sort(), pub.sort())
})

test('robots.txt keeps crawlers off the API and the private pages and names the sitemap', () => {
  for (const path of ['/api/', '/analyze/', '/login', '/profile', '/compare', '/settings']) assert.match(robots, new RegExp(`^Disallow: ${path}$`, 'm'))
  const origin = /<loc>(https:\/\/[^/]+)\//.exec(sitemap)[1]
  assert.match(robots, new RegExp(`^Sitemap: ${origin}/sitemap\\.xml$`, 'm'))
})

test('the manifest names Overtone and every icon it lists is in public/', () => {
  const manifest = JSON.parse(read('../public/manifest.webmanifest'))
  assert.equal(manifest.name, 'Overtone')
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'))
  for (const icon of manifest.icons) assert.ok(readFileSync(new URL(`../public${icon.src}`, import.meta.url)).length > 0, icon.src)
})
