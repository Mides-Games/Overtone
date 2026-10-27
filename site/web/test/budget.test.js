import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chunkName, initialScripts } from '../scripts/budget.mjs'

/** scripts/budget.mjs (W10.1): which scripts count as initial, and the names budgets are keyed by. */

test('initial scripts are the entry and its modulepreloads, nothing lazy', () => {
  const html = `
    <script type="module" crossorigin src="/assets/index-CQ0WoU3g.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/jsx-runtime-CSqUQ5a1.js">
    <link rel="stylesheet" crossorigin href="/assets/index-Dw7XjRoo.css">
    <script>try { localStorage.getItem('mides.theme') } catch {}</script>`
  assert.deepEqual(initialScripts(html), ['assets/index-CQ0WoU3g.js', 'assets/jsx-runtime-CSqUQ5a1.js'])
})

test('a chunk is budgeted by its source name, hash removed', () => {
  assert.equal(chunkName('AnalysisResult-C6CAyQ1W.js'), 'AnalysisResult')
  assert.equal(chunkName('rolldown-runtime-WkwZ5CU-.js'), 'rolldown-runtime')
  assert.equal(chunkName('chunk-OB3PAWPO-BbwZzqhw.js'), 'chunk-OB3PAWPO')
})
