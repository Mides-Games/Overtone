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
 * the next load.
 *
 * TRUSTED_PROXY_HOPS (default 1) is how many proxies sit in front of this
 * process: 1 for the TLS proxy (Cloudflare, nginx or Caddy). The API counts its
 * rate limit per client address, and everything it receives comes from here,
 * so the X-Forwarded-For it reads has to be one this process vouches for: the
 * last TRUSTED_PROXY_HOPS entries of the incoming header (the ones those
 * proxies appended) plus the address of the connection itself. Whatever a
 * client wrote further left is dropped. The API then trusts this process and
 * those hops, TRUST_PROXY = TRUSTED_PROXY_HOPS + 1.
 *
 * HSTS (default 1) sends Strict-Transport-Security with every page. Set it to
 * 0 only when the site is served over plain http, as on a laptop.
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
import path from 'node:path';

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 8080);
const ROOT = path.resolve(process.env.WEB_ROOT || 'site/web/dist');
const UPSTREAM = new URL(process.env.API_UPSTREAM || 'http://127.0.0.1:4012');
const HOPS = hops(process.env.TRUSTED_PROXY_HOPS);
const HSTS = !['0', 'false', 'no'].includes(String(process.env.HSTS ?? '1').trim().toLowerCase());
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
  '.txt': 'text/plain; charset=utf-8',
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

// The chain the API reads: the last HOPS entries the trusted proxies appended,
// then the connection's own address. Never what a client typed before them.
function forwardedFor(req) {
  const raw = req.headers['x-forwarded-for'];
  const incoming = (Array.isArray(raw) ? raw.join(',') : raw || '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const kept = HOPS > 0 ? incoming.slice(-HOPS) : [];
  return [...kept, req.socket.remoteAddress || 'unknown'].join(', ');
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
  headers['x-forwarded-for'] = forwardedFor(req);
  headers['x-forwarded-proto'] ||= 'http';
  headers['x-forwarded-host'] ||= req.headers.host || '';
  headers.host = UPSTREAM.host;
  const up = http.request(
    { hostname: UPSTREAM.hostname, port: UPSTREAM.port || 80, method: req.method, path: req.url, headers },
    (r) => {
      res.writeHead(r.statusCode || 502, forwardable(r.headers));
      r.pipe(res);
    },
  );
  up.on('error', (err) => {
    console.error(`overtone-web: ${req.method} ${req.url} -> api failed: ${err.code || err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":"api_unreachable"}');
    } else {
      res.destroy();
    }
  });
  req.pipe(up);
}

// The built index.html carries one inline script (theme and language before the
// first frame). It is allowed by its hash, read from the file being served, so
// the policy follows the build and nothing else inline runs.
let policy = { mtime: -1, value: '' };

async function contentSecurityPolicy() {
  const index = path.join(ROOT, 'index.html');
  const s = await file(index);
  const mtime = s ? s.mtimeMs : 0;
  if (mtime === policy.mtime) return policy.value;
  const html = s ? await readFile(index, 'utf8') : '';
  const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter((m) => m[1].length)
    .map((m) => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  const value = [
    "default-src 'self'",
    `script-src 'self'${hashes.length ? ' ' + hashes.join(' ') : ''}`,
    // Avatars and banners come from Mides, on whatever host it serves them.
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "style-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  policy = { mtime, value };
  return value;
}

async function securityHeaders() {
  const headers = {
    'content-security-policy': await contentSecurityPolicy(),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
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
  res.writeHead(200, {
    'content-type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': s.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...(await securityHeaders()),
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(target).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url === '/api' || req.url.startsWith('/api/')) return proxy(req, res);
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
      `${HOPS} trusted proxy hop(s), HSTS ${HSTS ? 'on' : 'off'}, proxy secret ${PROXY_SECRET ? 'set' : 'NOT set'}`,
  );
});
