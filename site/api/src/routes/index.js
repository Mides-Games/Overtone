import { Router } from 'express';

import analyses from './analyses.routes.js';
import auth from './auth.routes.js';
import health from './health.routes.js';
import me from './me.routes.js';

/** Everything under /api/v1. */
const router = Router();

router.use(health);
router.use(auth);
router.use(me);
router.use(analyses);

export default router;
