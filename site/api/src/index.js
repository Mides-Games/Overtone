import { app } from './app.js';
import { closeDatabase, connectDatabase, describeDbError, hasDatabase } from './config/database.js';
import { env } from './config/env.js';

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
  console.warn('[db] DATABASE_URL is not set: accounts are kept in memory and vanish on restart (development only).');
}

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
