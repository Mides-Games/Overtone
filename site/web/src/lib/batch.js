/**
 * Where a batch of uploads stands (W3.14), from the status each song last
 * read. Pure, so the tests reach it without a browser.
 *
 * A song is finished when it will not change any more: it has a timing, was
 * refused, failed or was cancelled (W3.12). One still uploading, waiting or
 * being analysed is not.
 * `complete` is true only for a batch, two songs or more, every one of them
 * finished: a single upload opens its own page, which already says it.
 *
 * The tab title and the notification W3.14 started here now live in
 * `lib/tracker.js` (W3.22, W3.23), for every page, which counts batches with this.
 */
const FINISHED = ['done', 'refused', 'failed', 'cancelled']

export function batchProgress(statuses) {
  const total = statuses.length
  const finished = statuses.filter((status) => FINISHED.includes(status)).length
  const done = statuses.filter((status) => status === 'done').length
  return { total, finished, done, complete: total > 1 && finished === total }
}
