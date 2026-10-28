import { HttpError } from './http-error.js';

/**
 * Social v2 on published timings (W5.6, W6, W13.15, W13.18): the rules both
 * stores and the routes share. Pure, so the tests reach them without a server.
 */

// ── Stars ───────────────────────────────────────────────────────────────────

/**
 * "Best rated" counts a timing only from this many ratings on. Three, not
 * one: one rating is one person's opinion (often a friend's, or the
 * uploader's second account), and with few accounts at first a higher bar
 * would leave the sort empty for months. Three is the least that says more
 * than one person agreed, and the page says what the bar is.
 */
export const MIN_RATINGS_TO_RANK = 3;

/**
 * And among those, the order is a Bayesian average, as docs/16 §4 asks: the
 * ratings are counted with PRIOR_RATINGS more at PRIOR_STARS (the middle of
 * the scale), so a 5.0 from three people (4.0) does not outrank a 4.6 from
 * two hundred (4.58). The page shows the plain average; only the order uses this.
 */
export const PRIOR_RATINGS = 3;
export const PRIOR_STARS = 3;

/** The order's score: the Bayesian average of `count` ratings summing to `sum`. */
export const rankScore = (sum, count) => (PRIOR_RATINGS * PRIOR_STARS + sum) / (PRIOR_RATINGS + count);

/** The plain average to two decimals, or null when nobody rated. */
export const averageOf = (sum, count) => (count ? Math.round((sum / count) * 100) / 100 : null);

/** Whole stars 1-5, or a 400. */
export const starsOf = (raw) => {
  if (!Number.isInteger(raw) || raw < 1 || raw > 5) throw new HttpError(400, 'stars is a whole number from 1 to 5.', 'BAD_STARS');
  return raw;
};

// ── Ranking of timers (W6) ──────────────────────────────────────────────────

/**
 * A timer enters the ranking by uses with this many uses of their published
 * timings by other accounts, and the ranking by stars with this many ratings
 * received. Small on purpose: few people use the site at first, and a bar
 * nobody clears would make the page a promise. The page states both.
 */
export const TIMER_MIN_USES = 3;
export const TIMER_MIN_RATINGS = 5;
export const TIMERS_LIMIT = 50;
export const TIMER_SORTS = ['uses', 'stars'];

// ── The recent list's orders (W5.1) ─────────────────────────────────────────

/**
 * `new` is the keyset list utils/timings.js pages by time. `rated` and `used`
 * are orders by numbers that move while someone reads, so their pages are by
 * offset (a cursor `o<n>`): a keyset over a moving score would skip or repeat
 * rows just the same, and an offset at least says so plainly.
 */
export const LIST_SORTS = ['new', 'rated', 'used'];
export const OFFSET_MAX = 10_000;

// ── "I used this" ───────────────────────────────────────────────────────────

const MODES = ['osu', 'taiko', 'fruits', 'mania'];

/**
 * An osu! beatmapset link in its one canonical form, or null for none.
 * Accepted: `https://osu.ppy.sh/beatmapsets/<set>` with an optional
 * `#<mode>/<beatmap>`, and the old `https://osu.ppy.sh/s/<set>`; http, a
 * `www.` and a trailing slash are forgiven. Anything else (another host, a
 * user page, a query string, a `javascript:` link) is a 400, so the link a
 * page shows can only ever point at a beatmapset on osu.ppy.sh. The set's
 * metadata is not fetched: that needs the osu! API (W9.2).
 */
export const beatmapUrlOf = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const bad = () => new HttpError(400, 'beatmapUrl is an osu.ppy.sh beatmapset link.', 'BAD_BEATMAP_URL');
  if (typeof raw !== 'string' || raw.length > 200) throw bad();
  const text = raw.trim();
  const match =
    /^https?:\/\/(?:www\.)?osu\.ppy\.sh\/(?:beatmapsets\/(\d{1,10})\/?(?:#([a-z]+)\/(\d{1,10}))?|s\/(\d{1,10})\/?)$/.exec(text);
  if (!match) throw bad();
  const set = match[1] ?? match[4];
  if (match[2] && !MODES.includes(match[2])) throw bad();
  if (Number(set) < 1) throw bad();
  return `https://osu.ppy.sh/beatmapsets/${Number(set)}${match[2] ? `#${match[2]}/${Number(match[3])}` : ''}`;
};

// ── Comments ────────────────────────────────────────────────────────────────

/** A comment is a remark on a timing, not an essay: a fourth of a suggestion. */
export const COMMENT_MAX = 1000;
export const COMMENTS_PAGE = 100;
/** The longest song a comment's time may point into, when the result does not say. */
const AT_MAX_MS = 86_400_000;

/**
 * A comment's place in the song (W13.15): whole milliseconds from 0 to the
 * song's length (`durationS`, when the result knows it), or null for a
 * comment on the whole timing. Out of range is a 400, never clamped: a time
 * past the end would be a link to nothing.
 */
export const atMsOf = (raw, durationS = null) => {
  if (raw === undefined || raw === null) return null;
  const end = Number.isFinite(durationS) && durationS > 0 ? Math.ceil(durationS * 1000) : AT_MAX_MS;
  if (!Number.isInteger(raw) || raw < 0 || raw > Math.min(end, AT_MAX_MS)) {
    throw new HttpError(400, 'atMs is a time in the song, in whole milliseconds.', 'BAD_TIME');
  }
  return raw;
};

// ── Collections ─────────────────────────────────────────────────────────────

export const COLLECTION_NAME_MAX = 80;
export const COLLECTIONS_PER_ACCOUNT = 50;
export const ITEMS_PER_COLLECTION = 500;

// ── Profiles (W5.6, W13.18) ─────────────────────────────────────────────────

/**
 * What a username in a URL may be before it is looked up: Mides' usernames
 * are letters, digits, `_`, `.` and `-`. Anything else cannot be one, and is
 * the same 404 as a name nobody has.
 */
export const USERNAME = /^[A-Za-z0-9_.-]{1,40}$/;

/** Suggestion states that mean "accepted" (W5.2: aceptada / planeada → en progreso → hecha). */
export const ACCEPTED_STATES = ['planned', 'progress', 'done'];

/**
 * A timer's badges from their numbers, in the order a profile shows them.
 * Each is earned by something counted, never granted by hand:
 *
 * - `first-timing`: published one timing;
 * - `published-10`, `published-50`: published that many;
 * - `suggestion-accepted`: a suggestion of theirs reached planned, in
 *   progress or done (the community records its author);
 * - `used-by-others`: another account marked one of their timings used.
 *
 * `ranked-match` (docs/16 §4: a published timing that matches the ranked
 * map's) waits for the osu! link (W9.2), which is what names a timing's
 * beatmapset; when it lands it is one more line here, fed by a count of
 * matched timings in `stats.rankedMatches`.
 */
export const badgesOf = (stats) => {
  const badges = [];
  if (stats.published >= 1) badges.push('first-timing');
  if (stats.published >= 10) badges.push('published-10');
  if (stats.published >= 50) badges.push('published-50');
  if (stats.acceptedSuggestion) badges.push('suggestion-accepted');
  if (stats.uses >= 1) badges.push('used-by-others');
  if ((stats.rankedMatches ?? 0) >= 1) badges.push('ranked-match');
  return badges;
};

/** A person as a public page names them: the Mides public fields, nothing else. */
export const personOf = (row) =>
  row ? { username: row.username, displayName: row.display_name ?? row.displayName ?? null, avatarUrl: row.avatar_url ?? row.avatarUrl ?? null } : null;
