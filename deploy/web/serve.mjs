#!/usr/bin/env node
/*
 * overtone-web: serves the built site and forwards /api to overtone-api.
 *
 *   PORT=4006 WEB_ROOT=site/web/dist API_UPSTREAM=http://<bridge-ip>:4012 node deploy/web/serve.mjs
 *
 * One process per environment, no dependencies. The browser only ever talks
 * to this origin, so the API needs no CORS and no public hostname of its own:
 * the TLS proxy in front of the node publishes this port and nothing else.
 *
 * Static files are read from WEB_ROOT. A path that is not a file falls back
 * to index.html (the app routes on the client). Vite's hashed /assets/* are
 * cached for a year; index.html is never cached, so a release is visible on
 * the next load.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 8080);
const ROOT = path.resolve(process.env.WEB_ROOT || 'site/web/dist');
const UPSTREAM = new URL(process.env.API_UPSTREAM || 'http://127.0.0.1:4012');

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

// Request and response bodies are piped, never buffered: an audio upload goes
// through at the size the API accepts, and the API is the one that limits it.
function proxy(req, res) {
  const headers = forwardable(req.headers);
  const peer = req.socket.remoteAddress || '';
  headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${peer}` : peer;
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
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found\n');
  }
  const immutable = rel.startsWith('/assets/');
  res.writeHead(200, {
    'content-type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': s.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
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
  console.log(`overtone-web: listening on ${PORT}, serving ${ROOT}, /api -> ${UPSTREAM.origin}`);
});
