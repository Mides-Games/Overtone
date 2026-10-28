import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * docs/design.md is the decision and index.css the code: the colour table in
 * the one must be the tokens in the other, and no source file may name a
 * colour token the stylesheet does not declare (the way `--lavender`
 * would have lingered in draw.js after the rename to `--tempo`).
 */
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = read('../src/index.css')
const doc = read('../../../docs/design.md')

/** The custom properties declared in the block whose selector is exactly `selector`. */
function tokens(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&')
  const block = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  assert.ok(block, `index.css declares ${selector}`)
  return Object.fromEntries([...block[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

test("design.md's colour table is index.css's tokens, in both themes", () => {
  const light = tokens(':root')
  const dark = tokens('.dark')
  const rows = [...doc.matchAll(/^\| `--([\w-]+)` \| `(#[0-9a-f]{6})` \| `(#[0-9a-f]{6})` \|/gim)]
  assert.ok(rows.length >= 15, `the table has its rows (${rows.length})`)
  for (const [, name, darkValue, lightValue] of rows) {
    assert.equal(dark[name]?.toLowerCase(), darkValue.toLowerCase(), `dark --${name}`)
    assert.equal(light[name]?.toLowerCase(), lightValue.toLowerCase(), `light --${name}`)
  }
})

test('every colour token the source names is declared in index.css', () => {
  const declared = new Set([...css.matchAll(/--([\w-]+):/g)].map((m) => m[1]))
  const src = fileURLToPath(new URL('../src/', import.meta.url))
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (/\.(jsx?|css)$/.test(entry.name)) files.push(join(dir, entry.name))
    }
  }
  walk(src)
  // Set inline by the code itself, not by the stylesheet: the reader's font size, a stagger index, a popover's corner.
  const local = new Set(['font-scale', 'i', 'origin'])
  const missing = []
  for (const file of files) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/var\(--([\w-]+)/g)) {
      if (!declared.has(name) && !local.has(name) && !name.startsWith('tw-')) missing.push(`${file.slice(src.length)}: --${name}`)
    }
  }
  assert.deepEqual(missing, [])
})
