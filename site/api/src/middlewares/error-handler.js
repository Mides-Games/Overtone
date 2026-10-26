import { isProduction } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';

/**
 * The central error handler. Express recognises it by its four parameters, so
 * `next` stays even though it is unused.
 */
export const errorHandler = (err, _req, res, _next) => {
  // A malformed JSON body arrives from express.json() as a 400 with `type`.
  const status = err.status ?? err.statusCode ?? 500;

  // A crash gets its stack; a 5xx this code chose to answer (501, 503) one line.
  if (status >= 500 && !(err instanceof HttpError)) console.error(err);
  else if (status >= 500) console.warn(`[http] ${status} ${err.code ?? ''} ${err.message}`);

  // An error may carry its own headers: the Retry-After of a 429 is part of
  // the answer, not decoration.
  if (err.headers) res.set(err.headers);

  // An error is never cached.
  res.set('Cache-Control', 'no-store');

  res.status(status).json({
    error: {
      status,
      message: status >= 500 && isProduction ? 'Internal server error' : err.message,
      // Only an HttpError's own code: a Node or PostgreSQL code is internal.
      ...(err instanceof HttpError && err.code ? { code: err.code } : {}),
      ...(err instanceof HttpError && err.details ? { details: err.details } : {}),
    },
  });
};

export const notFound = (req, _res, next) => {
  next(new HttpError(404, `No route for ${req.method} ${req.path}`, 'NOT_FOUND'));
};
