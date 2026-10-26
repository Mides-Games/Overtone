import { Router } from 'express';

import analyses from './analyses.routes.js';
import health from './health.routes.js';

/** Everything under /api/v1. */
const router = Router();

router.use(health);
router.use(analyses);

export default router;
