import { sessionAccount } from '../services/account.service.js';
import { COOKIE, cookiesOf, read } from '../services/session.service.js';
import { HttpError } from '../utils/http-error.js';

/**
 * Reads the session if there is one; `req.account` is the row or `null`.
 * A request made with a personal API token (middlewares/token.js) already
 * carries its account, and no cookie to read.
 */
export const optionalSession = async (req, _res, next) => {
  if (req.token) return next();
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
 * A browser's own session, never a personal API token: managing tokens, say,
 * which a token must not do to itself. middlewares/token.js already keeps
 * tokens off every route outside its allow-list; this says so on the route.
 */
export const requireBrowserSession = async (req, res, next) => {
  if (req.token) return next(new HttpError(403, 'API tokens cannot be used for this request. Use the website.', 'TOKEN_NOT_ALLOWED'));
  return requireSession(req, res, next);
};

/**
 * The other half of CSRF, after SameSite=Lax: every state-changing request
 * carries a header that a plain form or an <img> on another site cannot set,
 * and that a cross-origin fetch could only set after a CORS preflight this
 * API never answers.
 */
export const SAME_ORIGIN_HEADER = 'overtone-web';

export const requireSameOrigin = (req, _res, next) => {
  // A personal API token (W12.20) is not ambient: no other site can make a
  // browser send it, and its request's cookies were dropped before any route
  // ran (middlewares/token.js). There is nothing to forge, and only the
  // token's allow-listed routes are reachable with it.
  if (req.token) return next();
  if (req.get('X-Requested-With') !== SAME_ORIGIN_HEADER) {
    return next(new HttpError(403, 'Request not allowed.', 'CSRF_HEADER_MISSING'));
  }
  return next();
};
