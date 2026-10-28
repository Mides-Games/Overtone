import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { openapiPath, parseYaml, readOpenApi, reduce, schemaLine } from '../scripts/openapi.mjs'
import { curlExample, tokenFormProblem } from '../src/lib/api-tokens.js'
import { groupOperations, prose } from '../src/lib/openapi-view.js'

/**
 * `/developers` renders site/api/docs/openapi.yaml through a YAML reader of
 * our own (W12.20). These hold it to the corner of YAML the document uses,
 * and make it refuse, loudly, what it does not read.
 */

test('the YAML reader reads mappings, sequences, flow collections, quotes and blocks', () => {
  const doc = parseYaml(
    [
      '# a comment',
      'a: 1',
      'b: 0.5',
      "c: 'it''s'",
      'd: "x\\"y\\u0041"',
      'e: [one, "two, three", { k: v }]',
      'f: { type: [string, \'null\'], description: The caller\'s own rows. }',
      'g:',
      '  - plain',
      '  - k: v',
      '    l: [1, 2]',
      '  -',
      '    m: true',
      'h: |',
      '  line one',
      '',
      '  line two',
      'i: >-',
      '  folded',
      '  together',
      '',
      '  apart',
      'j:',
      '  nested: null',
      '  "200": { $ref: \'#/x\' }',
      'k: plain words go',
      '  on to the next line',
      'l:',
      '- at the same indent',
      'm: [a,',
      '    b]',
    ].join('\n'),
  )
  assert.deepEqual(doc, {
    a: 1,
    b: 0.5,
    c: "it's",
    d: 'x"yA',
    e: ['one', 'two, three', { k: 'v' }],
    f: { type: ['string', 'null'], description: "The caller's own rows." },
    g: ['plain', { k: 'v', l: [1, 2] }, { m: true }],
    h: 'line one\n\nline two\n',
    i: 'folded together\napart',
    j: { nested: null, 200: { $ref: '#/x' } },
    k: 'plain words go on to the next line',
    l: ['at the same indent'],
    m: ['a', 'b'],
  })
})

test('the YAML reader refuses what it does not read, with the line', () => {
  const refuses = (text, pattern) => assert.throws(() => parseYaml(text), pattern, text)
  refuses('a: 1\na: 2', /line 2: "a" is given twice/)
  refuses('a: &anchor 1', /"&" is not read/)
  refuses('a: *anchor', /"\*" is not read/)
  refuses('a: value # comment', /comment after a plain value/)
  refuses('a: { b: c, d }', /"d" has no value/)
  refuses('a: [1, 2', /never closed/)
  refuses("a: 'open", /not closed/)
  refuses('a:\n\tb: 1', /tab in the indentation/)
  refuses('a: 1\n   b: 2', /unexpected indentation/)
  refuses('just text', /expected "key: value"/)
})

test('the real document reads, every $ref in it resolves, and the reduced page has every operation', () => {
  const raw = parseYaml(readFileSync(openapiPath, 'utf8'))
  assert.equal(raw.openapi, '3.1.0')
  const refs = [...JSON.stringify(raw).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((m) => m[1])
  assert.ok(refs.length > 50)
  for (const ref of refs) {
    const target = ref.split('/').reduce((node, key) => node?.[key], raw)
    assert.ok(target, `#/${ref} resolves`)
  }
  const page = readOpenApi()
  const count = Object.values(raw.paths).reduce((n, item) => n + ['get', 'post', 'put', 'patch', 'delete'].filter((m) => item[m]).length, 0)
  assert.equal(page.operations.length, count)
  for (const op of page.operations) {
    assert.ok(op.summary, `${op.method} ${op.path} has a summary`)
    assert.ok(op.responses.length, `${op.method} ${op.path} has responses`)
  }
  assert.equal(new Set(page.operations.map((op) => op.id)).size, page.operations.length, 'ids are unique anchors')
  // The token routes are marked, the token routes' own management is not.
  const scope = (method, path) => page.operations.find((op) => op.method === method && op.path === path)?.tokenScope
  assert.equal(scope('POST', '/analyses'), 'upload')
  assert.equal(scope('GET', '/timings'), 'read:timings')
  assert.equal(scope('POST', '/me/tokens'), null)
  assert.equal(scope('POST', '/analyses/{id}/publish'), null)
})

test('a schema reads in one line', () => {
  assert.equal(schemaLine({ $ref: '#/components/schemas/Token' }), 'Token')
  assert.equal(schemaLine({ type: ['string', 'null'], pattern: '^a$' }), 'string | null /^a$/')
  assert.equal(schemaLine({ type: 'array', items: { type: 'string', enum: ['x', 'y'] } }), 'string ("x", "y")[]')
  assert.equal(schemaLine({ const: 'overtone-web' }), '"overtone-web"')
  const page = reduce({ paths: { '/a/b': { get: { summary: 's', responses: { 200: { description: 'ok' } } } } } })
  assert.deepEqual(page.operations[0].responses, [{ status: '200', description: 'ok', schema: null }])
})

test('the page groups operations by their first segment and splits descriptions into paragraphs', () => {
  const groups = groupOperations([{ path: '/me' }, { path: '/analyses/{id}' }, { path: '/me/tokens' }, { path: '/analyses' }])
  assert.deepEqual(groups.map((g) => [g.name, g.operations.length]), [['/me', 2], ['/analyses', 2]])
  assert.deepEqual(prose('one\nline\n\n  two\n'), ['one line', 'two'])
  assert.deepEqual(prose(null), [])
})

test('the tokens form checks a name and its scopes before anything is sent', () => {
  assert.equal(tokenFormProblem('  ', ['upload']), 'name')
  assert.equal(tokenFormProblem('x'.repeat(61), ['upload']), 'long')
  assert.equal(tokenFormProblem('bot', []), 'scopes')
  assert.equal(tokenFormProblem('bot', ['admin']), 'scopes')
  assert.equal(tokenFormProblem('bot', ['read:analyses', 'upload']), null)
  assert.equal(curlExample('https://x.test'), 'curl -H "Authorization: Bearer $OVERTONE_TOKEN" https://x.test/api/v1/me/analyses')
})
