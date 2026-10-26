import { connect, describe, readSchema } from './apply.js';

/**
 * Applies schema.sql to DATABASE_URL. Idempotent, so it runs at every deploy.
 *
 *   pnpm --dir site/api db:migrate
 */

const url = (process.env.DATABASE_URL ?? '').trim();
if (!url) {
  console.error('DATABASE_URL is not set: there is no database to migrate.');
  process.exit(1);
}

let client;
try {
  client = await connect(url);
  await client.query(await readSchema());
  console.log('Schema applied.');
} catch (error) {
  console.error('Could not apply the schema:', describe(error));
  process.exitCode = 1;
} finally {
  await client?.end();
}
