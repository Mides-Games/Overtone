import { randomBytes } from 'node:crypto';

import { connect, describe, readSchema } from './apply.js';

/**
 * Proves schema.sql is valid and idempotent, without touching real tables.
 *
 *   pnpm --dir site/api check
 *
 * With DATABASE_URL set it creates a throwaway schema inside a transaction,
 * applies schema.sql to it twice (the second run is the idempotency proof),
 * lists what it made and rolls the whole transaction back, whatever happened. Without DATABASE_URL it says it
 * skipped and exits 0: a check that cannot run is reported, not faked.
 */

const EXPECTED = [
  'accounts', 'analyses', 'collection_items', 'collections', 'discord_dms', 'discord_link_codes', 'jobs', 'moderation_log', 'notifications',
  'rate_limits', 'reports', 'reviews', 'songs', 'suggestion_votes', 'suggestions', 'timing_comments', 'timing_ratings', 'timing_reactions', 'timing_uses', 'timing_votes', 'timings',
];

const url = (process.env.DATABASE_URL ?? '').trim();
if (!url) {
  console.log('check: skipped -- DATABASE_URL is not set, so schema.sql was not applied anywhere.');
  process.exit(0);
}

const scratch = `overtone_check_${randomBytes(4).toString('hex')}`;
let client;
try {
  client = await connect(url);
  const schema = await readSchema();

  // DDL is transactional in PostgreSQL: everything below is rolled back, so
  // nothing outlives the check, not even the search_path.
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA ${scratch}`);
  await client.query(`SET LOCAL search_path TO ${scratch}`);
  await client.query(schema);
  await client.query(schema);

  const { rows } = await client.query(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
    [scratch],
  );
  const made = rows.map((row) => row.table_name);
  const missing = EXPECTED.filter((name) => !made.includes(name));
  const extra = made.filter((name) => !EXPECTED.includes(name));

  if (missing.length || extra.length) {
    console.error(`check: FAILED -- missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`);
    process.exitCode = 1;
  } else {
    console.log(`check: ok -- schema.sql applied twice, ${made.length} tables.`);
  }
} catch (error) {
  console.error('check: FAILED --', describe(error));
  process.exitCode = 1;
} finally {
  if (client) {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}
