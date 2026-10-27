import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// deploy/web/serve.mjs run as the panel runs it, in front of a stand-in API.
const SERVE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deploy', 'web', 'serve.mjs');

const running = [];
after(() => {
  for (const close of running) close();
});

/** A stand-in API on an ephemeral port; `handler(req, res)` answers. */
const upstream = async (handler) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  running.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return server.address().port;
};

const freePort = async () => {
  const probe = http.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

/** serve.mjs with `env`, forwarding to `apiPort`; resolves to its port once it listens. */
const serve = async (apiPort, env = {}) => {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVE], {
    env: { ...process.env, PORT: String(port), WEB_ROOT: '.', API_UPSTREAM: `http://127.0.0.1:${apiPort}`, HSTS: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(() => child.kill());
  let output = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('listening on')) resolve();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('exit', (code) => reject(new Error(`serve.mjs exited ${code}: ${output}`)));
  });
  return port;
};

/** GET `path` on `port` with `headers`; resolves to `{ status, body }`. */
const get = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      })
      .on('error', reject);
  });

/** A stand-in API as the real one reads addresses: Express with TRUST_PROXY=2. */
const echoIp = async () => {
  const { default: express } = await import('express');
  const app = express();
  app.set('trust proxy', 2);
  app.get('/api/ip', (req, res) => res.json({ ip: req.ip, xff: req.get('X-Forwarded-For') ?? null }));
  return upstream(app);
};

test('a client that reaches the web directly is counted by its own address, whatever it writes', async () => {
  const api = await echoIp();
  const port = await serve(api); // TRUSTED_PROXY_ADDRS unset: nobody is a proxy
  const forged = await get(port, '/api/ip', { 'X-Forwarded-For': '6.6.6.6, 7.7.7.7' });
  assert.deepEqual(JSON.parse(forged.body), { ip: '127.0.0.1', xff: '127.0.0.1' });
  const plain = await get(port, '/api/ip');
  assert.equal(JSON.parse(plain.body).ip, '127.0.0.1');
});

test('behind a trusted proxy the client is the address the proxy appended, not one it was sent', async () => {
  const api = await echoIp();
  // The test connects from 127.0.0.1, so here it plays Cloudflare: a client
  // sent "6.6.6.6", and the proxy appended the address it saw.
  const port = await serve(api, { TRUSTED_PROXY_ADDRS: '173.245.48.0/20, 127.0.0.0/8, 2400:cb00::/32' });
  const { body } = await get(port, '/api/ip', { 'X-Forwarded-For': '6.6.6.6, 203.0.113.9' });
  assert.deepEqual(JSON.parse(body), { ip: '203.0.113.9', xff: '203.0.113.9, 127.0.0.1' });
});

test('a connection outside the trusted ranges gets no say in its address', async () => {
  const api = await echoIp();
  const port = await serve(api, { TRUSTED_PROXY_ADDRS: '173.245.48.0/20,2400:cb00::/32' });
  const { body } = await get(port, '/api/ip', { 'X-Forwarded-For': '6.6.6.6, 203.0.113.9' });
  assert.equal(JSON.parse(body).ip, '127.0.0.1');
});

test('a malformed trusted range stops the start', async () => {
  await assert.rejects(serve(1, { TRUSTED_PROXY_ADDRS: '300.1.1.1/8' }), /not an address or CIDR range/);
  await assert.rejects(serve(1, { TRUSTED_PROXY_ADDRS: '10.0.0.0/33' }), /not an address or CIDR range/);
});

test('images load only from this origin, data: and Mides\' own origins', async () => {
  const policy = async (env) => {
    const port = await serve(1, env);
    const { headers } = await get(port, '/missing.png');
    return headers['content-security-policy'].split('; ').find((d) => d.startsWith('img-src'));
  };
  assert.equal(await policy({}), "img-src 'self' data:");
  assert.equal(
    await policy({ MIDES_WEB_URL: 'https://mides.example/', MIDES_IMAGE_ORIGINS: 'https://cdn.mides.example, https://mides.example' }),
    "img-src 'self' data: https://mides.example https://cdn.mides.example",
  );
  await assert.rejects(serve(1, { MIDES_IMAGE_ORIGINS: 'https://cdn.mides.example/avatars' }), /not an http\(s\) origin/);
});

test('an API that does not answer is cut after API_TIMEOUT_S with a 504', async () => {
  const api = await upstream(() => {}); // never answers
  const port = await serve(api, { API_TIMEOUT_S: '1' });
  const started = Date.now();
  const { status, body } = await get(port, '/api/v1/health');
  assert.equal(status, 504);
  assert.equal(JSON.parse(body).error, 'api_timeout');
  assert.ok(Date.now() - started < 10_000);
});

test('robots.txt, the sitemap and the manifest are served as themselves, with their types', async () => {
  // A built site in miniature: the real public/ files, copied as Vite copies them.
  const root = await mkdtemp(join(tmpdir(), 'overtone-serve-'));
  running.push(() => rm(root, { recursive: true, force: true }));
  const pub = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'public');
  for (const name of ['robots.txt', 'sitemap.xml', 'manifest.webmanifest']) await copyFile(join(pub, name), join(root, name));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>app</title>');
  const port = await serve(1, { WEB_ROOT: root });

  const robots = await get(port, '/robots.txt');
  assert.equal(robots.status, 200);
  assert.equal(robots.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(robots.body, /^Sitemap: https:\/\//m);

  const sitemap = await get(port, '/sitemap.xml');
  assert.equal(sitemap.headers['content-type'], 'application/xml; charset=utf-8');
  assert.match(sitemap.body, /<urlset /);

  const manifest = await get(port, '/manifest.webmanifest');
  assert.equal(manifest.headers['content-type'], 'application/manifest+json');
  assert.equal(JSON.parse(manifest.body).name, 'Overtone');
  // The manifest is fetched under default-src 'self': nothing to add to the policy.
  assert.match(manifest.headers['content-security-policy'], /default-src 'self'/);

  // A missing file with an extension is a 404, never the app shell.
  assert.equal((await get(port, '/sitemap-2.xml')).status, 404);
});

test('an API that answers is forwarded as before', async () => {
  const api = await upstream((_req, res) => res.end('{"ok":true}'));
  const port = await serve(api, { API_TIMEOUT_S: '1' });
  const { status, body } = await get(port, '/api/v1/health');
  assert.equal(status, 200);
  assert.equal(body, '{"ok":true}');
});
