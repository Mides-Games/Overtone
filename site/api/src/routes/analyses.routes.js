import { Router } from 'express';

import { HttpError } from '../utils/http-error.js';

const router = Router();

/**
 * Uploading a song for analysis: not built yet (phase W3.4, which needs the
 * worker of W2). The route exists so the web form, the OpenAPI document and
 * the rate limit are wired against the real path. It answers 501 without
 * reading the body, and closes the connection so a large upload is not
 * drained for nothing.
 */
router.post('/analyses', (_req, res) => {
  res.set('Connection', 'close');
  throw new HttpError(501, 'Analysis is not available yet: the queue and worker are still being built.', 'NOT_IMPLEMENTED');
});

export default router;
