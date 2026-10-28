/**
 * The site's public statistics (W12.13): what `GET /stats` may say, and the
 * pieces both stores share so they cannot disagree. Pure, so the tests reach
 * it without a server.
 *
 * Aggregates only. The stores hand over counts, a histogram and two
 * percentiles; nothing here takes a row, so nothing here can pass one on.
 */

/** The window the analysis times are read over, in days. */
export const STATS_DAYS = 30;

/**
 * Fewer finished analyses than this in the window and the times are not
 * given: a median of two jobs is a number that looks measured and is not
 * (CLAUDE.md rule 2). The page says "not enough analyses yet".
 */
export const MIN_TIMED = 5;

/**
 * The BPM histogram's edges, 20 BPM apart: bucket i holds edges[i-1] <= bpm <
 * edges[i], bucket 0 everything below the first edge and the last everything
 * from the last edge up. The same reading as PostgreSQL's
 * `width_bucket(bpm, edges)`, which the pg store uses with this array, so the
 * two stores bucket a BPM on an edge the same way. 120-240 is the octave osu!
 * maps are read at (python/overtone.py MAP_OCTAVE_RANGE), so it sits in the
 * middle with room on either side.
 */
export const BPM_EDGES = [80, 100, 120, 140, 160, 180, 200, 220, 240, 260];

/** The bucket of `bpm`, 0..BPM_EDGES.length, as `width_bucket` numbers it. */
export const bucketOf = (bpm) => {
  let i = 0;
  while (i < BPM_EDGES.length && bpm >= BPM_EDGES[i]) i += 1;
  return i;
};

/**
 * The `q` quantile of `values` with linear interpolation between the two
 * nearest ranks: PostgreSQL's `percentile_cont`, so both stores agree. Null
 * for no values.
 */
export const percentile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = q * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
};

const whole = (n) => Math.max(0, Math.trunc(Number(n) || 0));
const seconds = (ms) => (ms === null || ms === undefined || !Number.isFinite(Number(ms)) ? null : Math.round(Number(ms) / 100) / 10);

/**
 * The response, built field by field from what a store counted:
 *
 *   counts   { done, refused, failed, cached, published, songs }
 *   buckets  counts per bucket, BPM_EDGES.length + 1 of them (missing ones are 0)
 *   tempo    { single, variable }
 *   times    { count, medianMs, p90Ms }
 *   queue    { queued, running }
 *
 * Anything else a store might add is dropped here.
 */
export const shapeStats = ({ counts = {}, buckets = [], tempo = {}, times = {}, queue = {} }, { days = STATS_DAYS, now = new Date() } = {}) => {
  const timed = whole(times.count);
  const enough = timed >= MIN_TIMED;
  return {
    generatedAt: new Date(now).toISOString(),
    totals: {
      done: whole(counts.done),
      refused: whole(counts.refused),
      failed: whole(counts.failed),
      cached: whole(counts.cached),
      published: whole(counts.published),
      songs: whole(counts.songs),
    },
    bpm: {
      edges: [...BPM_EDGES],
      buckets: Array.from({ length: BPM_EDGES.length + 1 }, (_, i) => ({
        from: i === 0 ? null : BPM_EDGES[i - 1],
        to: i === BPM_EDGES.length ? null : BPM_EDGES[i],
        count: whole(buckets[i]),
      })),
    },
    tempo: { single: whole(tempo.single), variable: whole(tempo.variable) },
    analysisTime: {
      days,
      count: timed,
      minCount: MIN_TIMED,
      medianS: enough ? seconds(times.medianMs) : null,
      p90S: enough ? seconds(times.p90Ms) : null,
    },
    queue: { queued: whole(queue.queued), running: whole(queue.running) },
  };
};
