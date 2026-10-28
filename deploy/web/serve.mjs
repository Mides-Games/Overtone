#!/usr/bin/env node
/*
 * overtone-web: serves the built site and forwards /api to overtone-api.
 *
 *   PORT=8080 WEB_ROOT=site/web/dist API_UPSTREAM=http://127.0.0.1:4012 node deploy/web/serve.mjs
 *
 * One process per environment, no dependencies. The browser only ever talks
 * to this origin, so the API needs no CORS and no public hostname of its own:
 * the TLS proxy in front of the node publishes this port and nothing else.
 *
 * Static files are read from WEB_ROOT. A path that is not a file falls back
 * to index.html (the app routes on the client). Vite's hashed /assets/* are
 * cached for a year; index.html is never cached, so a release is visible on
 * the next load. Text files are sent brotli or gzip compressed when the
 * browser asks (W10.1), compressed once per file version and kept in memory.
 *
 * TRUSTED_PROXY_ADDRS is the comma-separated addresses or CIDR ranges of the
 * TLS proxy in front (Cloudflare's published ranges, docs/deploy.md). The API
 * counts its rate limit and quotas per client address, and everything it
 * receives comes from here, so the X-Forwarded-For it reads has to be one this
 * process vouches for. A connection from inside TRUSTED_PROXY_ADDRS keeps the
 * last TRUSTED_PROXY_HOPS (default 1) entries of its header (the ones the
 * proxies appended) plus its own address; whatever a client wrote further left
 * is dropped. Any other connection, including everyone while the variable is
 * empty, has its header discarded whole and is forwarded as its own address.
 * The API trusts this process and those hops, TRUST_PROXY = TRUSTED_PROXY_HOPS
 * + 1, which names the real client in both cases.
 *
 * API_TIMEOUT_S (default 60) cuts a forwarded request whose connection to the
 * API has been idle that long (504), so an API that hangs cannot pin this
 * process's sockets. Idle, not total: an upload that keeps moving is not cut.
 *
 * MIDES_WEB_URL and MIDES_IMAGE_ORIGINS (the API's own values) are the only
 * origins besides this one that images load from (img-src). Unset, only this
 * origin and data: are allowed, and avatars show their initials.
 *
 * HSTS (default 1) sends Strict-Transport-Security with every page. Set it to
 * 0 only when the site is served over plain http, as on a laptop.
 *
 * /t/<id>, a published timing's page (W3.27), is index.html with that
 * timing's title and Open Graph tags written into its head, read from the
 * API's /timings/<id>/card and escaped, so a link shared on Discord shows
 * the song, its BPM and who timed it. Without a card in 1.5 s, or for a
 * timing that is not published, it is the plain index.html.
 *
 * /embed/<id> (W12.18) is the one page another site may frame: its CSP says
 * frame-ancestors * and it has no X-Frame-Options. Every other response keeps
 * frame-ancestors 'none' and X-Frame-Options: DENY.
 *
 * /sw.js, the service worker (W12.23), is served no-cache with
 * Service-Worker-Allowed: /, and a POST to /share-target that no worker
 * answered is a 303 to /analyze, its body never read.
 *
 * PROXY_SECRET is the same value as the API's: every request forwarded to the
 * API carries it in X-Overtone-Proxy, and the API answers 404 to anything
 * without it, because on the panel the API's own port is public too. A
 * client's own X-Overtone-Proxy is dropped. /api/internal/* (the worker's
 * routes) is never forwarded at all.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 8080);
const ROOT = path.resolve(process.env.WEB_ROOT || 'site/web/dist');
const UPSTREAM = new URL(process.env.API_UPSTREAM || 'http://127.0.0.1:4012');
const HOPS = hops(process.env.TRUSTED_PROXY_HOPS);
const TRUSTED = trustedProxies(process.env.TRUSTED_PROXY_ADDRS);
const IMAGE_ORIGINS = imageOrigins(process.env.MIDES_WEB_URL, process.env.MIDES_IMAGE_ORIGINS);
const HSTS = !['0', 'false', 'no'].includes(String(process.env.HSTS ?? '1').trim().toLowerCase());
const API_TIMEOUT_MS = seconds(process.env.API_TIMEOUT_S, 60) * 1000;
const PROXY_HEADER = 'x-overtone-proxy';
const PROXY_SECRET = (process.env.PROXY_SECRET || '').trim();
if (PROXY_SECRET && PROXY_SECRET.length < 32) {
  console.error('overtone-web: PROXY_SECRET must be at least 32 characters');
  process.exit(1);
}

function hops(raw) {
  if (raw === undefined || String(raw).trim() === '') return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10) {
    console.error(`overtone-web: TRUSTED_PROXY_HOPS must be an integer from 0 to 10 (got "${raw}")`);
    process.exit(1);
  }
  return n;
}

// The origins of MIDES_WEB_URL and MIDES_IMAGE_ORIGINS, the same values the
// API has: where profile pictures may load from.
function imageOrigins(web, extra) {
  const out = new Set();
  for (const raw of [web, ...String(extra ?? '').split(',')]) {
    const value = String(raw ?? '').trim().replace(/\/+$/, '');
    if (!value) continue;
    let url;
    try {
      url = new URL(value);
    } catch {
      url = null;
    }
    if (!url || !['http:', 'https:'].includes(url.protocol) || (raw !== web && url.origin !== value)) {
      console.error(`overtone-web: "${value}" in MIDES_WEB_URL / MIDES_IMAGE_ORIGINS is not an http(s) origin`);
      process.exit(1);
    }
    out.add(url.origin);
  }
  return [...out];
}

function seconds(raw, fallback) {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 3600) {
    console.error(`overtone-web: API_TIMEOUT_S must be a number of seconds from 1 to 3600 (got "${raw}")`);
    process.exit(1);
  }
  return n;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  // robots.txt, sitemap.xml and the web app manifest (W10.3): crawlers and
  // browsers read these by type, and nosniff forbids them guessing.
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// Hop-by-hop headers are about one connection, never forwarded across two.
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function forwardable(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP.has(k)) out[k] = v;
  return out;
}

function trustedProxies(raw) {
  const list = new net.BlockList();
  const ranges = String(raw ?? '').split(',').map((r) => r.trim()).filter(Boolean);
  for (const range of ranges) {
    const [address, bits, ...rest] = range.split('/');
    const family = net.isIP(address);
    const max = family === 6 ? 128 : 32;
    const prefix = bits === undefined ? max : Number(bits);
    if (!family || rest.length || !/^\d*$/.test(bits ?? '') || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      console.error(`overtone-web: TRUSTED_PROXY_ADDRS holds "${range}", not an address or CIDR range`);
      process.exit(1);
    }
    list.addSubnet(address, prefix, family === 6 ? 'ipv6' : 'ipv4');
  }
  return { list, count: ranges.length };
}

// The connection's own address; an IPv4 client on a dual-stack socket arrives
// as ::ffff:a.b.c.d and is matched, and forwarded, as a.b.c.d.
function peerOf(req) {
  const raw = req.socket.remoteAddress || '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  return mapped ? mapped[1] : raw;
}

function fromTrustedProxy(peer) {
  const family = net.isIP(peer);
  return TRUSTED.count > 0 && family > 0 && TRUSTED.list.check(peer, family === 6 ? 'ipv6' : 'ipv4');
}

// The chain the API reads. From a trusted proxy: the last HOPS entries it
// appended, then its own address. From anyone else: their address alone,
// whatever X-Forwarded-For they wrote, since nothing vouches for it.
function forwardedFor(req, peer, trusted) {
  if (!trusted) return peer || 'unknown';
  const raw = req.headers['x-forwarded-for'];
  const incoming = (Array.isArray(raw) ? raw.join(',') : raw || '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const kept = HOPS > 0 ? incoming.slice(-HOPS) : [];
  return [...kept, peer || 'unknown'].join(', ');
}

// The worker's routes are reached on the API's own port with their own bearer
// token; nothing from a browser goes there. Matched on the decoded,
// slash-collapsed, lower-cased path, so no spelling of it slips through.
function internal(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://x').pathname);
  } catch {
    return true; // undecodable: refuse rather than guess
  }
  const p = pathname.replace(/\/{2,}/g, '/').toLowerCase();
  return p === '/api/internal' || p.startsWith('/api/internal/');
}

// Request and response bodies are piped, never buffered: an audio upload goes
// through at the size the API accepts, and the API is the one that limits it.
function proxy(req, res) {
  if (internal(req.url)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{"error":{"status":404,"message":"Not found.","code":"NOT_FOUND"}}');
  }
  const headers = forwardable(req.headers);
  // The API answers only requests that carry this (site/api's shared-secret.js):
  // its port is public on the panel, and this is what tells it the request came
  // through here, with an X-Forwarded-For this process wrote.
  delete headers[PROXY_HEADER];
  if (PROXY_SECRET) headers[PROXY_HEADER] = PROXY_SECRET;
  const peer = peerOf(req);
  const trusted = fromTrustedProxy(peer);
  headers['x-forwarded-for'] = forwardedFor(req, peer, trusted);
  // The same rule for the scheme and host a proxy reports.
  if (!trusted || !headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'http';
  if (!trusted || !headers['x-forwarded-host']) headers['x-forwarded-host'] = req.headers.host || '';
  headers.host = UPSTREAM.host;
  const up = http.request(
    { hostname: UPSTREAM.hostname, port: UPSTREAM.port || 80, method: req.method, path: req.url, headers },
    (r) => {
      res.writeHead(r.statusCode || 502, forwardable(r.headers));
      r.pipe(res);
    },
  );
  // An API that stops answering, or a connection that stops moving, must not
  // hold this process's sockets forever: idle for API_TIMEOUT_S, it is cut.
  up.setTimeout(API_TIMEOUT_MS, () => {
    up.destroy(Object.assign(new Error(`no answer in ${API_TIMEOUT_MS / 1000} s`), { code: 'ETIMEDOUT' }));
  });
  up.on('error', (err) => {
    console.error(`overtone-web: ${req.method} ${req.url} -> api failed: ${err.code || err.message}`);
    if (!res.headersSent) {
      const timedOut = err.code === 'ETIMEDOUT';
      res.writeHead(timedOut ? 504 : 502, { 'content-type': 'application/json' });
      res.end(timedOut ? '{"error":"api_timeout"}' : '{"error":"api_unreachable"}');
    } else {
      res.destroy();
    }
  });
  // A client that leaves takes its forwarded request with it.
  res.on('close', () => {
    if (!res.writableFinished) up.destroy();
  });
  req.pipe(up);
}

// The built index.html carries one inline script (theme and language before the
// first frame). It is allowed by its hash, read from the file being served, so
// the policy follows the build and nothing else inline runs.
let policy = { mtime: -1, value: '' };

async function contentSecurityPolicy(framable = false) {
  const index = path.join(ROOT, 'index.html');
  const s = await file(index);
  const mtime = s ? s.mtimeMs : 0;
  if (mtime !== policy.mtime) policy = { mtime, value: await basePolicy(s, index) };
  // W12.18: an embed card (/embed/<id>) may be framed by any site; every
  // other page by none.
  return policy.value.replace("frame-ancestors 'none'", framable ? 'frame-ancestors *' : "frame-ancestors 'none'");
}

async function basePolicy(s, index) {
  const html = s ? await readFile(index, 'utf8') : '';
  const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter((m) => m[1].length)
    .map((m) => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  const value = [
    "default-src 'self'",
    `script-src 'self'${hashes.length ? ' ' + hashes.join(' ') : ''}`,
    // Avatars and banners come from Mides' own origins and nowhere else: the
    // API keeps no image URL outside them either (site/api mides.service.js).
    ["img-src 'self' data:", ...IMAGE_ORIGINS].join(' '),
    "font-src 'self' data:",
    "style-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return value;
}

// The embed card's path, and nothing else, may be framed (W12.18).
const EMBED_PAGE = /^\/embed\/[0-9a-f]{32}\/?$/;

async function securityHeaders(framable = false) {
  const headers = {
    'content-security-policy': await contentSecurityPolicy(framable),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
  // X-Frame-Options has no "anyone": it is left out where frame-ancestors allows framing.
  if (!framable) headers['x-frame-options'] = 'DENY';
  if (HSTS) headers['strict-transport-security'] = 'max-age=31536000';
  return headers;
}

async function file(p) {
  try {
    const s = await stat(p);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

// ── A shared timing's link preview (W3.27) ──────────────────────────────────
//
// Discord, Slack and the like read a link's Open Graph tags and never run the
// page's script, so the tags of /t/<id> are written here: the API's card of
// that timing (title, artist, BPM, red lines, uploader; no result) into the
// served index.html. Every value is the uploader's own text and is escaped
// for an HTML attribute. A card that does not come in time, or a timing that
// is not published, gets the plain page: the app says what is wrong.
const TIMING_PAGE = /^\/t\/([0-9a-f]{32})\/?$/;
const CARD_TIMEOUT_MS = 1500;
const CARD_MAX_BYTES = 16 * 1024;

const INVISIBLE = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

function escapeAttr(value) {
  return String(value ?? '')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The card, read from the API as overtone-web forwards anything else: the
// proxy secret, and the visitor's address so the API's read limit counts them.
function timingCard(req, id) {
  return new Promise((resolve) => {
    const headers = { accept: 'application/json', host: UPSTREAM.host };
    if (PROXY_SECRET) headers[PROXY_HEADER] = PROXY_SECRET;
    const peer = peerOf(req);
    headers['x-forwarded-for'] = forwardedFor(req, peer, fromTrustedProxy(peer));
    headers['x-forwarded-proto'] = 'http';
    const up = http.request(
      { hostname: UPSTREAM.hostname, port: UPSTREAM.port || 80, method: 'GET', path: `/api/v1/timings/${id}/card`, headers },
      (r) => {
        if (r.statusCode !== 200) {
          r.resume();
          return resolve(null);
        }
        let body = '';
        let card = null;
        r.setEncoding('utf8');
        r.on('data', (chunk) => {
          body += chunk;
          if (body.length > CARD_MAX_BYTES) up.destroy();
        });
        r.on('end', () => {
          try {
            card = JSON.parse(body);
          } catch {
            card = null;
          }
        });
        r.on('error', () => {});
        // After 'end', or instead of it when the answer was cut: either way, done.
        r.on('close', () => resolve(card && typeof card === 'object' ? card : null));
      },
    );
    up.setTimeout(CARD_TIMEOUT_MS, () => up.destroy());
    up.on('error', () => resolve(null));
    up.end();
  });
}

/** index.html with the timing's title and Open Graph tags in its head. */
function withCard(html, card) {
  const song = [card.artist, card.title].filter(Boolean).join(' - ') || 'A timing';
  const bpm = Number.isFinite(card.bpm) ? `${Math.round(card.bpm * 100) / 100} BPM` : null;
  const lines = Number.isInteger(card.redLines) ? `${card.redLines} red line${card.redLines === 1 ? '' : 's'}` : null;
  const who = card.uploader?.username ? `timed by ${card.uploader.username}` : 'timed anonymously';
  const title = escapeAttr(`${song} · Overtone`);
  const description = escapeAttr([bpm, lines, who].filter(Boolean).join(' · '));
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Overtone" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta name="twitter:card" content="summary" />`,
  ].join('\n    ');
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${title}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/i, () => `<meta name="description" content="${description}" />`)
    .replace(/<\/head>/i, () => `    ${tags}\n  </head>`);
}

async function serveTimingPage(req, res, id) {
  const index = path.join(ROOT, 'index.html');
  if (!(await file(index))) return false;
  const card = await timingCard(req, id);
  if (!card) return false;
  const body = Buffer.from(withCard(await readFile(index, 'utf8'), card), 'utf8');
  res.writeHead(200, {
    'content-type': TYPES['.html'],
    'content-length': body.length,
    // Never kept: an unpublished timing must stop being described at once.
    'cache-control': 'no-store',
    ...(await securityHeaders()),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

async function serve(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    return res.end();
  }
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  const timing = TIMING_PAGE.exec(rel);
  if (timing && (await serveTimingPage(req, res, timing[1]))) return;
  // Resolved against ROOT and checked to stay inside it: `..` never escapes.
  let target = path.join(ROOT, path.normalize(rel));
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(404);
    return res.end();
  }
  let s = await file(target);
  if (!s && !path.extname(target)) {
    target = path.join(ROOT, 'index.html');
    s = await file(target);
  }
  if (!s) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...(await securityHeaders()) });
    return res.end('not found\n');
  }
  const immutable = rel.startsWith('/assets/');
  const ext = path.extname(target).toLowerCase();
  // W12.23: the service worker is checked on every visit, never kept stale by
  // an HTTP cache, and its scope is the whole site (it sits at the root, so
  // the header only says so outright).
  const worker = rel === '/sw.js';
  const headers = {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : worker ? 'no-cache, max-age=0' : 'no-cache',
    ...(worker ? { 'service-worker-allowed': '/' } : {}),
    ...(await securityHeaders(EMBED_PAGE.test(rel))),
  };
  const encoding = COMPRESSIBLE.has(ext) && s.size >= COMPRESS_MIN_BYTES ? pickEncoding(req.headers['accept-encoding']) : null;
  if (COMPRESSIBLE.has(ext)) headers.vary = 'Accept-Encoding';
  if (encoding) {
    const body = await compressed(target, s, encoding);
    res.writeHead(200, { ...headers, 'content-encoding': encoding, 'content-length': body.length });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  res.writeHead(200, { ...headers, 'content-length': s.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(target).pipe(res);
}

// ── Compression (W10.1) ─────────────────────────────────────────────────────
//
// Text files go out as brotli, else gzip, when the browser takes either: the
// built JS is about a third of its size compressed. Each file is compressed
// once per version (path, size and mtime) and kept in memory, so a busy page
// costs no CPU after its first visitor; a release brings new hashed names and
// the old entries age out of the small LRU. A TLS proxy in front (Cloudflare)
// passes an encoded body through as it is. Below 1 kB it is not worth it.
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.txt', '.xml', '.webmanifest']);
const COMPRESS_MIN_BYTES = 1024;
const COMPRESS_CACHE_MAX = 128;
const compressCache = new Map();

/** `br` or `gzip` from an Accept-Encoding header, honouring q=0; null for neither. */
function pickEncoding(header) {
  const accepted = new Set();
  for (const part of String(header ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q && !(Number(q.slice(2)) > 0)) continue;
    accepted.add(name.trim());
  }
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip')) return 'gzip';
  return null;
}

async function compressed(target, s, encoding) {
  const key = `${encoding}:${target}:${s.size}:${s.mtimeMs}`;
  const hit = compressCache.get(key);
  if (hit) {
    compressCache.delete(key);
    compressCache.set(key, hit);
    return hit;
  }
  const raw = await readFile(target);
  const body =
    encoding === 'br'
      ? await brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
      : await gzip(raw, { level: 9 });
  compressCache.set(key, body);
  if (compressCache.size > COMPRESS_CACHE_MAX) compressCache.delete(compressCache.keys().next().value);
  return body;
}

// W12.23: the installed app's share target posts the shared audio to
// /share-target, and the service worker answers it in the browser. When no
// worker does (it was cleared, or not installed yet), the post reaches here:
// the file is not read, and the visitor lands on the Analyze page, told to
// pick it there.
function shareWithoutWorker(req, res) {
  req.resume();
  res.writeHead(303, { location: '/analyze?shared=unavailable', connection: 'close', 'cache-control': 'no-store', 'content-length': 0 });
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.url === '/api' || req.url.startsWith('/api/')) return proxy(req, res);
  if (req.method === 'POST' && /^\/share-target\/?(\?.*)?$/.test(req.url)) return shareWithoutWorker(req, res);
  serve(req, res).catch((err) => {
    console.error(`overtone-web: ${req.url}: ${err.message}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

// The panel's stop is ^C: finish what is in flight, then go.
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

server.listen(PORT, '0.0.0.0', () => {
  // The egg's "done" line: the panel shows the server as running from here.
  console.log(
    `overtone-web: listening on ${PORT}, serving ${ROOT}, /api -> ${UPSTREAM.origin}, ` +
      `${HOPS} trusted proxy hop(s) from ${TRUSTED.count} trusted range(s), HSTS ${HSTS ? 'on' : 'off'}, proxy secret ${PROXY_SECRET ? 'set' : 'NOT set'}`,
  );
});
