/**
 * An estimated wait for each row of the public queue (W3.16), from what one
 * worker job was measured to cost (W2.4, docs/timeline.md "W2.4: what one
 * worker job costs"). Pure, so the tests reach it without a server.
 *
 * Always a range, never a number: the same job cost four times as much on
 * this machine loaded as quiet, and the server's container has not been
 * measured yet. The low end is the quiet run, as a fixed part plus a part
 * per minute of audio (fitted to its 1, 6 and 10 minute cases); the high end
 * is the conservative figure docs/16-web-platform.md gives for W3.16, the
 * loaded run: 35 s per minute of audio with the Beat This! vote, 11 without.
 *
 *   quiet, vote      8.2 s at 1 min, 32 s at 6, 54 s at 10   ->  3 + 5.1 s/min
 *   quiet, no vote   2.1 s at 1 min, 5.4 s at 6, 9 s at 10   ->  1.4 + 0.77 s/min
 *
 * `fast` is the no-vote figure (it also skips the octave judges, so it can
 * only be cheaper); `strict` costs what `normal` does while it runs the same
 * analysis (worker/timing_result.py, MODE_SETTINGS).
 *
 * A job whose length is not known (the browser could not read it) has a
 * fixed part for its low end and no high end: everything behind it then gets
 * "at least" and not a made-up ceiling. One worker is assumed, as deployed
 * (docs/deploy.md): with more, the real wait is shorter, never longer.
 */
export const COSTS = {
  fast: { fixed: 1.4, perMin: 0.77, highPerMin: 11 },
  normal: { fixed: 3, perMin: 5.1, highPerMin: 35 },
  strict: { fixed: 3, perMin: 5.1, highPerMin: 35 },
};

/** One job's cost in seconds, `{ low, high }`; `high` null when its length is unknown. */
export const jobCost = (mode, seconds) => {
  const cost = COSTS[mode] ?? COSTS.normal;
  if (!Number.isFinite(seconds) || seconds <= 0) return { low: cost.fixed, high: null };
  const minutes = seconds / 60;
  const low = cost.fixed + cost.perMin * minutes;
  return { low, high: Math.max(low, cost.highPerMin * minutes) };
};

/**
 * `live` is the queue as the store lists it: running rows first, then the
 * queued in the order the worker takes them. Returns, for each row's public
 * id, `{ lowS, highS }`: how long until it is done, by this estimate, whole
 * seconds, `highS` null for "at least `lowS`". A running row counts what is
 * left of its own job by its progress.
 */
export const estimateQueue = (live) => {
  const out = new Map();
  let low = 0;
  let high = 0;
  for (const row of live) {
    const cost = jobCost(row.mode, row.audioSeconds);
    const left = row.status === 'running' ? 1 - Math.min(1, Math.max(0, Number(row.progress) || 0)) : 1;
    if (row.status === 'running') {
      // Running jobs run side by side only with more workers; one is assumed.
      low += cost.low * left;
      high = high === null || cost.high === null ? null : high + cost.high * left;
    } else if (row.status === 'queued') {
      low += cost.low;
      high = high === null || cost.high === null ? null : high + cost.high;
    } else {
      continue;
    }
    out.set(row.publicId, { lowS: Math.round(low), highS: high === null ? null : Math.max(Math.round(low), Math.round(high)) });
  }
  return out;
};
