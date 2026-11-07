/**
 * What the end-to-end run feeds the site: a short WAV to upload and the
 * `timing-result v1.1` a fake worker answers every job with. Neither comes
 * from the engine; they only have to be shaped as the real ones are
 * (worker/timing_result.py), so the pages draw them.
 */

export const SONG_SECONDS = 8
/** The two red lines: 120 BPM from 0.05 s, 150 BPM from 4.05 s. */
export const LINES = [
  { time_ms: 50, bpm: 120 },
  { time_ms: 4050, bpm: 150 },
]

/** Every beat of LINES up to the end, in ms. */
const beatTimes = () => {
  const out = []
  LINES.forEach((line, i) => {
    const end = LINES[i + 1]?.time_ms ?? SONG_SECONDS * 1000
    for (let t = line.time_ms; t < end; t += 60_000 / line.bpm) out.push({ t: Math.round(t), bpm: line.bpm })
  })
  return out
}

/**
 * A mono 16-bit WAV of SONG_SECONDS: a 5 ms click on every beat of LINES,
 * louder on each bar's first. Small (350 kB at 22.05 kHz) and decodable by
 * any browser, so the upload form reads its length as it would a song's.
 * Another `rate` gives other bytes, so another SHA-1: a song the API has not
 * timed yet, instead of the stored result of the first.
 */
export function clickWav(rate = 22_050) {
  const frames = SONG_SECONDS * rate
  const buffer = Buffer.alloc(44 + frames * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + frames * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(frames * 2, 40)
  beatTimes().forEach(({ t }, i) => {
    const start = Math.round((t / 1000) * rate)
    const gain = i % 4 === 0 ? 0.9 : 0.5
    for (let n = 0; n < rate * 0.005 && start + n < frames; n++) {
      const v = Math.sin((2 * Math.PI * 1000 * n) / rate) * gain * (1 - n / (rate * 0.005))
      buffer.writeInt16LE(Math.round(v * 32767), 44 + (start + n) * 2)
    }
  })
  return buffer
}

/** The result the fake worker posts for every job. */
export function fakeResult(engineHash) {
  const beats = beatTimes()
  const sections = LINES.map((line, i) => ({
    index: i,
    start_ms: line.time_ms,
    end_ms: LINES[i + 1]?.time_ms ?? SONG_SECONDS * 1000,
    bpm: line.bpm,
    confidence: i === 0 ? 0.95 : 0.8,
    level: i === 0 ? 'high' : 'medium',
    residual_ms: 1.5,
    coverage: 0.9,
    drift_ms: 0.4,
    drift_p90_ms: 1.2,
    drift_bias_ms: 0.1,
    onsets: beats.filter((b) => b.bpm === line.bpm).length,
  }))
  return {
    format: 'timing-result',
    version: 1,
    minor: 1,
    engine: 'v3',
    engine_mode: 'precision',
    engine_hash: engineHash,
    beat_vote: false,
    duration_s: SONG_SECONDS,
    refused: false,
    refusal: null,
    global_bpm: 120,
    offset_ms: LINES[0].time_ms,
    meter: '4/4',
    stability: 0.9,
    residual_ms: 1.5,
    red_lines: LINES.map((line) => ({
      time_ms: line.time_ms,
      bpm: line.bpm,
      beat_length_ms: 60_000 / line.bpm,
      meter: 4,
      meter_known: true,
    })),
    sections,
    findings: [],
    osu_timing: LINES.map((line) => `${line.time_ms},${60_000 / line.bpm},4,2,0,100,1,0`).join('\n'),
    beats: { t_ms: beats.map((b) => b.t), bpm: beats.map((b) => b.bpm) },
    downbeats_ms: beats.filter((_, i) => i % 4 === 0).map((b) => b.t),
    onsets: { t_ms: beats.map((b) => b.t), w: beats.map(() => 100) },
    onset_envelope: { span_ms: 0, v: [] },
    swing: null,
    pulse_hints: [],
  }
}

/**
 * The osu! account the stand-in osu! (serve-api.mjs) answers with: shaped as
 * osu-web's UserExtended with one ruleset's statistics, every field the wider
 * osu! card reads (2026-11-07) filled, a few days of rank missing and two
 * months without plays, so each chart draws its gaps. Made up; nobody's.
 */
export function fakeOsuUser() {
  const history = Array.from({ length: 90 }, (_, i) => (i >= 40 && i < 44 ? 0 : 18_400 - i * 95 + (i % 7) * 35))
  const months = []
  for (let i = 0; i < 26; i++) {
    if (i === 9 || i === 10) continue
    const y = 2024 + Math.floor((i + 5) / 12)
    const m = ((i + 5) % 12) + 1
    months.push({ start_date: `${y}-${String(m).padStart(2, '0')}-01`, count: 100 + i * 12 })
  }
  return {
    id: 4040,
    username: 'e2e_mapper',
    country_code: 'AR',
    playmode: 'osu',
    is_supporter: true,
    join_date: '2016-04-12T20:11:05+00:00',
    follower_count: 1342,
    mapping_follower_count: 287,
    kudosu: { total: 419, available: 40 },
    scores_first_count: 3,
    ranked_beatmapset_count: 6,
    loved_beatmapset_count: 1,
    guest_beatmapset_count: 11,
    pending_beatmapset_count: 3,
    graveyard_beatmapset_count: 24,
    nominated_beatmapset_count: 0,
    favourite_beatmapset_count: 156,
    user_achievements: Array.from({ length: 87 }, (_, i) => ({ achievement_id: i })),
    rank_highest: { rank: 9512, updated_at: '2025-06-03T00:00:00Z' },
    rank_history: { mode: 'osu', data: history },
    monthly_playcounts: months,
    groups: [{ short_name: 'BN', name: 'Beatmap Nominators', colour: '#A347EB', is_probationary: false }],
    statistics: {
      global_rank: history.at(-1),
      country_rank: 212,
      pp: 5873.42,
      hit_accuracy: 98.1234,
      play_count: 23_817,
      play_time: 2_918_400,
      ranked_score: 18_734_998_112,
      total_hits: 6_120_331,
      maximum_combo: 2410,
      replays_watched_by_others: 58,
      level: { current: 102, progress: 63 },
      grade_counts: { ss: 41, ssh: 12, s: 612, sh: 88, a: 1290 },
    },
  }
}
