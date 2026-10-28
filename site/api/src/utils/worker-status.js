/**
 * Whether an analysis worker is talking to this API (W10.4, the /status page).
 *
 * The worker is an HTTP client of /api/internal: it claims every
 * WORKER_POLL_S (2 s by default) while the queue is empty and reports
 * progress while it analyses. So "a worker called recently" is the honest
 * signal, and the only one: an idle worker leaves no row anywhere.
 *
 * Held in this process's memory. One API process answers both the worker and
 * the health check in every deployment so far (docs/deploy.md); with several
 * behind a balancer each would only know about the calls it received.
 *
 * `ok` within SEEN_WINDOW_S of the last call; `down` after that; `unknown`
 * while no worker has called since this process started (right after a
 * restart, and always in development with OVERTONE_WORKER=0).
 */
export const SEEN_WINDOW_S = 120;

let lastSeen = null;

/** Any authenticated call from a worker counts. */
export const workerSeen = (now = Date.now()) => {
  lastSeen = now;
};

/**
 * W13.19: what the worker last said of its memory, when it says anything
 * (worker/main.py sends it with each claim where it can read /proc): the
 * analysis process's resident MB now, the last job's peak, and its limit.
 * Each field a whole number of MB or null; anything else is dropped, never
 * stored as sent. Shown on the staff panel only.
 */
let memoryReport = null;

const mb = (value) => (Number.isInteger(value) && value >= 0 && value <= 1_048_576 ? value : null);

export const reportMemory = (raw, now = Date.now()) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const report = { rssMb: mb(raw.rss_mb), peakMb: mb(raw.peak_mb), limitMb: mb(raw.limit_mb) };
  if (report.rssMb === null && report.peakMb === null && report.limitMb === null) return;
  memoryReport = { ...report, at: now };
};

/** The last memory report and how old it is, or null when the worker never sent one. */
export const workerMemory = (now = Date.now()) =>
  memoryReport && {
    rssMb: memoryReport.rssMb,
    peakMb: memoryReport.peakMb,
    limitMb: memoryReport.limitMb,
    secondsAgo: Math.max(0, Math.round((now - memoryReport.at) / 1000)),
  };

/** For the tests. */
export const resetWorkerMemory = () => {
  memoryReport = null;
};

/** `{ status, seenSecondsAgo }`, `seenSecondsAgo` null when never seen. */
export const workerStatus = (now = Date.now(), seen = lastSeen) => {
  if (seen === null) return { status: 'unknown', seenSecondsAgo: null };
  const ago = Math.max(0, Math.round((now - seen) / 1000));
  return { status: ago <= SEEN_WINDOW_S ? 'ok' : 'down', seenSecondsAgo: ago };
};
