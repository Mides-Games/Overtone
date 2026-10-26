import { isProduction } from '../config/env.js';

/**
 * The headers that keep a response of this JSON API from being used as
 * anything else. Written by hand rather than with helmet: four of helmet's
 * headers apply to an API that never serves HTML, and four readable lines beat
 * a dependency one has to go and read.
 *
 * - `nosniff`: a JSON body is never reinterpreted as HTML or script.
 * - `X-Frame-Options: DENY`: nothing here is framed.
 * - `Referrer-Policy: no-referrer`: the API never navigates anywhere.
 * - `Cross-Origin-Resource-Policy: same-site`: other sites cannot embed it.
 * - HSTS in production only: sent from localhost it pins the developer's own
 *   localhost to https in their browser.
 */
export const securityHeaders = (_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cross-Origin-Resource-Policy', 'same-site');

  if (isProduction) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
};
