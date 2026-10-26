import pg from 'pg';

import { env } from './env.js';

// pg is CommonJS: import the default and destructure.
const { Pool } = pg;

/**
 * The PostgreSQL pool, or `null` when `DATABASE_URL` is not set.
 *
 * No database is allowed in development only (`env.js` refuses it in
 * production): the stores in `services/` then keep their rows in memory, so a
 * tester can run `pnpm dev` on a machine with no Postgres and still sign in.
 */
export const pool = env.databaseUrl
  ? new Pool({
      connectionString: env.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  : null;

// Errors from idle clients (the database restarted, say) must not crash the process.
pool?.on('error', (error) => {
  console.error('[db] unexpected error on an idle PostgreSQL client:', error.message);
});

export const hasDatabase = () => pool !== null;

/** `query('SELECT * FROM accounts WHERE id = $1', [id])` */
export const query = (text, params) => {
  if (!pool) throw new Error('No database configured (DATABASE_URL is empty).');
  return pool.query(text, params);
};

/**
 * pg reports a refused connection as an AggregateError with an empty message
 * (Node tries IPv6 and IPv4 separately), so look at `errors` and `code` too.
 */
export const describeDbError = (error) =>
  error.message || error.errors?.map((item) => item.message).join(' | ') || error.code || 'unknown error';

/** Checks the connection at boot; throws if the database does not answer. */
export const connectDatabase = async () => {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
};

export const closeDatabase = async () => {
  if (pool) await pool.end();
};
