import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApi } from '../src/api.js';
import { checkAttachment } from '../src/attachment.js';
import { COMMANDS, parseRef } from '../src/commands.js';
import { loadConfig, offMessage } from '../src/config.js';
import { createReported } from '../src/handlers.js';
import { createNotifier } from '../src/notifier.js';
import { registerCommands } from '../src/register.js';
import { STRINGS, langOf } from '../src/strings.js';
import { BOT_TOKEN, fakeApi, summary } from './fakes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let api;
before(async () => {
  api = await fakeApi();
});
after(() => api.close());

test('the DM outbox: each notice sent once, an already-answered one skipped, a refused DM tolerated', async () => {
  const reported = createReported();
  reported.add('b'.repeat(32));
  api.state.dms = [
    { discordId: '600000000000000001', analysis: summary() },
    { discordId: '600000000000000002', analysis: summary({ id: 'b'.repeat(32) }) },
    { discordId: '600000000000000003', analysis: summary({ id: 'c'.repeat(32) }) },
  ];
  const sent = [];
  const warnings = [];
  const notifier = createNotifier({
    api: createApi({ base: api.base, token: BOT_TOKEN }),
    reported,
    log: { warn: (line) => warnings.push(line) },
    sendDm: async (id, message) => {
      if (id === '600000000000000003') throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
      sent.push([id, message]);
    },
  });
  assert.equal(await notifier.tick(), 1);
  assert.equal(sent[0][0], '600000000000000001');
  assert.equal(sent[0][1].embeds[0].title, 'Timing: Artist - Song');
  // The warning names the error, never the Discord id.
  assert.ok(warnings.every((w) => !w.includes('600000000000000003')));
  assert.equal(await notifier.tick(), 0);
});

test('an outbox that cannot be read is a warning, not a crash', async () => {
  const notifier = createNotifier({ api: createApi({ base: 'http://127.0.0.1:1', token: BOT_TOKEN }), sendDm: async () => {}, log: { warn() {} } });
  assert.equal(await notifier.tick(), 0);
});

test('commands are valid for Discord: names, description lengths, option counts, required first', () => {
  const names = COMMANDS.map((c) => c.name);
  assert.deepEqual(names, ['time-song', 'timing', 'queue', 'compare', 'recent', 'link', 'notify']);
  const described = (thing) => {
    assert.match(thing.name, /^[-_a-z0-9]{1,32}$/);
    assert.ok(thing.description.length >= 1 && thing.description.length <= 100, thing.description);
    for (const text of Object.values(thing.description_localizations ?? {})) assert.ok(text.length <= 100, text);
  };
  for (const command of COMMANDS) {
    described(command);
    const options = command.options ?? [];
    assert.ok(options.length <= 25);
    options.forEach(described);
    const firstOptional = options.findIndex((o) => !o.required);
    if (firstOptional >= 0) assert.ok(options.slice(firstOptional).every((o) => !o.required), `${command.name}: required after optional`);
  }
});

test('a timing reference is an id or a /t/ or /analyze/ link, nothing else', () => {
  const id = '0123456789abcdef0123456789abcdef';
  assert.equal(parseRef(id), id);
  assert.equal(parseRef(` ${id.toUpperCase()} `), id);
  assert.equal(parseRef(`https://overtone.midesprojects.com/t/${id}`), id);
  assert.equal(parseRef(`https://staging.example/analyze/${id}/`), id);
  assert.equal(parseRef(`https://x.example/t/${id}/extra`), null);
  assert.equal(parseRef('javascript:alert(1)'), null);
  assert.equal(parseRef(''), null);
});

test('attachments: the extension, the type and the size against the site\'s cap', () => {
  const ok = { name: 'a.flac', size: 10, contentType: 'audio/flac', url: 'https://cdn.discordapp.com/attachments/1/2/a.flac' };
  const opts = { maxBytes: 100, extensions: ['flac', 'mp3'] };
  assert.deepEqual(checkAttachment(ok, opts), { ok: true });
  assert.deepEqual(checkAttachment({ ...ok, contentType: null }, opts), { ok: true });
  assert.deepEqual(checkAttachment({ ...ok, contentType: 'application/octet-stream' }, opts), { ok: true });
  assert.equal(checkAttachment({ ...ok, name: 'a.flac.exe' }, opts).reason, 'format');
  assert.equal(checkAttachment({ ...ok, contentType: 'image/png' }, opts).reason, 'type');
  assert.equal(checkAttachment({ ...ok, size: 101 }, opts).reason, 'size');
  assert.equal(checkAttachment({ ...ok, size: 0 }, opts).reason, 'size');
  assert.equal(checkAttachment({ ...ok, url: 'https://cdn.discordapp.com.evil.example/a.flac' }, opts).reason, 'host');
  assert.equal(checkAttachment({ ...ok, url: 'file:///etc/passwd' }, opts).reason, 'host');
});

test('both languages say the same things', () => {
  const shape = (tree) => Object.entries(tree).map(([k, v]) => [k, typeof v === 'object' ? shape(v) : typeof v]);
  assert.deepEqual(shape(STRINGS.es), shape(STRINGS.en));
  assert.equal(langOf('es-ES'), 'es');
  assert.equal(langOf('es-419'), 'es');
  assert.equal(langOf('en-GB'), 'en');
  assert.equal(langOf(undefined), 'en');
});

test('config: off, naming what is missing, until all three are set', () => {
  const none = loadConfig({});
  assert.equal(none.ok, false);
  assert.deepEqual(none.missing, ['DISCORD_TOKEN', 'BOT_TOKEN', 'OVERTONE_API']);
  assert.match(offMessage(none), /OFF: DISCORD_TOKEN, BOT_TOKEN, OVERTONE_API are not set/);
  const short = loadConfig({ DISCORD_TOKEN: 'x', BOT_TOKEN: 'short', OVERTONE_API: 'ftp://x' });
  assert.equal(short.ok, false);
  assert.equal(short.problems.length, 2);
  const all = loadConfig({ DISCORD_TOKEN: 'x', BOT_TOKEN: BOT_TOKEN, OVERTONE_API: 'http://10.0.0.2:3001/' });
  assert.equal(all.ok, true);
  assert.equal(all.apiUrl, 'http://10.0.0.2:3001');
});

test('the bot started without its secrets says it is off and exits 0, without loading discord.js', () => {
  const env = { ...process.env };
  for (const name of ['DISCORD_TOKEN', 'BOT_TOKEN', 'OVERTONE_API']) delete env[name];
  const run = spawnSync(process.execPath, [join(ROOT, 'src', 'index.js')], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /\[overtone-bot\] OFF: DISCORD_TOKEN, BOT_TOKEN, OVERTONE_API are not set/);
});

test('registering PUTs the whole list to the guild or the application, as the bot', async () => {
  const seen = [];
  const rest = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(JSON.parse(body).map((c, i) => ({ id: String(i), name: c.name }))));
  });
  rest.listen(0, '127.0.0.1');
  await once(rest, 'listening');
  const base = `http://127.0.0.1:${rest.address().port}`;
  try {
    const guild = await registerCommands({ token: 'tok', appId: '700000000000000001', guildId: '800000000000000001', api: base });
    assert.equal(guild.scope, 'guild');
    assert.equal(guild.names.length, COMMANDS.length);
    assert.deepEqual(seen[0].method, 'PUT');
    assert.equal(seen[0].url, '/applications/700000000000000001/guilds/800000000000000001/commands');
    assert.equal(seen[0].auth, 'Bot tok');
    assert.deepEqual(seen[0].body, COMMANDS);
    const global = await registerCommands({ token: 'tok', appId: '700000000000000001', api: base });
    assert.equal(global.scope, 'global');
    assert.equal(seen[1].url, '/applications/700000000000000001/commands');
    await assert.rejects(registerCommands({ token: 'tok', appId: 'nope', api: base }), /DISCORD_APP_ID/);
  } finally {
    rest.close();
  }
});

test('discord.js loads at its pin and has what index.js uses', async () => {
  const { Client, Events, GatewayIntentBits, version } = await import('discord.js');
  assert.equal(version, '14.27.0');
  assert.equal(typeof Events.InteractionCreate, 'string');
  assert.equal(typeof Events.ClientReady, 'string');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  assert.equal(typeof client.users.send, 'function');
  await client.destroy();
});

test('the register script refuses to run without its token and app id', () => {
  const env = { ...process.env };
  delete env.DISCORD_TOKEN;
  delete env.DISCORD_APP_ID;
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'register.mjs')], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /DISCORD_TOKEN and DISCORD_APP_ID not set/);
});
