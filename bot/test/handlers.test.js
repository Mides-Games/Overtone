import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { createApi } from '../src/api.js';
import { createHandlers, createReported, EPHEMERAL } from '../src/handlers.js';
import { createLimiter, defaultLimits } from '../src/limits.js';
import { BOT_TOKEN, fakeApi, fakeCdn, interaction, summary } from './fakes.js';

let api;
let cdn;
before(async () => {
  api = await fakeApi();
  cdn = await fakeCdn();
});
after(() => {
  api.close();
  cdn.close();
});

let clock;
beforeEach(() => {
  clock = 0;
  api.state.requests.length = 0;
  api.state.uploadError = null;
  api.state.progress = [summary({ status: 'queued', position: 2 }), summary({ status: 'running', progress: 0.5, stage: 'tempo' }), summary()];
});

/** The handlers against the fakes, on a clock that moves only when the bot sleeps. */
const handlers = (extra = {}) =>
  createHandlers({
    api: createApi({ base: api.base, token: BOT_TOKEN }),
    limits: defaultLimits(() => clock),
    hosts: ['127.0.0.1'],
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    pollMs: 3000,
    log: { warn() {}, error() {} },
    ...extra,
  });

const audio = (path = '/song.mp3', overrides = {}) => ({
  name: 'My Song.mp3', size: 1000, contentType: 'audio/mpeg', url: `${cdn.base}${path}`, ...overrides,
});

const last = (i, kind) => i.log.filter(([k]) => k === kind).at(-1)?.[1];

test('/time-song downloads, uploads as the user, edits the reply as it waits, and answers with the embed', async () => {
  const i = interaction({ command: 'time-song', options: { audio: audio() } });
  await handlers().handle(i);

  const upload = api.state.requests.find((r) => r.method === 'POST' && r.path === '/analyses');
  assert.equal(upload.headers['x-discord-user'], '400000000000000004');
  assert.equal(upload.headers['x-filename'], 'My%20Song.mp3');
  assert.equal(upload.headers['content-type'], 'application/octet-stream');
  assert.equal(upload.body.length, 1000);
  assert.equal(upload.headers['x-private'], undefined);

  const edits = i.log.filter(([k]) => k === 'edit').map(([, m]) => m.content);
  assert.deepEqual(edits.slice(0, 3), ['Sending the song to Overtone…', 'In the queue, number 2.', 'Analysing: 50 % (tempo).']);
  const final = last(i, 'edit');
  assert.equal(final.content, '');
  const [embed] = final.embeds;
  assert.equal(embed.title, 'Timing: Artist - Song');
  assert.deepEqual(embed.fields.slice(0, 4).map((f) => [f.name, f.value]), [
    ['BPM', '150'], ['Offset', '123 ms'], ['Red lines', '1'], ['Confidence', 'high (97 %)'],
  ]);
  // No page: neither linked nor published here.
  assert.match(embed.description, /Link your Overtone account/);
});

test('/time-song in Spanish speaks Spanish', async () => {
  const i = interaction({ command: 'time-song', locale: 'es-419', options: { audio: audio() } });
  await handlers().handle(i);
  assert.equal(i.log.find(([k]) => k === 'edit')[1].content, 'Mandando la canción a Overtone…');
  assert.equal(last(i, 'edit').embeds[0].fields[3].value, 'alta (97 %)');
});

test('/time-song with publish publishes and links the public page; private sends X-Private', async () => {
  const i = interaction({ command: 'time-song', options: { audio: audio(), publish: true, private: true } });
  await handlers().handle(i);
  assert.equal(api.state.requests.find((r) => r.path === '/analyses').headers['x-private'], '1');
  assert.ok(api.state.requests.some((r) => r.method === 'POST' && r.path.endsWith('/publish')));
  const [embed] = last(i, 'edit').embeds;
  assert.equal(embed.url, `https://overtone.test/t/${'a'.repeat(32)}`);
});

test('an attachment is checked before a byte is downloaded: format, type, size and host', async () => {
  const cases = [
    [audio('/song.mp3', { name: 'notes.txt' }), /not an audio file Overtone reads\. Send MP3, OGG/],
    [audio('/song.mp3', { contentType: 'text/html' }), /does not look like audio/],
    [audio('/song.mp3', { size: 2 * 1_048_576 }), /larger than 1 MB/],
    [audio('/song.mp3', { url: 'https://evil.example/song.mp3' }), /not on Discord's servers/],
  ];
  for (const [att, message] of cases) {
    api.state.requests.length = 0;
    const i = interaction({ command: 'time-song', user: `4${String(Math.random()).slice(2, 19).padEnd(17, '0')}`, options: { audio: att } });
    await handlers().handle(i);
    const reply = last(i, 'reply');
    assert.match(reply.content, message);
    assert.equal(reply.flags, EPHEMERAL);
    assert.equal(api.state.requests.filter((r) => r.path === '/analyses').length, 0);
  }
});

test('what the CDN sends is checked too: a page is not audio, and a body past the cap is cut', async () => {
  for (const [path, message] of [['/page.mp3', /does not look like audio/], ['/big.mp3', /larger than 1 MB/]]) {
    api.state.requests.length = 0;
    const i = interaction({ command: 'time-song', options: { audio: audio(path) } });
    await handlers().handle(i);
    assert.match(last(i, 'edit').content, message);
    assert.equal(api.state.requests.filter((r) => r.path === '/analyses').length, 0);
  }
});

test('the API\'s refusals become sentences: the anonymous quota points at /link', async () => {
  api.state.uploadError = { status: 429, code: 'QUOTA_EXCEEDED', message: 'x', details: { limit: 5, scope: 'anonymous' } };
  const i = interaction({ command: 'time-song', options: { audio: audio() } });
  await handlers().handle(i);
  assert.match(last(i, 'edit').content, /Without a linked account you can analyse 5 songs a day here\. Link your Overtone account \(\/link\)/);

  api.state.uploadError = { status: 429, code: 'PENDING_LIMIT', message: 'x', details: { limit: 3 } };
  const j = interaction({ command: 'time-song', user: '400000000000000009', options: { audio: audio() } });
  await handlers().handle(j);
  assert.match(last(j, 'edit').content, /already have 3 songs in the queue/);
});

test('/time-song past Discord\'s edit window says so once, then posts the result in the channel', async () => {
  api.state.progress = [
    summary({ status: 'queued', position: 9 }), summary({ status: 'queued', position: 5 }), summary({ status: 'queued', position: 1 }),
    summary({ status: 'running', progress: 0.1 }), summary(),
  ];
  const reported = createReported();
  const i = interaction({ command: 'time-song', options: { audio: audio() } });
  await handlers({ pollMs: 5 * 60_000, reported }).handle(i);
  const contents = i.log.filter(([k]) => k === 'edit').map(([, m]) => m.content);
  assert.equal(contents.filter((c) => /15 minutes/.test(c)).length, 1);
  const posted = last(i, 'channel');
  assert.equal(posted.content, '<@400000000000000004>, your song is done:');
  assert.deepEqual(posted.allowedMentions, { users: ['400000000000000004'] });
  assert.ok(reported.has('a'.repeat(32)));

  // A channel the bot cannot write in: a DM instead.
  api.state.progress = [summary({ status: 'queued', position: 9 }), summary({ status: 'queued' }), summary({ status: 'queued' }), summary({ status: 'queued' }), summary()];
  const j = interaction({ command: 'time-song', user: '400000000000000008', options: { audio: audio() }, channelFails: true });
  await handlers({ pollMs: 5 * 60_000 }).handle(j);
  assert.ok(last(j, 'dm').embeds[0]);
});

test('a refused or failed analysis says so, with the engine\'s reason', async () => {
  api.state.progress = [summary({ status: 'refused', bpm: null, refusal: 'No steady pulse.', level: null })];
  const i = interaction({ command: 'time-song', options: { audio: audio() } });
  await handlers().handle(i);
  const [embed] = last(i, 'edit').embeds;
  assert.equal(embed.title, 'No reliable timing');
  assert.match(embed.description, /No steady pulse\./);
});

test('per-user limits: past them the bot answers privately and calls nothing', async () => {
  const limits = { any: createLimiter({ max: 2, windowMs: 60_000, now: () => clock }), upload: createLimiter({ max: 1, windowMs: 60_000, now: () => clock }) };
  const h = handlers({ limits });
  await h.handle(interaction({ command: 'queue' }));
  await h.handle(interaction({ command: 'queue' }));
  const before = api.state.requests.length;
  const i = interaction({ command: 'queue' });
  await h.handle(i);
  assert.match(last(i, 'reply').content, /try again in \d+ s/);
  assert.equal(last(i, 'reply').flags, EPHEMERAL);
  assert.equal(api.state.requests.length, before);
  // Another user is not held back.
  const j = interaction({ command: 'queue', user: '400000000000000007' });
  await h.handle(j);
  assert.ok(last(j, 'edit').embeds);
});

test('/timing takes a link or an id; anything else is refused privately', async () => {
  const id = 'a'.repeat(32);
  for (const ref of [id, `https://overtone.midesprojects.com/t/${id}`, `<https://overtone.test/analyze/${id.toUpperCase()}>`]) {
    const i = interaction({ command: 'timing', options: { timing: ref } });
    await handlers().handle(i);
    assert.equal(last(i, 'edit').embeds[0].fields[0].value, '150', ref);
  }
  const bad = interaction({ command: 'timing', options: { timing: 'https://overtone.test/profile' } });
  await handlers().handle(bad);
  assert.match(last(bad, 'reply').content, /32-character id/);

  const missing = interaction({ command: 'timing', options: { timing: 'b'.repeat(32) } });
  await handlers().handle(missing);
  assert.match(last(missing, 'edit').content, /No timing with that id/);
});

test('/compare shows both and how far apart they are', async () => {
  api.state.timings['c'.repeat(32)] = summary({ id: 'c'.repeat(32), title: 'Other', bpm: 151.5, offsetMs: 120 });
  const i = interaction({ command: 'compare', options: { a: 'a'.repeat(32), b: 'c'.repeat(32) } });
  await handlers().handle(i);
  const [embed] = last(i, 'edit').embeds;
  assert.equal(embed.fields[2].value, '1.5 BPM · -3 ms');
});

test('/queue, /recent, /link and /notify', async () => {
  const q = interaction({ command: 'queue' });
  await handlers().handle(q);
  assert.deepEqual(last(q, 'edit').embeds[0].fields.map((f) => f.value).slice(0, 3), ['3', '1', '7']);
  assert.match(last(q, 'edit').embeds[0].fields[3].value, /#2 · Mine/);

  const mapper = interaction({ command: 'recent', options: { user: { id: '500000000000000005', username: 'm' } } });
  await handlers().handle(mapper);
  assert.equal(last(mapper, 'edit').embeds[0].title, 'Latest timings of mapper');
  assert.equal(api.state.requests.at(-1).headers['x-discord-target'], '500000000000000005');
  const nobody = interaction({ command: 'recent' });
  await handlers().handle(nobody);
  assert.match(last(nobody, 'edit').content, /has not linked/);

  const good = interaction({ command: 'link', options: { code: 'GOOD-CODE' } });
  await handlers().handle(good);
  assert.deepEqual(good.log[0], ['defer', { flags: EPHEMERAL }]);
  assert.match(last(good, 'edit').content, /\*\*mapper\*\* on Overtone/);
  const bad = interaction({ command: 'link', options: { code: 'NOPE' } });
  await handlers().handle(bad);
  assert.match(last(bad, 'edit').content, /not valid or has expired/);

  const on = interaction({ command: 'notify', options: { state: 'on' } });
  await handlers().handle(on);
  assert.match(last(on, 'edit').content, /DMs on/);
  const unlinked = interaction({ command: 'notify', user: '400000000000000006', options: { state: 'off' } });
  await handlers().handle(unlinked);
  assert.match(last(unlinked, 'edit').content, /Link your Overtone account first/);
});

test('an API that does not answer is "not answering", not a stack trace', async () => {
  const h = createHandlers({
    api: createApi({ base: 'http://127.0.0.1:1', token: BOT_TOKEN }),
    limits: defaultLimits(),
    log: { warn() {}, error() {} },
  });
  const i = interaction({ command: 'queue' });
  await h.handle(i);
  assert.match(last(i, 'edit').content, /not answering/);
});

test('a song name cannot write markdown or mentions into the embed', async () => {
  api.state.progress = [summary({ title: '**bold** @everyone', artist: '# heading' })];
  const i = interaction({ command: 'time-song', options: { audio: audio() } });
  await handlers().handle(i);
  const { title } = last(i, 'edit').embeds[0];
  assert.ok(title.includes('\\*\\*bold\\*\\*'));
  assert.ok(title.includes('@​everyone'));
});
