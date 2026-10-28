# 19 — An acoustic fingerprint for "already timed?" (W13.21): a study

Written 2026-10-28. The roadmap row W13.21 asks whether the site can say "this song was
already timed" when someone uploads the same song in another file (another MP3, another
bitrate, an OGG from another set), where the SHA-1 the site already uses
(`/analyses/lookup`, W3.11) only finds byte-identical files. The row asks for the cost to
be weighed first. This is that weighing: a measurement, not a feature.

**Verdict: promising, not clearly good. Nothing ships now.** On real songs, every
re-encode and every small shift we tried stays far below every pair of different songs.
But the different-song tail was measured on 9,480 pairs, and a live lookup would compare
each upload with up to 100,000 published timings. Audio with little pitched content
(drum-only tracks) cannot be told apart at all. Shipping also takes a JavaScript port held
bit for bit to the reference, a decode the upload page does not do today, and a server
index. The follow-up is listed at the end.

## Method

`proto/fingerprint_study.py` holds the reference fingerprint and the measurement.

```bash
.venv/Scripts/python.exe -u proto/fingerprint_study.py --songs 80 --seconds 45 --pairs 30 --workers 11
```

That one line ran in about 6 minutes on 11 worker processes (2026-10-27). With no
arguments it samples 150 songs from the first 60 s of each file. An earlier attempt at
that size ran for over 25 minutes without printing anything (buffered output), was
stopped, and was not repeated, so the numbers below are the smaller run's.

**The fingerprint** is Chromaprint-like and needs nothing but an FFT, so a browser can
compute it:

1. mono, resampled to 11,025 Hz;
2. a Hann STFT of 4,096 samples every 1,365 (8.08 frames a second);
3. the energy of each frame from 28 Hz to 3,520 Hz folded into 12 pitch classes,
   smoothed over five frames and L2-normalised (a near-silent frame becomes zeros);
4. sixteen fixed Haar-like filters over that chroma image, each a log ratio of two
   areas, quantised into 2 Gray-coded bits: 32 bits a frame.

Step 4 uses the filter layout and thresholds of Chromaprint's default configuration.
Nothing is trained here. The front end only follows Chromaprint's description, so it is
not claimed to equal libchromaprint's output. Over the library originals each of the 32
bits is set between 37% and 64% of the time (median 52%), so every bit carries
information.

**The comparison** is the bit error rate (BER): the share of bits that differ over the
frames two fingerprints share, at the best alignment within ±5 s and with at least 12 s
of overlap. Identical audio scores 0, unrelated songs about 0.5.

**The audio:**

- **Library.** 80 originals: osu! sets sampled at random (seed 1321) from the local
  Songs folder (4,910 sets; the folder Corpus B names, `bench/local_data.py`), the first
  45 s of each set's audio. Song names stay on this machine. Only aggregate numbers are
  given here.
- **Synthetic.** The 24 `bench/benchmark.py` tracks (drum kit, a few with a sustained
  pad), first 45 s.
- **Variants of each original,** re-encoded with libsndfile through `soundfile` (there is
  no ffmpeg on this machine; libsndfile 1.2.2 writes MP3, Vorbis and Opus):
  - MP3 at 320, 128 and 80 kbps (CBR);
  - Ogg Vorbis at about 60 kbps;
  - Ogg Opus at about 32 kbps (48 kHz);
  - a 48 kHz resample;
  - −6 dB gain;
  - 0.3 to 1.0 s of leading silence added, the same amount cut, and the added silence
    combined with MP3 at 128 kbps.

  Libsndfile's Vorbis encoder overflows the default thread stack on Windows, so every
  encode runs in a thread with a 64 MB stack.
- **"Same title, another set."** 30 pairs of sets whose folder names give the same
  artist and title but whose audio files differ in size. These include other cuts and
  edits, so they are reported apart and not counted in the main metric.

## Numbers

### The same song

BER of each variant against its original, over the 80 library originals:

| variant | median | worst | misses at 0.30 |
|---|---|---|---|
| MP3 320 kbps | 0.000 | 0.001 | 0 / 80 |
| MP3 128 kbps | 0.003 | 0.007 | 0 / 80 |
| MP3 80 kbps | 0.008 | 0.014 | 0 / 80 |
| Vorbis ~60 kbps | 0.016 | 0.028 | 0 / 80 |
| Opus ~32 kbps | 0.031 | 0.057 | 0 / 80 |
| 48 kHz resample | 0.000 | 0.000 | 0 / 80 |
| −6 dB | 0.000 | 0.003 | 0 / 80 |
| +0.3–1 s silence | 0.039 | 0.080 | 0 / 80 |
| −0.3–1 s cut | 0.041 | 0.080 | 0 / 80 |
| silence + MP3 128 | 0.039 | 0.079 | 0 / 80 |

The shifts cost the most because the hop is 124 ms: a shift that is not a whole number of
frames moves every frame's window.

### Different songs

The 9,480 pairs are the 80 originals pairwise, plus each one's MP3 128 kbps variant
against every other original.

- Quantiles: 1% 0.408, 5% 0.435, median 0.473, max 0.570.
- Three pairs scored under 0.30, all at 0.033. They are one pair counted three times:
  two sets of the same remix, with different files (checked by hand on this machine).
  So it is a true match, and the fingerprint found it.
- Without that pair, the lowest different-song BER is 0.321, between two rock/metal
  tracks with distorted guitars. Their chroma is flat, so their bits look alike.
- **False matches: 0 of 9,480 at 0.30, once the duplicate is set aside.**

### Synthetic hard negatives

The 276 pairs of different benchmark tracks: 7 under 0.10, 26 under 0.15, 56 under 0.20,
136 under 0.30.

- One pair is the same audio twice (`secs-3` and `three-sections` share a definition).
- The rest are kick, snare and hats at different tempos. They have no pitch, so their
  chroma is the same noise.

This is the fingerprint's real blind spot. Chroma tells songs apart by harmony. Percussion
only, speech or noise all look alike to it. Two drum loops at 150 and 175 BPM score about
0.10.

### Same title in another set

Of the 30 pairs, 29 score under 0.30 (median 0.049, 95% at 0.217). One pair scores 0.477:
another cut or edit, which a ±5 s alignment cannot follow. Widening the search to ±30 s
changes nothing. Matching TV-size cuts against full versions would need matching on
segments, which was not built.

### The threshold

0.30 is the line used above. On the measured numbers, a threshold of **0.20** would sit
2.5× above the worst re-encode (0.080) and 1.6× below the nearest different real song
(0.321). Only the synthetic drum tracks fall under it.

### Cost

- **Computing it (Python and numpy, decode not counted):** 474 ms per audio minute on
  one idle process (10-song pilot), 731 ms with 11 processes sharing the machine. A
  WebAssembly or plain-JS FFT in a browser should land within the same order. That was
  not measured.
- **Decoding:** the upload page (`pages/Analyze.jsx`) does not decode audio. It hashes
  the file (SHA-1) and reads its length from an `<audio>` element. The result page does
  decode, in `lib/session-audio.js` through `decodeAudioData`, because the waveform
  needs it: about 130 MB of float samples for six minutes of stereo, by that file's own
  comment. A fingerprint before upload would add that decode to the upload page. On the
  result page it is already paid.
- **Size:** 485 frames a minute at 4 bytes is 1,938 bytes a minute. The first 60 s are
  enough to recognise a song in these numbers, so storing those is about 1.9 kB an
  analysis, or 7.8 kB for a whole four-minute song.
- **Matching:** 0.96 ms per pair with the ±5 s search, 0.014 ms at a single alignment
  (numpy, about 340 frames each). A naive scan of every published timing with the full
  search would cost:

  | published timings | naive scan |
  |---|---|
  | 1,000 | about 1 s |
  | 10,000 | about 10 s |
  | 100,000 | about 96 s |

  That is fine at 1k, too slow at 100k, and Node would not change the order.
- **An index:** the exact 32-bit frame values make one. A re-encode keeps a median of 92%
  of its frames' exact values at MP3 128 kbps, 37% at Opus 32 kbps and 28% after a
  shift. Different songs share a median of 0% (max 35%, the duplicate). An inverted
  index from frame value to analysis, with the BER computed only on candidates that
  share values, would bring a lookup to a few milliseconds. At 485 rows per analysis it
  is 48 million rows at 100k timings, so in practice only a sample of frames would be
  indexed. Neither the index nor its sampling was built or measured.

## What shipping it would take

1. **A JavaScript port matched bit for bit.** The resampler, the STFT, the chroma
   folding, the smoothing and normalisation, and the 16 filters with their thresholds.
   It would come with a parity fixture: a few committed PCM excerpts and their
   fingerprints from `proto/fingerprint_study.py`, which a `node:test` test holds equal,
   in the manner of the golden vectors. Two float paths will differ near the thresholds.
   The test would allow a measured BER, not demand zero.
2. **Where the browser computes it.** On the result page, after the decode it already
   does (`useSongAudio`), the hint becomes "this song may already be timed: see …"
   after the upload, never in its way. Before the upload it costs a full decode on the
   upload page, for a hint the person would see a few seconds sooner.
3. **The server.**
   - A table `audio_fingerprints (analysis_id, frames bytea)`, about 2 kB a row, written
     when a timing is published. Only published timings can be matched.
   - Plus the index above.
   - A lookup route under `requireSameOrigin`, a `guard(...)` limit and a size cap (a
     fingerprint of at most 60 s, about 2 kB). It answers with at most a few published
     timing ids, never a score that could be used to probe the table.
4. **Privacy.**
   - A fingerprint cannot be turned back into audio, but it does identify the song.
   - So only published timings (already public) would be stored and matched.
   - The fingerprint a visitor sends would be compared and dropped, never stored, and
     private analyses would never be fingerprinted.
   - No external service is involved: AcoustID and MusicBrainz stay out (offline by
     default, `CLAUDE.md`).
5. **The blind spot.** Below a chroma-energy floor (drum-only or very noisy audio), the
   page should say nothing rather than guess. That floor would need its own measurement.

## Recommendation: a follow-up, not now

1. **Too few negative pairs.** A matching mistake points someone at the wrong song's
   timing. The tail that decides this was measured on 9.5k pairs, while one lookup at
   scale is 100k comparisons. The next run should cover at least 500 originals (125k
   pairs) on the owner's server, where the Songs folder also lives
   (`bench/remote.py`).
2. **The drum-track failure needs a guard** that has not been built or measured.
3. **Common re-uploads were not measured:** a rate change (osu!'s DT and nightcore
   edits), a pitch shift, a fade-in, and a different cut (TV size against full).
4. **The cost is real for a hint.** A bit-exact JS port, a parity fixture, a table, an
   index and a route. The byte-identical case is already covered by the SHA-1 lookup.

If the larger run keeps different songs above about 0.30 and the guard holds, the design
above (result page, published timings only, threshold 0.20) is the one to build.
