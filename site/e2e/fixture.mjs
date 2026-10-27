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
