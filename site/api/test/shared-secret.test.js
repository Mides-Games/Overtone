import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bearerGuard, proxyGuard, sameSecret } from '../src/middlewares/shared-secret.js';

/** A request as much as the guards read of one. */
const request = (path, headers = {}) => {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { path, headers: lower, get: (name) => lower[name.toLowerCase()] };
};

/** Runs a middleware and returns what it passed to next: undefined to go on, or the error. */
const run = (middleware, req) => {
  let passed = 'not called';
  middleware(req, {}, (error) => {
    passed = error;
  });
  return passed;
};

const SECRET = 'p'.repeat(40);

test('sameSecret matches only the exact value', () => {
  assert.equal(sameSecret(SECRET, SECRET), true);
  assert.equal(sameSecret(`${SECRET}x`, SECRET), false);
  assert.equal(sameSecret(SECRET.slice(1), SECRET), false);
  assert.equal(sameSecret(undefined, SECRET), false);
  // An unset secret opens nothing, not even for an empty header.
  assert.equal(sameSecret('', ''), false);
});

test('the proxy guard lets through only what carries the secret', () => {
  const guard = proxyGuard(SECRET);
  assert.equal(run(guard, request('/api/v1/health', { 'X-Overtone-Proxy': SECRET })), undefined);

  for (const headers of [{}, { 'X-Overtone-Proxy': 'wrong' }, { 'X-Overtone-Proxy': '' }]) {
    const error = run(guard, request('/api/v1/health', headers));
    assert.equal(error?.status, 404, JSON.stringify(headers));
  }
});

test('the proxy guard leaves the worker routes to their bearer', () => {
  const guard = proxyGuard(SECRET);
  assert.equal(run(guard, request('/api/internal/jobs/claim')), undefined);
  assert.equal(run(guard, request('/api/internal')), undefined);
  // A look-alike prefix is not the internal tree.
  assert.equal(run(guard, request('/api/internalx/jobs'))?.status, 404);
  assert.equal(run(guard, request('/api/v1/internal/jobs'))?.status, 404);
});

test('without a secret (development) the proxy guard is open', () => {
  assert.equal(run(proxyGuard(''), request('/api/v1/health')), undefined);
});

test('the worker bearer demands the exact token', () => {
  const guard = bearerGuard('t'.repeat(43));
  assert.equal(run(guard, request('/api/internal/jobs/claim', { Authorization: `Bearer ${'t'.repeat(43)}` })), undefined);
  for (const value of [undefined, '', 'Bearer', `Bearer ${'t'.repeat(42)}`, `Basic ${'t'.repeat(43)}`, 't'.repeat(43)]) {
    const headers = value === undefined ? {} : { Authorization: value };
    assert.equal(run(guard, request('/api/internal/jobs/claim', headers))?.status, 401, String(value));
  }
});

test('an unset worker token refuses every worker', () => {
  assert.equal(run(bearerGuard(''), request('/api/internal/jobs/claim', { Authorization: 'Bearer ' }))?.status, 401);
});
