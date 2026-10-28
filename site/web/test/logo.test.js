import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * The site's logo is Overtone's own, written by assets/logo.py next to the
 * desktop app's icon (its cleaner web mark), never redrawn by hand: run `.venv/Scripts/python.exe assets/logo.py`
 * after changing the mark, and these hold the outputs together.
 */
const read = (path) => readFileSync(new URL(path, import.meta.url))

test('favicon.svg is assets/logo-web.svg, the web mark, byte for byte', () => {
  assert.deepEqual(read('../public/favicon.svg'), read('../../../assets/logo-web.svg'))
})

test('every PNG icon the manifest and index.html name exists at its stated size', () => {
  const size = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)]
  const manifest = JSON.parse(read('../public/manifest.webmanifest'))
  for (const icon of manifest.icons.filter((i) => i.type === 'image/png')) {
    const [w, h] = icon.sizes.split('x').map(Number)
    assert.deepEqual(size(read(`../public${icon.src}`)), [w, h], icon.src)
  }
  assert.deepEqual(size(read('../public/favicon-32.png')), [32, 32])
  assert.deepEqual(size(read('../public/apple-touch-icon.png')), [180, 180])
  assert.deepEqual(size(read('../public/og-image.png')), [1200, 630])
})
