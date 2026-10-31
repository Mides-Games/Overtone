import { Router } from 'express';

import { guard } from '../middlewares/rate-limit.js';
import { teamView } from '../services/team.service.js';

/**
 * The team, public (/team and /testers on the site):
 *
 *   GET /team   { mides, staff, testers }: Mides Projects' staff with their
 *               Mides rank, Overtone's staff and its testers
 *
 * Giving an Overtone rank is a staff route (`POST /staff/ranks`).
 */
const router = Router();

router.get('/team', guard('team', 120, 10 * 60_000), async (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(await teamView());
});

export default router;
