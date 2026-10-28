import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKEN_ROUTES } from '../src/middlewares/token.js';
import { readOpenApi } from '../../web/scripts/openapi.mjs';

/**
 * The document the /developers page renders (site/api/docs/openapi.yaml)
 * says which operations a personal token reaches (`x-token-scope`, W12.20).
 * It must say exactly what middlewares/token.js lets through, no more and no
 * less, or a tool written from the page would be refused, or a route would
 * be open without the page saying so.
 */
test('every operation marked for tokens is on the allow-list with the same scope, and the other way round', () => {
  const doc = readOpenApi();
  const marked = doc.operations
    .filter((op) => op.tokenScope)
    .map((op) => `${op.method} ${op.path} ${op.tokenScope}`)
    .sort();
  // The allow-list's paths, written as the document writes them.
  const sample = (re) => re.source
    .replace(/\\\//g, '/')
    .replace(/^\^/, '')
    .replace(/\/\?\$$/, '')
    .replace('[0-9a-f]{32}', '{id}')
    .replace('\\.(txt|csv)', '.@');
  const allowed = TOKEN_ROUTES.flatMap(({ method, path, scope }) => {
    const p = sample(path);
    const paths = p.endsWith('.@') ? [p.replace('.@', '.txt'), p.replace('.@', '.csv')] : [p];
    return paths.map((one) => `${method} ${one} ${scope ?? 'any'}`);
  }).sort();
  assert.deepEqual(marked, allowed);
});
