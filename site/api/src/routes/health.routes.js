import { Router } from 'express';

import { hasDatabase, query } from '../config/database.js';
import { env } from '../config/env.js';
import { COSTS } from '../utils/estimate.js';
import { workerStatus } from '../utils/worker-status.js';

const router = Router();

/**
 * Is the API up, and is its database? Also the limits the web shows next to
 * the upload form, so they are stated in one place.
 *
 * `worker` (W10.4, the /status page) says whether an analysis worker called
 * lately (utils/worker-status.js). It does not change the status code: an API
 * without a worker still answers, and uploads wait in the queue. Only a
 * database that does not answer makes this a 503.
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
    worker: workerStatus(),
    devLogin: env.devLogin,
    limits: {
      anonDailyLimit: env.anonDailyLimit,
      userDailyLimit: env.userDailyLimit,
      anonMaxPending: env.anonMaxPending,
      userMaxPending: env.userMaxPending,
      maxAudioSeconds: env.maxAudioSeconds,
      maxUploadMb: env.maxUploadMb,
    },
    // W11.1, W3.16: what one job costs per mode (utils/estimate.js), so the
    // form can say roughly how long each mode takes for the file picked.
    costs: COSTS,
  });
});

export default router;
