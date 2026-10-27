import { once } from 'node:events';
import { createServer } from 'node:http';

/**
 * Stand-ins for the tests: site/api's /api/internal/bot, Discord's CDN and
 * an interaction. The API answers from `state`, which each test shapes, and
 * records every request so the tests can say what the bot sent.
 */

export const BOT_TOKEN = 'b'.repeat(40);

const listen = async (handler) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => (server.closeAllConnections(), server.close()) };
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
};

export const summary = (overrides = {}) => ({
  id: 'a'.repeat(32), status: 'done', title: 'Song', artist: 'Artist', bpm: 150, offsetMs: 123, redLines: 1,
  variable: false, meter: '4/4', level: 'high', confidence: 0.97, refusal: null, error: null, cached: false,
  published: false, url: null, ...overrides,
});

export const fakeApi = async () => {
  const state = {
    requests: [],
    health: { ok: true, siteUrl: 'https://overtone.test', maxUploadMb: 1, extensions: ['mp3', 'ogg', 'wav', 'flac', 'm4a', 'opus'] },
    // GET /analyses/:id answers these in turn, the last one forever.
    progress: [summary({ status: 'queued', position: 2 }), summary({ status: 'running', progress: 0.5, stage: 'tempo' }), summary()],
    uploadError: null,
    timings: { ['a'.repeat(32)]: summary({ published: true, url: 'https://overtone.test/t/' + 'a'.repeat(32) }) },
    dms: [],
  };
  const api = await listen(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace('/api/internal/bot', '');
    state.requests.push({ method: req.method, path, headers: req.headers, body });
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${BOT_TOKEN}`) return send(401, { error: { status: 401, code: 'UNAUTHORIZED' } });
    if (req.method === 'GET' && path === '/health') return send(200, state.health);
    if (req.method === 'POST' && path === '/analyses') {
      if (state.uploadError) return send(state.uploadError.status, { error: state.uploadError });
      return send(202, { id: 'a'.repeat(32), status: 'queued', cached: false });
    }
    let m = /^\/analyses\/([0-9a-f]{32})$/.exec(path);
    if (req.method === 'GET' && m) {
      const next = state.progress.length > 1 ? state.progress.shift() : state.progress[0];
      return send(200, next);
    }
    m = /^\/analyses\/([0-9a-f]{32})\/publish$/.exec(path);
    if (req.method === 'POST' && m) return send(200, summary({ published: true, url: `https://overtone.test/t/${m[1]}` }));
    m = /^\/timings\/([0-9a-f]{32})$/.exec(path);
    if (req.method === 'GET' && m) {
      return state.timings[m[1]] ? send(200, state.timings[m[1]]) : send(404, { error: { status: 404, code: 'NOT_FOUND', message: 'No such timing.' } });
    }
    if (req.method === 'GET' && path === '/queue') {
      return send(200, { waiting: 3, running: 1, finishedLastHour: 7, mine: [{ id: 'a'.repeat(32), status: 'queued', title: 'Mine', artist: null, position: 2 }] });
    }
    if (req.method === 'GET' && path === '/recent') {
      return req.headers['x-discord-target'] === '500000000000000005'
        ? send(200, { linked: true, username: 'mapper', timings: [summary({ published: true, url: 'https://overtone.test/t/x' })] })
        : send(200, { linked: false, timings: [] });
    }
    if (req.method === 'POST' && path === '/link') {
      const { code } = JSON.parse(body.toString() || '{}');
      return code === 'GOOD-CODE' ? send(200, { linked: true, username: 'mapper' }) : send(400, { error: { status: 400, code: 'BAD_LINK_CODE', message: 'bad' } });
    }
    if (req.method === 'PUT' && path === '/notify') {
      return req.headers['x-discord-user'] === '400000000000000004'
        ? send(200, { notify: JSON.parse(body.toString()).on })
        : send(409, { error: { status: 409, code: 'DISCORD_NOT_LINKED', message: 'link first' } });
    }
    if (req.method === 'POST' && path === '/dms/claim') {
      const dms = state.dms;
      state.dms = [];
      return send(200, { dms });
    }
    return send(404, { error: { status: 404, code: 'NOT_FOUND' } });
  });
  return { ...api, state };
};

/** Discord's CDN: /song.mp3 (audio), /page.mp3 (HTML), /big.mp3 (over 1 MB, declared or not). */
export const fakeCdn = async () =>
  listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/song.mp3') {
      // ?v=<n> is another song: other bytes, so another SHA-1.
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '1000' });
      return res.end(Buffer.alloc(1000, Number(url.searchParams.get('v') ?? 7) % 256));
    }
    if (req.url === '/page.mp3') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html></html>');
    }
    if (req.url === '/big.mp3') {
      // Chunked, no length: the cap has to count.
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      const chunk = Buffer.alloc(64 * 1024, 1);
      let left = 40;
      const pump = () => {
        while (left > 0) {
          left -= 1;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        return res.end();
      };
      return pump();
    }
    res.writeHead(404);
    return res.end();
  });

/** A ChatInputCommandInteraction as far as handlers.js reads one; `log` is what the bot did with it. */
export const interaction = ({ command, user = '400000000000000004', locale = 'en-US', options = {}, channelFails = false }) => {
  const log = [];
  const i = {
    commandName: command,
    locale,
    user: { id: user, username: 'tester', send: async (m) => log.push(['dm', m]) },
    deferred: false,
    replied: false,
    options: {
      getAttachment: (n) => options[n] ?? null,
      getString: (n) => options[n] ?? null,
      getBoolean: (n) => options[n] ?? null,
      getUser: (n) => options[n] ?? null,
    },
    reply: async (m) => {
      i.replied = true;
      log.push(['reply', m]);
    },
    deferReply: async (m) => {
      i.deferred = true;
      log.push(['defer', m]);
    },
    editReply: async (m) => log.push(['edit', m]),
    followUp: async (m) => log.push(['followUp', m]),
    channel: {
      send: async (m) => {
        if (channelFails) throw new Error('Missing Access');
        log.push(['channel', m]);
      },
    },
    log,
  };
  return i;
};
