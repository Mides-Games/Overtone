import { sessionAccount } from '../services/account.service.js';
import { COOKIE, cookiesOf, read } from '../services/session.service.js';
import { HttpError } from '../utils/http-error.js';

/** Reads the session if there is one; `req.account` is the row or `null`. */
export const optionalSession = async (req, _res, next) => {
  const session = read(cookiesOf(req)[COOKIE]);
  req.account = session ? await sessionAccount(session) : null;
  next();
};

export const requireSession = async (req, res, next) => {
  await optionalSession(req, res, () => {});
  if (!req.account) return next(new HttpError(401, 'You need to sign in.', 'SIGN_IN_REQUIRED'));
  return next();
};

/**
 * The other half of CSRF, after SameSite=Lax: every state-changing request
 * carries a header that a plain form or an <img> on another site cannot set,
 * and that a cross-origin fetch could only set after a CORS preflight this
 * API never answers.
 */
export const SAME_ORIGIN_HEADER = 'overtone-web';

export const requireSameOrigin = (req, _res, next) => {
  if (req.get('X-Requested-With') !== SAME_ORIGIN_HEADER) {
    return next(new HttpError(403, 'Request not allowed.', 'CSRF_HEADER_MISSING'));
  }
  return next();
};
