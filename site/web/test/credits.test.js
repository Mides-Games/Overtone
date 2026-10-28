import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { npmLicence, pythonLicence, readLicenceFile, readLock } from '../scripts/credits.mjs'

/**
 * The credits page (W4.8) shows src/data/credits.json, which
 * scripts/credits.mjs writes. These check the shape the page relies on and
 * that the list still covers what the project pins, so a dependency added
 * without a re-run fails here instead of going uncredited.
 */
const credits = JSON.parse(readFileSync(new URL('../src/data/credits.json', import.meta.url), 'utf8'))
const repo = new URL('../../../', import.meta.url)

const isText = (value) => typeof value === 'string' && value.trim().length > 0

test('the credits file has every part the page shows, each entry named, versioned and licensed', () => {
  assert.deepEqual(Object.keys(credits).sort(), ['fonts', 'model', 'npm', 'overtone', 'python'])
  assert.equal(credits.overtone.licence, 'MIT')
  assert.ok(isText(credits.overtone.holder))
  assert.equal(credits.model.name, 'Beat This!')
  assert.equal(credits.model.licence, 'MIT')
  assert.match(credits.model.url, /^https:\/\//)
  for (const entry of [...credits.python, ...credits.npm]) {
    assert.ok(isText(entry.name) && isText(entry.version) && isText(entry.licence), JSON.stringify(entry))
  }
  for (const entry of credits.npm) {
    assert.ok(['web', 'api'].includes(entry.part), entry.name)
    assert.ok(['runtime', 'build'].includes(entry.role), entry.name)
    assert.equal(typeof entry.direct, 'boolean')
  }
  assert.ok(Array.isArray(credits.fonts))
})

test('every pinned Python package is credited at its pin', () => {
  const pinned = readLock(readFileSync(new URL('python/requirements.lock', repo), 'utf8'))
  const listed = new Map(credits.python.map((p) => [p.name, p.version]))
  for (const { name, version } of pinned) assert.equal(listed.get(name), version, `${name}: re-run scripts/credits.mjs`)
})

test('every direct npm dependency of the web and the API is credited', () => {
  for (const part of ['web', 'api']) {
    const manifest = JSON.parse(readFileSync(new URL(`site/${part}/package.json`, repo), 'utf8'))
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      assert.ok(credits.npm.some((p) => p.part === part && p.name === name && p.direct), `${part}: ${name}: re-run scripts/credits.mjs`)
    }
  }
})

test('a Python licence is read from the metadata, in order of trust, and never guessed', () => {
  assert.equal(pythonLicence('Name: a\nLicense-Expression: MIT\nLicense: BSD\n\nbody'), 'MIT')
  assert.equal(pythonLicence('Name: a\nLicense: ISC\nClassifier: License :: OSI Approved :: MIT License\n'), 'ISC')
  // A licence text pasted into the field is not a name: the classifier is.
  assert.equal(
    pythonLicence('Name: a\nLicense: Copyright (c) 2001 Somebody\n        All rights reserved.\nClassifier: License :: OSI Approved :: BSD License\n'),
    'BSD License',
  )
  assert.equal(pythonLicence('Name: a\nVersion: 1\n\nLicense: MIT in the body does not count'), 'unknown')
})

test('an npm licence comes from license, the legacy licenses list, or is unknown', () => {
  assert.equal(npmLicence({ license: 'MIT' }), 'MIT')
  assert.equal(npmLicence({ license: { type: 'ISC' } }), 'ISC')
  assert.equal(npmLicence({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }), 'MIT OR Apache-2.0')
  assert.equal(npmLicence({}), 'unknown')
})

test('the lock reader and the LICENSE reader', () => {
  assert.deepEqual(readLock('# head\nnumpy==2.5.3\n\nscipy==1.18.1  # pinned\n'), [
    { name: 'numpy', version: '2.5.3' },
    { name: 'scipy', version: '1.18.1' },
  ])
  assert.throws(() => readLock('numpy>=2'), /not name==version/)
  assert.deepEqual(readLicenceFile('MIT License\n\nCopyright (c) 2026 githaltwastaken\n'), { licence: 'MIT', year: '2026', holder: 'githaltwastaken' })
})
