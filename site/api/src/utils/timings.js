import { HttpError } from './http-error.js';
import { LIST_SORTS, OFFSET_MAX } from './social.js';

/**
 * Published timings (W3.27, W5.1) and a person's history (W3.26): what each
 * list may show, how its filters read, and its cursor. Pure, so the tests
 * reach them without a server; both stores use the same definitions.
 */

/** Rows per page, by default and at most. */
export const PAGE_SIZE = 24;
export const PAGE_MAX = 50;
/** The longest search text: a title and an artist fit, a pasted page does not. */
export const QUERY_MAX = 100;
/** BPM filters are read inside this range; the engine never reports outside it. */
const BPM_LIMIT = 1000;
const STATUSES = ['queued', 'running', 'done', 'refused', 'failed'];

/** One line of a name: no line breaks, no runs of spaces. */
const field = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Title and artist as a public page names a song: the file's own tags, else
 * the file name read as "Artist - Title", else the file name's stem and no
 * artist. The same reading as the web's .osz (site/web lib/osz.js), so the
 * page and the map it builds agree. The file name itself is never shown.
 */
export const songNames = ({ tagTitle, tagArtist, filename }) => {
  if (tagTitle) return { title: field(tagTitle), artist: field(tagArtist) || null };
  const stem = field(String(filename ?? '').replace(/\.[^.]*$/, ''));
  const split = /^(.+?)\s+-\s+(.+)$/.exec(stem);
  if (split) return { artist: field(split[1]), title: field(split[2]) };
  return { title: stem || null, artist: field(tagArtist) || null };
};

/** The song's main BPM, as the result reports it, or null (a refusal). */
export const mainBpm = (result) => {
  const bpm = Number(result?.global_bpm);
  return result && result.global_bpm !== null && Number.isFinite(bpm) ? bpm : null;
};

export const redLineCount = (result) => (Array.isArray(result?.red_lines) ? result.red_lines.length : 0);

/**
 * Variable tempo: red lines at more than one BPM (to 0.01). A meter change
 * alone adds a red line at the same tempo and is still a single tempo.
 */
export const isVariable = (result) =>
  new Set((result?.red_lines ?? []).map((line) => Math.round(Number(line.bpm) * 100))).size > 1;

/**
 * A page's cursor: the last row's time in microseconds since the epoch and
 * its public id, `<µs>-<id>`. Keyset, not offset: a timing published while
 * someone reads page 2 neither repeats a row nor skips one. Microseconds,
 * because that is what PostgreSQL keeps; JavaScript's milliseconds would
 * leave two rows in the same millisecond on either side of the cut.
 */
export const encodeCursor = (micros, id) => `${micros}-${id}`;

export const decodeCursor = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const match = typeof raw === 'string' ? /^(\d{1,17})-([0-9a-f]{32})$/.exec(raw) : null;
  if (!match) throw new HttpError(400, 'cursor is not one this API gave.', 'BAD_CURSOR');
  return { micros: BigInt(match[1]), id: match[2] };
};

/** An offset cursor, `o<n>`: the pages of an order by numbers (W6). */
export const encodeOffset = (offset) => `o${offset}`;

export const decodeOffset = (raw) => {
  if (raw === undefined || raw === null || raw === '') return 0;
  const match = typeof raw === 'string' ? /^o(\d{1,5})$/.exec(raw) : null;
  if (!match || Number(match[1]) > OFFSET_MAX) throw new HttpError(400, 'cursor is not one this API gave.', 'BAD_CURSOR');
  return Number(match[1]);
};

/** A Date (memory) as microseconds, as a BigInt: what a cursor compares. */
export const microsOf = (date) => BigInt(new Date(date).getTime()) * 1000n;

const number = (raw, name) => {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (typeof raw !== 'string' || !Number.isFinite(n) || n < 0 || n > BPM_LIMIT) {
    throw new HttpError(400, `${name} is a BPM from 0 to ${BPM_LIMIT}.`, 'BAD_FILTER');
  }
  return n;
};

const day = (raw, name) => {
  if (raw === undefined || raw === '') return null;
  const match = typeof raw === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) : null;
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw new HttpError(400, `${name} is a date, YYYY-MM-DD.`, 'BAD_FILTER');
  }
  return date;
};

/**
 * The search text: control and bidi characters out, spaces collapsed, at
 * most QUERY_MAX characters. Null when nothing is left.
 */
export const cleanQuery = (raw) => {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw new HttpError(400, 'q is text.', 'BAD_FILTER');
  const text = raw
    .replace(/[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, QUERY_MAX);
  return text || null;
};

/**
 * A list's filters from the query string. Recent (`kind: 'recent'`) takes
 * q, bpmMin, bpmMax and tempo (single | variable); history also status, from
 * and to (UTC days, both included). Anything malformed is a 400, never a
 * silent "everything".
 */
export const listFilters = (query = {}, { kind = 'recent' } = {}) => {
  // The recent list's order (W6): newest, best rated or most used. The two
  // by numbers page by offset (utils/social.js LIST_SORTS says why).
  let sort = 'new';
  if (kind === 'recent' && query.sort !== undefined && query.sort !== '') {
    if (!LIST_SORTS.includes(query.sort)) throw new HttpError(400, `sort is one of ${LIST_SORTS.join(', ')}.`, 'BAD_FILTER');
    sort = query.sort;
  }
  const filters = {
    q: cleanQuery(query.q),
    bpmMin: number(query.bpmMin, 'bpmMin'),
    bpmMax: number(query.bpmMax, 'bpmMax'),
    tempo: null,
    status: null,
    from: null,
    to: null,
    sort,
    cursor: sort === 'new' ? decodeCursor(query.cursor) : null,
    offset: sort === 'new' ? 0 : decodeOffset(query.cursor),
    // Set by a profile's list, never read from the query.
    accountId: null,
    limit: PAGE_SIZE,
  };
  if (query.tempo !== undefined && query.tempo !== '') {
    if (!['single', 'variable'].includes(query.tempo)) throw new HttpError(400, 'tempo is single or variable.', 'BAD_FILTER');
    filters.tempo = query.tempo;
  }
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (typeof query.limit !== 'string' || !Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit is a whole number.', 'BAD_FILTER');
    filters.limit = Math.min(n, PAGE_MAX);
  }
  if (kind === 'history') {
    if (query.status !== undefined && query.status !== '') {
      if (!STATUSES.includes(query.status)) throw new HttpError(400, `status is one of ${STATUSES.join(', ')}.`, 'BAD_FILTER');
      filters.status = query.status;
    }
    filters.from = day(query.from, 'from');
    const to = day(query.to, 'to');
    // `to` names a whole day: everything before the next one.
    filters.to = to ? new Date(to.getTime() + 86_400_000) : null;
  }
  return filters;
};

/**
 * Whether a row passes `filters` (the memory store's reading of what the
 * PostgreSQL one writes in SQL). `at` is the row's list time.
 */
export const matches = (row, filters) => {
  const bpm = mainBpm(row.result);
  if (filters.bpmMin !== null && (bpm === null || bpm < filters.bpmMin)) return false;
  if (filters.bpmMax !== null && (bpm === null || bpm > filters.bpmMax)) return false;
  if (filters.tempo && isVariable(row.result) !== (filters.tempo === 'variable')) return false;
  if (filters.status && row.status !== filters.status) return false;
  if (filters.accountId && row.accountId !== filters.accountId) return false;
  if (filters.from && row.createdAt < filters.from) return false;
  if (filters.to && row.createdAt >= filters.to) return false;
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    const hay = [row.tagTitle, row.tagArtist, row.filename].filter(Boolean).join('\n').toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
};

/** A LIKE pattern that matches `text` anywhere, its own % _ and \ taken literally. */
export const likePattern = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const uploaderOf = (row) =>
  row.uploader
    ? { username: row.uploader.username, displayName: row.uploader.displayName ?? null, avatarUrl: row.uploader.avatarUrl ?? null }
    : null;

/**
 * The result as a public page shows it. The worker's result names no file,
 * but this is the one door to the public: anything that could identify the
 * upload is dropped here by name, whatever a later worker adds.
 */
const PRIVATE_RESULT_KEYS = ['sha1', 'audio_sha1', 'path', 'filename', 'file', 'anon_hash', 'ip_hash'];
const publicResult = (result) => {
  if (!result || typeof result !== 'object') return null;
  const out = { ...result };
  for (const key of PRIVATE_RESULT_KEYS) delete out[key];
  return out;
};

/**
 * One row of the recent list (W5.1). Built field by field, never by spreading
 * the row: the row carries sha1, anon_hash and ip_hash, and none of them
 * leaves through here.
 */
export const recentEntry = (row) => ({
  id: row.publicId,
  ...songNames(row),
  bpm: mainBpm(row.result),
  redLines: redLineCount(row.result),
  variable: isVariable(row.result),
  uploader: uploaderOf(row),
  anonymous: !row.uploader,
  publishedAt: row.publishedAt ? new Date(row.publishedAt).toISOString() : null,
});

/**
 * A timing's own page (W3.27): the list's fields, when it was analysed, and
 * the result. `published` is false for an anonymous upload opened from the
 * queue, which has no votes or comments.
 */
export const publicTiming = (row) => ({
  ...recentEntry(row),
  published: Boolean(row.publishedAt),
  createdAt: new Date(row.createdAt).toISOString(),
  result: publicResult(row.result),
});

/** One row of a person's own history (W3.26): theirs, so the file name and the privacy too. */
export const historyEntry = (row) => ({
  id: row.publicId,
  filename: row.filename,
  ...songNames(row),
  status: row.status,
  bpm: mainBpm(row.result),
  redLines: redLineCount(row.result),
  variable: isVariable(row.result),
  private: Boolean(row.private),
  published: Boolean(row.publishedAt),
  ...(row.publishedAt ? { publishedAt: new Date(row.publishedAt).toISOString() } : {}),
  cached: Boolean(row.cachedFrom),
  createdAt: new Date(row.createdAt).toISOString(),
});
