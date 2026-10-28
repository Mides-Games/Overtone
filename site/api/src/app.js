import express from 'express';

import { env } from './config/env.js';
import { errorHandler, notFound } from './middlewares/error-handler.js';
import { rateLimit } from './middlewares/rate-limit.js';
import { securityHeaders } from './middlewares/security-headers.js';
import { INTERNAL_PREFIX, proxyGuard } from './middlewares/shared-secret.js';
import { bearerToken } from './middlewares/token.js';
import bot from './routes/bot.routes.js';
import v1 from './routes/index.js';
import internal from './routes/internal.routes.js';
import { VERSION_BODY_LIMIT } from './services/version.service.js';

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
// Only what came through overtone-web, except the worker's own routes.
app.use(proxyGuard(env.proxySecret));
// The worker's routes first: their own bearer, their own body limit, and
// outside the per-address rate limit, which counts visitors.
// The Discord bot's routes (W9.3) go first, with BOT_TOKEN: inside the
// worker's prefix (so overtone-web refuses to forward them all the same) but
// never under WORKER_TOKEN.
app.use(`${INTERNAL_PREFIX}/bot`, bot);
app.use(INTERNAL_PREFIX, internal);

// A saved version may carry an edited timing (W7): up to 512 packed red lines,
// about 25 kB, which the route caps and checks line by line. Parsed here first,
// so the small limit below never sees that one body.
app.use('/api/v1/analyses/:id/versions', express.json({ limit: VERSION_BODY_LIMIT }));
// Small on purpose: JSON bodies here are a code or a form. Audio arrives as a
// raw body that analyses.routes.js streams to disk itself.
app.use(express.json({ limit: '16kb' }));

// A personal API token (W12.20) is read before the rate limit, which then
// counts that token instead of the address; a request without one is untouched.
app.use('/api/v1', bearerToken);
app.use('/api', rateLimit);
app.use('/api/v1', v1);

app.use(notFound);
app.use(errorHandler);
