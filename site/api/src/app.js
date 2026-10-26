import express from 'express';

import { env } from './config/env.js';
import { errorHandler, notFound } from './middlewares/error-handler.js';
import { rateLimit } from './middlewares/rate-limit.js';
import { securityHeaders } from './middlewares/security-headers.js';
import v1 from './routes/index.js';

/**
 * The Express application, without listening: `index.js` listens.
 *
 * There is no CORS middleware on purpose. The web is served from the same
 * origin (Vite's proxy in development, the reverse proxy in production), so a
 * cross-origin browser request has nothing to be allowed.
 */
export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', env.trustProxy);

app.use(securityHeaders);
// Small on purpose: JSON bodies here are a code or a form, never audio.
app.use(express.json({ limit: '16kb' }));

app.use('/api', rateLimit);
app.use('/api/v1', v1);

app.use(notFound);
app.use(errorHandler);
