import assert from 'node:assert/strict';
import { test } from 'node:test';

delete process.env.DATABASE_URL;
const { analyses, fairOrder } = await import('../src/services/analysis.service.js');

const job = (seq, owner) => ({ owner, job: { seq } });
const names = (list) => list.map((a) => `${a.owner}${a.job.seq}`);

test('a batch takes turns with everybody else instead of going first in full', () => {
  // A sends four, then B one, then C one, then A one more.
  const queued = [job(1, 'A'), job(2, 'A'), job(3, 'A'), job(4, 'A'), job(5, 'B'), job(6, 'C'), job(7, 'A')];
  assert.deepEqual(names(fairOrder(queued, (a) => a.owner)), ['A1', 'B5', 'C6', 'A2', 'A3', 'A4', 'A7']);
});

test('between equal turns whoever was served longest ago goes first', () => {
  // A's first song already ran: A's next is A's 1st queued again, but B and C were never served.
  const queued = [job(2, 'A'), job(3, 'A'), job(5, 'B'), job(6, 'C')];
  const served = { A: 1000 };
  assert.deepEqual(names(fairOrder(queued, (a) => a.owner, (o) => served[o] ?? 0)), ['B5', 'C6', 'A2', 'A3']);
});

test('one person alone keeps the order they sent', () => {
  const queued = [job(3, 'A'), job(1, 'A'), job(2, 'A')];
  assert.deepEqual(names(fairOrder(queued, (a) => a.owner)), ['A1', 'A2', 'A3']);
});

test('the memory store claims, positions and counts by the same fair order', async () => {
  const store = analyses();
  let n = 0;
  const upload = (who) =>
    store.create({
      publicId: (++n).toString(16).padStart(32, '0'),
      sha1: 'e'.repeat(40),
      filename: `${who}${n}.mp3`,
      sizeBytes: 1,
      accountId: who === 'user' ? 'acct-1' : null,
      ipHash: who === 'user' ? 'ip-user' : `ip-${who}`,
    });
  for (let i = 0; i < 3; i++) await upload('batch');
  await upload('single');
  await upload('user');

  assert.deepEqual(await store.countPending({ ipHash: 'ip-batch' }), { mine: 3, all: 5 });
  assert.deepEqual(await store.countPending({ accountId: 'acct-1', ipHash: 'ip-other' }), { mine: 1, all: 5 });

  const { live } = await store.queue();
  assert.deepEqual(live.map((r) => [r.filename, r.position]), [
    ['batch1.mp3', 1],
    ['single4.mp3', 2],
    ['user5.mp3', 3],
    ['batch2.mp3', 4],
    ['batch3.mp3', 5],
  ]);
  assert.equal((await store.get((4).toString(16).padStart(32, '0'))).position, 2);

  const claimed = [];
  for (let i = 0; i < 5; i++) claimed.push((await store.claim()).filename);
  assert.deepEqual(claimed, ['batch1.mp3', 'single4.mp3', 'user5.mp3', 'batch2.mp3', 'batch3.mp3']);
  assert.deepEqual(await store.countPending({ ipHash: 'ip-batch' }), { mine: 3, all: 5 });
});
