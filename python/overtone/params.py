"""Every module-level constant and experiment flag of the v3 engine.

Code reads them as ``params.NAME`` so a value set on ``overtone`` (tests,
``overtone_runs.py`` experiments) is seen on the next call.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import librosa
import numpy as np
import soundfile as sf
from scipy import signal
from scipy.ndimage import median_filter

from overtone_paths import app_version, data_root


#: The release's version (overtone_paths.app_version): what every written file's
#: header states. The engine generation is not the product.
APP_VERSION = app_version()
TARGET_SR = 44100
HOP = 256  # ~5.8 ms at 44.1 kHz: timing-grid resolution suited to mapping.
#: Pulse octaves the UI and CLI may force (1 = whatever the engine detected).
ALLOWED_FACTORS = (0.25, 0.5, 1.0, 2.0, 4.0)
#: The octave osu! songs are mapped at. Below it the engine has usually read
#: half the mapper's beat, above it double: on the anime single-tempo stage
#: (bench/stages.py, 2026-10-22) detections under 120 BPM were half the map in
#: 227 of 249 dev maps and every one over 300 was double. Folding the global
#: BPM into [120, 240] took the exact-octave share from 77.1 % to 95.2 % on dev,
#: 75.8 % to 95.2 % held out, and 72.6 % to 86.8 % on every one-red-line map.
MAP_OCTAVE_RANGE = (120.0, 240.0)
#: Drift following (_follow_drift). Off until 2026-10-23: with a guard of
#: "fits at all better" it took Take You Down, a steady song whose single red
#: line puts 99.9 % of beats within 10 ms, to 5 lines and 81.9 %. With
#: DRIFT_MIN_GAIN (10 % better) Take You Down keeps 99.9 % and Noble still
#: rises 40.7 -> 58.9 %; held out, beats within 10 ms: anime one tempo
#: 62.2 -> 75.2 %, anime tempo changes 48.2 -> 52.8 %, bands 26.9 -> 30.5 %.
DRIFT_FOLLOW = True
DRIFT_MIN_GAIN = 0.9


#: The stages an analysis announces through its progress callback, each by a
#: short id. ``bench/gates.py perf`` times the stages by these ids, and a test
#: holds this table to every message the engine sends, so a reworded message
#: cannot silently lose its stage.
STAGES = {
    "Loading and normalizing audio…": "load",
    "Detecting attacks at sample resolution…": "attacks",
    "Scanning pulse coherence…": "coherence",
    "Resolving the beat octave…": "octave",
    "Fitting tempo sections…": "sections",
    "Checking the beats with Beat This!…": "beatthis",
    "No fittable grid — falling back to the beat tracker…": "fallback",
    "Extracting transients and tempo hypotheses…": "transients",
    "Tracking beats (hybrid DP + PLP + peaks)…": "tracking",
    "Tracking beats (Beat This!)…": "tracking-network",
    "Resolving half/double-time pulse…": "pulse",
    "Computing local tempo and persistent changes…": "local",
}


#: Spectrogram and tempogram are built a block at a time. librosa materialises
#: each whole: the linear spectrogram behind the onset envelope was ~1.3 GB for
#: a 5-minute song at FIT_HOP, the tempogram behind the fallback tracker's
#: tempo estimate ~3.5 GB -- enough, two songs at a time, to freeze a 16 GB
#: machine. Block sizes are the fastest measured on that song: large for the
#: spectrogram (2.2 s against 1.9 s one-shot, ~0.2 GB), small for the
#: tempogram, whose column FFTs then stay in cache (6.0 s a pass against 7.0 s
#: one-shot, ~70 MB). The frames come out the same (see _mel_power, _tempogram).
SPECTROGRAM_BLOCK = 8192
TEMPOGRAM_BLOCK = 1024
ONSET_N_FFT = 2048
#: Frames of a block's STFT computed between two stop checks: a quarter of a
#: block, 0.1-0.2 s of work. A block whole took up to 1.6 s on a busy machine.
STFT_RUN = 2048


# -- multi-band flux: what started, not just that something did ---------------
#
# The default envelope answers "did anything start". A mapper looking at a
# song wants "what started, and where": a kick moves the sub band, a hat the
# top, a broadband click all seven. This is a port of
# `crates/overtone-dsp/src/multiband.rs`, constant for constant, so the page
# shows the same bands the Rust front end computes; a measurement holds the
# two to each other on the corpus.

#: Seven log-spaced bands over the mel path's own range, so both front ends
#: cover the same spectrum: 40, 89, 199, 445, 992, 2214, 4940, 11025 Hz, each
#: 2.23 times the last. These are **not** the hitsound features' musical
#: bands (docs/06 §2): band i here is not band i there, and nothing above
#: 11.025 kHz moves any of them, a cymbal's air shimmer included.
BAND_COUNT = 7
BAND_LO_HZ = 40.0
BAND_HI_HZ = 11025.0
#: The dB floor under the loudest band energy, as the default envelope's
#: `power_to_db` uses. Global on purpose: one loud transient raises the floor
#: everywhere, and a per-block floor would make the answer depend on blocking.
BAND_TOP_DB = 80.0
BAND_AMIN = 1e-10


#: Mel bands the spectrogram is read on, and the top of its range. The same
#: 128 bands to 11.025 kHz the analysis path itself uses, so the picture is
#: the spectrum the engine listened to and not a second opinion drawn beside
#: it. (`_mel_power` passes both to librosa; they live here to be reported.)
MEL_BANDS = 128
MEL_FMAX_HZ = 11025.0
#: How far under the loudest cell a cell can be before it is simply black.
#: librosa's own default for a display spectrogram, and the same floor the
#: onset path uses on its own scale.
MEL_TOP_DB = 80.0


#: How far under the loudest moment the energy curve's floor sits. Wider than
#: the spectrogram's 80 dB on purpose: this is one line about a whole song,
#: and a quiet intro should still have somewhere to be drawn.
LOUDNESS_FLOOR_DB = 60.0
#: Under this, a file has no loudest moment to be read against. The curve is
#: relative to the song's own peak, and a silent file normalised against its
#: own silence would draw a full line — silence claiming to be loud. No music
#: sits here: the quietest thing the corpus holds peaks near -40 dB RMS.
LOUDNESS_SILENT_DB = -80.0


# -- how much of a moment is a hit and how much is a note ---------------------
#
# Fitzgerald's median separation: a sustained partial is a horizontal line on
# a spectrogram, so a median along **time** keeps it and erases transients; a
# hit is a vertical line, so a median along **frequency** keeps it and erases
# partials. Soft Wiener masks split each cell between the two, and the
# percussive mask's share of a frame's energy is how much of that moment was
# a hit.
#
# Run on the analysis path's own mel grid rather than on linear bins, because
# 1025 bins cost 22 s of median filtering on a one-minute song against 1.4 s
# on 128 mel bands, and the answer moves by 0.003. That grid is not the one
# `crates/overtone-dsp/src/hpss.rs` uses, so its kernels do not carry over:
# a mel filterbank smears a partial across neighbouring bands, and the
# frequency kernel has to step over that smear. Both were chosen by what they
# do to signals whose truth is known (timeline, 2026-09-27).

#: The time median's span. Measured on 2 ms clicks, 40 ms noise snares, a
#: 55 Hz kick decaying over 150 ms, a held tone and a held chord: at 100 ms
#: a click reads 1.000 percussive, a snare 0.981, a tone 0.000 and a chord
#: 0.102, and a kick 0.543 — half transient, half body, which is what a kick
#: is. Longer kernels widen the gap no further and start claiming the body
#: too: 0.788 at 150 ms, 0.988 at 300.
HPSS_KERNEL_MS = 100.0
#: The frequency median's span, in mel bands. The gap between the worst hit
#: and the worst tonal signal peaks here at every kernel length tried
#: (+0.879 at 100 ms, against +0.539 at 3 bands): fewer bands leave a smeared
#: partial standing and a chord reads 0.41 percussive.
HPSS_KERNEL_BANDS = 13
#: Frames for this measure. A balance is a texture over tenths of a second,
#: and halving the frame rate from the fitting envelope's halves the cost
#: while moving the answer by 0.003.
HPSS_HOP = 256
# The v2 engine derived BPM from *differences between consecutive detected
# beats*. That is inherently noisy: every beat carries a few milliseconds of
# onset-detection jitter, and differencing amplifies it, so the reported tempo
# wobbled by ~0.2 BPM and offsets landed ~8 ms late.
#
# v3 never differentiates. It fits an explicit linear model
#
#       t(k) = offset + k * period          (k = integer beat index)
#
# to the detected attack times by iteratively re-weighted least squares. With
# a few hundred inlier attacks the fitted period averages the jitter down by
# sqrt(N), which is what turns "±0.2 BPM" into "±0.001 BPM" and puts offsets
# inside a millisecond of the true attack.
#
# Stages:
#   1. Attacks are detected on a 2.9 ms envelope and then re-timed on the raw
#      waveform at sample resolution (removes the ~8 ms detector latency).
#   2. A weighted circular-coherence sweep  R(f) = |Σ w·e^{2πi f t}| / Σ w
#      scores every plausible pulse rate; candidates are then ranked by how
#      much attack energy each grid explains times how many of its own slots
#      are filled. R is an O(N) statistic per frequency, so the whole range is
#      swept at once instead of trusting one tracker's guess.
#   3. Expanding-window least squares locks a grid onto a span without ever
#      slipping a beat index, and a robust re-centring pass puts its phase on
#      the densest residual cluster rather than the mean of everything nearby.
#   4. Attacks are grouped by index modulo m; the accent depth plus tempogram
#      hints choose how many atoms make one beat (and, with meter, which atom
#      is the downbeat). This is the octave decision, made from evidence.
#   5. Sections grow forward while attacks keep landing on the grid, each one
#      re-seeding its own coherence scan so a tempo change cannot poison it.
#      Boundaries settle on the beat where the two grids cross, and every
#      section is refitted on its own attacks alone.

FIT_HOP = 128            # 2.9 ms frames for the fitting envelope
MAX_SCAN_ONSETS = 5000   # cap the coherence/kernel sweeps on dense tracks
MAX_SCAN_FREQS = 20000   # ... and on very long seed windows
SCAN_SPAN_S = 90.0       # anchor window for the octave decision
MAX_AUDIO_SECONDS = 3600.0        # refuse absurd inputs instead of thrashing RAM
MAX_OSU_BYTES = 16 * 1024 * 1024  # a beatmap is a few hundred kB; this is generous
MAX_CLICK_SECONDS = 1800.0
BEAT_MULTIPLES = (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16)


# -- the pulse over the whole track, as a surface --------------------------
#
# The seed scan anchors on one densest window because the sweep is expensive
# in NumPy; this walks the same sweep across the track, so the pulse can be
# *seen* rather than inferred from where sections ended up. A port of
# `crates/overtone-tempo/src/map.rs` (DSP §B.3) as far as the surface and its
# ridge go; what Rust does with it afterwards — seeding, replacing the
# tempogram — stays there.

#: Sliding window and hop, in seconds. Twelve seconds holds enough attacks
#: for R(f) to have a peak worth reading, and two is fine enough to see a
#: change arrive.
MAP_WIDTH_S = 12.0
MAP_HOP_S = 2.0
#: The pulse rates swept, as periods. The candidate sweep's own range.
MAP_PERIOD_RANGE = (0.055, 1.35)
#: Attacks a window needs before its column is worth a ridge point.
MAP_MIN_ATTACKS = 8
#: A peak this far under the column's best is not a candidate for the ridge.
MAP_PEAK_FLOOR = 0.3


#: The share gate (0.40) alone let sparse random attacks through: with 24-40
#: attacks in 30-40 s, the best of the seed search's grids cleared it in
#: 38-55 % of trials, and 53 of 240 rendered random-click files got a grid.
#: No single statistic separates them from real music. The chance of so many
#: inliers (_pulse_log10p) reached 10**-5.47 for random attacks but was as
#: weak as 10**-1.30 for real songs whose vocals sit off the grid. The fitting
#: envelope's pulse gap (_fit_pulse_gap) reached 0.072 for the random clicks,
#: and 0.105 for random attack times, while five of 109 real songs sat
#: between 0.035 and 0.101. Together they do: a grid is refused only when both
#: are weak. At 0.10 one of 240 random attack sets kept a grid; at 0.15 none
#: does. Of the songs weak enough to consult the envelope, two score above it
#: (0.200, 0.426) and keep their grid. Three are refused, and none had a grid
#: worth keeping: a ballad guessed at 73 BPM whose ranked map has 363 red lines
#: between 47 and 68.5, and two songs whose grids put 5 % and 18 % of their
#: ranked map's beats within 10 ms (median 48 and 28 ms off). Python hands
#: those to the fallback tracker; Rust reports no grid.
WEAK_PULSE_LOG10P = -6.0
STRONG_PULSE_GAP = 0.15


#: A 4-beat bar's downbeat must also out-weigh the beat half a bar away. The
#: onset envelope favours broadband hits, so a snare on 2 and 4 -- or, read at
#: double tempo, on every other "beat" -- can out-weigh the kick on 1, and a
#: pattern that repeats every half bar says nothing about which half starts
#: the bar. Measured against 88 ranked maps: of the 21 bars claimed, only 5 sat
#: on the map's downbeat, and the 9 below 1.25 all missed (7 of them one beat
#: early, on the backbeat before the 1); the synthetic fixtures with a real
#: accent score 1.29 and 1.55.
HALF_BAR_CONTRAST = 1.25


#: Beats of the grid carried forward through growth. Refitting everything
#: since the section began made the loop quadratic -- on the six-minute
#: fixture, 189 refits over 205,604 attack-rows, 3.16 s of a 10.9 s analysis
#: -- and bought nothing the final fit does not do itself, since that one runs
#: on the whole span. A window this long still spans 32 bars of 4/4, which is
#: a longer lever arm than any growth step needs; a section shorter than it is
#: fitted over everything, exactly as before.
GROWTH_WINDOW_BEATS = 128


#: Beats a bar may hold. Not every integer: 11 beats to a bar is not a time
#: signature, it is a fit artefact.
BAR_MULTIPLES = (2, 3, 4, 5, 6, 7, 8, 9, 12)
#: Beats-per-bar a *region* may be written in, given a bar. These are the
#: subdivisions a mapper actually chooses between.
BEATS_PER_BAR = (2, 3, 4, 6, 8, 12)
#: A bar is only claimed when its downbeat stands out by this much.
BAR_CONTRAST = 1.20
#: A meter region must hold at least this many bars to be worth a red line.
MIN_METER_BARS = 4


#: How close, in beats, every section's beat must divide the measured bar for
#: the whole track to be one bar in several notations. Measured: signature
#: changes over a constant bar tile it to 0.0001; 128 -> 150 BPM misses by 0.31.
BAR_TILE_TOL = 0.02

#: Frames decoded at a time: about 24 s of audio at 44.1 kHz, under a tenth
#: of a second's work for an MP3, so a stop is asked that often.
DECODE_BLOCK = 1 << 20


#: A file with this share of samples at full scale reads as clipped.
#: Mastering can sit near zero innocently, so the bar is a share, not a peak:
#: one stray full-scale sample is not clipping.
AUDIO_CLIP_SHARE = 0.001
#: Leading near-silence past this reads as trimmable dead air. The number is
#: the tool's own bar, not the client's: no ranking rule was verifiable
#: offline, so no ranking number is encoded anywhere in this report.
AUDIO_LEAD_WARN_MS = 2000.0
#: Below CD quality gets a note, as a fact about the file, not a verdict.
AUDIO_RATE_FLOOR = 44100


#: Below this, the onset envelope is no more periodic than itself shuffled:
#: there is no pulse to time. Measured with _pulse_gap exactly as written:
#: white, pink and brown noise and the benchmark's noise fixture +0.014..+0.022;
#: 27 real songs from an osu! Songs folder (including the live-band track that
#: falls back to the tracker) +0.090 or more, median +0.225; every synthetic
#: fixture, ramps included, +0.257 or more. 0.05 still let the tracker answer
#: 12 of 240 random-click renders (gaps 0.0505-0.0779); at 0.07 it answers one
#: (0.0779), and none of 28 more real songs that reach the tracker scores below
#: 0.0956. Higher would be cutting into music on a sample this size.
MIN_PULSE_GAP = 0.07
PULSE_SHUFFLES = 5
#: One analysis window in 16 (~93 ms apart at 44.1 kHz). The median barely
#: moves (0.64289 -> 0.64295 on secs-4) and the check costs ~0.25 s, not ~7 s.
PULSE_STRIDE = 16
PULSE_WINDOW = 384


#: A song's tracker lag is read only when at least this many of the fallback
#: tracker's beats, and at least half of them, sit on an attack the re-timing
#: can see (98-99 % do on the four Corpus B songs that fall back).
MIN_LAG_BEATS = 8


#: The fallback tracker's beats from Beat This! (BEAT_THIS_TRACKER), its 50 fps
#: frames then moved onto the onset envelope's peaks as the librosa tracker's
#: are (refine_beats). The fallback path is the engine's weakest: on the server's
#: dev reports of a7d6b6c it was right 25 % of bands' time against the precision
#: path's 72 %, its beats within 10 ms 53 % against 77 %. Beat This! alone sat up
#: to ~10 ms off on its frame grid (docs/timeline.md, its 2026-10 measurement);
#: the snapping is what that run lacked. Off until measured (beat-this-tracker).
BEAT_THIS_TRACKER = False


#: Phase 27.6: the fallback tracker's beats decoded from Beat This!'s beat
#: activation by a tempo-following HMM, written from Krebs, Böck and Widmer
#: (ISMIR 2015): each state is (beat interval, position in it), the position
#: advances one frame at a time, and the interval may change only on a beat,
#: by a cost that grows with the ratio. Unlike madmom its range opens to
#: DBN_BPM_RANGE (madmom stops at 55 BPM, which forces slow songs to double),
#: and an explicit prior on the octave, a log-normal around DBN_PRIOR_BPM,
#: leans towards how mappers time songs. Off until measured (dbn-tracker).
DBN_TRACKER = False
DBN_BPM_RANGE = (40.0, 300.0)
#: Frames per second the activation is decoded at (Beat This!'s 50, upsampled):
#: at 50 fps a 250 BPM beat is 12 frames and its neighbour 13 is 231 BPM.
DBN_FPS = 100
#: Beat-interval states, log-spaced over DBN_BPM_RANGE.
DBN_TEMPI = 80
#: The tempo-change cost on a beat, exp(-lambda * |ratio - 1|) (Krebs: 100).
DBN_TRANSITION_LAMBDA = 100.0
#: The share of an interval that counts as "on the beat" for the observation.
DBN_BEAT_SHARE = 1.0 / 16
#: How much a beat state's activation outweighs the rest's (Krebs: 16).
DBN_OBSERVATION_LAMBDA = 16.0
#: The octave prior: centre and width (in octaves) of the log-normal on the tempo.
DBN_PRIOR_BPM = 150.0
DBN_PRIOR_OCTAVES = 1.0


#: How far a section's BPM may sit from a whole number and still be tried on
#: it, and how much worse the whole-number grid may fit its attacks. Mappers
#: time anime songs at whole BPMs (97 % of the S1 misses, 2026-10-23), and a
#: least-squares fit over a short section lands a few tenths away from them.
WHOLE_BPM_REACH = 0.5
WHOLE_BPM_SLACK = (1.2, 0.5)        # rms may grow x1.2 + 0.5 ms


#: Drift following (Phase 10, stage plan): a fixed grid slowly leaves a song
#: whose tempo breathes, and mappers correct it with a red line every few
#: bars. The grid is re-fitted every DRIFT_WINDOW_BEATS beats on that window's
#: attacks and a red line written where it moved. Kept only when the fixed and
#: the followed grids part by more than DRIFT_MIN_MS (90th percentile) AND the
#: followed one fits the attacks better. Chosen on dev samples of the three
#: stages (2026-10-23) and confirmed on held-out ones: beats within 10 ms of the
#: map's, anime one tempo 62.2 -> 76.8 %, anime tempo changes 48.2 -> 53.9 %,
#: live bands 26.9 -> 30.3 %. Windows of 4-8 beats followed noise, and with no
#: guard single-tempo songs lost 6 points.
DRIFT_WINDOW_BEATS = 96
DRIFT_MIN_MS = 15.0
DRIFT_MAX_STEP = 0.03       # a window may move the tempo by at most 3 %


#: The local-tempo tracker, for the songs the precision engine refuses (Phase
#: 10, 2026-10-23). The v2 tracker held one tempo near its prior, so a song
#: that moves between 130, 180 and 260 BPM (Sledgehammer) came out at ~128
#: throughout. Each LOCAL_WINDOW_S window of the onset envelope offers its
#: autocorrelation tempi and their octaves; a Viterbi path trades candidate
#: strength against tempo jumps (an exact octave jump is cheap: mappers double
#: a double-time section) and distance outside LOCAL_RANGE_BPM; librosa's
#: dynamic-programming beat tracker then follows that tempo curve, and the
#: beats become red lines wherever their spacing leaves the line's grid by more
#: than LOCAL_LINE_TOL_MS. Chosen on 40-song dev samples; held out (60 songs a
#: stage), beats within 10 ms on the songs that take this path: anime one tempo
#: 13.7 -> 73.4 %, anime tempo changes 7.4 -> 66.1 %, bands 13.8 -> 43.1 %.
#: On songs the precision engine times it is worse (82.0 -> 70.0 % on anime),
#: so it replaces only the fallback.
LOCAL_WINDOW_S = 8.0
LOCAL_HOP_S = 4.0
LOCAL_RANGE_BPM = (140.0, 300.0)
#: bias: a little cheaper the faster the tempo, as mappers time a
#: double-time part at the speed the drums play (S3 dev 56.4 -> 66.4 %).
LOCAL_COSTS = {"jump": 0.5, "octave": 0.2, "prior": 0.6, "bias": 0.1}
LOCAL_TIGHTNESS = 1000.0
LOCAL_LINE_TOL_MS = 8.0
#: Two fixes for the fallback tracker's tempo path (the owner's report,
#: 2026-10-31: a 225 BPM band song read mostly at 112 and 150, with ramps of
#: 206, 198, 188 ... BPM between). Both off until measured.
#:
#: LOCAL_STEP_JUMPS: the curve between two windows is a straight line, so a
#: jump of an octave became ~4 s of tempi the song never plays, and as many
#: red lines. A change larger than LOCAL_STEP_RATIO now happens at once,
#: half-way between the windows' centres (experiment local-step).
#:
#: LOCAL_OCTAVE_UP: where the path reads a tempo X on some windows and ~X/2
#: on others (within LOCAL_OCTAVE_UP_TOL), and X is still a tempo osu! maps
#: at (MAP_OCTAVE_RANGE), the X/2 windows are read at X: the slower one is
#: the bar's kick-snare pair of the faster song, not a second tempo. X must
#: hold at least LOCAL_OCTAVE_UP_SHARE of the windows, so one stray window
#: lifts nothing (experiment local-octave-up).
LOCAL_STEP_JUMPS = False
LOCAL_STEP_RATIO = 1.08
LOCAL_OCTAVE_UP = False
LOCAL_OCTAVE_UP_TOL = 0.04
LOCAL_OCTAVE_UP_SHARE = 0.1


#: A local-tempo reading's octave (the fallback tracker's _local_tempo_track,
#: or Beat This!'s lines), three experiments measured on the owner's server
#: before any is on by default (timeline, 2026-10-26). LOCAL_OCTAVE_FOLD
#: doubles one below MAP_OCTAVE_RANGE (the fix/local-tempo-octave work).
#: LOCAL_OCTAVE_HALVE also reads one at 2x or 4x of the reading it replaced
#: back at that reading's octave: right for slow anime the tracker read at
#: their pulse, wrong for fast bands it read at half. LOCAL_OCTAVE_JUDGE
#: halves only where Beat This! hears the slower pulse. All off: v3 as it was.
LOCAL_OCTAVE_FOLD = True
LOCAL_OCTAVE_HALVE = True
LOCAL_OCTAVE_JUDGE = True
#: How close a local-tempo reading must sit to 2x or 4x the reading it
#: replaced to be taken as that reading an octave or two up.
LOCAL_OCTAVE_SLACK = 0.06


#: Red lines read an octave off the rest of their song (one section at 310
#: in a song at 155, the owner's Flower Petals - Sunday Cruise): each line
#: near 2x or 1/2 of the song's own tempo -- the one that holds the most of
#: its length -- is read at the song's octave where Beat This!, over that
#: line's span, hears that octave. On since 2026-10-26 (bands held out
#: tempo ok 57.7 -> 59.9 %, dev unchanged).
SECTION_OCTAVE_JUDGE = True

#: A song the beat tracker splits into dozens of red lines that one steady
#: grid explains: on bands-variable dev, all 185 maps that fell back to the
#: tracker missed the tempo, 72 of them mapped with a single red line while
#: the tracker gave a median of 78. When Beat This!'s beats over the whole
#: song sit on one grid (CONSTANT_GRID_SHARE of them within
#: CONSTANT_GRID_TOL_MS), the song is read as that grid, at the octave of the
#: tempo that held most of it. On since 2026-10-27 at 30 ms and 0.8:
#: bands tempo ok dev 46.7 -> 51.1 %, held out 59.9 unchanged; anime-variable
#: dev 31.5 unchanged, held out 19.5 -> 20.4 %; anime-single never reaches it.
CONSTANT_GRID = True
CONSTANT_GRID_TOL_MS = 30.0
CONSTANT_GRID_SHARE = 0.8

#: Red lines as the fewest steady stretches that explain Beat This!'s beats.
#: Two failures share one cause: the precision grid gives one line where the
#: song changes tempo (15 bands-variable dev songs, 75 maps, mapped 180 ->
#: 195 -> 200 and the like), and the tracker gives ~78 drifting lines where
#: the mapper used a few. Optimal partitioning of the beats into straight
#: lines, each new line costing PIECEWISE_PENALTY beats' worth of
#: PIECEWISE_SIGMA_MS error. Off until measured on the server.
PIECEWISE_GRID = False
PIECEWISE_SIGMA_MS = 15.0
PIECEWISE_PENALTY = 40.0
PIECEWISE_MIN_BEATS = 16


#: Tempo changes read off the attacks themselves (CHANGE_POINTS): a one-line
#: song is followed beat by beat, each beat put on the strongest attack near
#: where the grid expects it, and the beats found are split by optimal
#: partitioning into the fewest steady stretches (sigma CHANGE_SIGMA_MS, the
#: attacks' own spread). anime-variable dev (2026-10-28): 474 misses are maps
#: timed with ~6 lines that came out as one, 0.9-4.8 % off; fixed-window drift
#: following cut where a window ended and lost. A split stands only where the
#: stretches differ by CHANGE_MIN_STEP and explain the attacks clearly better.
CHANGE_POINTS = False
CHANGE_SIGMA_MS = 6.0
CHANGE_MIN_STEP = 0.004
CHANGE_GAIN = 0.85
CHANGE_MIN_BEATS = 16


#: A gap is the faster pulse's when it sits within this share of half the median.
STEADY_GRID_HALF_TOL = 0.15
#: and the faster pulse is the grid's when this share of the gaps is at it.
STEADY_GRID_HALF_SHARE = 0.1
#: Periods searched around that pulse (Beat This!'s 20 ms frames round 283 to 280).
STEADY_GRID_RANGE = 0.04


#: A line an octave off its song is folded back even when Beat This! does not
#: confirm it (SECTION_OCTAVE_JUDGE alone asks it to). On 2026-10-28 runs, 255
#: of 1629 anime-variable and 115 of 636 bands maps mixed octaves inside one
#: song -- a run of tempo changes read at double, or a start at double that
#: settles -- where the mapper kept one. Off until measured.
OCTAVE_CONTINUITY = False


#: The judge's last answer, by the audio it heard: the judges ask Beat This!
#: about one song up to four times, and each pass costs seconds.
_BEAT_THIS_HEARD: list = []


#: The whole song read an octave off what Beat This! hears: mappers time slow
#: songs at 80-100 and fast punk and metal at 240-260, where MAP_OCTAVE_RANGE
#: (120-240) folds them the other way (bands-variable: 35 single-line maps
#: an octave off). When Beat This!'s tempo is near 2x or 1/2 of the song's
#: own, every red line moves to its octave. Off until measured on the server.
SONG_OCTAVE_BEAT_THIS = False


#: Beat This! as an extra voter (Phase 10, 10.3; owner decision 2026-10-24).
#: The network (assets/models/beat_this_final0.onnx, MIT, see beat_this.json)
#: reads a log-mel spectrogram and marks each 20 ms frame as a beat or not;
#: its beats become red lines (_beats_to_lines) and replace the precision
#: engine's only where they explain the song's own attacks better by
#: BEAT_THIS_MARGIN (attack-to-beat F-measure at BEAT_THIS_TOL_MS). Chosen on
#: 40-song dev samples; held out (60 songs a stage), beats within 10 ms of the
#: map: anime one tempo 80.5 -> 81.6 %, anime tempo changes 64.3 -> 65.1 %,
#: bands 40.7 -> 43.5 % (within 20 ms 64.3 -> 69.5 %). Alone it is worse at
#: 10 ms (its beats sit on a 50 fps grid), and on the songs the precision
#: engine refuses the local-tempo tracker does better, so it votes only there.
#: Without the model file or onnxruntime the vote is skipped.
BEAT_THIS_MODEL = "beat_this_final0.onnx"
BEAT_THIS_MARGIN = 0.05
BEAT_THIS_TOL_MS = 15.0
BEAT_THIS_SR = 22050
BEAT_THIS_FFT = 1024
BEAT_THIS_HOP = 441                    # 50 frames a second
BEAT_THIS_MELS = 128
BEAT_THIS_BAND_HZ = (30.0, 11000.0)
BEAT_THIS_CHUNK = 1500                 # frames per network call, as Beat This! runs it
BEAT_THIS_BORDER = 6                   # frames discarded at each chunk edge
_BEAT_THIS_SESSION: list = []          # [session] once loaded, [None] when unavailable
_BEAT_THIS_JUDGE: list = []            # the octave judge's own, the vote's switch aside


#: The drums, not the mix, for the grid (PERCUSSIVE_INPUT): harmonic-percussive
#: separation (librosa's median-filter HPSS) leaves the kick, snare and hats and
#: drops the sustained guitars and bass that smear a live band's attacks.
#: Beat This! keeps the mix. 0 is off; above 0, the separation's margin.
#: Off by default: on in the server's re-analysis it took the service past its
#: memory cap on every song (2026-10-30). Measured with experiment percussive.
PERCUSSIVE_INPUT = 0.0


#: The drum kit's own bands for the grid (DRUM_BANDS): HPSS's percussive part,
#: then the kick (under 120 Hz), the snare's body (150-400 Hz) and the hats
#: (over 6 kHz) mixed back at DRUM_BAND_WEIGHTS, so a cymbal wash or a
#: guitar's pick noise in the middle bands weighs less than a kick or a
#: snare. Off until measured (experiment drum-bands).
DRUM_BANDS = False
DRUM_BAND_WEIGHTS = (1.0, 1.0, 0.5)


#: Following the drummer on the tracker path (DRUMMER_FOLLOW): the kick and
#: snare onsets of _drum_signal, each expected beat taking the strongest one
#: near it and the beat spacing following slowly (an alpha-beta filter, as
#: B-Keeper follows a live kick drum), the beats then written as red lines.
#: Replaces the tracker's lines only where they explain the drum onsets
#: DRUMMER_GAIN better with no more lines. Off until measured.
DRUMMER_FOLLOW = False
DRUMMER_GAIN = 0.9


#: The tracker held to what Beat This! hears (TRACKER_GUARD). The owner's
#: reports of 2026-10-29: Sunday Cruise, ~158 BPM throughout by Beat This!,
#: came out at ~300 for 20-40 s and 120-160 s; Pathetic, Ordinary, ~200, rose
#: to 230-263 from 2:25 and stayed. The tracker's prior leans to fast tempi
#: and nothing held it back. A tracker line more than TRACKER_GUARD_OFF off
#: Beat This!'s tempo over its span is rewritten from Beat This!'s beats, a
#: run of such lines as one; Beat This!'s local tempo an octave off its own
#: song tempo is not trusted, and the song tempo stands in.
TRACKER_GUARD = False
TRACKER_GUARD_OFF = 0.06
TRACKER_GUARD_SHARE = 0.1


#: HPSS in blocks of this many seconds, each padded by PERCUSSIVE_PAD_S of
#: its neighbours (_percussive_blocks). The whole song at once peaked at
#: 1.75 GB for five minutes, and four analyses at a time took the server past
#: its memory cap (2026-10-30). The median filters see +-0.2 s, so a 2 s pad
#: leaves every kept sample's filters whole.
PERCUSSIVE_BLOCK_S = 20.0
PERCUSSIVE_PAD_S = 2.0


#: The drums stem of our own separator for the grid (STEMS_DRUMS, roadmap
#: step 28.3): Mides-Games/Stemsplit's U-Net, run as its CLI the way the Rust
#: engine runs overtone-cli, so the network and its weights stay out of this
#: workspace until they earn a place. Beat This! keeps the mix. Off until
#: measured (experiment stems-drums); when on and the separator is missing,
#: the analysis fails rather than quietly measuring the mix.
STEMS_DRUMS = False
#: Where the separator is: the binary (on PATH unless STEMSPLIT_CLI names it)
#: and the weights (assets/models, see stemsplit.json; STEMSPLIT_MODEL overrides).
STEMSPLIT_CLI = os.environ.get("STEMSPLIT_CLI", "stemsplit")
STEMSPLIT_MODEL = os.environ.get("STEMSPLIT_MODEL", "")
STEMSPLIT_WEIGHTS = "stemsplit.safetensors"
STEMSPLIT_TIMEOUT_S = 900.0


#: A per-song octave rule fitted on the server's stages (OCTAVE_RULE). The
#: precision grid's misses sit where the fixed range cuts: a fast punk song
#: read at half (under 130 BPM, its half beats as loud as its beats) and a
#: slow one read at double (over 160 BPM, almost nothing on the half beats).
#: Fitted on dev (bands and anime-variable, tidy-bpm runs of 2026-10-28,
#: 1677 maps), checked on held out (681): first lines at the right octave
#: +63 maps dev, +44 held out. Off until measured end to end.
OCTAVE_RULE = True
OCTAVE_RULE_DOUBLE = (130.0, 0.9)     # below this BPM, at or above this off-beat ratio
OCTAVE_RULE_HALVE = (160.0, 0.3)      # above this BPM, below this off-beat ratio
#: The least off-beat weight a halving needs. With nothing on the half beats
#: (a click track, a sparse intro) the rule cannot tell a slow song read at
#: double from a fast one with no subdivision, and halved 174 and 180 to 87
#: and 90 (engine tests, 2026-10-30). Measured 2026-10-30 (rust engine, 08501366):
#: halving never fired on bands-variable (dev 47.6 / held out 61.0 with or
#: without it) and was worth 0.3 points on anime-single dev (78.4 vs 78.1),
#: held out equal (82.2). So it is off: only the doubling half of the rule
#: runs. Experiment octave-rule-floor (0.05) brings it back.
OCTAVE_RULE_HALVE_FLOOR = float("inf")


#: The song's octave by a model of mapped tempi (TEMPO_JUDGE, roadmap 27.8,
#: overtone/tempo_judge.py): trained on 2,698 ranked songs' dominant red-line
#: BPM (bench/tempo_model.py). On 1,102 held-out songs it picks the mapped
#: octave from a reading at x1/2, x1, x2 in 95.8 / 91.3 / 95.2 % against
#: 89.3 % for the fixed 120-240 range. Applied to the stages' cached analyses
#: (2026-11-07) it changes a song only when it rates the new octave
#: TEMPO_JUDGE_MARGIN times the reading; with no margin it broke 14 band maps.
#: Off until measured end to end (experiment tempo-judge).
TEMPO_JUDGE = False
TEMPO_JUDGE_MARGIN = 10.0
TEMPO_JUDGE_MODEL = "tempo_judge.npz"


#: Octaves smoothed across neighbouring red lines (OCTAVE_SMOOTH): the owner's
#: report of 2026-10-28, a run of tempo changes read at double, or a song that
#: starts at double and settles. Each line may stay, double or halve; leaving
#: its own reading costs OCTAVE_SMOOTH_KEEP plus OCTAVE_SMOOTH_SPAN times its
#: share of the song (a long line is believed, a short one is not), and an
#: octave step between neighbours costs 1. The cheapest path (Viterbi) wins.
OCTAVE_SMOOTH = False
OCTAVE_SMOOTH_KEEP = 0.2
OCTAVE_SMOOTH_SPAN = 3.0


#: Tempo changes on the downbeat (LINES_ON_DOWNBEATS, roadmap 27.7): mappers
#: start a new red line on beat 1 of a bar, and the tracker's lines land on
#: whatever beat the tempo moved (the owner's report, 2026-10-30, on live band
#: songs). Each line after the first moves by whole beats of its own, so its
#: grid stays where it was, to the beat nearest the previous line's next bar
#: line, counted from the first line's accented beat. A move is kept only when
#: the grid explains the attacks no worse than LINES_ON_DOWNBEATS_LOSS (10 ms
#: F). Off until measured (experiment lines-on-downbeats).
LINES_ON_DOWNBEATS = False
LINES_ON_DOWNBEATS_TOL = 0.25          # of a beat: a bar line farther away is not this one's
LINES_ON_DOWNBEATS_LOSS = 0.002


#: Tempo changes at phrase points (PHRASE_LINES, the owner's request of
#: 2026-10-31): the tracker opened a red line every half bar on band songs
#: (78 lines on Kick Me, one in the map; 61 % of its segments shorter than a
#: bar), so lines on downbeats had nothing to land on. First neighbouring
#: lines merge, cheapest first, into one line fitted on their beats while the
#: attacks lose no more than PHRASE_LOSS of 10 ms F (twice that for a line
#: shorter than PHRASE_MIN_BARS bars). Then each change left moves, within a
#: bar, to where a mapper recalculates: a downbeat (PHRASE_DOWNBEAT_BONUS) or
#: the beat after the music eases off, a beat with under PHRASE_QUIET of the
#: usual attack weight (PHRASE_QUIET_BONUS); the fit decides between them.
PHRASE_LINES = True
PHRASE_MIN_BARS = 2.0
PHRASE_LOSS = 0.01
PHRASE_DOWNBEAT_BONUS = 0.004
PHRASE_QUIET = 0.5
PHRASE_QUIET_BONUS = 0.003


#: A line within PHRASE_OCTAVE_TOL of twice or half the song's tempo is read
#: at the song's octave before merging (the owner's report, 2026-10-31:
#: sections at half or double BPM inside a band song).
PHRASE_OCTAVE_TOL = 0.04


#: Neighbouring lines this close in BPM merge at three times PHRASE_LOSS: a
#: live drummer's 151.5 / 152 / 152.2 is one tempo (Senses Fail - Angela Baker).
PHRASE_CLOSE = 0.02
#: The fit tolerance merges are priced at: a live band drifts past 10 ms
#: inside a bar that a mapper still times with one line.
PHRASE_TOL_MS = 20.0
#: A section read at double (Alesana - Seduction from 3:29, the owner's
#: report of 2026-10-31: ~235 where the song plays ~118): above
#: PHRASE_HALVE_BPM, at least PHRASE_HALVE_S long, with half-beat attack
#: weight under PHRASE_HALVE_RATIO of its beats' and under PHRASE_HALVE_REL
#: of the rest of the song's. Relative to the song, so a fast song with no
#: subdivision anywhere (the 174 / 180 tests OCTAVE_RULE halved) is kept.
PHRASE_HALVE_BPM = 160.0
PHRASE_HALVE_S = 4.0
PHRASE_HALVE_RATIO = 0.2
PHRASE_HALVE_REL = 0.5
#: Within this share of the rest of the song's tempo a part is kept as read.
PHRASE_HALVE_SAME = 0.08


#: A red line on its attack (the owner's report, 2026-10-31: lines a few ms
#: off the note they start on). Each line's grid moves by the weighted median
#: of its strong attacks' error, at most PHRASE_PHASE_MAX of a beat, and a
#: change prefers a beat with a strong attack within PHRASE_ONSET_MS.
PHRASE_PHASE_MAX = 0.1
PHRASE_ONSET_MS = 10.0
PHRASE_ONSET_BONUS = 0.008


#: No double tick (the owner's report, 2026-10-31): a change a few ms after
#: one of the previous line's beats ticks twice. Among a change's places, one
#: within PHRASE_TICK_ON_MS of a previous beat (heard as one tick) or at
#: least PHRASE_TICK_GAP of a beat after it wins over the rest; one still a
#: few ms off (a drift fix) stretches the previous grid onto it or moves onto
#: the previous beat, the cheaper, within PHRASE_STRETCH_MS and at most
#: PHRASE_STRETCH_LOSS of 10 ms F (_one_tick).
PHRASE_TICK_GAP = 0.4
PHRASE_TICK_ON_MS = 3.0
PHRASE_STRETCH_MS = 25.0
PHRASE_STRETCH_LOSS = 0.03
#: A line split where a second line explains its attacks (the owner's report,
#: 2026-10-31: parts a mapper times with several lines had none): the best
#: cut leaving PHRASE_DRIFT_BARS bars a side that raises 10 ms F by
#: PHRASE_DRIFT_GAIN, unless it keeps the tempo and moves the grid under
#: PHRASE_DRIFT_MIN_MS, which adds a tick, not a fix.
PHRASE_DRIFT_BARS = 4
PHRASE_DRIFT_GAIN = 0.03
PHRASE_DRIFT_MIN_MS = 10.0


#: Bar-by-bar lines on songs with no click (the fallback tracker's), as a
#: ranked mapper times a live band (My Chemical Romance - Vampires Will Never
#: Hurt You, 2437969: 236 red lines, 85 % of them one bar long, 94 % starting
#: exactly where the previous grid's bar ends, BPMs with two decimals). Each
#: phrase's downbeats move onto the strong attacks of their bar (at most
#: PHRASE_BAR_SHIFT of a beat), each bar gets the BPM that ends it exactly on
#: the next downbeat, so the grid runs on with no double tick, and bars merge
#: while one line still puts every downbeat between within PHRASE_BAR_TOL_MS.
PHRASE_BARS = True
PHRASE_BAR_SHIFT = 0.15
PHRASE_BAR_TOL_MS = 4.0


#: Red lines a mapper can read: a BPM keeps two decimals at most, and one
#: where that is within TIDY_BPM_ONE_DECIMAL of it (180.19 -> 180.2; 180.18
#: stays), at the owner's request (2026-10-28): 180.178 is not a tempo
#: anyone hears. Each line keeps the beat at the middle of its span where it
#: was, so the rounding's drift is split between the line's two ends. On since
#: 2026-10-28: the tidy-bpm runs left tempo ok and octave unchanged on every
#: stage (bands dev 51.1, held out 59.9; anime-variable 31.9 / 21.5).
TIDY_BPM = True
#: Decimals a BPM is written with. Two since 2026-10-31, the owner's request
#: after comparing a ranked set (2437969, Vampires Will Never Hurt You: 94.04,
#: 94.11 ...); 1 brings back the one-decimal rule below.
TIDY_BPM_DECIMALS = 2
TIDY_BPM_ONE_DECIMAL = 0.011
#: The most a line's ends may move to write its BPM with one decimal.
TIDY_BPM_DRIFT_MS = 2.0


#: A red line above OCTAVE_CAP_BPM is read at half (OCTAVE_CAP). Measured on
#: the server's dev reports of 2026-10-31 (5fdf765, bench/diagnose.py by our
#: line's BPM): above 260 no stretch of anime-single or anime-variable was right
#: and 70-97 % of that time was the map's double; bands' fallback lines there
#: were 18 % right and 24 % double. 240-260 is mixed (bands' precision lines 83 %
#: right), so the cap starts above it.
OCTAVE_CAP = True
OCTAVE_CAP_BPM = 260.0


#: Decimals StepMania's tags are written with. Both are floats in the format
#: and most hand-written files use three, but three decimals of a BPM is a
#: coarser grid than this engine fits: on the pinned readings, rounding the
#: BPM there alone walked a chart up to 3.7 ms off its own beats over an hour
#: of them. Six costs a few bytes and puts that under a microsecond.
STEPMANIA_DECIMALS = 6


#: What `read_timing_file` reads, by the extension it reads it from.
TIMING_FORMATS = {".qua": "quaver", ".sm": "stepmania", ".ssc": "stepmania"}
#: A timing file is tags and numbers; anything this size is not one.
MAX_TIMING_BYTES = 16 * 1024 * 1024


#: Beats one red line may click before the schedule gives up on it: a guard
#: against a hand-typed BPM in the thousands, not a limit any song reaches.
MAX_CLICKS_PER_LINE = 20000
#: Subdivisions a click may add between beats (1 = beats only).
CLICK_SUBDIVISIONS = (1, 2, 3, 4)


#: How far export snapping may move a detected red line onto the previous
#: grid. Measured: the precision engine's section changes sit 0.005-0.026 ms
#: off it (rounding noise, the only thing snapping is for). The old tolerance,
#: a quarter beat, moved the fallback tracker's red lines by up to 75 ms on a
#: real song and hand-placed ones by up to a quarter beat.
SNAP_TOLERANCE_MS = 1.0


#: How far before the sound ranked maps put their red lines (10.0a): the
#: median signed distance from a map's red line to Overtone's grid, fitted on
#: the dev songs of the three Songs-folder stages (bench/stages.py,
#: 2026-10-23: 27.6 ms pooled; 28.0 / 26.4 / 25.0 by stage), never in the
#: engine -- only on what is written for osu! (with_map_lead). Held out, the
#: map's first red line within 5 ms of the written one: anime one tempo
#: 1.7 -> 41.9 %, anime tempo changes 1.9 -> 35.3 %, bands 0.5 -> 34.8 %.
MAP_LEAD_MS = 28.0

#: Two red lines this close (in units of the governing beat) cannot both sit
#: on downbeats: one of them is a duplicate.
DUPLICATE_BEATS = 1.0
#: A section shorter than one bar is suspicious but possible (fills, pickups).
MIN_BEATS_PER_SECTION = 4.0
#: Past this adjacent-section ratio the change is a detection error, not music.
IMPOSSIBLE_RATIO = 4.0
#: Within this band of x2 (or /2, in log2 space — octaves live there) the
#: octave is a human judgement call, and the finding says exactly that: it
#: never asserts which side is right.
OCTAVE_BAND_LOG = 0.15
#: A first red line this far after the first beat leaves the intro untimed.
LATE_FIRST_LINE_S = 2.0


#: The bar lengths the editor offers, in beats: the largest in 25,174 local
#: maps is 16 (MAX_METER bounds what the reader accepts, not what a mapper sets).
EDIT_METERS = range(1, 17)

#: An .osz is a zip; a mistyped path should not turn into a gigabyte of audio.
MAX_OSZ_AUDIO_BYTES = 64 * 1024 * 1024


# -- Write history ------------------------------------------------------------
# Every .osu write lands here: what changed, and the backup holding what it
# replaced, so the History view can list, diff and restore. One JSON object
# per line; a torn tail line never hides the rest.

#: Entries kept; the file is rewritten at twice this, so it stays small.
HISTORY_LIMIT = 200

#: Comparison rate for the shift: 0.09 ms a lag, anti-aliased against codec
#: highs loss, and a 5-minute song fits the FFT in tens of megabytes.
SWAP_SR = 11025
#: Refusals, measured on synthetic shifts and real pairs: true shifts read
#: peak 0.96 and up, re-encodes apart; tempo twins and strangers read under
#: 0.11; different cuts sit between and refuse, which is the safe side.
SWAP_MIN_PEAK = 0.5
SWAP_MIN_SHARP = 50.0
#: A tempo ratio past this is not a shift: over 3 minutes, 0.5 % already
#: walks 0.9 s.
SWAP_MAX_TEMPO_DRIFT = 0.005


_OSU_LINE = re.compile(r"[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+\Z")


#: Past this octave-normalised BPM gap the map and the detection disagree
#: rather than round differently. Offsets reuse the benchmark's 5 ms bar.
MAP_BPM_TOLERANCE = 1.0
MAP_OFFSET_TOLERANCE_MS = 5.0


#: Audio extensions Overtone can analyse, shared by the GUIs' file dialogs.
AUDIO_EXTENSIONS = (".wav", ".flac", ".ogg", ".mp3", ".m4a", ".aac", ".opus", ".aiff")


#: What osu! reads for the fields an old green line leaves out: meter,
#: sample set, sample index, volume, uninherited (0: a green) and effects.
_GREEN_FIELD_DEFAULTS = ("", "", "4", "0", "0", "100", "0", "0")


#: The multipliers osu! plays a green line's slider velocity at: 0.1x to 10x.
SV_RANGE = (0.1, 10.0)
#: A span reads constant already when the scroll right after its red line is
#: within this share of the reference's: normalised by hand, or by a first run.
SCROLL_TOLERANCE = 1e-4

#: An object within this of an attack belongs to it. Mappers think in
#: milliseconds, and 50 ms is an eighth note at 150 BPM — generous enough for
#: human timing, tight enough to exclude the neighbour.
OBJECT_WINDOW_MS = 50.0
#: Nearest-neighbour object gap under this with small steps reads as a stream.
STREAM_GAP_MS = 250.0
STREAM_STEP_PX = 150.0
#: A step at least this big on a fast gap reads as a jump.
JUMP_STEP_PX = 200.0
JUMP_GAP_MS = 500.0


#: The snap divisors osu!'s editor offers, coarsest first.
SNAP_DIVISORS = (1, 2, 3, 4, 6, 8, 12, 16)
#: How far an object may sit from its exact tick and still count as snapped.
#: osu! stores whole milliseconds against a red line whose beat is fractional,
#: so a snapped object can sit past 1 ms: on 61 ranked maps, 272 of 30,553
#: objects sat 1-2 ms from a tick and 5 past 2 ms. At 1 ms the audit flagged
#: those 272 as unsnapped. A name of its own: it once shared
#: SNAP_TOLERANCE_MS with export snapping, and the later definition silently
#: set both.
OBJECT_SNAP_TOLERANCE_MS = 2.0


#: An attack this far from a divisor tick still counts as on it. The snap
#: audit's 2 ms is about objects, stored whole-millisecond; attacks are
#: measured, with detection jitter on top, so the bar is looser — and it is
#: the tool's own, adjustable, not the client's.
DIVISOR_TOLERANCE_MS = 15.0
#: A section needs a finer divisor when the attacks on thirds or sixths carry
#: this share of its weight, with at least this many of them. Weighted, not
#: counted: sample echoes and noise-floor detections sit on triplet grids by
#: coincidence of tempo, but they are quiet next to the drums — on straight
#: 120-132 BPM material they held up to 20 % of the count yet under 7 % of
#: the weight, while real triplets hold both. One stray triplet is feel.
DIVISOR_MIN_WSHARE = 0.10
DIVISOR_MIN_COUNT = 3


#: The swing lane reads the song this many beats at a time: two bars of 4/4.
#: A feel is a pattern that repeats, so one beat says nothing, and a window
#: this short still changes where the song does.
SWING_WINDOW_BEATS = 8
#: How far either side of its beat a beat's own attacks are looked for.
SWING_ON_SPAN = 0.2
#: The latest the off-beat eighth is looked for, as a share of the beat: past
#: a 5:1 swing it is the next beat's pickup, not an eighth.
SWING_LATE_MAX = 0.84
#: The swung eighth has to carry this share of the window's attack weight...
SWING_MIN_SHARE = 0.10
#: ...and the straight eighth at most this share of the swung one's. Measured
#: on 34 local maps whose reading is the map's own pulse (12 of Corpus B, 22
#: tagged swing or jazz): of the windows this calls swung, the mapper snapped
#: their off-beats late too in 72 %, and 6 % of the straight windows had late
#: objects. Neither bar is tuned to a song — every pair from 0.15-0.35 here and
#: 0.05-0.20 above lands between 65 % and 87 %, at 6-7 % (2026-09-27).
SWING_MAX_STRAIGHT = 0.25
#
# `_grow_sections` extends a section while its inlier share holds, and that
# share cannot move across an exact 2x change: the grid is continuous, so
# every attack of the slow half still lands on the fast half's grid. What
# moves is **coverage** on a subdivided grid, which the growth loop computes
# and throws away.
#
# Coverage alone is not enough — a drop, a breakdown and a sparse bar all
# lower it. The discriminator is **parity**: in a half-time region the filled
# slots share one residue mod 2; in a thinned-out one they are scattered.
#
#     coverage ~0.5   "half the slots are empty"
#     parity   ~1.0   "and it is every other one, not a random half"
#
# What this produces is what DSP §B.2 asks for: a hint, surfaced, never a
# silent split. Mapping the whole track at the reported BPM stays defensible,
# so nothing here moves a red line by itself.

#: Windows are sized in beats of the reported grid. Eight beats is two bars of
#: 4/4 — short enough to localise a change, long enough that one missed hit
#: does not move the statistics.
DENSITY_WINDOW_BEATS = 8
#: Subdivisions of the reported beat to test. The signal is invisible at the
#: beat itself: a half-time region still has an attack on every beat.
DENSITY_SUBDIVISIONS = (2, 4)
#: A window is "thinned" when at most this fraction of its slots is filled...
DENSITY_COVERAGE_MAX = 0.70
#: ...and at least this fraction of the filled weight shares a residue mod 2.
#: Random thinning gives about 0.5; an exact half-time gives about 1.0.
DENSITY_PARITY_MIN = 0.85
#: Both sides of a proposed change must be this many windows long.
DENSITY_MIN_RUN = 2
#: The thinned run's coverage must sit this far under the rest of its section.
DENSITY_COVERAGE_DROP = 0.2
#: An attack this far from a slot still fills it (or 6 ms, whichever is more).
DENSITY_TOL_RATIO = 0.12


#: A red line closer than this to another is the same line written twice.
RED_LINE_CLASH_MS = 1.0

#: Beat lengths closer than this are one number written twice (a float
#: round-trip in some editor); offsets are compared exactly as written.
MAPSET_BEAT_TOLERANCE_MS = 1e-6
#: Fields the difficulties of one set must agree on, by .osu section.
MAPSET_AUDIO_FIELDS = ("AudioFilename", "PreviewTime", "AudioLeadIn")
MAPSET_METADATA_FIELDS = ("Artist", "ArtistUnicode", "Title", "TitleUnicode",
                          "Creator", "Source", "Tags")
#: osu!'s value for a [General] number that is left out, so a missing
#: AudioLeadIn and an explicit 0 read as the same setting.
_MAPSET_GENERAL_DEFAULTS = {"PreviewTime": -1.0, "AudioLeadIn": 0.0}

#: The subdivisions of a red line's beat its attacks are read at, coarsest
#: first. Straight music sits on 1/2 or 1/4, a shuffle on 1/3.
REFERENCE_DIVISORS = (1, 2, 3, 4)
#: A finer subdivision is taken only when it explains clearly more attack
#: weight: 1/4 always catches what 1/2 does, so without this slack every
#: span would read at 1/4 and resolve its offset to only an eighth of a beat.
REFERENCE_DIVISOR_SLACK = 0.9
#: Fewer attacks than this in a span cannot pin both an offset and a slope.
REFERENCE_MIN_ATTACKS = 8
#: The engine's own share gate: below it a grid explains too little of the
#: attack weight to vouch for, or against, the red line.
REFERENCE_MIN_SHARE = 0.40
#: Past this a line's offset or its end-of-span drift is worth a look. It is
#: the benchmark's 5 ms bar, the same one the compare card uses.
REFERENCE_TOLERANCE_MS = MAP_OFFSET_TOLERANCE_MS
#: An error is flagged only past this many of its own standard errors too.
REFERENCE_SIGMAS = 2.0


#: A meter past this is no meter: the largest in 25,174 local maps is 16, and a
#: fuzzed 2**64 made the hitsound report ask for a list of 2**66 slots.
MAX_METER = 1024


#: The first window a span is locked in, in beats of the map. The map's grid
#: is best known at its own red line, so the fit starts there and grows
#: forward; started mid-span, a BPM 1 % off has already walked a beat away.
REFERENCE_LOCK_BEATS = 8
#: How far the fit may move the map's beat. A typed BPM is off by tenths or
#: a few percent; a fit that wanders further has found another pulse (on one
#: real song it shrank each pass until the least squares overflowed), so the
#: last fit inside the band is kept and the share says how little it explains.
REFERENCE_PERIOD_BAND = (0.8, 1.25)
#: Sample sets as the format numbers them; 0 means "inherit".
SAMPLE_SET_NAMES = {1: "normal", 2: "soft", 3: "drum"}
#: A sound takes the timing point in force this long after it, as osu!lazer's
#: legacy decoder does, so a green line placed a hair late still reaches the
#: object it was meant for. Stable's own rule is not verified here.
SAMPLE_LENIENCY_MS = 5.0


#: The engine lives in ``python/``, data at the repo root.
_HERE = Path(__file__).resolve().parent.parent
ROOT = _HERE.parent
#: osu!'s floor: a sound is never quieter than this, whatever the map says.
MIN_SAMPLE_VOLUME = 5

#: A phrase boundary moves to a proven downbeat at most this far. The
#: boundaries sit on a 0.5 s feature grid and the Rust tests hold them within
#: 1.5 s of the truth; past that, the nearest bar line is another phrase's.
STRUCTURE_SNAP_S = 1.5
#: The proven bar beside the nearest one takes the edge when the level changes
#: more there, the way it goes from one section to the next, by this many dB:
#: the phrase's first bar is where the change lands, and the novelty peak
#: (4 s either side, on 0.5 s windows) sits up to a bar off it, most often a
#: bar early, on a break or a fill before a chorus. On ranked maps' kiai starts
#: with an edge within 2 bars, the kiai's own bar: nearest 42 % -> this rule
#: 65 % on the 500 songs it was chosen on; 46 % -> 56 % on 500 held out (27
#: fixed, 12 broken, p 0.024), short of the bar set beforehand (+10 points and
#: p < 0.01); frozen, then 35 % -> 49 % on the 673 songs neither used (46
#: fixed, 19 broken, sign test p 0.001), kiai ends 50 % -> 52 %. See timeline.md.
STRUCTURE_PHRASE_MARGIN_DB = 0.5
#: Points the energy lane keeps: enough for a wide window, few for the bridge.
STRUCTURE_LANE_POINTS = 800

#: Tempos an assisted grid may take, wider than osu!'s usual range: the user
#: says where the bars are, so a 70 BPM ballad is a fact, not an octave error.
ASSISTED_BPM_RANGE = (40.0, 400.0)
#: How far past the second mark the seed window reaches at least, in beats:
#: two marks one bar apart hold too few attacks to fit a slope on.
ASSISTED_SEED_BEATS = 8
#: Growth past the marks, as the engine grows a section: a chunk must put this
#: much of its weight on the grid, within this fraction of a subdivision. The
#: engine's 0.55 assumes a grid that explains nearly every attack; a swung song
#: read at the beat puts only 0.54-0.57 on it, even beside the marks, and never
#: grew past them. So a chunk must fit about as well as the seed did: 0.8 of the
#: seed's share, between the share gate and the engine's bar.
ASSISTED_GROW_SHARE = 0.55
ASSISTED_GROW_RATIO = 0.8
ASSISTED_GROW_RMS = 0.09
#: A mark snaps to the strongest attack within a quarter beat of it, and never
#: further than a hand in the editor is off.
ASSISTED_SNAP_BEATS = 0.25
ASSISTED_SNAP_S = 0.060
#: The longest stretch the grid may be lost in and still continue, as long as
#: the same grid comes back after it: a breakdown of 16 bars at 128 BPM.
ASSISTED_GAP_S = 30.0
#: Where growth stops, this much further is searched for a grid of its own; a
#: period within this fraction of ours, up to an octave, is ours.
ASSISTED_CHANGE_WINDOW_S = 12.0
ASSISTED_SAME_GRID = 0.005
#: A grid that held fewer bars than this is answered but called short. Marked
#: on 30 ranked maps, every fit that held 11 bars or fewer missed the map's BPM
#: by 0.25-1.9, and every one that held 22 or more came within 0.043. The
#: least-squares standard error was tried and dropped: it put nearly every fit,
#: good ones included, past two of its own errors.
ASSISTED_MIN_BARS = 16
#: Adding the line keeps detected lines this close to the span's end.
ASSISTED_EDGE_BEATS = 8
#: The engine refuses a grid chance explains at 10**-6 because its seed search
#: tries thousands of grids and keeps the best. Here the user proposed one, so
#: one in a thousand is the same bar. Marks on white noise score 0 to -1.
ASSISTED_CHANCE_LOG10P = -3.0

#: A timestamp the osu! editor understands: minutes (any number), seconds and
#: milliseconds, then the combo numbers of the objects it names, if any.
MOD_STAMP = re.compile(r"^\d{2,}:\d{2}:\d{3}( \(\d+(,\d+)*\))?$")
#: The order sources are listed in when two findings share a moment.
MOD_SOURCES = ("reference", "suggestion", "snap", "alignment")
