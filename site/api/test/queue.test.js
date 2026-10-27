import assert from 'node:assert/strict';
import { test } from 'node:test';

import { queueEntry } from '../src/utils/queue.js';
import { cleanTag, songLabel } from '../src/utils/upload.js';

const base = {
  publicId: 'a'.repeat(32),
  status: 'queued',
  position: 2,
  filename: 'Some_Artist.-.Song.mp3',
  tagTitle: 'Song',
  tagArtist: 'Artist',
  private: false,
  uploader: { username: 'mapper', displayName: 'Mapper', avatarUrl: 'https://cdn.example/a.png', id: 'secret' },
  createdAt: '2026-10-26T10:00:00.000Z',
  finishedAt: null,
  anonHash: 'hash',
  accountId: 'acct',
};
const now = Date.parse('2026-10-26T10:01:30.000Z');

test('a song is named by its tags, then by its cleaned file name', () => {
  assert.equal(songLabel({ tagArtist: 'A', tagTitle: 'T', filename: 'x.mp3' }), 'A - T');
  assert.equal(songLabel({ tagTitle: 'T', filename: 'x.mp3' }), 'T');
  assert.equal(songLabel({ tagArtist: 'A', filename: 'My_Song.v2.ogg' }), 'My Song v2');
  assert.equal(songLabel({ filename: null }), null);
});

test('a tag loses control characters and markup brackets and is cut to 200', () => {
  assert.equal(cleanTag(encodeURIComponent('AC/DC')), 'AC/DC');
  assert.equal(cleanTag('a\u0000<b>\n c'), 'ab c');
  assert.equal(cleanTag('x'.repeat(300)).length, 200);
  assert.equal(cleanTag('   '), null);
  assert.equal(cleanTag(undefined), null);
});

test('a public entry shows the song and the public profile only', () => {
  const entry = queueEntry(base, { now });
  assert.equal(entry.song, 'Artist - Song');
  assert.deepEqual(entry.uploader, { username: 'mapper', displayName: 'Mapper', avatarUrl: 'https://cdn.example/a.png' });
  assert.equal(entry.anonymous, false);
  assert.equal(entry.position, 2);
  assert.equal(entry.elapsedS, 90);
  for (const key of ['id', 'filename', 'anonHash', 'accountId', 'publicId', 'sha1']) assert.ok(!(key in entry), key);
});

test('a private entry shows neither song nor uploader, nor whether there was one', () => {
  const entry = queueEntry({ ...base, private: true }, { now });
  assert.equal(entry.song, null);
  assert.equal(entry.uploader, null);
  assert.equal(entry.anonymous, null);
  assert.equal(entry.private, true);
  assert.equal(entry.status, 'queued');
});

test('only the uploader gets the id to open it', () => {
  assert.equal(queueEntry(base, { mine: true, now }).id, base.publicId);
  assert.ok(!('id' in queueEntry(base, { mine: false, now })));
});

test('a finished entry measures from upload to finish and drops the position', () => {
  const entry = queueEntry({ ...base, status: 'done', finishedAt: '2026-10-26T10:00:42.000Z' }, { now });
  assert.equal(entry.elapsedS, 42);
  assert.ok(!('position' in entry));
  const running = queueEntry({ ...base, status: 'running', progress: 0.5, stage: 'tempo' }, { now });
  assert.equal(running.progress, 0.5);
  assert.equal(running.stage, 'tempo');
});

test('the memory queue lists running first, then queued in claim order, then the finished', async () => {
  delete process.env.DATABASE_URL;
  const { analyses } = await import('../src/services/analysis.service.js');
  const store = analyses();
  const make = (n) =>
    store.create({ publicId: String(n).repeat(32), sha1: 'f'.repeat(40), filename: `${n}.mp3`, sizeBytes: 1 });
  for (const n of [1, 2, 3, 4]) await make(n);
  const first = await store.claim();
  await store.finish(first.publicId, first.attempt, { engine_hash: 'abcdef12', refused: false });
  await store.claim();

  const { live, more, recent } = await store.queue();
  assert.deepEqual(live.map((r) => [r.filename, r.status, r.position]), [
    ['2.mp3', 'running', null],
    ['3.mp3', 'queued', 1],
    ['4.mp3', 'queued', 2],
  ]);
  assert.equal(more, 0);
  assert.deepEqual(recent.map((r) => r.filename), ['1.mp3']);
});
