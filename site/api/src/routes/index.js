import { Router } from 'express';

import analyses from './analyses.routes.js';
import auth from './auth.routes.js';
import community from './community.routes.js';
import health from './health.routes.js';
import links from './links.routes.js';
import me from './me.routes.js';
import notifications from './notifications.routes.js';
import staff from './staff.routes.js';
import votes from './votes.routes.js';
import social from './social.routes.js';
import stats from './stats.routes.js';
import timings from './timings.routes.js';
import tokens from './tokens.routes.js';
import versions from './versions.routes.js';

/** Everything under /api/v1. */
const router = Router();

router.use(health);
router.use(auth);
router.use(me);
router.use(analyses);
router.use(community);
router.use(timings);
router.use(tokens);
router.use(versions);
router.use(links);
router.use(social);
router.use(votes);
router.use(notifications);
router.use(staff);
router.use(stats);

export default router;
