import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

/**
 * What `migrate.js` and `check.js` share: read schema.sql and open a client.
 *
 * Both talk to pg directly and not through `config/env.js`: neither needs the
 * session secrets, and they should not invent random ones just to run.
 */

export const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export const readSchema = () => readFile(schemaPath, 'utf8');

export const connect = async (connectionString) => {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  return client;
};

/** pg reports a refused connection as an AggregateError with an empty message. */
export const describe = (error) =>
  error.message || error.errors?.map((item) => item.message).join(' | ') || error.code || 'unknown error';
