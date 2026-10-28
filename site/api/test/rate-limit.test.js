import assert from 'node:assert/strict';
import { test } from 'node:test';

delete process.env.DATABASE_URL;
const { clientKey, guard, memoryCounter } = await import('../src/middlewares/rate-limit.js');

/** Runs a middleware and returns what it passed to next: undefined to go on, or the error. */
const run = async (middleware, ip = '203.0.113.7') => {
  let passed = 'not called';
  await middleware({ ip }, {}, (error) => {
    passed = error;
  });
  return passed;
};

test('a client past the limit gets 429 with how long to wait', async () => {
  const limit = guard('t-basic', 3, 60_000, { counter: memoryCounter() });
  for (let i = 0; i < 3; i++) assert.equal(await run(limit), undefined);
  const error = await run(limit);
  assert.equal(error.status, 429);
  assert.equal(error.code, 'RATE_LIMITED');
  assert.ok(Number(error.headers['Retry-After']) >= 59);
  // Another address has its own budget.
  assert.equal(await run(limit, '198.51.100.1'), undefined);
});

test('two processes count apart in memory, and together on a shared counter', async () => {
  // In memory each process has its own counter: a client alternating between
  // two of them gets twice the limit. That is what W3.17 is about.
  const apart = [guard('t-two', 2, 60_000, { counter: memoryCounter() }), guard('t-two', 2, 60_000, { counter: memoryCounter() })];
  const outcomes = [];
  for (let i = 0; i < 4; i++) outcomes.push(await run(apart[i % 2]));
  assert.deepEqual(outcomes, [undefined, undefined, undefined, undefined]);

  // With one counter behind both (the table, in production), the third is refused.
  const shared = memoryCounter();
  const together = [guard('t-two', 2, 60_000, { counter: shared }), guard('t-two', 2, 60_000, { counter: shared })];
  const results = [];
  for (let i = 0; i < 4; i++) results.push((await run(together[i % 2]))?.status);
  assert.deepEqual(results, [undefined, undefined, 429, 429]);
});

test('the counter never sees the address, only its keyed hash', async () => {
  const seen = [];
  const counter = { hit: async (bucket, client) => (seen.push(client), { count: 1, waitMs: 1000 }) };
  await run(guard('t-hash', 5, 60_000, { counter }), '192.0.2.44');
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].includes('192.0.2.44'));
  assert.match(seen[0], /^[0-9a-f]{32}$/);
  assert.equal(seen[0], clientKey('192.0.2.44'));
  assert.notEqual(clientKey('192.0.2.44'), clientKey('192.0.2.45'));
});

test('when the shared count fails the request still passes, counted in this process', async () => {
  const broken = { hit: async () => { throw new Error('connection refused'); } };
  const limit = guard('t-down', 2, 60_000, { counter: broken });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await run(limit), undefined);
    assert.equal(await run(limit), undefined);
    assert.equal((await run(limit))?.status, 429);
  } finally {
    console.warn = warn;
  }
});

test('a window that has passed starts again at one', async () => {
  const counter = memoryCounter();
  const limit = guard('t-window', 1, 20, { counter });
  assert.equal(await run(limit), undefined);
  assert.equal((await run(limit))?.status, 429);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await run(limit), undefined);
});
