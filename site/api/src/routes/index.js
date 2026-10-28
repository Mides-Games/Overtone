import { Router } from 'express';

import analyses from './analyses.routes.js';
import auth from './auth.routes.js';
import community from './community.routes.js';
import health from './health.routes.js';
import links from './links.routes.js';
import me from './me.routes.js';
import social from './social.routes.js';
import stats from './stats.routes.js';
import timings from './timings.routes.js';

/** Everything under /api/v1. */
const router = Router();

router.use(health);
router.use(auth);
router.use(me);
router.use(analyses);
router.use(community);
router.use(timings);
router.use(links);
router.use(social);
router.use(stats);

export default router;
