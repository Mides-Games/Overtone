import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `pnpm dev`: the API with the fake login on, so a tester needs no secrets,
 * and the analysis worker beside it, so an upload gets analysed.
 *
 * A launcher rather than `MIDES_DEV_LOGIN=1 node ...` in package.json, because
 * that syntax does not exist in cmd.exe. A value in `.env` wins: set
 * MIDES_DEV_LOGIN=0 there to try the real Mides SSO in development.
 *
 * The worker is `worker/main.py` run by the repository's `.venv` Python (or
 * OVERTONE_PYTHON). It gets the WORKER_TOKEN generated here, so the two agree
 * without anyone typing a secret. Set OVERTONE_WORKER=0 to start the API
 * alone (to run a worker yourself, with the same WORKER_TOKEN).
 */
process.env.MIDES_DEV_LOGIN ??= '1';
process.env.WORKER_TOKEN ??= randomBytes(32).toString('base64url');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const python = () => {
  if (process.env.OVERTONE_PYTHON) return process.env.OVERTONE_PYTHON;
  const candidates = [join(root, '.venv', 'Scripts', 'python.exe'), join(root, '.venv', 'bin', 'python')];
  return candidates.find((path) => existsSync(path)) ?? null;
};

const startWorker = () => {
  if (['0', 'false', 'no'].includes(String(process.env.OVERTONE_WORKER ?? '').toLowerCase())) {
    console.log('[dev] OVERTONE_WORKER=0: the worker is not started; uploads stay queued until one runs.');
    return;
  }
  const exe = python();
  if (!exe) {
    console.warn(
      '[dev] No Python for the worker: create .venv at the repository root ' +
        '(python -m venv .venv && .venv/Scripts/pip install -r python/requirements.lock) ' +
        'or set OVERTONE_PYTHON. The site runs; uploads stay queued until a worker runs.',
    );
    return;
  }
  const worker = spawn(exe, [join(root, 'worker', 'main.py')], {
    cwd: root,
    // stdin stays a pipe the worker watches: when this process goes, however
    // it goes (node --watch restarts it without running exit handlers on
    // Windows), the pipe closes and the worker leaves with it.
    stdio: ['pipe', 'inherit', 'inherit'],
    env: {
      ...process.env,
      OVERTONE_API: `http://127.0.0.1:${process.env.PORT || 3001}`,
      WORKER_EXIT_WITH_STDIN: '1',
      PYTHONUNBUFFERED: '1',
    },
  });
  worker.on('error', (error) => console.error(`[dev] the worker did not start: ${error.message}`));
  worker.on('exit', (code) => {
    if (code) console.warn(`[dev] the worker stopped (exit ${code}); restart pnpm dev to start it again.`);
  });
  process.on('exit', () => worker.kill());
};

await import('./index.js');
startWorker();
