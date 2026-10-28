import { HttpError } from './http-error.js';
import { cleanText } from './text.js';

/**
 * What a person may write on their own profile (the profile edit, 2026-10-28):
 * an "About" text, a name to show instead of Mides' one, four links, an
 * accent colour and up to six pinned timings. Pure, so the tests reach it
 * without a server; both stores keep what these functions return and nothing
 * else.
 *
 * The photo, the banner and the username stay Mides' (ADR-W3): they are
 * refreshed at every sign-in, and the page says where to change them.
 */

/** The "About" text, in code points after cleaning. A paragraph or two, not a page. */
export const ABOUT_MAX = 600;

/** A shown name: Mides' own `full_name` fits in this too. */
export const NAME_MAX = 40;

/** A link, as stored. Every accepted form normalises well under it. */
export const LINK_MAX = 200;

/** Pinned timings at the top of a profile. */
export const SHOWCASE_MAX = 6;

/**
 * The accents a profile may pick. The colours themselves live in the web
 * (site/web lib/accents.js), each checked there for AA contrast on both
 * themes; the API keeps only the name, so a value here can never be a colour
 * nobody checked. `null` is the site's own teal.
 */
export const ACCENTS = ['blue', 'violet', 'pink', 'orange', 'green', 'red'];

export const LINK_KINDS = ['osu', 'website', 'youtube', 'twitch'];

const badLink = (kind) => new HttpError(400, `That is not a ${kind} link this profile can show.`, 'BAD_LINK', { kind });

/** A URL object for `raw`, https only, no credentials, no port; else `null`. */
const httpsUrl = (raw) => {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > LINK_MAX || /\s/.test(text)) return null;
  let url;
  try {
    // A bare "osu.ppy.sh/users/2" is read as https, as a person would mean it.
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return url;
};

const hostIs = (url, hosts) => hosts.includes(url.hostname.toLowerCase());

/**
 * Each kind's reading: the one canonical URL it keeps, or `null` when the
 * text is not that kind of link. A kind's link goes only to its own site: an
 * "osu!" link that leads elsewhere is the classic way to dress a phishing
 * page as a profile link.
 */
const READERS = {
  osu(raw) {
    const url = httpsUrl(raw);
    if (!url || !hostIs(url, ['osu.ppy.sh', 'www.osu.ppy.sh']) || url.search || url.hash) return null;
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    const m = /^\/(?:users|u)\/([A-Za-z0-9_\-[\]]{1,32})(?:\/(osu|taiko|fruits|mania))?\/?$/.exec(path);
    return m ? `https://osu.ppy.sh/users/${encodeURIComponent(m[1])}${m[2] ? `/${m[2]}` : ''}` : null;
  },
  website(raw) {
    const url = httpsUrl(raw);
    if (!url) return null;
    const host = url.hostname.toLowerCase();
    // A name with a dot, not an address: an IP or a single label is no one's website.
    if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[')) return null;
    return url.href.length <= LINK_MAX ? url.href : null;
  },
  youtube(raw) {
    const url = httpsUrl(raw);
    if (!url || !hostIs(url, ['youtube.com', 'www.youtube.com', 'm.youtube.com']) || url.search || url.hash) return null;
    const m = /^\/(@[A-Za-z0-9_.-]{3,30}|channel\/UC[A-Za-z0-9_-]{22}|c\/[A-Za-z0-9_.-]{1,100}|user\/[A-Za-z0-9_.-]{1,100})\/?$/.exec(url.pathname);
    return m ? `https://www.youtube.com/${m[1]}` : null;
  },
  twitch(raw) {
    const url = httpsUrl(raw);
    if (!url || !hostIs(url, ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv']) || url.search || url.hash) return null;
    const m = /^\/([A-Za-z0-9_]{4,25})\/?$/.exec(url.pathname);
    return m ? `https://www.twitch.tv/${m[1].toLowerCase()}` : null;
  },
};

/** One link of `kind`: its canonical URL, `null` for an empty value, a 400 for anything else. */
export const linkOf = (kind, raw) => {
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) return null;
  const out = READERS[kind]?.(raw) ?? null;
  if (!out) throw badLink(kind);
  return out;
};

/** The links object as sent: only the known kinds, each read; an empty one drops out. */
export const linksOf = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'links is an object.', 'BAD_LINK');
  const out = {};
  for (const kind of LINK_KINDS) {
    const value = linkOf(kind, raw[kind]);
    if (value) out[kind] = value;
  }
  return out;
};

/** Stored links read back: only known kinds that still read as their kind (a row edited by hand stays safe). */
export const storedLinks = (raw) => {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const kind of LINK_KINDS) {
    const value = typeof raw[kind] === 'string' ? READERS[kind](raw[kind]) : null;
    if (value) out[kind] = value;
  }
  return out;
};

const ID = /^[0-9a-f]{32}$/;

/**
 * The fields of a profile edit, read and cleaned: only the ones sent, so an
 * edit of one leaves the others as they are. A wrong type is a 400 naming
 * the field; text is cleaned (utils/text.js) and capped; an empty text means
 * "none" (the shown name falls back to Mides').
 */
export const profileEdit = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Send the fields to change.', 'BAD_PROFILE');
  const out = {};
  if ('private' in body) {
    if (typeof body.private !== 'boolean') throw new HttpError(400, 'private is true or false.', 'BAD_FLAG');
    out.private = body.private;
  }
  if ('about' in body) {
    if (body.about !== null && typeof body.about !== 'string') throw new HttpError(400, 'about is text.', 'BAD_ABOUT');
    out.about = cleanText(body.about ?? '', ABOUT_MAX, { multiline: true });
  }
  if ('displayName' in body) {
    if (body.displayName !== null && typeof body.displayName !== 'string') throw new HttpError(400, 'displayName is text.', 'BAD_NAME');
    out.displayName = cleanText(body.displayName ?? '', NAME_MAX);
  }
  if ('links' in body) out.links = linksOf(body.links);
  if ('accent' in body) {
    if (body.accent !== null && !ACCENTS.includes(body.accent)) throw new HttpError(400, 'accent is one of the palette, or null.', 'BAD_ACCENT');
    out.accent = body.accent;
  }
  if ('showcase' in body) {
    const list = body.showcase;
    if (!Array.isArray(list) || list.length > SHOWCASE_MAX || !list.every((id) => typeof id === 'string' && ID.test(id))) {
      throw new HttpError(400, `showcase is a list of at most ${SHOWCASE_MAX} timing ids.`, 'BAD_SHOWCASE');
    }
    if (new Set(list).size !== list.length) throw new HttpError(400, 'A timing is pinned once.', 'BAD_SHOWCASE');
    out.showcase = [...list];
  }
  if (!Object.keys(out).length) throw new HttpError(400, 'Send the fields to change.', 'BAD_PROFILE');
  return out;
};

/** A Discord username as Mides would send it (the 2023 names: 2-32 of a-z, 0-9, `_` and `.`), or `null`. */
export const discordName = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_.]{2,32}$/.test(value.trim()) ? value.trim().toLowerCase() : null;
