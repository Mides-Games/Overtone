import { randomBytes } from 'node:crypto';

import { Router } from 'express';

import { env, ssoConfigured } from '../config/env.js';
import { authRateLimit } from '../middlewares/rate-limit.js';
import { requireSameOrigin } from '../middlewares/session.js';
import { sessionAccount, signOut, upsertFromMides } from '../services/account.service.js';
import { authorizeUrl, exchangeCode, PROVIDERS, ssoStatus } from '../services/mides.service.js';
import {
  clearedCookieHeader,
  clearedSsoCookieHeader,
  COOKIE,
  cookieHeader,
  cookiesOf,
  issue,
  issueSsoStart,
  read,
  readSsoStart,
  SSO_COOKIE,
  ssoCookieHeader,
} from '../services/session.service.js';
import { HttpError } from '../utils/http-error.js';

/**
 * Signing in with Mides, and out. Ported from cavernia-api's auth routes,
 * reduced to the SSO: Overtone has no password form of its own.
 *
 *   GET  /auth/config        what the login screen can offer
 *   GET  /auth/sso/start     where to send the browser, plus the CSRF cookie
 *   POST /auth/sso/exchange  the code from /login/callback -> the session cookie
 *   POST /auth/logout
 *
 * With MIDES_DEV_LOGIN=1 (refused in production) the start route sends the
 * browser straight back to /login/callback with a `dev.` code and the exchange
 * signs it in as a fake account, without talking to Mides. The CSRF cookie is
 * demanded all the same, so the dev round trip exercises the real path.
 */
const router = Router();

// Nothing about signing in may sit in a cache.
router.use('/auth', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/**
 * `sso` is the pre-flight's answer (mides.service.js `ssoStatus`): `ready`,
 * `app_unknown` (Mides would refuse this app and strand the person on its
 * own error page), `unreachable`, `unknown` (no reason to block), or `off`
 * when this server has no Mides configured. The login page says so instead
 * of sending anyone away.
 */
router.get('/auth/config', async (_req, res) => {
  const configured = env.devLogin || ssoConfigured();
  res.json({
    devLogin: env.devLogin,
    providers: configured ? [...PROVIDERS] : [],
    sso: env.devLogin ? 'ready' : ssoConfigured() ? await ssoStatus() : 'off',
  });
});

/** The pre-flight's refusals, as the start route says them. */
const SSO_BLOCKED = {
  app_unknown: () => new HttpError(503, 'Sign-in through Mides is not available right now: Mides does not accept this site yet.', 'MIDES_APP_UNKNOWN'),
  unreachable: () => new HttpError(503, 'Sign-in through Mides is not available right now: Mides did not answer.', 'MIDES_UNAVAILABLE'),
};

router.get('/auth/sso/start', async (req, res) => {
  const provider = PROVIDERS.has(req.query.provider) ? req.query.provider : null;

  let url;
  if (env.devLogin) {
    const code = `dev.${provider ?? 'discord'}.${randomBytes(9).toString('base64url')}`;
    url = `${env.siteUrl}/login/callback#code=${code}`;
  } else {
    if (!ssoConfigured()) throw new HttpError(503, 'Sign-in is not configured on this server.', 'SSO_NOT_CONFIGURED');
    // A page loaded before Mides went away still asks here first: the same
    // answer as the login page's, so nobody is sent to a dead end.
    const blocked = SSO_BLOCKED[await ssoStatus()];
    if (blocked) throw blocked();
    url = authorizeUrl(provider);
  }

  res.set('Set-Cookie', ssoCookieHeader(issueSsoStart()));
  res.json({ url });
});

router.post('/auth/sso/exchange', authRateLimit, requireSameOrigin, async (req, res) => {
  const code = req.body?.code;
  if (!code || typeof code !== 'string' || code.length > 4096) {
    throw new HttpError(400, 'The sign-in code is missing.', 'SSO_CODE_MISSING');
  }

  // The trip is spent whatever happens: one start, one return.
  res.set('Set-Cookie', clearedSsoCookieHeader());
  if (!readSsoStart(cookiesOf(req)[SSO_COOKIE])) {
    throw new HttpError(
      400,
      'This sign-in did not start in this browser, or took too long. Start again from the login page.',
      'SSO_STATE_MISSING',
    );
  }

  const { user } = env.devLogin && code.startsWith('dev.') ? devUser(code) : await exchangeCode(code);
  const account = await upsertFromMides(user);

  res.set('Set-Cookie', [clearedSsoCookieHeader(), cookieHeader(issue(account.id, account.session_version))]);
  res.json({ ok: true });
});

router.post('/auth/logout', requireSameOrigin, async (req, res) => {
  // The account comes from the cookie's signature: if the database is down,
  // forgetting the token may fail, but signing out must not.
  const session = read(cookiesOf(req)[COOKIE]);
  if (session) {
    const account = await sessionAccount(session).catch(() => null);
    if (account) {
      await signOut(account.id).catch((error) => console.warn(`[auth] sign-out bookkeeping failed: ${error.message}`));
    }
  }

  res.set('Set-Cookie', clearedCookieHeader());
  res.status(204).end();
});

/** The Discord dev user's Discord id: a well-formed snowflake no real user has. */
export const DEV_DISCORD_ID = '100000000000000001';

/**
 * The fake Mides user of MIDES_DEV_LOGIN: one per provider, so both buttons
 * can be tried. The Google one is a moderator, so the queue's staff buttons
 * (W3.18) can be tried too.
 */
const devUser = (code) => {
  const provider = code.split('.')[1] === 'google' ? 'google' : 'discord';
  return {
    user: {
      midesUserId: `dev-${provider}`,
      username: `dev_${provider}`,
      displayName: `Dev tester (${provider})`,
      avatarUrl: null,
      bannerUrl: null,
      // The Discord one comes with a Discord id, as a Mides that sends
      // `discord_id` would (W9.1), so the bot's linked path can be tried.
      discordId: provider === 'discord' ? DEV_DISCORD_ID : null,
      role: provider === 'google' ? 'moderator' : null,
    },
  };
};

export default router;
