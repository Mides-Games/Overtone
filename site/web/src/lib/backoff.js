/**
 * How long to wait before asking again (W10.4): `base` while things answer,
 * doubling from `retry` after each failure in a row, never past `max`. So a
 * page left open while the service is down asks less and less often instead
 * of hammering it, and asks at its normal pace again once it answers.
 */
export function nextDelay(failures, { base = 30_000, retry = 5_000, max = 120_000 } = {}) {
  if (!(failures > 0)) return base
  return Math.min(max, retry * 2 ** (Math.min(failures, 20) - 1))
}
