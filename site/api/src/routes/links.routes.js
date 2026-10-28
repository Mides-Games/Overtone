import { Router } from 'express';

import { botConfigured, env, osuConfigured } from '../config/env.js';
import { guard } from '../middlewares/rate-limit.js';
import { requireSameOrigin, requireSession } from '../middlewares/session.js';
import { ownLinks } from '../services/account.service.js';
import { CODE_MINUTES, issueLinkCode, setDiscord, setNotify, setOsu } from '../services/links.service.js';
import { discordLinkUrl } from '../services/mides.service.js';
import { checkState, exchange, OSU_COOKIE, osuCookieHeader, startLink } from '../services/osu.service.js';
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
 *   DELETE /links/osu
 *
 * Every one needs the session; every mutating one the same-origin header and
 * a rate limit of its own.
 */
const router = Router();

const linkRateLimit = guard('links', 30, 10 * 60_000);

router.use(['/me/links', '/links'], (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/me/links', requireSession, (req, res) => {
  res.json({
    ...ownLinks(req.account),
    available: {
      // The Mides page needs only MIDES_WEB_URL here; whether Mides serves it is
      // Mides' side (docs/bot.md). Development's fake login has no Mides at all.
      midesDiscord: Boolean(env.midesWebUrl) && !env.devLogin,
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

router.delete('/links/osu', linkRateLimit, requireSameOrigin, requireSession, async (req, res) => {
  await setOsu(req.account.id, null);
  res.status(204).end();
});

export default router;
