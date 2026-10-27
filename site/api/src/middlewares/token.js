import { accountById } from '../services/account.service.js';
import { TOKEN_FORMAT, tokens } from '../services/token.service.js';
import { HttpError } from '../utils/http-error.js';
import { guard } from './rate-limit.js';

/**
 * `Authorization: Bearer ot_…` on /api/v1 (W12.20): a personal token in
 * place of the browser's cookie.
 *
 * Why a token never satisfies the CSRF guard by accident, in four rules:
 *
 * 1. **A token request has no cookies.** Once a Bearer header is seen, the
 *    request's Cookie header is dropped before any route reads it, so a
 *    request carrying both acts as the token's owner and never as the
 *    browser's session or anonymous cookie. A Bearer that is not a valid
 *    token is a 401: it never falls back to the cookie either.
 * 2. **The header cannot be ambient.** A cookie is attached by the browser
 *    to any request a page triggers; that is what CSRF abuses, and why the
 *    same-origin header exists. `Authorization` is not a CORS-safelisted
 *    header: another site's page can only send it after a preflight this API
 *    never answers, and a form, an <img> or a no-cors fetch cannot send it at
 *    all. So `requireSameOrigin` lets a token request through (a script has no
 *    browser to forge), while the cookie that request carried is already gone.
 * 3. **Only an allow-list of routes.** A token reaches the reads and the
 *    upload below, each under its scope, and nothing else: not publishing,
 *    not deleting, not the community, not staff routes, and not
 *    /me/tokens (a token never mints or revokes tokens). Anything else is 403
 *    `TOKEN_NOT_ALLOWED`, before the route runs.
 * 4. **Its own rate limit.** A token request skips the per-address limit and
 *    counts against its token instead (`guard` keys by the token); every
 *    route's own limit (uploads, reads) does the same. A per-address limit on
 *    the lookup itself keeps a flood of made-up tokens from reaching the table.
 *
 * Only the Bearer scheme triggers any of this: `Authorization: Basic` (a
 * staging site behind basic auth, say) leaves the request a browser request.
 */

const ID = '[0-9a-f]{32}';

/** What a token may call: method, path under /api/v1, and the scope it needs (`null`: any token). */
export const TOKEN_ROUTES = [
  ['GET', '/health', null],
  ['GET', '/me', null],
  ['GET', `/analyses/${ID}`, 'read:analyses'],
  ['GET', `/analyses/${ID}/timing\\.(txt|csv)`, 'read:analyses'],
  ['GET', `/analyses/${ID}/versions`, 'read:analyses'],
  ['GET', '/me/analyses', 'read:analyses'],
  ['POST', '/analyses', 'upload'],
  ['POST', '/analyses/lookup', 'upload'],
  ['GET', '/timings', 'read:timings'],
  ['GET', `/timings/${ID}`, 'read:timings'],
  ['GET', `/timings/${ID}/timing\\.(txt|csv)`, 'read:timings'],
].map(([method, path, scope]) => ({ method, path: new RegExp(`^${path}/?$`), scope }));

/** The rule `method path` falls under, or null. HEAD reads as GET. */
export const tokenRoute = (method, path) => {
  const m = method === 'HEAD' ? 'GET' : method;
  return TOKEN_ROUTES.find((r) => r.method === m && r.path.test(path)) ?? null;
};

/** The token in `Authorization: Bearer <token>`, '' for a Bearer with nothing usable, or null for no Bearer at all. */
export const bearerOf = (req) => {
  const header = req.get('Authorization');
  if (typeof header !== 'string') return null;
  const match = /^Bearer(?:\s+(.*))?$/i.exec(header.trim());
  if (!match) return null;
  return (match[1] ?? '').trim();
};

const invalid = () => {
  const error = new HttpError(401, 'This API token is not valid. It may have been revoked.', 'INVALID_TOKEN');
  error.headers = { 'WWW-Authenticate': 'Bearer error="invalid_token"' };
  return error;
};

// Lookups per address, token or not: wide, but a loop of guesses stops here
// before it reaches the table.
const lookupLimit = guard('token-auth', 600, 60_000);

/**
 * Mounted on /api/v1 before the rate limit. A request without a Bearer
 * passes untouched. One with a Bearer leaves with `req.token` (`{ id,
 * accountId, scopes }`) and `req.account` set and its cookies gone, or not at all.
 */
export const bearerToken = (req, res, next) => {
  const token = bearerOf(req);
  if (token === null) return next();
  // Rule 1 first, whatever happens next: nothing below reads a cookie of this request.
  delete req.headers.cookie;
  return lookupLimit(req, res, async (limited) => {
    if (limited) return next(limited);
    try {
      if (!TOKEN_FORMAT.test(token)) return next(invalid());
      const found = await tokens().authenticate(token);
      const account = found ? await accountById(found.accountId) : null;
      if (!found || !account) return next(invalid());
      const rule = tokenRoute(req.method, req.path);
      if (!rule) {
        return next(new HttpError(403, 'API tokens cannot be used for this request. Use the website.', 'TOKEN_NOT_ALLOWED'));
      }
      if (rule.scope && !found.scopes.includes(rule.scope)) {
        return next(new HttpError(403, `This token does not have the ${rule.scope} scope.`, 'TOKEN_SCOPE', { scope: rule.scope }));
      }
      req.token = found;
      req.account = account;
      return next();
    } catch (error) {
      return next(error);
    }
  });
};
