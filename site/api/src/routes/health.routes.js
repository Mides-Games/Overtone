import { Router } from 'express';

import { hasDatabase, query } from '../config/database.js';
import { env } from '../config/env.js';

const router = Router();

/**
 * Is the API up, and is its database? Also the limits the web shows next to
 * the upload form, so they are stated in one place.
 */
router.get('/health', async (_req, res) => {
  let database = 'none';
  if (hasDatabase()) {
    database = await query('SELECT 1')
      .then(() => 'ok')
      .catch(() => 'down');
  }

  res.set('Cache-Control', 'no-store');
  res.status(database === 'down' ? 503 : 200).json({
    status: database === 'down' ? 'degraded' : 'ok',
    database,
    devLogin: env.devLogin,
    limits: {
      anonDailyLimit: env.anonDailyLimit,
      userDailyLimit: env.userDailyLimit,
      maxAudioSeconds: env.maxAudioSeconds,
      maxUploadMb: env.maxUploadMb,
    },
  });
});

export default router;
