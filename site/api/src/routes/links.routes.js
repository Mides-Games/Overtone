import { Router } from 'express';

import { botConfigured, env, osuConfigured } from '../config/env.js';
import { guard } from '../middlewares/rate-limit.js';
import { requireSameOrigin, requireSession } from '../middlewares/session.js';
import { ownLinks } from '../services/account.service.js';
import { CODE_MINUTES, issueLinkCode, refreshOsu, setDiscord, setNotify, setOsu } from '../services/links.service.js';
import { discordLinkUrl } from '../services/mides.service.js';
import { checkState, exchange, OSU_COOKIE, osuCookieHeader, refreshProfile, startLink } from '../services/osu.service.js';
import { cookiesOf } from '../services/session.service.js';
import { HttpError } from '../utils/http-error.js';

/**
 * The signed-in account's links (W9.1, W9.2, W9.4). docs/bot.md has the flows.
 *
 *   GET    /me/links                 what is linked, and what this server can link
 *   GET    /links/discord/start      { url }: the Mides page that links Discord, back to /profile
 *   POST   /links/discord/code       { code, expiresAt }: for `/link <code>` in Discord (the bot)
 *   PUT    /links/discord/notify     { on }: the bot's DMs when an analysis ends
 *   DELETE /links/discord
 *   POST   /links/osu/start          { url } and the state cookie
 *   POST   /links/osu/exchange       { code, state } -> the osu! profile, stored
 *   POST   /links/osu/refresh        the osu! card read again from osu!, on the person's own press
 *   DELETE /links/osu
 *
 * Every one needs the session; every mutating one the same-origin header and
 * a rate limit of its own.
 */
const router = Router();

const linkRateLimit = guard('links', 30, 10 * 60_000);
// A refresh is a request to osu!: few an hour per address, and one per
// account every REFRESH_MINUTES whatever the address.
const refreshRateLimit = guard('osu-refresh', 10, 60 * 60_000);
export const REFRESH_MINUTES = 5;

router.use(['/me/links', '/links'], (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/me/links', requireSession, (req, res) => {
  res.json({
    ...ownLinks(req.account),
    available: {
      // Only once MIDES_DISCORD_LINK_PATH names a page Mides serves (env.js says
      // why it is unset by default). Development's fake login has no Mides at all.
      midesDiscord: Boolean(env.midesWebUrl && env.midesDiscordLinkPath) && !env.devLogin,
      bot: botConfigured(),
      osu: osuConfigured(),
    },
  });
});

router.get('/links/discord/start', requireSession, (_req, res) => {
  res.json({ url: discordLinkUrl() });
});

router.post('/links/discord/code', linkRateLimit, requireSameOrigin, requireSession, async (req, res) => {
  if (!botConfigured()) throw new HttpError(503, 'The Discord bot is not running on this server.', 'BOT_OFF');
  const { code, expiresAt } = await issueLinkCode(req.account.id);
  res.json({ code, expiresAt: expiresAt.toISOString(), minutes: CODE_MINUTES });
});

router.put('/links/discord/notify', linkRateLimit, requireSameOrigin, requireSession, async (req, res) => {
  const on = req.body?.on;
  if (typeof on !== 'boolean') throw new HttpError(400, 'on is true or false.', 'BAD_NOTIFY');
  if (!(await setNotify(req.account.id, on))) {
    throw new HttpError(409, 'Link Discord first: the DMs go to the linked Discord account.', 'DISCORD_NOT_LINKED');
  }
  res.json({ notify: on });
});

router.delete('/links/discord', linkRateLimit, requireSameOrigin, requireSession, async (req, res) => {
  await setDiscord(req.account.id, null);
  res.status(204).end();
});

router.post('/links/osu/start', linkRateLimit, requireSameOrigin, requireSession, (req, res) => {
  const { url, cookie } = startLink(req.account.id);
  res.set('Set-Cookie', osuCookieHeader(cookie));
  res.json({ url });
});

router.post('/links/osu/exchange', linkRateLimit, requireSameOrigin, requireSession, async (req, res) => {
  const { code, state } = req.body ?? {};
  if (typeof code !== 'string' || !code || code.length > 4096 || typeof state !== 'string' || !state) {
    throw new HttpError(400, 'The osu! code is missing.', 'OSU_CODE_MISSING');
  }
  // The trip is spent whatever happens: one start, one return.
  res.set('Set-Cookie', osuCookieHeader(''));
  const checked = checkState(cookiesOf(req)[OSU_COOKIE], state, req.account.id);
  if (!checked) {
    throw new HttpError(400, 'This link did not start in this browser, or took too long. Start again from your profile.', 'OSU_STATE_MISSING');
  }
  const profile = await exchange(code, checked);
  const row = await setOsu(req.account.id, profile);
  res.json({ osu: ownLinks(row).osu });
});

router.post('/links/osu/refresh', refreshRateLimit, requireSameOrigin, requireSession, async (req, res) => {
  if (!req.account.osu_user_id) throw new HttpError(409, 'Link osu! first.', 'OSU_NOT_LINKED');
  const last = req.account.osu_refreshed_at ?? req.account.osu_linked_at;
  const waitMs = last ? new Date(last).getTime() + REFRESH_MINUTES * 60_000 - Date.now() : 0;
  if (waitMs > 0) {
    const error = new HttpError(429, `The osu! card was read less than ${REFRESH_MINUTES} minutes ago.`, 'OSU_REFRESH_SOON', {
      retryAfterS: Math.ceil(waitMs / 1000),
    });
    error.headers = { 'Retry-After': String(Math.ceil(waitMs / 1000)) };
    throw error;
  }
  const profile = await refreshProfile(req.account.osu_user_id);
  const row = await refreshOsu(req.account.id, profile);
  if (!row) throw new HttpError(409, 'The osu! link changed meanwhile. Reload the page.', 'OSU_NOT_LINKED');
  res.json({ osu: ownLinks(row).osu });
});

router.delete('/links/osu', linkRateLimit, requireSameOrigin, requireSession, async (req, res) => {
  await setOsu(req.account.id, null);
  res.status(204).end();
});

export default router;
