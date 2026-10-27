import { Router } from 'express';

import { guard } from '../middlewares/rate-limit.js';
import { requireBrowserSession, requireSameOrigin } from '../middlewares/session.js';
import { MAX_TOKENS, NAME_MAX, parseScopes, SCOPES, tokens, tokenView } from '../services/token.service.js';
import { HttpError } from '../utils/http-error.js';
import { cleanText } from '../utils/text.js';

/**
 * Personal API tokens (W12.20), managed from the website only:
 *
 *   GET    /me/tokens        the account's tokens (never the secret), the scopes and the cap
 *   POST   /me/tokens        { name, scopes } -> 201 { token, ... }: the secret, this once
 *   DELETE /me/tokens/:id    revoke one
 *
 * A browser session, the same-origin header and a rate limit on the changes;
 * a token itself gets 403 here (middlewares/token.js and requireBrowserSession):
 * a leaked token cannot mint more of itself. "Not yours" is the 404 of "does
 * not exist".
 */
const router = Router();

const ID = /^[0-9a-f]{32}$/;
// Making and revoking tokens is rare; the cap (MAX_TOKENS) is the real bound,
// this only stops a loop.
const changeLimit = guard('tokens', 60, 10 * 60_000);

router.get('/me/tokens', requireBrowserSession, async (req, res) => {
  const list = await tokens().list(req.account.id);
  res.set('Cache-Control', 'no-store');
  res.json({ tokens: list.map(tokenView), scopes: SCOPES, max: MAX_TOKENS });
});

router.post('/me/tokens', changeLimit, requireSameOrigin, requireBrowserSession, async (req, res) => {
  const body = req.body ?? {};
  const name = cleanText(body.name, NAME_MAX + 1);
  if (!name) throw new HttpError(400, 'Give the token a name, so you know later what uses it.', 'BAD_NAME');
  if ([...name].length > NAME_MAX) throw new HttpError(400, `A token's name is at most ${NAME_MAX} characters.`, 'TOO_LONG', { max: NAME_MAX });
  const scopes = parseScopes(body.scopes);
  if (!scopes) throw new HttpError(400, `scopes is a list of ${SCOPES.join(', ')}.`, 'BAD_SCOPES', { scopes: SCOPES });
  const { token, row } = await tokens().create({ accountId: req.account.id, name, scopes });
  res.set('Cache-Control', 'no-store');
  res.status(201).json({ token, ...tokenView(row) });
});

router.delete('/me/tokens/:id', changeLimit, requireSameOrigin, requireBrowserSession, async (req, res) => {
  const { id } = req.params;
  if (!ID.test(id) || !(await tokens().revoke(req.account.id, id))) throw new HttpError(404, 'No such token.', 'NOT_FOUND');
  res.status(204).end();
});

export default router;
