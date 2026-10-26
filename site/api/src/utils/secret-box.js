import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { env } from '../config/env.js';

/**
 * A sealed box for what must stay unreadable if the database leaks: today,
 * each account's Mides refresh token. Ported from cavernia-api.
 *
 * AES-256-GCM, which also authenticates: a row edited by hand does not open,
 * instead of opening into something else. The key is derived from TOKEN_KEY
 * with HKDF and a purpose per kind of content, so a box of one purpose does not
 * open with another's key. Unlike cavernia it is not derived from the session
 * secret: rotating SESSION_SECRET signs everyone out without also throwing away
 * every stored token, and the other way round.
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>`, base64url. The version is for the day
 * the key or the algorithm changes, so nobody has to guess what a row holds.
 */

const VERSION = 'v1';
const MIDES_TOKEN = 'mides-refresh-token';

const key = (purpose) => Buffer.from(hkdfSync('sha256', env.tokenKey, 'overtone-api', purpose, 32));

export const seal = (plain, purpose = MIDES_TOKEN) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(purpose), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);

  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
};

/** What was in the box, or `null` if it is not a box of this key. */
export const open = (sealed, purpose = MIDES_TOKEN) => {
  const [version, iv, tag, body] = String(sealed ?? '').split('.');
  if (version !== VERSION || !iv || !tag || !body) return null;

  try {
    const decipher = createDecipheriv('aes-256-gcm', key(purpose), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));

    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
};
