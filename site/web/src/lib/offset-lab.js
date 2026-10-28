/**
 * The offset lab (W7), ported from the desktop app's (app/app.js `lab*`,
 * python/overtone.py `mp3_gapless_info`): what the file says about its own
 * delay, and a blind test of which click shift sounds in time.
 *
 * The blind test: each trial plays the same passage twice, the clicks shifted
 * by two hidden amounts in random order, one of them always none; the reader
 * says which was in time. Every shift runs against none, so the report is one
 * win rate per shift with a Wilson 95 % interval, honest about three votes a
 * shift, and the preferred shift is the best rate above one half, the smaller
 * shift breaking a tie; nothing when none is unbeaten. Read only: nothing is
 * applied unless the reader presses for it, and then only as the page's nudge.
 *
 * The desktop's second half, the first attack through Python's and Rust's
 * decoders side by side, needs both engines and the file on one machine; the
 * site has neither in the browser, so it is not ported.
 */

export const LAB_SHIFTS = [-30, -20, -10, 10, 20, 30]
export const LAB_REPS = 3
/** Seconds each presentation plays. */
export const LAB_WINDOW_S = 6

/** Every shift LAB_REPS times, shuffled, each against none in a random order: `{ shift, first }`. */
export function labTrials(random = Math.random) {
  const order = LAB_SHIFTS.flatMap((shift) => Array.from({ length: LAB_REPS }, () => shift))
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order.map((shift) => ({ shift, first: random() < 0.5 ? 0 : shift }))
}

/** The shift heard in presentation `which` (0 or 1) of a trial. */
export const presented = (trial, which) => (which === 0 ? trial.first : trial.first === 0 ? trial.shift : 0)

/** The tally after a vote for presentation `which`: picking the shift wins it, picking none loses it. */
export function vote(votes, trial, which) {
  const [wins, losses] = votes[trial.shift] ?? [0, 0]
  const won = presented(trial, which) === trial.shift
  return { ...votes, [trial.shift]: won ? [wins + 1, losses] : [wins, losses + 1] }
}

/** Wilson score interval, 95 %. */
export function wilson(wins, n) {
  if (!n) return [0, 0]
  const z = 1.96
  const p = wins / n
  const denom = 1 + (z * z) / n
  const middle = p + (z * z) / (2 * n)
  const half = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)
  return [Math.max(0, (middle - half) / denom), Math.min(1, (middle + half) / denom)]
}

/** Per shift: wins, trials, rate and interval; `best` the preferred one, or null when none is unbeaten. */
export function labReport(votes) {
  const rows = LAB_SHIFTS.map((shift) => {
    const [wins, losses] = votes[shift] ?? [0, 0]
    const n = wins + losses
    const [lo, hi] = wilson(wins, n)
    return { shift, wins, n, rate: n ? wins / n : 0, lo, hi }
  })
  const best = rows.reduce((a, b) => (b.rate > a.rate || (b.rate === a.rate && Math.abs(b.shift) < Math.abs(a.shift)) ? b : a))
  return { rows, best: best.rate > 0.5 ? best : null }
}

/**
 * An MP3's own gapless numbers from its first bytes (`mp3_gapless_info`):
 * the LAME tag's encoder delay and padding, in samples and ms at the file's
 * rate. `{ present: false }` for anything without one: Fraunhofer and old
 * encoders write none, and that is reported, not guessed.
 */
export function mp3GaplessInfo(head, name = '') {
  if (!/\.mp3$/i.test(name) || !(head instanceof Uint8Array)) return { present: false }
  let pos = 0
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    if (head.length < 10) return { present: false }
    let size = 0
    for (const byte of head.subarray(6, 10)) size = (size << 7) | (byte & 0x7f)
    pos = 10 + size
  }
  let sync = -1
  for (let i = pos; i < Math.min(pos + 256, head.length - 4); i++) {
    if (head[i] === 0xff && (head[i + 1] & 0xe0) === 0xe0) {
      sync = i
      break
    }
  }
  if (sync < 0) return { present: false }
  const version = (head[sync + 1] >> 3) & 0x03
  const mono = ((head[sync + 3] >> 6) & 0x03) === 3
  let xingAt
  let rates
  if (version === 3) {
    xingAt = sync + 4 + (mono ? 17 : 32)
    rates = [44100, 48000, 32000, 0]
  } else if (version === 2 || version === 0) {
    xingAt = sync + 4 + (mono ? 9 : 17)
    rates = version === 2 ? [22050, 24000, 16000, 0] : [11025, 12000, 8000, 0]
  } else return { present: false }
  const sampleRate = rates[(head[sync + 2] >> 2) & 0x03]
  const tag = String.fromCharCode(...head.subarray(xingAt, xingAt + 4))
  if (!sampleRate || (tag !== 'Xing' && tag !== 'Info')) return { present: false }
  let lameAt = -1
  // bytes.find(b"LAME", start, end): the whole tag inside the window.
  for (let i = xingAt + 4; i <= Math.min(xingAt + 240, head.length) - 4; i++) {
    if (head[i] === 0x4c && head[i + 1] === 0x41 && head[i + 2] === 0x4d && head[i + 3] === 0x45) {
      lameAt = i
      break
    }
  }
  if (lameAt < 0 || lameAt + 24 > head.length) return { present: false }
  const lame = head.subarray(lameAt, lameAt + 24)
  const raw = (lame[21] << 16) | (lame[22] << 8) | lame[23]
  const delay = (raw >> 12) & 0xfff
  const padding = raw & 0xfff
  const encoder = String.fromCharCode(...lame.subarray(0, 9)).replace(/\0+$/, '').replace(/[^\x20-\x7e]/g, '?')
  if (!encoder.startsWith('LAME')) return { present: false }
  const scale = 1000 / sampleRate
  const round3 = (x) => Math.round(x * 1000) / 1000
  return { present: true, encoder, sampleRate, delaySamples: delay, paddingSamples: padding, delayMs: round3(delay * scale), paddingMs: round3(padding * scale) }
}

/** The first 8 kB of `file`, read for its header; null when it cannot be read. */
export async function readHead(file) {
  try {
    return new Uint8Array(await file.slice(0, 8192).arrayBuffer())
  } catch {
    return null
  }
}
