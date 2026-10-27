/**
 * Where a batch of uploads stands (W3.14), from the status each card last
 * read. Pure, so the tests reach it without a browser.
 *
 * A song is finished when it will not change any more: it has a timing, was
 * refused, failed or was cancelled (W3.12). One still uploading, waiting or
 * being analysed is not.
 * `complete` is true only for a batch, two songs or more, every one of them
 * finished: a single upload opens its own page, which already says it.
 */
const FINISHED = ['done', 'refused', 'failed', 'cancelled']

export function batchProgress(statuses) {
  const total = statuses.length
  const finished = statuses.filter((status) => FINISHED.includes(status)).length
  const done = statuses.filter((status) => status === 'done').length
  return { total, finished, done, complete: total > 1 && finished === total }
}

/** The tab's title while a batch runs: "2/5 ready · Overtone", or the page's own title for a single song. */
export function batchTitle(progress, label, base) {
  return progress.total > 1 ? `${label} · ${base}` : base
}

/**
 * Whether to send the notification now: when the batch has just become
 * complete, never again for the same batch, and only if the person asked
 * for it and the browser allowed it.
 */
export function shouldNotify({ wasComplete, progress, wanted, permission }) {
  return Boolean(wanted && permission === 'granted' && progress.complete && !wasComplete)
}
