import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
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

test('an API that does not answer is cut after API_TIMEOUT_S with a 504', async () => {
  const api = await upstream(() => {}); // never answers
  const port = await serve(api, { API_TIMEOUT_S: '1' });
  const started = Date.now();
  const { status, body } = await get(port, '/api/v1/health');
  assert.equal(status, 504);
  assert.equal(JSON.parse(body).error, 'api_timeout');
  assert.ok(Date.now() - started < 10_000);
});

test('an API that answers is forwarded as before', async () => {
  const api = await upstream((_req, res) => res.end('{"ok":true}'));
  const port = await serve(api, { API_TIMEOUT_S: '1' });
  const { status, body } = await get(port, '/api/v1/health');
  assert.equal(status, 200);
  assert.equal(body, '{"ok":true}');
});
