import { HttpError } from './http-error.js';

/**
 * How a person asks for an analysis (W11.1, W3.21, W12.19): a mode, chosen by
 * how long they want to wait, and hints, every one optional. Pure, so the
 * tests reach it without a server; worker/timing_result.py reads the same
 * shape and checks the same bounds again.
 *
 *   mode     fast | normal | strict (default normal: the analysis as it was)
 *   tempo    constant | changes      "one BPM throughout" or "the tempo changes"
 *   bpm      30-400                  an approximate BPM, or instead
 *   bpm_min, bpm_max                 an expected range (both, min < max)
 *   meter    1-16                    beats per bar
 *   start_s, end_s                   analyse only this stretch, in seconds
 *   band     true                    a live band: the worker separates the drums
 *
 * The mode and the hints are part of the cache key: the same audio asked for
 * another way is another result. `optionsKey` is that key, one canonical
 * string, '' for no hints, so an equal request always finds the same row.
 */
export const MODES = ['fast', 'normal', 'strict'];
export const DEFAULT_MODE = 'normal';
export const TEMPO_HINTS = ['constant', 'changes'];
export const BPM_RANGE = [30, 400];
export const METER_RANGE = [1, 16];
/** The shortest stretch worth analysing, as the worker's MIN_STRETCH_S. */
export const MIN_STRETCH_S = 10;
/** The options travel in a header on upload: no more than this, as JSON. */
export const MAX_OPTIONS_BYTES = 512;

const KEYS = ['tempo', 'bpm', 'bpm_min', 'bpm_max', 'meter', 'start_s', 'end_s', 'band'];

const bad = (message) => new HttpError(400, message, 'BAD_OPTIONS');

/** The mode asked for, `normal` when none; anything else is a 400. */
export const parseMode = (raw) => {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MODE;
  if (typeof raw !== 'string' || !MODES.includes(raw)) {
    throw new HttpError(400, `mode is one of ${MODES.join(', ')}.`, 'BAD_MODE');
  }
  return raw;
};

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const round3 = (value) => Math.round(value * 1000) / 1000;

/**
 * The hints, checked: `{ options, key }`, `options` holding only what was
 * given (numbers rounded to the millisecond or the thousandth of a BPM).
 * Anything unknown, of the wrong type or out of bounds is a 400 that says
 * which: a hint that silently vanished would be worse than none.
 */
export const parseOptions = (raw, { maxSeconds = 3600 } = {}) => {
  if (raw === undefined || raw === null) return { options: {}, key: '' };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('options is an object.');
  const unknown = Object.keys(raw).filter((k) => !KEYS.includes(k));
  if (unknown.length) throw bad(`Unknown option: ${unknown[0].slice(0, 32)}.`);
  const out = {};
  const given = (k) => raw[k] !== undefined && raw[k] !== null;

  if (given('tempo')) {
    if (!TEMPO_HINTS.includes(raw.tempo)) throw bad(`tempo is ${TEMPO_HINTS.join(' or ')}.`);
    out.tempo = raw.tempo;
  }
  const bpm = (k) => {
    if (!isNumber(raw[k]) || raw[k] < BPM_RANGE[0] || raw[k] > BPM_RANGE[1]) {
      throw bad(`${k} is a BPM from ${BPM_RANGE[0]} to ${BPM_RANGE[1]}.`);
    }
    return round3(raw[k]);
  };
  if (given('bpm')) {
    if (given('bpm_min') || given('bpm_max')) throw bad('Give an approximate BPM or a range, not both.');
    out.bpm = bpm('bpm');
  } else if (given('bpm_min') || given('bpm_max')) {
    const low = bpm('bpm_min');
    const high = bpm('bpm_max');
    if (!(low < high)) throw bad('bpm_min is below bpm_max.');
    out.bpm_min = low;
    out.bpm_max = high;
  }
  if (given('meter')) {
    if (!Number.isInteger(raw.meter) || raw.meter < METER_RANGE[0] || raw.meter > METER_RANGE[1]) {
      throw bad(`meter is a whole number of beats from ${METER_RANGE[0]} to ${METER_RANGE[1]}.`);
    }
    out.meter = raw.meter;
  }
  if (given('start_s') || given('end_s')) {
    const start = raw.start_s;
    const end = raw.end_s;
    if (!isNumber(start) || !isNumber(end) || start < 0 || end > maxSeconds) {
      throw bad(`start_s and end_s are seconds from 0 to ${maxSeconds}.`);
    }
    if (end - start < MIN_STRETCH_S) throw bad(`The stretch is at least ${MIN_STRETCH_S} seconds long.`);
    out.start_s = round3(start);
    out.end_s = round3(end);
  }
  if (given('band')) {
    if (typeof raw.band !== 'boolean') throw bad('band is true or false.');
    if (raw.band) out.band = true;
  }
  return { options: out, key: optionsKey(out) };
};

/** One canonical string for a set of hints: the cache key's part. */
export const optionsKey = (options) =>
  Object.keys(options ?? {})
    .filter((k) => KEYS.includes(k))
    .sort()
    .map((k) => `${k}=${options[k]}`)
    .join(';');

/**
 * The options header of an upload (`X-Options`, JSON, percent-encoded by the
 * browser like the file name): the hints, or a 400 when it is not JSON or is
 * too long to be anything this page sends.
 */
export const optionsFromHeader = (header, limits) => {
  if (header === undefined || header === null || header === '') return parseOptions(null, limits);
  if (typeof header !== 'string' || header.length > MAX_OPTIONS_BYTES * 3) throw bad('X-Options is too long.');
  let text;
  try {
    text = decodeURIComponent(header);
  } catch {
    throw bad('X-Options is not percent-encoded JSON.');
  }
  if (Buffer.byteLength(text) > MAX_OPTIONS_BYTES) throw bad('X-Options is too long.');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw bad('X-Options is not JSON.');
  }
  return parseOptions(raw, limits);
};

/**
 * The audio's length as the browser read it, in seconds (one decimal), or
 * null: only ever used for the queue's estimate (W3.16), never trusted for
 * anything the worker does. A stretch counts as its own length.
 */
export const audioSecondsOf = (raw, options = {}) => {
  if (Number.isFinite(options.start_s) && Number.isFinite(options.end_s)) {
    return Math.round((options.end_s - options.start_s) * 10) / 10;
  }
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (!isNumber(value) || value <= 0 || value > 4 * 3600) return null;
  return Math.round(value * 10) / 10;
};
