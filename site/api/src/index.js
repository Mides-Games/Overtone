import { app } from './app.js';
import { closeDatabase, connectDatabase, describeDbError, hasDatabase } from './config/database.js';
import { env } from './config/env.js';
import { sweepStaleJobs } from './routes/internal.routes.js';
import { analyses } from './services/analysis.service.js';
import { prepareSpool } from './services/spool.service.js';

/**
 * Boots the API. With DATABASE_URL set, the database must answer first: a
 * server that starts and then fails every request is harder to notice than one
 * that does not start. Without it (development only) the stores run in memory.
 */

if (hasDatabase()) {
  try {
    await connectDatabase();
  } catch (error) {
    console.error(`[db] PostgreSQL does not answer: ${describeDbError(error)}`);
    process.exit(1);
  }
} else {
  console.warn('[db] DATABASE_URL is not set: accounts and analyses are kept in memory and vanish on restart (development only).');
}

// Without a database the queue dies with the process, so its audio goes too.
await prepareSpool({ clear: !hasDatabase() });

// A worker that died mid-job is noticed even while no other worker claims.
const sweeper = setInterval(() => {
  sweepStaleJobs().catch((error) => console.error('[queue] sweep failed:', error.message));
}, 30_000);
sweeper.unref();

// Analyses their owners deleted (W3.26) are erased at once and kept, marked,
// only while their day's quota still counts them; past that day they go.
const purger = setInterval(() => {
  analyses().purgeDeleted().catch((error) => console.error('[history] purge failed:', error.message));
}, 60 * 60_000);
purger.unref();

const server = app.listen(env.port, env.host || undefined, () => {
  const where = `${env.host || 'localhost'}:${env.port}`;
  console.log(`overtone-api listening on http://${where} (${env.nodeEnv}${env.devLogin ? ', MIDES_DEV_LOGIN on' : ''})`);
});

const shutdown = (signal) => {
  console.log(`${signal}: closing`);
  server.close(() => closeDatabase().finally(() => process.exit(0)));
  // A keep-alive connection must not hold the process open forever.
  setTimeout(() => process.exit(0), 5_000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
