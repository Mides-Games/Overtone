"""Overtone — tempo map analyser for osu! beatmapping (v3 engine).

The v2 engine read tempo from the *gaps between detected beats*. Differencing
amplifies the few milliseconds of jitter every onset detector carries, so its
BPM wandered by a couple of tenths and its offsets sat about 8 ms late.

v3 never differences anything. It fits an explicit model

    t(k) = offset + k · beat_length          (k = integer beat index)

to the detected attack times by iteratively re-weighted least squares. Hundreds
of inlier attacks average the jitter down by sqrt(N), which is what turns
"±0.2 BPM" into "±0.001 BPM" and puts offsets inside a millisecond of the true
attack. On the synthetic benchmark (24 tracks: odd tempos, noise, jitter, swing,
drops, sparse bars, 2-4 tempo changes) every section lands within 0.05 BPM and
5 ms of ground truth, most of them within 0.001 BPM and 0.3 ms.

Pipeline
--------
1. Load mono audio at 44.1 kHz (SoundFile fast-path, librosa fallback).
2. Detect attacks on a 2.9 ms onset envelope, then **re-time each one on the
   raw waveform at sample resolution** — a spectral-flux peak lags the physical
   attack by about a window, and an offset 8 ms late is audible in the editor.
3. Find the *atomic* pulse with a weighted circular-coherence sweep,
   R(f) = |Σ w·e^{2πi f t}| / Σ w, ranked by how much attack energy each grid
   explains times how many of its own slots are filled.
4. Lock that grid onto the track with expanding-window least squares.
5. Decide how many atoms make a beat from the accent pattern (attacks grouped
   by index modulo m) plus tempogram hints — the octave is chosen from
   evidence, never by blind multiplication.
6. Grow constant-tempo sections forward while attacks keep landing on the grid;
   each new section re-seeds its own coherence scan, so an abrupt change cannot
   poison it. Boundaries settle on the beat where the two grids cross, and each
   section is refitted on its own attacks alone.
7. Fall back to the v2 hybrid beat tracker when no grid fits at all (rubato,
   free time, no percussion).

Defaults (1.5 BPM / 12 beats / 75 %) target songs whose BPM changes often;
the Steady preset (2.0 / 20 / 85 %) suits constant-tempo tracks.

Everything is local: no uploads, no accounts.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import queue
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import librosa
import numpy as np
import soundfile as sf
from scipy import signal
from scipy.ndimage import median_filter

APP_VERSION = "3.0"
DEFAULT_LANGUAGE = "English"  # English is the default UI language.
CONFIG_PATH = Path.home() / ".overtone.json"
#: The name before the project was renamed to Overtone. Read as a
#: fallback so an existing install keeps its preferences.
LEGACY_CONFIG_PATH = Path.home() / ".timing_analyzer.json"
TARGET_SR = 44100
HOP = 256  # ~5.8 ms at 44.1 kHz: timing-grid resolution suited to mapping.
#: Pulse octaves the UI and CLI may force (1 = whatever the engine detected).
ALLOWED_FACTORS = (0.25, 0.5, 1.0, 2.0, 4.0)


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TimingPoint:
    offset_ms: float
    bpm: float
    confidence: float
    beat_index: int
    #: Beats per bar for this point, written into the .osu meter field and
    #: used to accent the click track. Defaults to 4 so every existing caller
    #: and every hand-made point keeps working unchanged.
    meter: int = 4
    #: True when the accents actually proved where the bar starts. When they
    #: did not, the offset is anchored to a beat rather than a downbeat —
    #: guessing a bar without evidence pushes the first red line up to three
    #: beats past the first sound.
    meter_known: bool = False
    #: True when the mapper placed or edited this point. Export snapping never
    #: moves it, and never pulls the next detected point onto its grid.
    manual: bool = False


@dataclass
class Analysis:
    source: str
    duration: float
    beats: np.ndarray
    local_bpms: np.ndarray
    points: list[TimingPoint]
    hop_length: int
    sample_rate: int
    subdivision: float
    # v2 enrichment (defaults keep old pickles/callers working)
    global_bpm: float = 0.0
    stability: float = 0.0
    meter: str = "4/4"
    onset: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    # Pre-subdivision beat grid (frames): lets the GUI/CLI re-resolve ×1/×2/×4
    # without re-tracking beats.
    base_frames: np.ndarray | None = None
    # v3 precision engine: the raw evidence and the fitted grids. Present only
    # when the grid engine ran; the legacy tracker leaves them empty and every
    # consumer falls back to the beat-array path.
    attack_times: np.ndarray = field(default_factory=lambda: np.zeros(0))
    attack_weights: np.ndarray = field(default_factory=lambda: np.zeros(0))
    sections: list["GridSection"] = field(default_factory=list)
    meter_beats: int = 4
    downbeat_class: int = 0
    fit_residual_ms: float = 0.0
    engine: str = "legacy"


# ---------------------------------------------------------------------------
# Onset envelope
# ---------------------------------------------------------------------------

def _fast_onset_envelope(y: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """Fast spectral-flux envelope, independent of the slow beat tracker."""
    _, _, spectrum = signal.stft(y, fs=sr, nperseg=1024, noverlap=1024 - hop,
                                 boundary=None, padded=False)
    magnitude = np.abs(spectrum)
    return np.maximum(np.diff(magnitude, axis=1), 0).mean(axis=0).astype(np.float32)


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


def _mel_power(y: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """librosa's centred 128-band mel power spectrogram, a block at a time.

    Each frame is the same zero-padded slice of the signal as in the one-shot
    call, so only the mel projection's float32 summation order can differ:
    at most ~2e-6 of the envelope's range, measured on a real song.
    """
    padded = np.pad(y.astype(np.float32), ONSET_N_FFT // 2, mode="constant")
    frames = 1 + y.size // hop
    blocks = []
    for first in range(0, frames, SPECTROGRAM_BLOCK):
        last = min(frames, first + SPECTROGRAM_BLOCK)
        blocks.append(librosa.feature.melspectrogram(
            y=padded[first * hop:(last - 1) * hop + ONSET_N_FFT], sr=sr, n_fft=ONSET_N_FFT,
            hop_length=hop, center=False, fmax=11025, n_mels=128))
    return np.concatenate(blocks, axis=-1)


def _onset_envelope(y: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """Normalized onset-strength envelope (librosa first, flux fallback)."""
    try:
        env = librosa.onset.onset_strength(
            S=librosa.power_to_db(_mel_power(y, sr, hop)), sr=sr, hop_length=hop,
            n_fft=ONSET_N_FFT, aggregate=np.median,
        ).astype(np.float32)
    except Exception:
        env = _fast_onset_envelope(y, sr, hop)
    if env.size == 0:
        return env
    # Normalize to [0, 1] with a robust ceiling so thresholds are portable
    # across quiet/loud masters.
    ceiling = float(np.percentile(env, 99.5))
    if ceiling > 1e-9:
        env = env / ceiling
    return np.clip(env, 0.0, 1.5).astype(np.float32)


# ---------------------------------------------------------------------------
# Beat tracking (hybrid)
# ---------------------------------------------------------------------------

def _peak_beats(onset: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """Find musical attacks and reconstruct occasional missing beats."""
    frame_rate = sr / hop
    prominence = float(np.percentile(onset, 65))
    peaks, _ = signal.find_peaks(onset, distance=max(1, round(frame_rate * 0.18)),
                                 prominence=max(prominence, 1e-8))
    if len(peaks) < 8:
        return peaks.astype(int)
    gaps = np.diff(peaks)
    band = (gaps > frame_rate * 0.18) & (gaps < frame_rate * 0.42)
    typical = float(np.median(gaps[band])) if np.any(band) else float(np.median(gaps))
    if not np.isfinite(typical) or typical <= 0:
        return peaks.astype(int)
    rebuilt = [int(peaks[0])]
    for left, right in zip(peaks[:-1], peaks[1:]):
        # Capped: a pathological ``typical`` would otherwise expand one gap into
        # millions of phantom beats.
        count = min(64, max(1, int(round((right - left) / typical))))
        rebuilt.extend(np.rint(np.linspace(left, right, count + 1)[1:]).astype(int).tolist())
    return np.asarray(rebuilt, dtype=int)


def _regularity_score(frames: np.ndarray) -> float:
    """Higher = more clock-like. Used to pick between tracker candidates."""
    if len(frames) < 8:
        return -1e9
    gaps = np.diff(frames.astype(float))
    med = float(np.median(gaps))
    if med <= 0:
        return -1e9
    mad = float(np.median(np.abs(gaps - med)))
    cv = mad / med  # robust coefficient of variation
    coverage = len(frames) / max(1.0, (frames[-1] - frames[0]) / med)
    return float(coverage - 6.0 * cv)


def _tempogram(onset: np.ndarray, sr: int, hop: int, win_length: int):
    """librosa.feature.tempogram(onset, center=True), in blocks of columns.

    The envelope is padded once exactly as librosa pads it, and each block is
    the uncentred tempogram of its own slice: every column is the same window
    of the same signal, so the blocks join bit for bit into the one-shot array
    (checked on fixtures and a real song) without its FFT buffers.
    """
    n = onset.shape[-1]
    half = win_length // 2
    padded = np.pad(onset, (half, half), mode="linear_ramp", end_values=[0, 0])
    for first in range(0, n, TEMPOGRAM_BLOCK):
        last = min(n, first + TEMPOGRAM_BLOCK)
        yield librosa.feature.tempogram(onset_envelope=padded[first:last - 1 + win_length],
                                        sr=sr, hop_length=hop, win_length=win_length,
                                        center=False)


def _tempo_readings(onset: np.ndarray, sr: int, hop: int) -> tuple[np.ndarray, np.ndarray]:
    """Both of the fallback tracker's readings of librosa's 8-second tempogram.

    ``(per-frame tempo, overall tempo)``: what _global_tempo_guides reads with
    ``aggregate=None, std_bpm=1.0``, and what librosa.beat.beat_track estimates
    for itself (the time-mean read through the default prior). v3 built that
    tempogram twice, whole; this is one pass in blocks. The per-frame tempo is
    column for column the same; the mean is summed block by block and differs
    from numpy's one-shot mean by ~1e-16, which picks the same tempo bin.
    """
    win = int(librosa.time_to_frames(8.0, sr=sr, hop_length=hop))
    per_frame, total = [], 0.0
    for block in _tempogram(onset, sr, hop, win):
        per_frame.append(librosa.feature.rhythm.tempo(tg=block, sr=sr, hop_length=hop,
                                                      aggregate=None, std_bpm=1.0))
        total = total + block.sum(axis=-1, keepdims=True)
    overall = librosa.feature.rhythm.tempo(tg=total / onset.shape[-1], sr=sr, hop_length=hop)
    return np.concatenate(per_frame, axis=-1), overall


def _track_beats_hybrid(onset: np.ndarray, sr: int, hop: int,
                        prior_tempo: float | None = None,
                        tracker_bpm: np.ndarray | None = None) -> np.ndarray:
    """Combine librosa trackers with the peak fallback; keep the steadiest.

    ``tracker_bpm`` is the DP tracker's own tempo estimate when the caller has
    it already (see _tempo_readings).
    """
    candidates: list[np.ndarray] = []
    # 1) Dynamic-programming beat tracker (tight: less drift on steady music).
    try:
        if tracker_bpm is None:
            tracker_bpm = _tempo_readings(onset, sr, hop)[1]
        _tempo, lib_frames = librosa.beat.beat_track(
            onset_envelope=onset, sr=sr, hop_length=hop,
            tightness=100, trim=False, bpm=tracker_bpm)
        lib_frames = np.asarray(lib_frames, dtype=int)
        if len(lib_frames) >= 8:
            candidates.append(lib_frames)
    except Exception:
        pass
    # 2) Predominant local pulse, peak-picked at the prior tempo scale.
    try:
        pulse = librosa.beat.plp(onset_envelope=onset, sr=sr, hop_length=hop,
                                 prior=prior_tempo if prior_tempo else None)
        distance = None
        if prior_tempo and np.isfinite(prior_tempo) and prior_tempo > 0:
            beat_frames_est = (60.0 / prior_tempo) * (sr / hop)
            distance = max(2, int(round(beat_frames_est * 0.6)))
        plp_peaks, _ = signal.find_peaks(
            pulse, distance=distance or max(2, int(round(sr / hop * 0.25))),
            prominence=float(np.percentile(pulse, 70)))
        if len(plp_peaks) >= 8:
            candidates.append(plp_peaks.astype(int))
    except Exception:
        pass
    # 3) Always-available peak fallback.
    fallback = _peak_beats(onset, sr, hop)
    if len(fallback) >= 8:
        candidates.append(fallback)
    if not candidates:
        # Degenerate: return whatever we have rather than failing outright.
        return fallback.astype(int)
    candidates.sort(key=_regularity_score, reverse=True)
    return np.unique(candidates[0]).astype(int)


def _refine_beats_to_transients(beat_frames: np.ndarray, onset: np.ndarray,
                                sr: int, hop: int, radius_ms: float = 35.0,
                                return_float: bool = False,
                                hold_without_peak: bool = False) -> np.ndarray:
    """Re-anchor each beat to its strongest nearby transient.

    Parabolic interpolation gives sub-frame precision. With integer frames
    (``return_float=False``) the correction is rounded back so downstream
    code stays frame-exact; with ``return_float=True`` the fractional part is
    kept — essential above ~200 BPM, where a single 5.8 ms frame already spans
    ~2 % of tempo and would make 225 vs 222 BPM sections flip-flop.
    ``radius_ms`` widens after subdivision inserts, whose interpolated
    positions can sit far from the true attack.

    ``hold_without_peak`` leaves a beat where it is when the loudest point in
    its window is on the window's edge: that is the tail or the rise of a
    neighbouring hit, not an attack of its own. Inserted beats need it -- on a
    bare click track at x2 they were dragged to the previous click's tail and
    120 BPM came out as 186.
    """
    if len(beat_frames) == 0 or len(onset) == 0:
        return np.asarray(beat_frames, dtype=float if return_float else int)
    radius = max(2, int(round(radius_ms / 1000.0 * sr / hop)))
    refined = []
    for frame in beat_frames:
        center = int(np.clip(round(frame), 0, len(onset) - 1))
        lo, hi = max(0, center - radius), min(len(onset), center + radius + 1)
        window = onset[lo:hi]
        if window.size == 0:
            refined.append(float(center))
            continue
        best = lo + int(np.argmax(window))
        if hold_without_peak and best in (lo, hi - 1):
            refined.append(float(frame))
            continue
        shift = 0.0
        if 0 < best < len(onset) - 1:
            a, b, c = float(onset[best - 1]), float(onset[best]), float(onset[best + 1])
            denom = (a - 2 * b + c)
            shift = 0.5 * (a - c) / denom if abs(denom) > 1e-9 else 0.0
            shift = float(np.clip(shift, -0.5, 0.5))
        refined.append(float(best) + shift)
    out = np.asarray(refined, dtype=float)
    if not return_float:
        out = np.unique(np.rint(out).astype(int))
        return out[out < len(onset)]
    out = out[(out >= 0) & (out < len(onset))]
    return np.unique(out)


# ---------------------------------------------------------------------------
# Tempo helpers
# ---------------------------------------------------------------------------

def _fill_missed_beats(frames: np.ndarray, max_fill: int = 8,
                       ratio: float = 1.7) -> np.ndarray:
    """Interpolate beats the tracker dropped (sparse breakdowns, soft bars).

    A gap is filled only when the tempo on *both* sides agrees (past and
    future medians within 25 %) and the gap is an integer multiple (up to
    ``max_fill`` + 1) of that tempo. This keeps abrupt 2× jumps intact — old
    gaps are never paved with new-tempo phantom beats — while isolated drops
    inside steady passages are rebuilt. Long holes and song edges are left
    alone; the grid restarts naturally after the break.
    Only lengthens gaps — tempo jumps (shorter intervals) never trigger it.
    """
    frames = np.asarray(np.sort(np.asarray(frames, dtype=float)))
    if len(frames) < 5:
        return frames
    gaps = np.diff(frames)
    out: list[float] = [float(frames[0])]
    for k, gap in enumerate(gaps):
        left, right = float(frames[k]), float(frames[k + 1])
        past, future = gaps[max(0, k - 6):k], gaps[k + 1:k + 7]
        count = 1
        if len(past) >= 2 and len(future) >= 2:
            past_med, fut_med = float(np.median(past)), float(np.median(future))
            if past_med > 0 and fut_med > 0:
                agree = min(past_med, fut_med) / max(past_med, fut_med)
                if agree >= 0.75:
                    ref = (past_med + fut_med) / 2.0
                    if gap / ref >= ratio:
                        multi = int(round(gap / ref))
                        if 2 <= multi <= max_fill + 1:
                            sub = gap / multi
                            if abs(sub - ref) / ref <= 0.35:
                                count = multi
        if count >= 2:
            step = (right - left) / count
            out.extend(left + step * s for s in range(1, count))
        out.append(right)
    return np.unique(np.asarray(out, dtype=float))


def _robust_local_bpms(beats: np.ndarray, radius: int = 3) -> np.ndarray:
    """Median of neighbouring beat intervals + MAD outlier rejection."""
    beats = np.asarray(beats, dtype=float)
    if beats.size < 2:
        return np.zeros(beats.size, dtype=float)
    intervals = np.diff(beats)
    raw = 60.0 / np.maximum(intervals, 1e-5)
    width = min(len(raw) if len(raw) % 2 else len(raw) - 1, radius * 2 + 1)
    smooth = median_filter(raw, size=max(1, width), mode="nearest")
    # Hampel-style clamp: single missed/doubled intervals snap back to the
    # local median instead of dragging it.
    mad = np.abs(raw - smooth)
    scale = float(np.median(mad)) if len(mad) else 0.0
    if scale > 1e-9:
        tol = np.maximum(6.0 * scale, smooth * 0.06)
        smooth = np.where(np.abs(raw - smooth) > tol, smooth, raw)
        smooth = median_filter(smooth, size=max(1, width), mode="nearest")
    # One output per beat; copy the last local tempo to its trailing beat.
    return np.append(smooth, smooth[-1])


def _global_tempo_guides(onset: np.ndarray, sr: int, hop: int,
                         frame_tempi: np.ndarray | None = None) -> list[tuple[float, float]]:
    """Return [(bpm, weight)] tempo hypotheses from a tempogram + tracker.

    Legacy (v2) path only; the v3 engine uses ``_tempo_hints`` instead.
    ``frame_tempi`` is the per-frame tempo when the caller has it already
    (see _tempo_readings).
    """
    guides: list[tuple[float, float]] = []
    try:
        # aggregate=None returns one estimate per frame (shape 2×T); collapse
        # across time with a median — never just read the first frames, which
        # cover the (often unrepresentative) song intro.
        if frame_tempi is None:
            frame_tempi = _tempo_readings(onset, sr, hop)[0]
        tempo_frames = np.atleast_2d(np.asarray(frame_tempi, dtype=float))
        for value in np.median(tempo_frames, axis=1):
            if 30 <= value <= 600 and np.isfinite(value):
                guides.append((float(value), 1.0))
    except Exception:
        pass
    try:
        tempogram = np.concatenate(list(_tempogram(onset, sr, hop, 384)), axis=-1)
        agg = np.mean(tempogram, axis=1)
        freqs = librosa.tempo_frequencies(len(agg), hop_length=hop, sr=sr)
        mask = (freqs >= 30) & (freqs <= 600)
        agg, freqs = agg[mask], freqs[mask]
        if agg.size:
            agg = agg / max(float(np.max(agg)), 1e-9)
            peaks, props = signal.find_peaks(agg, prominence=0.08, distance=4)
            order = np.argsort(props.get("prominences", np.zeros_like(peaks, dtype=float)))[::-1]
            for idx in order[:6]:
                guides.append((float(freqs[peaks[idx]]), float(agg[peaks[idx]])))
    except Exception:
        pass
    # Deduplicate near-identical hypotheses, keeping the strongest weight.
    merged: list[tuple[float, float]] = []
    for bpm, weight in sorted(guides, key=lambda t: -t[1]):
        if all(abs(bpm - kept) >= max(1.5, kept * 0.01) for kept, _ in merged):
            merged.append((bpm, weight))
    return merged[:8]


def _segment_tempi(beats: np.ndarray, bpms: np.ndarray, min_delta: float,
                   persistence: int) -> list[TimingPoint]:
    """Create stable tempo regions from beat-level estimates.

    A candidate must differ from the current region by ``min_delta`` and stay
    near its own median for ``persistence`` beats. One outlier per window is
    tolerated (second-largest deviation rules), so a single noisy beat can't
    veto a real change — or fabricate one. Confirmed starts are backtracked
    to the midpoint crossing so red lines land on the musical change, not
    ``persistence`` beats late.
    """
    if len(beats) == 0:
        return []
    points: list[TimingPoint] = []
    current = float(np.median(bpms[:min(len(bpms), persistence)]))

    def add(index: int, tempo: float, region: np.ndarray) -> None:
        spread = float(np.median(np.abs(region - np.median(region)))) if len(region) else 0.0
        steadiness = max(0.0, min(1.0, 1.0 - spread / max(tempo * 0.04, 0.5)))
        # Longer sections earn trust: a 4-beat wobble should rarely outrank a
        # 40-beat plateau even if both look steady.
        length_bonus = min(0.15, 0.15 * len(region) / max(persistence * 3, 1))
        confidence = max(0.0, min(1.0, steadiness * 0.9 + length_bonus))
        points.append(TimingPoint(float(beats[index] * 1000), float(tempo), confidence, index))

    def backtrack(from_index: int, region_start: int, old: float, new: float) -> int:
        """Walk back to where the curve crossed the old/new midpoint."""
        mid = (old + new) / 2.0
        j = from_index - 1
        limit = max(region_start, from_index - 2 * persistence)
        if new > old:
            while j > limit and bpms[j] >= mid:
                j -= 1
        else:
            while j > limit and bpms[j] <= mid:
                j -= 1
        return j + 1

    add(0, current, bpms[:persistence])
    region_start = 0
    i = persistence
    while i < len(bpms):
        window = bpms[i:min(i + persistence, len(bpms))]
        candidate = float(np.median(window))
        tol = max(min_delta, candidate * 0.012)
        # Tolerate a single outlier: the second-largest deviation decides.
        devs = np.sort(np.abs(window - candidate))
        steady = len(window) >= persistence and (devs[-2] if len(devs) > 1 else devs[-1]) < tol
        if steady and abs(candidate - current) >= min_delta:
            # Confirm it is a meaningful, sustained new tempo.
            start = backtrack(i, region_start, current, candidate)
            add(start, candidate, bpms[start:min(start + persistence, len(bpms))])
            region_start, current = start, candidate
            i += persistence
        else:
            i += 1

    # Refine each displayed BPM using its complete assigned region.
    refined: list[TimingPoint] = []
    for n, point in enumerate(points):
        end = points[n + 1].beat_index if n + 1 < len(points) else len(bpms)
        region = bpms[point.beat_index:end]
        tempo = float(np.median(region)) if len(region) else point.bpm
        spread = float(np.median(np.abs(region - tempo))) if len(region) else 0.0
        steadiness = max(0.0, min(1.0, 1.0 - spread / max(tempo * 0.04, 0.5)))
        length_bonus = min(0.15, 0.15 * len(region) / max(persistence * 3, 1))
        confidence = max(0.0, min(1.0, steadiness * 0.9 + length_bonus))
        refined.append(TimingPoint(point.offset_ms, tempo, confidence, point.beat_index))
    # Refinement can make two initially distinct noisy regions converge. Do
    # not export a red line unless its final BPM still clears the filter.
    final = [refined[0]]
    for point in refined[1:]:
        if abs(point.bpm - final[-1].bpm) >= min_delta:
            final.append(point)
    return final


def _subdivision_support(onset: np.ndarray, beat_frames: np.ndarray, factor: int) -> float:
    """Measure whether attacks exist at the proposed grid positions."""
    if factor == 1:
        positions = beat_frames.astype(float)
    else:
        # Score only *new* positions. Including the already-detected beats
        # would make an empty half-time grid look strong by construction.
        positions = np.concatenate([np.linspace(a, b, factor, endpoint=False)[1:]
                                    for a, b in zip(beat_frames[:-1], beat_frames[1:])])
    values = []
    for index in np.rint(positions).astype(int):
        values.append(float(np.max(onset[max(0, index - 2):min(len(onset), index + 3)])))
    return float(np.median(values)) if values else 0.0


def _guide_weight_at(tempo_guides: list[tuple[float, float]] | None, bpm: float,
                     tol: float = 0.03) -> float:
    """Strongest tempogram-hypothesis weight within ``tol`` of ``bpm``."""
    if not tempo_guides:
        return 0.0
    best = 0.0
    for tempo_hint, weight in tempo_guides:
        for mult in (0.5, 1.0, 2.0):
            if abs(tempo_hint * mult - bpm) <= max(1.5, bpm * tol):
                best = max(best, float(weight))
    return best


def _choose_subdivision(onset: np.ndarray, beat_frames: np.ndarray,
                        prefer_map_bpm: bool,
                        tempo_guides: list[tuple[float, float]] | None = None) -> int:
    """Resolve half/double-time with onset evidence, not blind multiplication.

    Why this is lenient when the base pulse sits *outside* the 120–300 map
    range: a tracker that locks onto 112 BPM when the song is really 224 BPM
    halves every later section gap too (112.5 vs 111.1 differs by only
    ~1.4 BPM < min_delta), collapsing the whole map into one "constant"
    section. So an out-of-range base only needs moderate in-between attack
    evidence to double, while an in-range base still needs strong evidence.

    It only ever keeps the tracked pulse or doubles / quadruples it. A lock
    above 300 BPM is kept as it is; nothing here halves it, so ÷2 is the way
    back from a double-time read.
    """
    if len(beat_frames) < 4:
        return 1
    frame_rate = TARGET_SR / HOP
    base_bpm = 60.0 / max(float(np.median(np.diff(beat_frames.astype(float)))), 1e-6) * frame_rate
    base_support = max(_subdivision_support(onset, beat_frames, 1), 1e-9)
    base_in_map = 120 <= base_bpm <= 300
    # A base pulse outside the map range starts disfavoured: doubling out of
    # it should be easy, staying on it should require the doubled grid to
    # genuinely lack attacks.
    best_factor, best_score = 1, 1.0 if base_in_map else 0.72
    for factor in (2, 4):
        bpm = base_bpm * factor
        if not 30 <= bpm <= 600:
            continue
        support_ratio = _subdivision_support(onset, beat_frames, factor) / base_support
        guide_boost = 0.15 * min(_guide_weight_at(tempo_guides, bpm), 1.0)
        in_map = 120 <= bpm <= 300
        if prefer_map_bpm and not base_in_map and in_map:
            range_bonus, need = 0.45, 0.30
        elif prefer_map_bpm and in_map:
            range_bonus, need = 0.22, 0.42
        else:
            range_bonus, need = 0.0, 0.50
        need -= 0.10 * min(_guide_weight_at(tempo_guides, bpm), 1.0)
        score = support_ratio + range_bonus + guide_boost
        if support_ratio >= need and score > best_score:
            best_factor, best_score = factor, score
    return best_factor


def _insert_subdivisions(frames: np.ndarray, factor: int) -> np.ndarray:
    """Split each beat step into ``factor`` even sub-steps (float frames).

    Kept in float so sub-frame transient corrections survive: rounding here
    would re-impose ±1-frame tempo quantization (~±2 % at 225 BPM).
    """
    frames = np.asarray(frames, dtype=float)
    if factor == 1:
        return frames
    pieces = [np.linspace(a, b, factor, endpoint=False) for a, b in zip(frames[:-1], frames[1:])]
    return np.append(np.concatenate(pieces), frames[-1])


def _resubdivide(frames: np.ndarray, subdivision: float) -> np.ndarray:
    """Beats at ``subdivision`` times the tracked rate.

    1, 2, 4 split each tracked step evenly (_insert_subdivisions). 0.5 and 0.25
    keep every 2nd / 4th tracked beat from the first, as the precision grid
    does when it is halved. Not the more accented phase: the onset envelope
    favours the snare, and on a 170 BPM kit that put the halved grid on the
    backbeat (see HALF_BAR_CONTRAST).
    """
    frames = np.asarray(frames, dtype=float)
    if subdivision >= 1:
        return _insert_subdivisions(frames, int(subdivision))
    return frames[::int(round(1.0 / subdivision))]


def _trim_leading_silence(beat_frames: np.ndarray, onset: np.ndarray) -> np.ndarray:
    """Drop beats extrapolated into leading silence before the music starts.

    The DP tracker emits a grid from frame 0 even when the song fades in
    later; without trimming, the first red line lands at 0 ms instead of on
    the first real attack. Only beats *before* the first loud transient with
    no local onset support are removed, so soft intros keep their grid.
    """
    frames = np.asarray(beat_frames, dtype=float)
    if len(frames) < 2 or len(onset) < 8:
        return frames
    ceiling = float(np.max(onset))
    if ceiling <= 1e-9:
        return frames
    loud = np.flatnonzero(onset >= ceiling * 0.25)
    if loud.size == 0:
        return frames
    first_sound = float(loud[0])

    def support(frame: float) -> float:
        center = int(np.clip(round(frame), 0, len(onset) - 1))
        lo, hi = max(0, center - 2), min(len(onset), center + 3)
        return float(np.max(onset[lo:hi]))

    i = 0
    while (i < len(frames) and frames[i] < first_sound
           and support(frames[i]) < ceiling * 0.12 and i < 8):
        i += 1
    trimmed = frames[i:]
    return trimmed if len(trimmed) >= 2 else frames


def _guess_meter(beats: np.ndarray, onset: np.ndarray, sr: int, hop: int) -> str:
    """Cheap 3/4 vs 4/4 guess from accent periodicity at bar multiples."""
    try:
        if len(beats) < 16:
            return "4/4"
        frame_rate = sr / hop
        beat_frames = np.rint(beats * frame_rate).astype(int)
        beat_frames = beat_frames[(beat_frames >= 0) & (beat_frames < len(onset))]
        strengths = np.array([float(np.max(onset[max(0, f - 2):f + 3])) for f in beat_frames])
        if strengths.size < 16 or float(np.std(strengths)) < 1e-9:
            return "4/4"
        scores = {}
        for period in (3, 4, 6):
            if len(strengths) < period * 3:
                continue
            trimmed = strengths[:len(strengths) - len(strengths) % period].reshape(-1, period)
            accents = trimmed[:, 0].mean()
            others = trimmed[:, 1:].mean()
            scores[period] = accents / max(others, 1e-9)
        if not scores:
            return "4/4"
        best = max(scores, key=lambda k: scores[k])
        if scores[best] < 1.08:
            return "4/4"
        return {3: "3/4", 4: "4/4", 6: "6/8"}[best]
    except Exception:
        return "4/4"


def _stability(local: np.ndarray) -> float:
    if len(local) < 2:
        return 0.0
    med = float(np.median(local))
    mad = float(np.median(np.abs(local - med)))
    return float(max(0.0, min(1.0, 1.0 - (mad / max(med * 0.03, 0.4)))))


# ---------------------------------------------------------------------------
# Precision grid engine (v3)
# ---------------------------------------------------------------------------
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
MAX_CONFIG_BYTES = 256 * 1024
MAX_CLICK_SECONDS = 1800.0
BEAT_MULTIPLES = (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16)


@dataclass(frozen=True)
class GridSection:
    """One constant-tempo region, fitted as offset + k*period."""
    start_s: float
    end_s: float
    period: float          # seconds per beat
    phase: float           # time of beat index 0 (may sit before start_s)
    inliers: int
    residual_ms: float     # RMS distance from attacks to the grid
    coverage: float        # fraction of grid positions that carry an attack

    @property
    def bpm(self) -> float:
        return 60.0 / self.period if self.period > 0 else 0.0


# -- attack detection --------------------------------------------------------

def _pick_onsets(env: np.ndarray, sr: int, hop: int) -> tuple[np.ndarray, np.ndarray]:
    """Peak-pick the envelope with parabolic (sub-frame) interpolation."""
    if env.size < 8:
        return np.zeros(0), np.zeros(0)
    distance = max(1, int(round(0.025 * sr / hop)))
    floor = max(0.04, float(np.percentile(env, 55)))
    peaks, _ = signal.find_peaks(env, distance=distance, prominence=0.05, height=floor)
    if peaks.size == 0:
        peaks, _ = signal.find_peaks(env, distance=distance)
    if peaks.size == 0:
        return np.zeros(0), np.zeros(0)
    frames = peaks.astype(float)
    inner = (peaks > 0) & (peaks < env.size - 1)
    a = env[peaks[inner] - 1].astype(float)
    b = env[peaks[inner]].astype(float)
    c = env[peaks[inner] + 1].astype(float)
    denom = a - 2 * b + c
    shift = np.where(np.abs(denom) > 1e-9, 0.5 * (a - c) / np.where(denom == 0, 1, denom), 0.0)
    frames[inner] += np.clip(shift, -0.5, 0.5)
    return frames * hop / sr, env[peaks].astype(float)


def _retime_onsets(y: np.ndarray, sr: int, times: np.ndarray,
                   back_s: float = 0.030, ahead_s: float = 0.012) -> np.ndarray:
    """Re-time each attack on the raw waveform, at sample resolution.

    A spectral-flux peak is reported roughly one analysis window *after* the
    physical attack (~8 ms with a 1024-sample window). Since every attack is
    delayed by about the same amount the tempo survives, but the offset does
    not — and an offset 8 ms late is audible in the osu! editor. So each
    coarse time is refined by looking at the local energy rise in the raw
    signal and taking the point where it crosses 20 % of that rise.
    """
    if times.size == 0 or y.size == 0:
        return times
    win = max(8, int(round(0.0015 * sr)))       # 1.5 ms energy window
    back = int(round(back_s * sr))
    ahead = int(round(ahead_s * sr))
    out = np.array(times, dtype=np.float64)
    for i, t in enumerate(times):
        centre = int(round(t * sr))
        lo = max(0, centre - back)
        hi = min(y.size, centre + ahead)
        if hi - lo < win * 3:
            continue
        seg = y[lo:hi].astype(np.float64)
        power = np.cumsum(seg * seg)
        # Energy inside the window ending at each sample; the rise starts when
        # the window's trailing edge reaches the attack.
        energy = np.sqrt(np.maximum(power[win:] - power[:-win], 0.0))
        if energy.size < 4:
            continue
        top = int(np.argmax(energy))
        if top == 0:
            continue
        base = float(np.min(energy[:top + 1]))
        peak = float(energy[top])
        if peak <= base * 1.6 or peak <= 1e-7:
            continue                              # no clear attack: keep the envelope time
        level = base + 0.20 * (peak - base)
        below = np.flatnonzero(energy[:top + 1] <= level)
        if below.size == 0:
            continue
        j = int(below[-1])
        if j >= top:
            continue
        span = energy[j + 1] - energy[j]
        frac = (level - energy[j]) / span if span > 1e-12 else 0.0
        refined = (lo + j + float(np.clip(frac, 0.0, 1.0)) + win) / sr
        if abs(refined - t) <= back_s:
            out[i] = refined
    return out


def _detect_attacks(y: np.ndarray, sr: int, hop: int = FIT_HOP,
                    retime: bool = True) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (times, weights, envelope) for every detected attack."""
    env = _onset_envelope(y, sr, hop)
    times, weights = _pick_onsets(env, sr, hop)
    if retime and times.size:
        times = _retime_onsets(y, sr, times)
        order = np.argsort(times)
        times, weights = times[order], weights[order]
        # Sub-sample retiming can collide two neighbours; keep the earlier of
        # any pair within 4 ms, whatever the weights (the Rust port matches).
        if times.size > 1:
            keep = np.r_[True, np.diff(times) > 0.004]
            times, weights = times[keep], weights[keep]
    return times, weights, env


# -- circular coherence ------------------------------------------------------

def _coherence_curve(times: np.ndarray, weights: np.ndarray,
                     freqs: np.ndarray, block: int = 512) -> np.ndarray:
    """R(f) = |Σ w·exp(2πi f t)| / Σ w  — phase agreement at pulse rate f."""
    total = float(np.sum(weights))
    if total <= 0 or times.size == 0:
        return np.zeros(freqs.size)
    out = np.empty(freqs.size, dtype=np.float64)
    t = times.astype(np.float64)
    w = weights.astype(np.float64)
    for start in range(0, freqs.size, block):
        chunk = freqs[start:start + block]
        angle = 2.0 * np.pi * np.outer(t, chunk)
        out[start:start + chunk.size] = np.hypot(w @ np.cos(angle), w @ np.sin(angle))
    return out / total


def _atomic_grid_candidates(times: np.ndarray, weights: np.ndarray,
                            period_range: tuple[float, float] = (0.055, 1.35),
                            keep: int = 10) -> list[tuple[float, float, float]]:
    """Candidate atomic pulses as [(period, phase, coherence)], shortest period first.

    ``R`` is high at the atomic pulse *and at every multiple of it*, and low at
    sub-multiples — so the fundamental is the slowest strong peak, which is
    exactly what we want to hand to the least-squares stage. The ``keep``
    slowest strong peaks are kept, each joined by its 2-4x multiples (up to
    1.6 times the range's slowest period), and the whole list is sorted by
    ascending period: fastest first, so ``[0]`` is not the fundamental.
    """
    if times.size < 8:
        return []
    if times.size > MAX_SCAN_ONSETS:        # bound the scan on very dense audio
        # Must not be called `keep`: that is the parameter naming how many
        # candidates to return, and rebinding it here made the final
        # `strong[:keep]` slice raise TypeError on dense tracks.
        dense = np.sort(np.argsort(weights)[-MAX_SCAN_ONSETS:])
        times, weights = times[dense], weights[dense]
    span = float(times[-1] - times[0])
    if span <= 1.0:
        return []
    lo_f, hi_f = 1.0 / period_range[1], 1.0 / period_range[0]
    step = 0.2 / span                      # keeps the coherence lobe resolvable
    freqs = np.arange(lo_f, hi_f, max(step, 1e-4))
    if freqs.size < 4:
        return []
    if freqs.size > MAX_SCAN_FREQS:
        # Only reachable if someone widens the seed windows; the sweep cost is
        # onsets x frequencies, so cap it rather than stall on a long window.
        freqs = np.linspace(lo_f, hi_f, MAX_SCAN_FREQS)
    curve = _coherence_curve(times, weights, freqs)
    peaks, _ = signal.find_peaks(curve, distance=2)
    if peaks.size == 0:
        peaks = np.array([int(np.argmax(curve))])
    best = float(np.max(curve[peaks]))
    if best <= 1e-6:
        return []
    strong = peaks[curve[peaks] >= 0.55 * best]
    strong = strong[np.argsort(freqs[strong])][:keep]
    out: list[tuple[float, float, float]] = []
    total = float(np.sum(weights))
    for idx in strong:
        f = float(freqs[idx])
        angle = 2.0 * np.pi * f * times
        c = float(weights @ np.cos(angle))
        s = float(weights @ np.sin(angle))
        # z = Σ w·e^{2πi f t} has arg(z) = 2π f φ, so φ = arg(z)/(2πf).
        phase = float(np.arctan2(s, c) / (2.0 * np.pi * f))
        out.append((1.0 / f, phase % (1.0 / f), float(curve[idx] if total else 0.0)))
    # A real grid is often also visible one or two octaves *down*; the slower
    # reading is the safer atom (it still contains every attack) and it keeps
    # swung or shuffled music, which has no clean sub-beat grid, fittable.
    widened: list[tuple[float, float, float]] = []
    for period, phase, coherence in out:
        for multiple in (1, 2, 3, 4):
            slower = period * multiple
            if slower > period_range[1] * 1.6:
                continue
            if all(abs(slower - kept) > 0.004 for kept, _p, _c in widened):
                widened.append((slower, phase % slower, coherence))
    widened.sort(key=lambda item: item[0])
    return widened


# -- least squares -----------------------------------------------------------

def _ls_fit(times: np.ndarray, weights: np.ndarray, period: float, phase: float,
            tol_s: float) -> tuple[float, float, np.ndarray] | None:
    """One weighted least-squares pass of t ≈ phase + k·period."""
    if times.size < 4 or period <= 0:
        return None
    k = np.round((times - phase) / period)
    inlier = np.abs(times - (phase + k * period)) <= tol_s
    if int(inlier.sum()) < 4:
        return None
    x, t, w = k[inlier], times[inlier], weights[inlier]
    if float(np.ptp(x)) < 2:
        return None
    sw = float(np.sum(w))
    xm, tm = float(w @ x) / sw, float(w @ t) / sw
    dx = x - xm
    sxx = float(w @ (dx * dx))
    if sxx <= 1e-12:
        return None
    new_period = float((w @ (dx * (t - tm))) / sxx)
    if not np.isfinite(new_period) or new_period <= 0:
        return None
    if not 0.5 * period <= new_period <= 2.0 * period:
        return None
    return new_period, float(tm - new_period * xm), inlier


def _recentre_phase(times: np.ndarray, weights: np.ndarray, period: float,
                    phase: float, sigma: float | None = None) -> float:
    """Snap the phase onto the *densest* residual cluster, not their average.

    Least squares balances everything inside its tolerance window, so a second
    population of attacks — swung off-beats, ghost notes, flams — drags the
    grid halfway towards them and the offset lands milliseconds late. Scoring
    candidate shifts with a narrow Gaussian kernel finds the mode instead of
    the mean, which is what the ear actually locks onto.
    """
    if times.size < 4 or period <= 0:
        return phase
    width = sigma if sigma is not None else min(0.012, 0.06 * period)
    if times.size > MAX_SCAN_ONSETS:
        # The kernel scan is onsets x shifts; the mode does not need every
        # attack, so score it on the strongest ones.
        keep = np.sort(np.argsort(weights)[-MAX_SCAN_ONSETS:])
        times, weights = times[keep], weights[keep]
    residual = np.mod(times - phase + 0.5 * period, period) - 0.5 * period
    shifts = np.linspace(-0.5 * period, 0.5 * period, 401)
    scaled = (residual[:, None] - shifts[None, :]) / width
    score = weights @ np.exp(-0.5 * np.clip(scaled * scaled, 0.0, 60.0))
    return float(phase + shifts[int(np.argmax(score))])


def _refine_grid(times: np.ndarray, weights: np.ndarray, period: float, phase: float,
                 tolerances=(0.30, 0.18, 0.10, 0.06, 0.04)) -> tuple[float, float, np.ndarray]:
    """Iteratively tighten the fit; each pass discards attacks off the grid."""
    inlier = np.ones(times.size, dtype=bool)
    for n, ratio in enumerate(tolerances):
        if n == 2:
            # Re-centre once the period is trustworthy but before the tolerance
            # gets narrow enough to lock a biased phase in place.
            phase = _recentre_phase(times, weights, period, phase)
        fit = _ls_fit(times, weights, period, phase, max(ratio * period, 0.006))
        if fit is None:
            break
        period, phase, inlier = fit
    return period, phase, inlier


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


def _pulse_log10p(times: np.ndarray, period: float, phase: float,
                  tol_ratio: float = 0.12) -> float:
    """log10 of the chance that uniformly random attack times land this many
    inliers on the grid (a binomial tail with p = 2*tol/period)."""
    n = int(times.size)
    if n == 0 or period <= 0:
        return 0.0
    tol = max(tol_ratio * period, 0.006)
    chance = min(1.0, 2.0 * tol / period)
    k = np.round((times - phase) / period)
    inliers = int(np.sum(np.abs(times - (phase + k * period)) <= tol))
    if inliers == 0 or chance >= 1.0:
        return 0.0
    from scipy.stats import binom
    return float(binom.logsf(inliers - 1, n, chance) / np.log(10.0))


def _grid_quality(times: np.ndarray, weights: np.ndarray, period: float,
                  phase: float, tol_ratio: float = 0.12) -> tuple[float, float, float]:
    """(inlier fraction, coverage of grid positions, RMS residual in ms)."""
    if times.size == 0 or period <= 0:
        return 0.0, 0.0, 999.0
    k = np.round((times - phase) / period)
    resid = times - (phase + k * period)
    tol = max(tol_ratio * period, 0.006)
    inlier = np.abs(resid) <= tol
    n = int(inlier.sum())
    if n == 0:
        return 0.0, 0.0, 999.0
    share = float(np.sum(weights[inlier]) / max(float(np.sum(weights)), 1e-9))
    slots = float(np.ptp(k[inlier])) + 1.0
    coverage = min(1.0, len(np.unique(k[inlier])) / max(slots, 1.0))
    rms = float(np.sqrt(np.mean(resid[inlier] ** 2)) * 1000.0)
    return share, coverage, rms


def _expand_fit(times: np.ndarray, weights: np.ndarray, period: float, phase: float,
                start: float, stop: float) -> tuple[float, float]:
    """Grow the fit outward in doubling spans so beat indices never slip."""
    centre = 0.5 * (start + stop)
    span = 12.0
    while True:
        lo, hi = max(start, centre - span), min(stop, centre + span)
        window = (times >= lo) & (times <= hi)
        if int(window.sum()) >= 8:
            period, phase, _ = _refine_grid(times[window], weights[window], period, phase)
        if lo <= start and hi >= stop:
            break
        span *= 2.0
    return period, phase


# -- octave / beat level -----------------------------------------------------

def _tempo_hints(env: np.ndarray, sr: int, hop: int,
                 decimate: int = 4) -> list[tuple[float, float]]:
    """Perceptual tempo hypotheses, used *only* to choose the octave.

    The grid fit already knows the pulse to six decimals; what it cannot know
    is which multiple of it a human calls "the beat". That is what a tempogram
    read through librosa's log-normal prior around 120 BPM answers. It is run
    on a max-pooled envelope (≈12 ms frames) because a tempo hint needs no more
    resolution than that, and the full-rate tempogram costs ~10 s per track.
    """
    hints: list[tuple[float, float]] = []
    try:
        usable = (env.size // decimate) * decimate
        coarse = env[:usable].reshape(-1, decimate).max(axis=1) if usable else env
        step = hop * decimate
        gram = librosa.feature.tempogram(onset_envelope=coarse.astype(np.float32), sr=sr,
                                         hop_length=step, win_length=192)
        agg = np.mean(gram, axis=1)
        freqs = librosa.tempo_frequencies(len(agg), hop_length=step, sr=sr)
        mask = np.isfinite(freqs) & (freqs >= 40) & (freqs <= 420)
        agg, freqs = agg[mask], freqs[mask]
        if agg.size:
            agg = np.maximum(agg, 0.0)
            agg = agg / max(float(np.max(agg)), 1e-9)
            # librosa's tempo prior: log-normal in log2 space, centred on 120.
            prior = np.exp(-0.5 * (np.log2(freqs / 120.0) / 1.0) ** 2)
            peaks, props = signal.find_peaks(agg, prominence=0.05, distance=3)
            if peaks.size:
                weighted = agg[peaks] * prior[peaks]
                best = int(peaks[int(np.argmax(weighted))])
                hints.append((float(freqs[best]), 1.0))
                order = np.argsort(props.get("prominences", np.zeros(peaks.size)))[::-1]
                for idx in order[:5]:
                    hints.append((float(freqs[peaks[idx]]), float(agg[peaks[idx]])))
    except Exception:
        pass
    return hints


def _hint_score(hints: list[tuple[float, float]], bpm: float) -> float:
    """Gaussian agreement in log2-tempo space (2× away scores ≈ 0)."""
    best = 0.0
    for hint, weight in hints:
        if hint <= 0:
            continue
        distance = abs(np.log2(bpm / hint))
        best = max(best, float(weight) * float(np.exp(-(distance ** 2) / (2 * 0.35 ** 2))))
    return best


def _beat_from_atoms(times: np.ndarray, weights: np.ndarray, period: float, phase: float,
                     hints: list[tuple[float, float]], prefer_map_bpm: bool) -> tuple[int, int]:
    """Choose (atoms per beat, phase class) from accent pattern + tempo hints.

    Attacks are grouped by their atom index modulo ``m``. If ``m`` atoms really
    make a beat, one class holds the kicks/snares and the others the filler, so
    its mean strength stands out. The tempo hints resolve the remaining
    ambiguity between "beat" and "half-bar", which accents alone cannot.
    """
    k = np.round((times - phase) / period)
    inlier = np.abs(times - (phase + k * period)) <= 0.15 * period
    if int(inlier.sum()) < 8:
        return 1, 0
    k = k[inlier].astype(np.int64)
    w = weights[inlier].astype(float)
    best = (1, 0, -1e9)
    for m in BEAT_MULTIPLES:
        bpm = 60.0 / (period * m)
        if not 55.0 <= bpm <= 420.0:
            continue
        cls = np.mod(k, m)
        totals = np.bincount(cls, weights=w, minlength=m)
        counts = np.bincount(cls, minlength=m)
        if m > 1 and int(np.min(counts)) == 0:
            means = np.where(counts > 0, totals / np.maximum(counts, 1), 0.0)
        else:
            means = totals / np.maximum(counts, 1)
        r = int(np.argmax(means))
        # Accent depth, not a ratio to the mean: if m atoms really make a beat
        # one class holds the kicks and another the filler, so the spread
        # between the strongest and weakest class is large. m = 1 scores 0 by
        # construction, which is right — an unsubdivided atom shows no accent.
        depth = float((means[r] - float(np.min(means))) / max(means[r], 1e-9))
        beats = (float(np.ptp(k)) / m) + 1.0
        coverage = min(1.0, counts[r] / max(beats, 1.0))
        in_range = 120.0 <= bpm <= 300.0
        score = (0.95 * _hint_score(hints, bpm)
                 + 0.85 * min(depth / 0.35, 1.0)
                 + 0.70 * coverage
                 # osu! is mapped at 120-300 BPM; when the accent evidence is
                 # equally happy either way this is what breaks the tie.
                 + (0.40 if (prefer_map_bpm and in_range) else 0.0)
                 - 0.45 * max(0.0, float(np.log2(90.0 / bpm)))
                 - 0.45 * max(0.0, float(np.log2(bpm / 340.0))))
        if score > best[2]:
            best = (m, r, score)
    return best[0], best[1]


#: A 4-beat bar's downbeat must also out-weigh the beat half a bar away. The
#: onset envelope favours broadband hits, so a snare on 2 and 4 -- or, read at
#: double tempo, on every other "beat" -- can out-weigh the kick on 1, and a
#: pattern that repeats every half bar says nothing about which half starts
#: the bar. Measured against 88 ranked maps: of the 21 bars claimed, only 5 sat
#: on the map's downbeat, and the 9 below 1.25 all missed (7 of them one beat
#: early, on the backbeat before the 1); the synthetic fixtures with a real
#: accent score 1.29 and 1.55.
HALF_BAR_CONTRAST = 1.25


def _meter_from_grid(times: np.ndarray, weights: np.ndarray, period: float,
                     phase: float) -> tuple[str, int, int]:
    """Guess the meter, the downbeat class, and how many beats to snap to.

    The third value is the bar length only when the accents actually prove one;
    otherwise it is 1, meaning "align the first red line to a beat, not a bar".
    Guessing a bar without evidence would push the first offset up to three
    beats past the first sound.
    """
    k = np.round((times - phase) / period)
    inlier = np.abs(times - (phase + k * period)) <= 0.15 * period
    if int(inlier.sum()) < 12:
        return "4/4", 0, 1
    k = k[inlier].astype(np.int64)
    w = weights[inlier].astype(float)
    best_meter, best_class, best_contrast = 4, 0, 0.0
    best_means = np.ones(4)
    for meter in (4, 3):
        if float(np.ptp(k)) < meter * 4:
            continue
        cls = np.mod(k, meter)
        totals = np.bincount(cls, weights=w, minlength=meter)
        counts = np.bincount(cls, minlength=meter)
        means = totals / np.maximum(counts, 1)
        r = int(np.argmax(means))
        contrast = float(means[r] / max(float(np.mean(means)), 1e-9))
        if contrast > best_contrast:
            best_meter, best_class, best_contrast, best_means = meter, r, contrast, means
    if best_contrast < 1.20:
        return "4/4", 0, 1                    # no usable accent: do not move the offset
    if best_meter % 2 == 0:
        opposite = best_means[(best_class + best_meter // 2) % best_meter]
        if best_means[best_class] < HALF_BAR_CONTRAST * opposite:
            return "4/4", 0, 1                # the accent repeats every half bar
    return ("4/4" if best_meter == 4 else "3/4"), best_class, best_meter


# -- section growing ---------------------------------------------------------

def _seed_grid(times: np.ndarray, weights: np.ndarray, lo: float, hi: float,
               prior_period: float | None = None,
               widths: tuple[float, ...] = (30.0, 16.0, 9.0)) -> tuple[float, float] | None:
    """Fit an atomic grid on the window starting at ``lo``.

    Each tempo region seeds itself instead of inheriting the previous fit: a
    period carried across a 128 → 142 BPM change assigns the wrong beat indices
    on the far side, and least squares cannot recover from a slipped index. The
    window shrinks until a grid actually locks, so a short region still gets a
    seed. ``prior_period`` keeps consecutive regions on the same octave — real
    tempo changes are small, octave flips are artefacts.

    Candidates are ranked by ``share × coverage``: *share* is the fraction of
    attack energy the grid explains (a grid twice too slow drops to a half),
    *coverage* is the fraction of its own slots that carry an attack (a grid
    twice too fast drops to a half). Only the true atom scores well on both.
    """
    best_pool: list[tuple[float, float, float]] = []
    best_score = 0.0
    for width in widths:
        span = min(width, hi - lo)
        if span < 4.0:
            continue
        window = (times >= lo) & (times <= lo + span)
        w_times, w_weights = times[window], weights[window]
        if w_times.size < 10:
            continue
        pool: list[tuple[float, float, float]] = []
        for period, phase, _coherence in _atomic_grid_candidates(w_times, w_weights):
            fitted, fit_phase, _inlier = _refine_grid(w_times, w_weights, period, phase)
            share, coverage, rms = _grid_quality(w_times, w_weights, fitted, fit_phase)
            if rms > 0.09 * fitted * 1000.0:
                continue
            pool.append((fitted, fit_phase, share * (0.25 + 0.75 * coverage)))
        if not pool:
            continue
        top = max(item[2] for item in pool)
        if top > best_score:
            best_pool, best_score = pool, top
        if top >= 0.45:
            break                       # a real grid locked; no need to shrink
    if not best_pool:
        return None
    # Near-ties go to the slowest grid (it is the fundamental, and it keeps the
    # beat reachable); with a prior, to whichever stays on the same octave.
    near = [item for item in best_pool if item[2] >= 0.92 * best_score]
    if prior_period and prior_period > 0:
        near.sort(key=lambda item: (round(abs(np.log2(item[0] / prior_period)), 2), -item[0]))
    else:
        near.sort(key=lambda item: -item[0])
    return near[0][0], near[0][1]


def _grow_sections(times: np.ndarray, weights: np.ndarray, period: float, phase: float,
                   min_delta: float, persistence: int,
                   seed_s: float = 8.0, step_s: float = 2.0) -> list[GridSection]:
    """Grow constant-tempo regions forward while attacks keep landing on the grid.

    Extending stops when a fresh chunk stops fitting — roughly where the tempo
    changed. The next region then runs its *own* coherence scan (see
    ``_seed_grid``) rather than inheriting the period that just failed, which
    is what lets an abrupt 128 → 142 switch be caught instead of averaged away.
    The rough boundary is refined afterwards by ``_settle_boundaries``.
    """
    if times.size < 8:
        return []
    sections: list[GridSection] = []
    start = float(times[0])
    finish = float(times[-1])
    prior = period
    guard = 0
    # Every counted pass ends at or past its seed window, so it moves start on
    # by seed_s or to the end: the track needs at most this many, and the guard
    # only backs that up. A fixed 64 stopped a 15-minute mix that changes tempo
    # every 9 s at 576 s and left the rest with no section and no red line.
    limit = max(64, int(np.ceil((finish - start) / seed_s)) + 2)
    while start < finish - 1.0 and guard < limit:
        guard += 1
        seed_hi = min(finish, start + max(seed_s, 12 * prior))
        # Short seed windows on purpose: a long one straddles the very tempo
        # change we are looking for. Growth extends a good seed anyway.
        fresh = _seed_grid(times, weights, start, seed_hi, prior_period=prior,
                           widths=(12.0, 7.0, 4.5))
        if fresh is not None:
            local_period, local_phase = fresh
        else:
            seed = (times >= start - 0.5 * prior) & (times <= seed_hi)
            if int(seed.sum()) < 6:
                # Too few attacks to seed from here -- a lone click, a count-in,
                # a quiet intro. Move on to the next attack instead of giving up
                # on the whole track: one click at 0.3 s before drums at 8 s used
                # to leave no section at all. Skips do not count against the
                # guard; start only moves forward through a finite list.
                later = times[times > start]
                if later.size == 0:
                    break
                start = float(later[0])
                guard -= 1
                continue
            local_period, local_phase, _ = _refine_grid(times[seed], weights[seed], prior, phase)
        edge = seed_hi
        while edge < finish:
            nxt = min(finish, edge + max(step_s, 4 * local_period))
            chunk = (times > edge) & (times <= nxt)
            if int(chunk.sum()) < 3:
                edge = nxt
                continue
            share, _cov, rms = _grid_quality(times[chunk], weights[chunk],
                                             local_period, local_phase, tol_ratio=0.11)
            if share < 0.55 or rms > 0.09 * local_period * 1000.0:
                break
            whole = (times >= start - 0.5 * local_period) & (times <= nxt)
            local_period, local_phase, _ = _refine_grid(times[whole], weights[whole],
                                                        local_period, local_phase)
            edge = nxt
        end = edge
        window = (times >= start - 0.5 * local_period) & (times <= end)
        local_period, local_phase, inlier = _refine_grid(times[window], weights[window],
                                                         local_period, local_phase)
        share, coverage, rms = _grid_quality(times[window], weights[window],
                                             local_period, local_phase)
        sections.append(GridSection(start, end, local_period, local_phase,
                                    int(inlier.sum()), rms, coverage))
        prior, phase = local_period, local_phase
        if end <= start + 1e-6:
            break
        start = end
    return _merge_sections(times, weights, sections, min_delta, persistence)


def _merge_sections(times: np.ndarray, weights: np.ndarray, sections: list[GridSection],
                    min_delta: float, persistence: int) -> list[GridSection]:
    """Fuse neighbours that share a tempo, drop regions too short to trust."""
    if not sections:
        return []
    merged: list[GridSection] = [sections[0]]
    for section in sections[1:]:
        previous = merged[-1]
        same = abs(section.bpm - previous.bpm) < min_delta
        tiny = (section.end_s - section.start_s) < persistence * section.period
        if same or tiny:
            merged[-1] = _refit_span(times, weights, previous.start_s, section.end_s,
                                     previous.period, previous.phase) or previous
        else:
            merged.append(section)
    # A tail region can still be too short after fusing; fold it backwards.
    while len(merged) > 1 and (merged[-1].end_s - merged[-1].start_s) < persistence * merged[-1].period:
        previous = merged[-2]
        fused = _refit_span(times, weights, previous.start_s, merged[-1].end_s,
                            previous.period, previous.phase)
        merged = merged[:-2] + [fused or previous]
    return merged


def _refit_span(times: np.ndarray, weights: np.ndarray, start: float, end: float,
                period: float, phase: float) -> GridSection | None:
    """Least-squares refit of one span; the number a red line will carry."""
    # Tight margins: a section fitted across even a couple of the neighbour's
    # bars picks up a phase error of several milliseconds.
    window = (times >= start - 0.15 * period) & (times <= end + 0.15 * period)
    if int(window.sum()) < 6:
        return None
    new_period, new_phase = _expand_fit(times[window], weights[window], period, phase,
                                        start - period, end + period)
    share, coverage, rms = _grid_quality(times[window], weights[window], new_period, new_phase)
    inlier = int(np.sum(np.abs(times[window] - (new_phase + np.round(
        (times[window] - new_phase) / new_period) * new_period)) <= 0.12 * new_period))
    return GridSection(start, end, new_period, new_phase, inlier, rms, coverage)


def _nearest_attack(times: np.ndarray, moment: float) -> float:
    """Distance from ``moment`` to the closest attack (inf when there are none)."""
    if times.size == 0:
        return float("inf")
    i = int(np.searchsorted(times, moment))
    best = float("inf")
    for j in (i - 1, i):
        if 0 <= j < times.size:
            best = min(best, abs(float(times[j]) - moment))
    return best


def _grid_reach(times: np.ndarray, period: float, phase: float, anchor: float,
                limit: float, backwards: bool, tolerance: float,
                allowed_misses: int = 1) -> float:
    """Walk a grid until its beats stop finding attacks; return the last that did."""
    step = -period if backwards else period
    beat = float(phase + np.round((anchor - phase) / period) * period)
    last, misses = beat, 0
    while True:
        beat += step
        if (backwards and beat < limit) or (not backwards and beat > limit):
            break
        if _nearest_attack(times, beat) <= tolerance:
            last, misses = beat, 0
        else:
            misses += 1
            if misses > allowed_misses:
                break
    return last


def _tune_boundary(times: np.ndarray, weights: np.ndarray, left: GridSection,
                   right: GridSection, reach: float = 10.0) -> float:
    """Place the split on the beat where the old grid stops explaining the music.

    Both grids pass through the change itself, so a least-squares cost is flat
    there — a beat either side scores the same. What is *not* flat is where
    each grid stops predicting attacks: the old one fails on the first beat of
    the new tempo, the new one fails on the last beat of the old. The red line
    belongs on the beat those two answers meet.
    """
    if left.period <= 0 or right.period <= 0:
        return right.start_s
    span = min(reach, 0.45 * (left.end_s - left.start_s), 0.45 * (right.end_s - right.start_s))
    if span <= 2 * left.period:
        return right.start_s
    lo = max(left.start_s + left.period, right.start_s - span)
    hi = min(right.end_s - right.period, right.start_s + span)
    if hi <= lo:
        return right.start_s
    # The tolerance has to be tight enough that the old grid cannot claim the
    # first beat of the new tempo, yet loose enough for a human drummer. Each
    # side's own fit residual sets it, so a jittery track relaxes on its own.
    def window_of(section: GridSection) -> float:
        return float(min(0.06 * section.period,
                         max(0.010, 4.0 * section.residual_ms / 1000.0)))

    earliest = _grid_reach(times, right.period, right.phase,
                           min(hi, right.start_s + 2 * right.period), lo,
                           backwards=True, tolerance=window_of(right))
    latest = _grid_reach(times, left.period, left.phase,
                         max(lo, left.end_s - 2 * left.period), hi,
                         backwards=False, tolerance=window_of(left))
    # Music does not jump: the new grid continues where the old one left off, so
    # at the true change the two grids share a beat and drift apart linearly on
    # either side. Their crossing is therefore a sharp minimum — far sharper
    # than any residual cost, which is flat there because both grids fit.
    span_lo = max(lo, min(earliest, latest) - 2 * right.period)
    span_hi = min(hi, max(earliest, latest) + 2 * right.period)
    if span_hi < span_lo:
        span_lo, span_hi = lo, hi
    k0 = int(np.ceil((span_lo - right.phase) / right.period - 1e-9))
    k1 = int(np.floor((span_hi - right.phase) / right.period + 1e-9))
    if k1 < k0:
        return float(min(max(right.start_s, lo), hi))
    beats = right.phase + np.arange(k0, k1 + 1) * right.period
    drift = np.abs(beats - (left.phase + np.round((beats - left.phase) / left.period) * left.period))
    best = float(beats[int(np.argmin(drift))])
    return float(min(max(best, lo), hi))


def _settle_boundaries(times: np.ndarray, weights: np.ndarray,
                       sections: list[GridSection], rounds: int = 2) -> list[GridSection]:
    """Alternate boundary search and per-section refit until both agree.

    Each pass moves the split to the beat that best separates the two grids,
    then refits both sides on their new spans — a section fitted across even a
    couple of foreign bars carries a phase error of several milliseconds.
    """
    if len(sections) < 2:
        return sections
    for _ in range(rounds):
        for i in range(len(sections) - 1):
            split = _tune_boundary(times, weights, sections[i], sections[i + 1])
            left, right = sections[i], sections[i + 1]
            sections[i] = GridSection(left.start_s, split, left.period, left.phase,
                                      left.inliers, left.residual_ms, left.coverage)
            sections[i + 1] = GridSection(split, right.end_s, right.period, right.phase,
                                          right.inliers, right.residual_ms, right.coverage)
        refitted: list[GridSection] = []
        for section in sections:
            fitted = _refit_span(times, weights, section.start_s, section.end_s,
                                 section.period, section.phase)
            refitted.append(fitted or section)
        sections = refitted
    return sections


# -- driver ------------------------------------------------------------------

def _phase_class(times: np.ndarray, weights: np.ndarray, period: float, phase: float,
                 m: int) -> int:
    """Which atom class inside a beat carries the accents (0 when unclear)."""
    if m <= 1:
        return 0
    k = np.round((times - phase) / period)
    inlier = np.abs(times - (phase + k * period)) <= 0.15 * period
    if int(inlier.sum()) < 4:
        return 0
    cls = np.mod(k[inlier].astype(np.int64), m)
    totals = np.bincount(cls, weights=weights[inlier].astype(float), minlength=m)
    counts = np.bincount(cls, minlength=m)
    means = totals / np.maximum(counts, 1)
    return int(np.argmax(means))


def _beat_sections(atom_sections: list[GridSection], times: np.ndarray,
                   weights: np.ndarray, m: int, first_class: int) -> list[GridSection]:
    """Convert atomic sections to beat-level ones (period ×m, phase on the accent)."""
    out: list[GridSection] = []
    for n, section in enumerate(atom_sections):
        window = (times >= section.start_s - section.period) & (times <= section.end_s + section.period)
        r = first_class if n == 0 else _phase_class(times[window], weights[window],
                                                    section.period, section.phase, m)
        out.append(GridSection(section.start_s, section.end_s, section.period * m,
                               section.phase + r * section.period, section.inliers,
                               section.residual_ms, section.coverage))
    return out


def _section_confidence(section: GridSection, persistence: int) -> float:
    beat_ms = section.period * 1000.0
    if beat_ms <= 0:
        return 0.0
    tightness = 1.0 - min(1.0, section.residual_ms / max(0.06 * beat_ms, 2.0))
    beats = max(1.0, (section.end_s - section.start_s) / section.period)
    length_bonus = min(1.0, beats / max(persistence * 3.0, 1.0))
    value = 0.55 * tightness + 0.30 * min(1.0, section.coverage * 1.15) + 0.15 * length_bonus
    return float(max(0.0, min(1.0, value)))


def section_measures(sections: list[GridSection], times: np.ndarray,
                     weights: np.ndarray) -> list[tuple[str, int, int]]:
    """Per-section ``(meter text, downbeat class, beats per bar)``.

    v3 read the meter once, from the first section, and wrote that same number
    into every red line. A song that moves to 3/4 for a bridge therefore came
    out wrong everywhere after the change, and every red line after the first
    was anchored to a plain beat, so osu!'s bar lines drifted out of step with
    the music.

    Each section is now measured on **its own attacks**. The rule that matters
    is inherited unchanged: a section whose accents do not prove a bar reports
    ``1``, meaning "anchor to a beat, not a bar". Guessing a bar without
    evidence pushes a red line up to three beats past where the music changed,
    which is worse than not knowing.
    """
    out: list[tuple[str, int, int]] = []
    for section in sections:
        window = ((times >= section.start_s - section.period)
                  & (times <= section.end_s + section.period))
        if int(window.sum()) < 12:
            out.append(("4/4", 0, 1))
            continue
        out.append(_meter_from_grid(times[window], weights[window],
                                    section.period, section.phase))
    return out


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


def detect_bar(times: np.ndarray, weights: np.ndarray, period: float,
               phase: float) -> tuple[float, float, int, float] | None:
    """Find the **bar**: how many of this grid's beats make one measure.

    Tempora's timeline is measures, not beats, and its physical quantity is
    measures per second — BPM is a presentation of it through the time
    signature (`MpsToBpm(mps) = mps * 60 * beats_per_bar`). Finding the bar is
    therefore the first thing an automatic version has to do, and everything
    else is expressed against it.

    Returns ``(bar_seconds, bar_phase, beats_in_bar, contrast)``, or None when
    the accents do not prove a bar. Refusing is the right answer then: a bar
    invented from nothing moves every red line.
    """
    if times.size < 16 or period <= 0:
        return None
    k = np.round((times - phase) / period)
    inlier = np.abs(times - (phase + k * period)) <= 0.15 * period
    if int(inlier.sum()) < 16:
        return None
    k = k[inlier].astype(np.int64)
    w = weights[inlier].astype(float)
    span = float(np.ptp(k))

    best: tuple[float, float, int, float] | None = None
    for m in BAR_MULTIPLES:
        if span < m * 4:
            continue
        cls = np.mod(k, m)
        totals = np.bincount(cls, weights=w, minlength=m)
        counts = np.bincount(cls, minlength=m)
        means = totals / np.maximum(counts, 1)
        r = int(np.argmax(means))
        contrast = float(means[r] / max(float(np.mean(means)), 1e-9))
        # Strongest downbeat wins. Preferring the *longest* bar was tried and
        # is wrong: a four-bar hypermeasure still shows some contrast (1.24 on
        # the reference track) and beat a true 3-beat bar at 1.5, giving a
        # 4800 ms measure where the truth is 1200. Near-ties go to the shorter
        # reading, which is the one a mapper writes.
        if contrast < BAR_CONTRAST:
            continue
        if best is None or contrast > best[3] * 1.05:
            best = (period * m, phase + r * period, m, contrast)
    return best


def meter_segments(times: np.ndarray, weights: np.ndarray, bar: float,
                   bar_phase: float, window_bars: int = 4
                   ) -> list[tuple[float, float, int, float]]:
    """Split a track into regions by **how the bar is subdivided**.

    This is the piece v3 had no notion of. Sections are grown on tempo — on
    measures per second — so a song whose bar never changes length but whose
    time signature moves between 6/4, 3/4 and 4/4 comes out as one section with
    one BPM. Measured on a track built to that shape, v3 reported two sections
    where the truth has six, and chose a single subdivision for all of it.

    Each window is scored against every plausible beats-per-bar with the same
    ``share x coverage`` ranking the seeder uses, and for the same reason: a
    grid twice too fine fills half its own slots, a grid too coarse leaves
    attacks off it, and only the written subdivision scores on both.

    Returns ``[(start_s, end_s, beats_in_bar, score)]``.
    """
    if times.size < 16 or bar <= 0:
        return []
    start = float(times[0])
    stop = float(times[-1])
    span = window_bars * bar
    if stop - start < 2 * span:
        return []

    windows: list[tuple[float, int, float]] = []
    edge = bar_phase + np.floor((start - bar_phase) / bar) * bar
    while edge + span <= stop + 1e-9:
        mask = (times >= edge) & (times < edge + span)
        if int(mask.sum()) >= 6:
            w_times, w_weights = times[mask], weights[mask]
            scored: list[tuple[float, int]] = []
            for beats in BEATS_PER_BAR:
                share, coverage, _rms = _grid_quality(
                    w_times, w_weights, bar / beats, bar_phase)
                scored.append((share * coverage, beats))
            scored.sort(key=lambda item: (-item[0], -item[1]))
            windows.append((edge, scored[0][1], scored[0][0]))
        edge += span

    if len(windows) < 2:
        return []

    # Merge neighbouring windows that agree, then drop runs too short to be a
    # time-signature change rather than a fill.
    runs: list[list] = []
    for edge, beats, score in windows:
        if runs and runs[-1][2] == beats:
            runs[-1][1] = edge + span
            runs[-1][3].append(score)
        else:
            runs.append([edge, edge + span, beats, [score]])
    # Counted in whole windows: the run's length in seconds is exactly one
    # window for a single-window run, and comparing it with MIN_METER_BARS
    # bars was an ulp coin flip -- at a 1.2 s bar, 85 of 200 such runs kept
    # and 115 dropped, by where the song started.
    merged = [r for r in runs if len(r[3]) * window_bars >= MIN_METER_BARS]
    if len(merged) < 2:
        return []
    # A dropped short run leaves a hole; hand it to the run before it. Then
    # settle each boundary on the exact bar, because a window wide enough to
    # read a signature is too wide to locate its change: a window straddling
    # the switch is labelled by whichever side fills more of it, which put
    # every boundary exactly one bar early on the reference track.
    out: list[tuple[float, float, int, float]] = []
    for n, run in enumerate(merged):
        end = merged[n + 1][0] if n + 1 < len(merged) else stop
        out.append([run[0], end, int(run[2]), float(np.mean(run[3]))])
    for n in range(1, len(out)):
        settled = _settle_meter_boundary(times, weights, bar, bar_phase,
                                         out[n - 1][2], out[n][2], out[n][0],
                                         window_bars)
        out[n - 1][1] = settled
        out[n][0] = settled
    return [(a, b, c, d) for a, b, c, d in out]


def _settle_meter_boundary(times: np.ndarray, weights: np.ndarray, bar: float,
                           bar_phase: float, left_beats: int, right_beats: int,
                           rough: float, window_bars: int) -> float:
    """The first bar that reads as ``right_beats`` rather than ``left_beats``.

    Scored one bar at a time. A single bar is thin evidence, so the walk takes
    the first bar where the new signature wins *and keeps winning* through the
    next one — a single ambiguous bar at a transition is common and should not
    move the red line.
    """
    if left_beats == right_beats or bar <= 0:
        return rough

    def reads_as(bar_index: float) -> int | None:
        lo = bar_phase + bar_index * bar
        mask = (times >= lo) & (times < lo + bar)
        if int(mask.sum()) < 3:
            return None
        scores = []
        for beats in (left_beats, right_beats):
            share, coverage, _rms = _grid_quality(times[mask], weights[mask],
                                                  bar / beats, bar_phase)
            scores.append(share * coverage)
        if abs(scores[0] - scores[1]) < 1e-9:
            return None
        return right_beats if scores[1] > scores[0] else left_beats

    centre = round((rough - bar_phase) / bar)
    for step in range(-window_bars, window_bars + 1):
        index = centre + step
        if reads_as(index) == right_beats and reads_as(index + 1) != left_beats:
            return bar_phase + index * bar
    return rough


#: How close, in beats, every section's beat must divide the measured bar for
#: the whole track to be one bar in several notations. Measured: signature
#: changes over a constant bar tile it to 0.0001; 128 -> 150 BPM misses by 0.31.
BAR_TILE_TOL = 0.02


def points_from_meter(sections: list[GridSection], times: np.ndarray,
                      weights: np.ndarray, persistence: int,
                      factor: float = 1.0) -> list[TimingPoint] | None:
    """Red lines from the **measure grid**, one per time-signature region.

    This is Tempora's model, automated. Its physical quantity is measures per
    second; BPM is a presentation of it through the signature, via
    ``MpsToBpm(mps) = mps * 60 * beats_per_bar``. A song whose bar never
    changes length but whose signature moves between 6/4, 3/4 and 4/4 is one
    tempo and several notations — and v3, which grows sections on tempo alone,
    could only ever report it as one BPM.

    Returns None when the track gives no reason to use this path: no provable
    bar, or a single signature throughout. Then the ordinary per-section
    placement stands, unchanged.

    It also returns None when the sections do not share that bar. The bar is
    measured on one section and applied to the whole track, so with a real
    tempo change it used to replace the correct sections: 128 -> 150 BPM with
    an audible downbeat came out as one 128 BPM red line for the whole song.
    A signature change over a constant bar tiles it with every section's beat
    (1.2 s / 0.4 s = 3, / 0.6 s = 2); a tempo change does not
    (1.875 s / 0.4 s = 4.69). A tempo change is the section path's job.
    """
    if not sections or times.size < 16 or factor != 1.0:
        return None
    primary = max(sections, key=lambda sec: sec.end_s - sec.start_s)
    found = detect_bar(times, weights, primary.period, primary.phase)
    if found is None:
        return None
    bar, bar_phase, _beats_in_bar, _contrast = found
    for section in sections:
        beats = bar / section.period
        if round(beats) < 1 or abs(beats - round(beats)) > BAR_TILE_TOL:
            return None

    segments = meter_segments(times, weights, bar, bar_phase)
    if len(segments) < 2:
        return None

    points: list[TimingPoint] = []
    for n, (start, end, beats, score) in enumerate(segments):
        # Tempora's formula, with measures per second as the physical quantity.
        bpm = (60.0 / bar) * beats
        if not 20.0 <= bpm <= 900.0:
            return None
        confidence = float(min(1.0, max(0.0, score)))
        points.append(TimingPoint(float(start * 1000.0), float(bpm),
                                  confidence, n, int(beats), True))
    return points


def _first_on_grid(times: np.ndarray, section: GridSection, tol_ratio: float = 0.12) -> float:
    """The first attack the first section's grid counts as its own.

    The first red line is placed from the first sound. With no bar to anchor
    it, an attack off the grid before the music -- noise from 0 s, a stray
    click -- put it on the grid beat nearest that attack, a beat before the
    music began (``very-noisy-132``: -34.65 ms, the music at 420 ms). An
    inlier is what the fit itself counts: within ``tol_ratio`` of a beat.
    """
    if times.size == 0:
        return float(section.start_s)
    k = np.round((times - section.phase) / section.period)
    on_grid = np.abs(times - (section.phase + k * section.period)) <= tol_ratio * section.period
    return float(times[on_grid][0]) if on_grid.any() else float(times[0])


def _points_from_sections(sections: list[GridSection], first_sound: float,
                          persistence: int, downbeat_class: int, meter: int,
                          factor: float = 1.0,
                          measures: list[tuple[str, int, int]] | None = None
                          ) -> list[TimingPoint]:
    """Turn fitted grids into osu! red lines, each on a (down)beat of its own grid."""
    points: list[TimingPoint] = []
    for n, section in enumerate(sections):
        period = section.period / factor
        if not np.isfinite(period) or period <= 0:
            continue
        bpm = 60.0 / period
        # The plausibility range is about the music, so it reads the section's
        # own tempo: a pulse factor the user chose must not silently drop one.
        if not 20.0 <= 60.0 / section.period <= 900.0:
            continue
        # Per-section bar, falling back to the global reading for section 0 so
        # behaviour is unchanged when no per-section measurement was made.
        if measures is not None and n < len(measures):
            _text, section_downbeat, section_bar = measures[n]
        elif n == 0:
            _text, section_downbeat, section_bar = ("4/4", downbeat_class, meter)
        else:
            _text, section_downbeat, section_bar = ("4/4", 0, 1)
        known = section_bar > 1

        if n == 0:
            # The first red line should land on a downbeat so osu!'s bar lines
            # match the music — but only when the accents prove where the bar
            # starts.
            anchor = section.phase + section_downbeat * section.period
            span = section.period * max(1, section_bar)
            start = max(section.start_s, first_sound) - 0.25 * period
            offset = anchor + np.ceil((start - anchor) / span - 1e-9) * span
            while offset < first_sound - 0.55 * period:
                offset += span
        elif known:
            # A tempo change lands on a bar line in practically all music, and
            # a red line on a downbeat is what makes osu!'s editor agree with
            # the song. Only done when this section's accents prove the bar.
            anchor = section.phase + section_downbeat * section.period
            span = section.period * section_bar
            # A quarter-period of slack, as section 0 has: the settled start
            # is a beat of this grid, and the final refit can leave that beat
            # microseconds before it -- ceil(x - 1e-9) then chose the next
            # one and the red line landed a whole beat (or bar) late.
            offset = anchor + np.ceil((section.start_s - 0.25 * period - anchor) / span - 1e-9) * span
        else:
            anchor = section.phase
            k = np.ceil((section.start_s - 0.25 * period - anchor) / period - 1e-9)
            offset = anchor + k * period

        points.append(TimingPoint(float(offset * 1000.0), float(bpm),
                                  _section_confidence(section, persistence), n,
                                  max(1, int(section_bar)) if known else 4,
                                  bool(known)))
    return points


def _synth_beats(sections: list[GridSection], factor: float = 1.0) -> np.ndarray:
    """Beat times implied by the fitted sections (used by the GUI trace)."""
    beats: list[float] = []
    for section in sections:
        period = section.period / factor
        if period <= 0:
            continue
        k0 = int(np.ceil((section.start_s - section.phase) / period - 1e-9))
        k1 = int(np.floor((section.end_s - section.phase) / period + 1e-9))
        if k1 < k0 or k1 - k0 > 200000:
            continue
        beats.extend(section.phase + np.arange(k0, k1 + 1) * period)
    return np.asarray(sorted(beats), dtype=np.float64)


def _local_bpm_curve(times: np.ndarray, weights: np.ndarray, sections: list[GridSection],
                     beats: np.ndarray, factor: float = 1.0) -> np.ndarray:
    """A genuine local-tempo trace: short least-squares fits, not beat deltas."""
    if beats.size == 0:
        return np.zeros(0)
    curve = np.zeros(beats.size, dtype=np.float64)
    for section in sections:
        period = section.period / factor
        if period <= 0:
            continue
        mask = (beats >= section.start_s - 1e-9) & (beats <= section.end_s + 1e-9)
        idx = np.flatnonzero(mask)
        if idx.size == 0:
            continue
        curve[idx] = 60.0 / period
        half = max(4.0 * section.period, 3.0)
        for j in idx[::4]:
            t = beats[j]
            window = (times >= t - half) & (times <= t + half)
            if int(window.sum()) < 8:
                continue
            fit = _ls_fit(times[window], weights[window], section.period, section.phase,
                          0.12 * section.period)
            if fit is None:
                continue
            local = fit[0] / factor
            if 0.6 * period <= local <= 1.7 * period:
                curve[j] = 60.0 / local
        # fill the sampled points across the section
        sampled = idx[::4]
        if sampled.size >= 2:
            curve[idx] = np.interp(beats[idx], beats[sampled], curve[sampled])
    unset = curve <= 0
    if np.any(unset) and np.any(~unset):
        curve[unset] = float(np.median(curve[~unset]))
    return curve


def _precision_engine(y: np.ndarray, sr: int, min_delta: float, persistence: int,
                      prefer_map_bpm: bool, retime: bool,
                      say: Callable[[str], None]) -> dict | None:
    """Full precision pipeline. Returns None when the audio has no usable grid."""
    say("Detecting attacks at sample resolution…")
    times, weights, env = _detect_attacks(y, sr, FIT_HOP, retime=retime)
    if times.size < 24:
        return None

    say("Scanning pulse coherence…")
    span_lo = float(times[0])
    span_hi = float(times[-1])
    # Anchor on the densest window: intros, outros and breakdowns are the least
    # informative places to decide what the beat is.
    anchor = span_lo
    if span_hi - span_lo > SCAN_SPAN_S:
        edges = np.arange(span_lo, span_hi - SCAN_SPAN_S + 1e-9, SCAN_SPAN_S / 3.0)
        if edges.size:
            counts = [int(np.sum((times >= e) & (times < e + SCAN_SPAN_S))) for e in edges]
            anchor = float(edges[int(np.argmax(counts))])
    anchor_hi = min(span_hi, anchor + SCAN_SPAN_S)
    seed = _seed_grid(times, weights, anchor, anchor_hi)
    if seed is None:
        return None
    atom_period, atom_phase = seed
    window = (times >= anchor) & (times <= anchor_hi)
    share, _coverage, _rms = _grid_quality(times[window], weights[window],
                                           atom_period, atom_phase)
    if share < 0.40:
        return None                       # no regular pulse: let the tracker try
    if (_pulse_log10p(times[window], atom_period, atom_phase) > WEAK_PULSE_LOG10P
            and _fit_pulse_gap(env, sr) < STRONG_PULSE_GAP):
        return None                       # chance explains the grid and the envelope agrees

    say("Resolving the beat octave…")
    hints = _tempo_hints(env, sr, FIT_HOP)
    m, first_class = _beat_from_atoms(times[window], weights[window], atom_period,
                                      atom_phase, hints, prefer_map_bpm)

    say("Fitting tempo sections…")
    # Sections are grown on the atomic grid, whose BPM is m times the beat BPM,
    # so both thresholds scale by m to keep the user-facing parameters honest.
    atom_sections = _grow_sections(times, weights, atom_period, atom_phase,
                                   max(min_delta * m, 1e-3), max(2, persistence * m))
    if not atom_sections:
        return None
    # first_class counts atoms from the anchor seed's phase, but section 0 was
    # seeded again inside _grow_sections and its phase can sit whole atoms
    # away; applied as-is, the class then names the off-beat (the only red line
    # 250 ms late at 120 BPM on tracks that start on the eighth-note grid).
    # Re-express it in section 0's own frame. floor(x + 0.5), not round():
    # the Rust port rounds halves the same way.
    shift = int(np.floor((atom_sections[0].phase - atom_phase) / atom_period + 0.5))
    first_class = (first_class - shift) % max(m, 1)
    sections = _beat_sections(atom_sections, times, weights, m, first_class)
    sections = _settle_boundaries(times, weights, sections)
    meter_text, downbeat, bar_beats = _meter_from_grid(
        times, weights, sections[0].period, sections[0].phase)
    return {"times": times, "weights": weights, "env": env, "sections": sections,
            "meter": meter_text, "meter_beats": bar_beats, "downbeat": downbeat,
            "atoms_per_beat": m, "first_sound": _first_on_grid(times, sections[0])}


# ---------------------------------------------------------------------------
# Main analysis entry point
# ---------------------------------------------------------------------------

def _load_audio(path: str | os.PathLike[str],
                say: Callable[[str], None]) -> tuple[np.ndarray, int]:
    """Decode to mono float32 at 44.1 kHz, peak-normalized."""
    say("Loading and normalizing audio…")
    # A missing or empty file is not a codec problem. All three used to read
    # "Could not decode audio ... install FFmpeg", which sends the user off to
    # install a program that cannot help.
    name = os.path.basename(os.fspath(path))
    if not os.path.isfile(path):
        raise RuntimeError(f"No audio file at {os.fspath(path)}.")
    if os.path.getsize(path) == 0:
        raise RuntimeError(f"{name} is empty (0 bytes).")
    try:
        # Ask libsndfile for the header first: a mistyped path to a multi-hour
        # file should cost nothing, not gigabytes of decoded samples.
        info = sf.info(str(path))
        if info.samplerate > 0 and info.frames / info.samplerate > MAX_AUDIO_SECONDS:
            raise ValueError(
                f"Audio is longer than {MAX_AUDIO_SECONDS / 60:.0f} minutes; "
                "trim the file before analysing it.")
    except ValueError:
        raise
    except Exception:
        pass                          # unreadable header: the decoders below decide
    try:
        # SoundFile decodes WAV/FLAC/OGG/MP3 directly and avoids an
        # unnecessary, expensive resample when already at 44.1 kHz.
        y, sr = sf.read(path, dtype="float32", always_2d=False)
        if isinstance(y, np.ndarray) and y.ndim == 2:
            y = np.mean(y, axis=1, dtype=np.float32)
        if sr != TARGET_SR:
            y = librosa.resample(y, orig_sr=sr, target_sr=TARGET_SR, res_type="soxr_hq")
            sr = TARGET_SR
    except Exception:
        try:
            y, sr = librosa.load(path, sr=TARGET_SR, mono=True, res_type="soxr_hq")
        except Exception as exc:
            if Path(name).suffix.lower() in (".mp3", ".m4a", ".aac", ".mp4", ".wma"):
                raise RuntimeError(
                    "Could not decode audio. For MP3/M4A/AAC install FFmpeg and add it to "
                    "PATH; WAV/FLAC/OGG open directly."
                ) from exc
            # WAV, FLAC, OGG and AIFF need no FFmpeg: this file is damaged or
            # is not the audio its name says.
            raise RuntimeError(
                f"Could not decode {name}: it is not audio this program can read, "
                "or it is damaged."
            ) from exc
    y = np.asarray(y, dtype=np.float32).reshape(-1)
    if not np.all(np.isfinite(y)):
        y = np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0)
    if y.size < sr * 2:
        raise ValueError("Audio must be at least two seconds long.")
    if y.size > sr * MAX_AUDIO_SECONDS:
        # A cap keeps a mistyped path (or a hostile multi-hour file) from
        # turning into gigabytes of intermediate arrays.
        raise ValueError(
            f"Audio is longer than {MAX_AUDIO_SECONDS / 60:.0f} minutes; "
            "trim the file before analysing it.")
    peak = float(np.max(np.abs(y)))
    if peak > 1e-9:
        y = (y / peak * 0.99).astype(np.float32)
    return y, int(sr)


def _weighted_median(values: np.ndarray, weights: np.ndarray) -> float:
    if values.size == 0:
        return 0.0
    order = np.argsort(values)
    values, weights = values[order], np.maximum(weights[order], 0.0)
    total = float(np.sum(weights))
    if total <= 0:
        return float(np.median(values))
    cumulative = np.cumsum(weights) / total
    return float(values[int(np.searchsorted(cumulative, 0.5))])


def _assemble_analysis(path: str | os.PathLike[str], y: np.ndarray, sr: int, fit: dict,
                       min_delta: float, persistence: int, min_confidence: float,
                       factor: float) -> Analysis:
    """Build the public :class:`Analysis` from a precision fit."""
    sections: list[GridSection] = fit["sections"]
    # A time-signature change at a constant tempo is invisible to section
    # growth, which splits on measures per second. When the bar is provable
    # and the signature moves, the measure grid places the red lines instead.
    points = points_from_meter(sections, fit["times"], fit["weights"],
                               persistence, factor)
    if points is None:
        measures = section_measures(sections, fit["times"], fit["weights"])
        points = _points_from_sections(sections, fit["first_sound"], persistence,
                                       fit["downbeat"], fit["meter_beats"], factor,
                                       measures)
    kept = [p for p in points if p.confidence >= min_confidence]
    if not kept and points:
        # Never hand back an empty map when a grid was clearly found.
        kept = [max(points, key=lambda p: p.confidence)]
    # Two sections can converge once each is refitted on its own attacks.
    final: list[TimingPoint] = kept[:1]
    for point in kept[1:]:
        # point.bpm already carries the pulse factor, so the threshold must too:
        # compared raw, ÷4 shrank a 3.5 BPM change to 0.875 and dropped it.
        if abs(point.bpm - final[-1].bpm) >= min_delta * factor:
            final.append(point)
    beats = _synth_beats(sections, factor)
    local = _local_bpm_curve(fit["times"], fit["weights"], sections, beats, factor)
    durations = np.array([max(s.end_s - s.start_s, 1e-6) for s in sections])
    bpms = np.array([s.bpm * factor for s in sections])
    global_bpm = _weighted_median(bpms, durations)
    residual = float(np.average([s.residual_ms for s in sections], weights=durations))
    natural = _synth_beats(sections, 1.0)          # the un-multiplied beat grid
    base_frames = natural * sr / FIT_HOP if natural.size else np.zeros(0)
    return Analysis(str(path), y.size / sr, beats, local, final, FIT_HOP, sr,
                    factor, global_bpm, _stability(local),
                    fit["meter"], fit["env"], np.asarray(base_frames, dtype=float),
                    fit["times"], fit["weights"], sections, fit["meter_beats"],
                    fit["downbeat"], residual, "precision")


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


def _pulse_clarity(onset: np.ndarray, sr: int, hop: int) -> float:
    """Median over the track of the best 40-300 BPM self-similarity.

    librosa.feature.tempogram's autocorrelation (periodic Hann, centred with a
    linear ramp, each window normalised by its peak) written in numpy and
    evaluated every PULSE_STRIDE frames; with a stride of 1 it matches librosa
    to 6e-16. It must not *call* librosa: a tempogram computed before the
    fallback tracker's first call changed that tracker's global BPM on a real
    song (198.07 -> 199.27), and a safeguard must not move a result.
    """
    env = np.asarray(onset, dtype=np.float64)
    k = np.arange(PULSE_WINDOW)
    half = PULSE_WINDOW // 2
    padded = np.pad(env, (half, half), mode="linear_ramp", end_values=(0, 0))
    hann = 0.5 - 0.5 * np.cos(2.0 * np.pi * k / PULSE_WINDOW)
    starts = np.arange(0, env.size, PULSE_STRIDE)
    frames = padded[starts[:, None] + k[None, :]] * hann[None, :]
    nfft = 1 << int(np.ceil(np.log2(2 * PULSE_WINDOW - 1)))
    spectrum = np.fft.rfft(frames, n=nfft, axis=1)
    lagged = np.fft.irfft(spectrum * np.conj(spectrum), n=nfft, axis=1)[:, :PULSE_WINDOW]
    peak = np.abs(lagged).max(axis=1, keepdims=True)
    lagged = np.divide(lagged, peak, out=np.zeros_like(lagged), where=peak > 0)
    lags = k * hop / sr
    band = (lags >= 0.2) & (lags <= 1.5)
    return float(np.median(lagged[:, band].max(axis=1)))


def _pulse_gap(onset: np.ndarray, sr: int, hop: int) -> float:
    """How much more periodic the onset envelope is than itself, shuffled.

    Shuffling the frames keeps the loudness distribution and destroys any
    rhythm, so noise scores about zero whatever its colour, while music — even
    rubato, even a live band whose tempo drifts — scores clearly above it. The
    shuffles use a fixed seed: the same audio always gets the same verdict.
    """
    onset = np.asarray(onset, dtype=np.float64)
    if onset.size < 64 or not np.any(onset > 0):
        return 0.0
    rng = np.random.default_rng(0)
    shuffled = [_pulse_clarity(rng.permutation(onset), sr, hop) for _ in range(PULSE_SHUFFLES)]
    return _pulse_clarity(onset, sr, hop) - float(np.mean(shuffled))


def _splitmix64(x: np.ndarray) -> np.ndarray:
    """SplitMix64 of each uint64: a hash Rust computes bit for bit."""
    z = x + np.uint64(0x9E3779B97F4A7C15)
    z = (z ^ (z >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
    z = (z ^ (z >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
    return z ^ (z >> np.uint64(31))


def _fit_pulse_gap(env: np.ndarray, sr: int) -> float:
    """_pulse_gap on the fitting envelope, for the precision engine's gate.

    The envelope at FIT_HOP is max-pooled in pairs, which puts its frames at
    HOP and the tempogram's 0.2-1.5 s lags inside its window. The shuffles
    order the frames by a SplitMix64 hash instead of numpy's generator, so the
    Rust engine takes the same decision on the same envelope.
    """
    usable = (env.size // 2) * 2
    onset = np.asarray(env[:usable], dtype=np.float64).reshape(-1, 2).max(axis=1)
    if onset.size < 64 or not np.any(onset > 0):
        return 0.0
    hop = 2 * FIT_HOP
    index = np.arange(onset.size, dtype=np.uint64)
    shuffled = []
    for shuffle in range(PULSE_SHUFFLES):
        keys = _splitmix64(index + np.uint64(shuffle << 32))
        shuffled.append(_pulse_clarity(onset[np.argsort(keys, kind="stable")], sr, hop))
    return _pulse_clarity(onset, sr, hop) - float(np.mean(shuffled))


def _legacy_analysis(path: str | os.PathLike[str], y: np.ndarray, sr: int,
                     min_delta: float, persistence: int, prefer_map_bpm: bool,
                     min_confidence: float, say: Callable[[str], None],
                     factor: float, refine_beats: bool) -> Analysis:
    """v2 tracker path: used when no regular pulse grid can be fitted.

    It refuses audio with no pulse at all instead of tracking one: a beat
    tracker always finds *some* beats, so on white noise it used to report
    127.68 BPM. A tempo that drifts or ramps still passes; noise does not.
    """
    say("Extracting transients and tempo hypotheses…")
    hop = HOP
    onset = _onset_envelope(y, sr, hop)
    if onset.size < 8:
        raise ValueError("Not enough beats detected. Try a file with clearer percussion.")
    if _pulse_gap(onset, sr, hop) < MIN_PULSE_GAP:
        raise ValueError("No rhythmic pulse found: this audio sounds like noise or has no beat, "
                         "so there is no BPM to report.")
    try:
        frame_tempi, tracker_bpm = _tempo_readings(onset, sr, hop)
    except Exception:
        frame_tempi = tracker_bpm = None
    guides = _global_tempo_guides(onset, sr, hop, frame_tempi)
    prior = guides[0][0] if guides else None

    say("Tracking beats (hybrid DP + PLP + peaks)…")
    beat_frames = _track_beats_hybrid(onset, sr, hop, prior, tracker_bpm)
    if len(beat_frames) < 8:
        raise ValueError("Not enough beats detected. Try a file with clearer percussion.")
    if refine_beats:
        beat_frames = _refine_beats_to_transients(beat_frames, onset, sr, hop)

    say("Resolving half/double-time pulse…")
    # ``factor`` multiplies the pulse the tracker settles on, as it does the
    # precision engine's: 0 or 1 is that pulse. It was read as an absolute
    # subdivision, so 1 switched the octave choice off and 0.5 / 0.25 were
    # dropped without a word.
    subdivision = _choose_subdivision(onset, beat_frames, prefer_map_bpm, guides)
    if factor:
        subdivision *= float(factor)
    beat_frames_raw = np.asarray(beat_frames, dtype=float).copy()
    beat_frames = _resubdivide(beat_frames, subdivision)
    if refine_beats:
        # Interpolated midpoints can sit up to half a beat away from the true
        # attack, so widen the snap window proportionally to the beat length.
        median_gap_s = float(np.median(np.diff(np.asarray(beat_frames, dtype=float)))) * hop / sr if len(beat_frames) > 1 else 0.5
        beat_frames = _refine_beats_to_transients(
            beat_frames, onset, sr, hop,
            radius_ms=float(np.clip(0.30 * median_gap_s * 1000, 25, 90)),
            # Only when the user asked for more beats: on the tracker's own
            # doubling, holding changed 9 of 27 real songs with no net gain
            # against their ranked maps (within 10 ms 0.128 -> 0.125).
            return_float=True,
            hold_without_peak=subdivision > 1 and float(factor) not in (0.0, 1.0))
    beat_frames = _trim_leading_silence(beat_frames, onset)
    beat_frames = _fill_missed_beats(beat_frames)
    beat_times = np.asarray(beat_frames, dtype=np.float64) * hop / sr

    say("Computing local tempo and persistent changes…")
    local = _robust_local_bpms(beat_times)
    valid = (local >= 30) & (local <= 600)
    if int(valid.sum()) < 8:
        raise ValueError("Detected tempo is outside the usable range.")
    beats_v, local_v = beat_times[valid], local[valid]
    candidates = _segment_tempi(beats_v, local_v, min_delta, persistence)
    points = [point for point in candidates if point.confidence >= min_confidence]
    if not points and candidates:
        points = [max(candidates, key=lambda p: p.confidence)]

    # The median of the measured beats, as rebuild_with_subdivision reports it.
    # Averaging it with a nearby tempogram guide was tried: a guide is a bin a
    # few tenths of a BPM wide, and on 16 single-tempo corpus cases the average
    # was further from the truth 14 times (median error 0.39 against 0.17 BPM).
    global_bpm = float(np.median(local_v)) if len(local_v) else 0.0
    return Analysis(str(path), y.size / sr, beats_v, local_v, points, hop, sr,
                    subdivision, global_bpm, _stability(local_v),
                    _guess_meter(beats_v, onset, sr, hop), onset, beat_frames_raw)


def analyze_audio(path: str | os.PathLike[str], min_delta: float = 1.5,
                  persistence: int = 12, prefer_map_bpm: bool = True,
                  min_confidence: float = 0.75,
                  progress: Callable[[str], None] | None = None,
                  force_subdivision: float = 0, refine_beats: bool = True,
                  engine: str = "auto") -> Analysis:
    """Analyse an audio file and return stable timing points.

    Most common formats work when libsndfile supports them. For MP3/M4A and
    other compressed formats, install FFmpeg so librosa can use its fallback.

    The default ``engine="auto"`` runs the v3 precision grid fitter and falls
    back to the v2 beat tracker only when the audio has no fittable pulse
    (rubato, free time, no percussion). ``engine="legacy"`` forces the v2 path,
    ``engine="precision"`` refuses to fall back.

    ``force_subdivision`` multiplies the detected beat rate (0 = auto; 0.5
    halves it, 2 doubles it). Use it when you *know* the song's octave — e.g.
    a 225 BPM stream reported as 112 BPM — or from the GUI pulse selector.
    ``refine_beats`` re-times every attack on the raw waveform at sample
    resolution; disable it only to diagnose whether that snapping drifts.
    """
    if min_delta <= 0 or persistence < 2 or not 0 <= min_confidence <= 1:
        raise ValueError("Minimum delta must be positive, persistence at least 2, confidence between 0 and 1.")
    if engine not in ("auto", "precision", "legacy"):
        raise ValueError("Engine must be 'auto', 'precision' or 'legacy'.")
    if force_subdivision and float(force_subdivision) not in ALLOWED_FACTORS:
        raise ValueError(f"Subdivision must be one of {sorted(ALLOWED_FACTORS)} (or 0 for auto).")
    say = progress or (lambda _message: None)
    y, sr = _load_audio(path, say)
    factor = float(force_subdivision) if force_subdivision else 1.0

    if engine in ("auto", "precision"):
        failure = ""
        try:
            fit = _precision_engine(y, sr, min_delta, persistence, prefer_map_bpm,
                                    refine_beats, say)
        except Exception as exc:
            if engine == "precision":
                raise
            # Falling back is correct, but doing it *silently* would hide a real
            # bug behind merely-worse numbers, so say what went wrong.
            fit, failure = None, f" ({type(exc).__name__}: {exc})"
        if fit is not None:
            return _assemble_analysis(path, y, sr, fit, min_delta, persistence,
                                      min_confidence, factor)
        if engine == "precision":
            raise ValueError(
                "No steady pulse could be fitted. Try engine='auto' or a file with clearer percussion.")
        say("No fittable grid — falling back to the beat tracker…" + failure)
    return _legacy_analysis(path, y, sr, min_delta, persistence, prefer_map_bpm,
                            min_confidence, say, float(force_subdivision), refine_beats)


def analyze_batch(folder: str | os.PathLike[str], min_delta: float = 1.5,
                  persistence: int = 12, prefer_map_bpm: bool = True,
                  min_confidence: float = 0.75, force_subdivision: float = 0.0,
                  refine_beats: bool = True, progress=None,
                  engine: str = "auto") -> list[dict]:
    """Analyze every audio file in a folder; one bad file never stops the rest.

    Phase 8 batch entry point (single flat folder — osu! song folders are
    flat, and so is this). Each row is plain JSON types: ``{"file", "ok",
    "global_bpm", "points", "duration", "error"}`` with the file's basename,
    sorted by name so two runs print the same table.
    """
    root = Path(folder)
    if not root.is_dir():
        raise ValueError(f"{root} is not a folder.")
    try:
        names = sorted(p.name for p in root.iterdir()
                       if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS)
    except OSError as exc:
        raise ValueError(f"Could not list {root}: {exc}") from exc
    rows: list[dict] = []
    for name in names:
        try:
            analysis = analyze_audio(str(root / name), min_delta, persistence,
                                     prefer_map_bpm, min_confidence, progress,
                                     force_subdivision, refine_beats, engine)
        except (ValueError, RuntimeError, OSError) as exc:
            rows.append({"file": name, "ok": False, "global_bpm": 0.0,
                         "points": 0, "duration": 0.0, "error": str(exc)})
            continue
        rows.append({"file": name, "ok": True,
                     "global_bpm": round(float(analysis.global_bpm), 4),
                     "points": len(analysis.points),
                     "duration": round(float(analysis.duration), 2), "error": ""})
    return rows


def rebuild_with_subdivision(analysis: Analysis, factor: float,
                             min_delta: float = 1.5, persistence: int = 12,
                             min_confidence: float = 0.75) -> Analysis:
    """Re-resolve an existing analysis at another pulse octave, no re-analysis.

    Powers the GUI "×2 / ÷2" quick fix. With a precision analysis this is exact
    — the fitted grids are simply read at a different beat rate. Raises
    ``ValueError`` for an unsupported factor or an analysis with no stored grid.
    """
    if float(factor) not in ALLOWED_FACTORS:
        raise ValueError(f"Subdivision factor must be one of {sorted(ALLOWED_FACTORS)}.")
    factor = float(factor)
    if analysis.sections:
        fit = {"times": analysis.attack_times, "weights": analysis.attack_weights,
               "env": analysis.onset, "sections": analysis.sections,
               "meter": analysis.meter, "meter_beats": analysis.meter_beats,
               "downbeat": analysis.downbeat_class,
               "first_sound": _first_on_grid(analysis.attack_times, analysis.sections[0])}
        rebuilt = _assemble_analysis(analysis.source, np.zeros(1), analysis.sample_rate,
                                     fit, min_delta, persistence, min_confidence, factor)
        return Analysis(analysis.source, analysis.duration, rebuilt.beats,
                        rebuilt.local_bpms, rebuilt.points, rebuilt.hop_length,
                        rebuilt.sample_rate, factor,
                        rebuilt.global_bpm, rebuilt.stability, rebuilt.meter,
                        rebuilt.onset, rebuilt.base_frames, rebuilt.attack_times,
                        rebuilt.attack_weights, rebuilt.sections, rebuilt.meter_beats,
                        rebuilt.downbeat_class, rebuilt.fit_residual_ms, "precision")
    if analysis.base_frames is None or len(analysis.base_frames) < 4:
        raise ValueError("This analysis has no stored beat grid to rebuild from.")
    frames = _resubdivide(analysis.base_frames, factor)
    median_gap_s = (float(np.median(np.diff(np.asarray(frames, dtype=float)))) * analysis.hop_length
                    / analysis.sample_rate) if len(frames) > 1 else 0.5
    frames = _refine_beats_to_transients(
        frames, analysis.onset, analysis.sample_rate, analysis.hop_length,
        radius_ms=float(np.clip(0.30 * median_gap_s * 1000, 25, 90)),
        return_float=True, hold_without_peak=factor > 1)
    frames = _trim_leading_silence(frames, analysis.onset)
    frames = _fill_missed_beats(frames)
    beat_times = np.asarray(frames, dtype=np.float64) * analysis.hop_length / analysis.sample_rate
    local = _robust_local_bpms(beat_times)
    valid = (local >= 30) & (local <= 600)
    beats_v, local_v = beat_times[valid], local[valid]
    candidates = _segment_tempi(beats_v, local_v, min_delta, persistence)
    points = [p for p in candidates if p.confidence >= min_confidence]
    if not points and candidates:
        points = [max(candidates, key=lambda p: p.confidence)]
    global_bpm = float(np.median(local_v)) if len(local_v) else 0.0
    return Analysis(analysis.source, analysis.duration, beats_v, local_v, points,
                    analysis.hop_length, analysis.sample_rate, factor, global_bpm,
                    _stability(local_v),
                    _guess_meter(beats_v, analysis.onset, analysis.sample_rate,
                                 analysis.hop_length),
                    analysis.onset, np.asarray(analysis.base_frames, dtype=float))


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------

def export_csv(analysis: Analysis, destination: str | os.PathLike[str]) -> None:
    """The red lines as the table, .osu, .osz and click track have them: snapped."""
    with open(destination, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["offset_ms", "bpm", "beat_index", "confidence"])
        writer.writerows((f"{p.offset_ms:.3f}", f"{p.bpm:.6f}", p.beat_index, f"{p.confidence:.3f}")
                         for p in snap_timing_points(analysis.points))


#: Beats one red line may click before the schedule gives up on it: a guard
#: against a hand-typed BPM in the thousands, not a limit any song reaches.
MAX_CLICKS_PER_LINE = 20000


#: Click levels: the first beat of a bar, any other beat, a subdivision.
CLICK_BAR, CLICK_BEAT, CLICK_SUB = 2, 1, 0
#: Subdivisions a click may add between beats (1 = beats only).
CLICK_SUBDIVISIONS = (1, 2, 3, 4)


def click_schedule(analysis: Analysis, duration: float | None = None,
                   subdivision: int = 1, accent: bool = True) -> list[tuple[float, int]]:
    """Every metronome click the red lines imply, as ``(seconds, level)``.

    One source for the exported click track and the app's live click, so what
    is heard in the app is what the WAV holds. Each red line clicks from its
    offset up to, not onto, the next line: the next line clicks its own first
    beat. It used to click onto it too, so every change of tempo clicked twice
    (at once when the change fell on the old grid, milliseconds apart when it
    did not). The first beat of a bar is ``CLICK_BAR`` (unless ``accent`` is
    off), on the line's own bar when it proved one, else on the song's meter
    (audit F-03: a waltz must not click in 4). ``subdivision`` adds that many
    evenly spaced ``CLICK_SUB`` clicks per beat, 2 for eighths, 4 for sixteenths.
    """
    if subdivision not in CLICK_SUBDIVISIONS:
        raise ValueError(f"Click subdivision must be one of {CLICK_SUBDIVISIONS}.")
    points = snap_timing_points(list(getattr(analysis, "points", None) or []))
    if duration is None:
        duration = float(min(max(analysis.duration, 1.0), MAX_CLICK_SECONDS))
    clicks: list[tuple[float, int]] = []
    for s, point in enumerate(points):
        if not np.isfinite(point.bpm) or point.bpm <= 0 or not np.isfinite(point.offset_ms):
            continue
        start = point.offset_ms / 1000.0
        last = s + 1 == len(points)
        end = duration if last else points[s + 1].offset_ms / 1000.0
        beat_len = 60.0 / point.bpm
        bar = 4
        if getattr(point, "meter_known", False):
            bar = max(1, int(getattr(point, "meter", 4) or 4))
        else:
            try:
                bar = max(1, min(16, int(str(getattr(analysis, "meter", "4/4")).split("/")[0])))
            except (ValueError, TypeError):
                bar = 4
        for k in range(MAX_CLICKS_PER_LINE * subdivision):
            t = start + k * beat_len / subdivision
            # The song's last line clicks to the end of the audio, inclusive.
            if (t > end + 1e-6) if last else (t >= end - 1e-6):
                break
            if k % subdivision:
                level = CLICK_SUB
            elif accent and (k // subdivision) % bar == 0:
                level = CLICK_BAR
            else:
                level = CLICK_BEAT
            clicks.append((t, level))
    return clicks


def export_click_track(analysis: Analysis, destination: str | os.PathLike[str],
                       sr: int = 44100, subdivision: int = 1, accent: bool = True) -> None:
    """Write a metronome WAV aligned to the detected red lines.

    Import it as a second track (or whistle-test it against the song) to
    *hear* whether the timing map drifts. The bar's first beat is the high
    tone, other beats the middle one, subdivisions a soft low one.
    """
    if not analysis.points:
        raise ValueError("Analyze audio first — there are no timing points.")
    if not 8000 <= sr <= 192000:
        raise ValueError("Click-track sample rate must be between 8 and 192 kHz.")
    # Checked before rendering, in words: soundfile raised a TypeError for an
    # unknown extension and "System error." for a missing folder, and only
    # after a long click track had been built.
    target = Path(destination)
    if not sf.check_format(target.suffix.lstrip(".").upper() or "?"):
        raise ValueError(f"{target.name}: give the click track a sound file extension such as .wav.")
    if not target.parent.is_dir():
        raise ValueError(f"Folder not found: {target.parent}")
    duration = float(min(max(analysis.duration, 1.0), MAX_CLICK_SECONDS))
    total = int((duration + 1.0) * sr)
    click = np.zeros(total, dtype=np.float32)
    # Pre-render both clicks once: rebuilding them per beat costs more than the
    # rest of the export put together on a long map.
    length = max(1, int(0.045 * sr))
    decay = np.exp(-np.arange(length) / (0.008 * sr))
    steps = np.arange(length) / sr
    # The app's live click uses the same three tones and levels.
    tones = {CLICK_BAR: (np.sin(2 * np.pi * 2093.0 * steps) * decay).astype(np.float32),
             CLICK_BEAT: (np.sin(2 * np.pi * 1568.0 * steps) * decay * 0.7).astype(np.float32),
             CLICK_SUB: (np.sin(2 * np.pi * 1318.5 * steps) * decay * 0.4).astype(np.float32)}

    for time_s, level in click_schedule(analysis, duration, subdivision, accent):
        idx = int(time_s * sr)
        if not 0 <= idx < total:
            continue
        tone = tones[level]
        end = min(total, idx + length)
        click[idx:end] += tone[:end - idx]
    peak = float(np.max(np.abs(click)))
    if peak > 1e-9:
        click = (click / peak * 0.9).astype(np.float32)
    sf.write(destination, click, sr)


#: How far export snapping may move a detected red line onto the previous
#: grid. Measured: the precision engine's section changes sit 0.005-0.026 ms
#: off it (rounding noise, the only thing snapping is for). The old tolerance,
#: a quarter beat, moved the fallback tracker's red lines by up to 75 ms on a
#: real song and hand-placed ones by up to a quarter beat.
SNAP_TOLERANCE_MS = 1.0


def snap_timing_points(points: list[TimingPoint]) -> list[TimingPoint]:
    """Remove rounding noise between a tempo change and the previous grid.

    osu! continues a red-line grid until the next red line. When a detected
    change sits within SNAP_TOLERANCE_MS of a beat of the preceding section,
    it is placed exactly on it, so the grids join without a sub-millisecond
    phase step. Anything further off is where the music put it and stays.
    Points the mapper placed or edited are never moved, and a detected point
    is never pulled onto the grid of one they moved.
    """
    if not points:
        return []
    snapped = [points[0]]
    for point in points[1:]:
        previous = snapped[-1]
        if previous.bpm <= 0 or point.manual or previous.manual:
            snapped.append(point)
            continue
        beat_length = 60000.0 / previous.bpm
        beat_count = max(1, round((point.offset_ms - previous.offset_ms) / beat_length))
        offset = previous.offset_ms + beat_count * beat_length
        # The v3 engine fits every section on its own attacks, so its offsets
        # are already exact. Only nudge one onto the previous grid when the two
        # nearly agree — a large "correction" means the change genuinely does
        # not fall on the old grid, and moving it there would invent an error.
        if abs(offset - point.offset_ms) > SNAP_TOLERANCE_MS:
            snapped.append(point)
            continue
        # Carry the bar across: rebuilding a point without it silently
        # reset every section to 'unknown', so the per-section meter
        # never reached the .osu or the click track.
        snapped.append(TimingPoint(offset, point.bpm, point.confidence,
                                   point.beat_index, point.meter, point.meter_known))
    return snapped


def osu_timing_text(analysis: Analysis, decimals: int = 0) -> str:
    """Return uninherited (red) timing points ready for an .osu [TimingPoints].

    Offsets are whole milliseconds by default: that is what the .osu format
    specifies and what osu!stable writes, and the fit is sub-millisecond, so
    rounding costs at most 0.5 ms. Pass ``decimals`` to keep the fractional part
    for tools that accept it (osu!lazer does).
    """
    # osu! only guarantees comments on their own lines. Do not append a human
    # annotation after the Effects field: some parsers treat it as invalid.
    rows = ["// Generated by Overtone v" + APP_VERSION]
    try:
        fallback = max(1, min(16, int(str(getattr(analysis, "meter", "4/4")).split("/")[0])))
    except (ValueError, TypeError):
        fallback = 4
    for p in snap_timing_points(list(getattr(analysis, "points", None) or [])):
        if not np.isfinite(p.bpm) or p.bpm <= 0 or not np.isfinite(p.offset_ms):
            continue
        beat_length = 60000.0 / p.bpm
        offset = (f"{p.offset_ms:.{int(decimals)}f}" if decimals > 0
                  else str(int(round(p.offset_ms))))
        # Each point carries the bar its own section proved. A song that moves
        # to 3/4 for a bridge used to get the first section's meter written
        # into every line.
        #
        # A point that does *not* know its own bar — a hand-added one, or a
        # section whose accents proved nothing — falls back to the analysis
        # meter rather than to a hard-coded 4. Writing 4 over a detected 3/4
        # would be inventing information the engine did not have.
        meter = fallback
        if getattr(p, "meter_known", False):
            meter = max(1, min(16, int(getattr(p, "meter", fallback) or fallback)))
        rows.append(f"{offset},{beat_length:.12f},{meter},1,0,100,1,0")
    return "\n".join(rows)


def analysis_report(analysis: Analysis) -> dict:
    """Machine-readable report (CLI --json, Phase 8).

    Snapped points — what the exporters write — plus the validation findings,
    all plain JSON types.
    """
    return {
        "source": str(getattr(analysis, "source", "")),
        "duration": float(analysis.duration),
        "global_bpm": float(analysis.global_bpm),
        "stability": float(analysis.stability),
        "meter": analysis.meter,
        "engine": analysis.engine,
        "subdivision": float(analysis.subdivision),
        "residual_ms": float(analysis.fit_residual_ms),
        "points": [{"offset_ms": p.offset_ms, "bpm": p.bpm,
                    "confidence": p.confidence, "meter": p.meter,
                    "meter_known": bool(p.meter_known)}
                   for p in snap_timing_points(analysis.points)],
        "findings": validate_timing_points(analysis),
    }


def analysis_summary(analysis: Analysis) -> str:
    """One-page human-readable report (CLI --stats and GUI details)."""
    lines = [
        f"Source:      {analysis.source}",
        f"Duration:    {analysis.duration:.2f} s   •   {len(analysis.beats)} beats",
        f"Global BPM:  {analysis.global_bpm:.2f}   •   meter {analysis.meter}   •   pulse x{analysis.subdivision}",
        f"Stability:   {analysis.stability:.0%}   •   sections {len(analysis.points)}",
        f"Engine:      {analysis.engine}   •   grid residual {analysis.fit_residual_ms:.2f} ms",
        "",
        f"{'#':>3}  {'offset_ms':>10}  {'bpm':>10}  {'beat_len':>9}  {'conf':>6}",
    ]
    for i, p in enumerate(snap_timing_points(analysis.points), 1):
        beat_len = 60000.0 / p.bpm if p.bpm > 0 else float("nan")
        lines.append(f"{i:>3}  {p.offset_ms:10.1f}  {p.bpm:10.4f}  {beat_len:9.2f}  {p.confidence:6.0%}")
    suggestions = suggest_section_pulse(analysis)
    if suggestions:
        lines.append("")
        lines.append("Pulse suggestions (select the section, then 2× § / ÷2 §):")
        for idx, factor, ratio in suggestions:
            lines.append(f"  §{idx + 1}: try ×{factor} (off-beat support {ratio:.0%})")
    findings = validate_timing_points(analysis)
    if findings:
        lines.append("")
        lines.append("Validation (check by ear):")
        for finding in findings:
            where = f"§{finding['index'] + 1}" if finding["index"] >= 0 else "song"
            lines.append(f"  {finding['level']:5} {where}: {_finding_text(finding)}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Validation findings (Phase 7, first row)
# ---------------------------------------------------------------------------

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


def validate_timing_points(analysis: Analysis) -> list[dict]:
    """Findings a mapper should review by ear before trusting the red lines.

    Pure Phase 7, first row: duplicate points, very short sections, impossible
    changes, suspicious offsets, octave mistakes. Operates on the *snapped*
    points — what the exporters write — so a finding names the line the mapper
    actually sees. Each finding is ``{"level", "key", "index", "values"}`` with
    plain JSON types; ``index`` is the governing point, -1 for song-level.
    Levels: ``error`` (the map is wrong), ``warn`` (check it), ``info`` (a
    judgement call, stated as one). An empty map has no findings, and findings
    never raise: validation must not break on the input it is checking.
    """
    try:
        points = snap_timing_points(list(getattr(analysis, "points", None) or []))
    except Exception:
        return []
    if not points:
        return []
    try:
        duration = float(getattr(analysis, "duration", 0.0) or 0.0)
        beats = np.asarray(getattr(analysis, "beats", []), dtype=np.float64)
        first_beat = float(beats[0]) if beats.size else 0.0
    except (TypeError, ValueError):
        duration, first_beat = 0.0, 0.0

    findings: list[dict] = []

    def err(key: str, index: int, values: dict | None = None) -> None:
        findings.append({"level": "error", "key": key, "index": index,
                         "values": values or {}})

    def warn(key: str, index: int, values: dict | None = None) -> None:
        findings.append({"level": "warn", "key": key, "index": index,
                         "values": values or {}})

    def info(key: str, index: int, values: dict | None = None) -> None:
        findings.append({"level": "info", "key": key, "index": index,
                         "values": values or {}})

    for n, point in enumerate(points):
        offset = getattr(point, "offset_ms", float("nan"))
        bpm = getattr(point, "bpm", float("nan"))
        try:
            bad = not (np.isfinite(offset) and np.isfinite(bpm))
        except TypeError:
            bad = True
        if bad or bpm <= 0:
            err("bad_number", n)
            continue
        if offset < 0:
            err("negative_offset", n, {"ms": f"{offset:.1f}"})
        elif duration > 0 and offset / 1000.0 > duration + 0.001:
            warn("past_end", n, {"ms": f"{offset:.1f}"})
        if n == 0 and first_beat > 0 and offset / 1000.0 - first_beat > LATE_FIRST_LINE_S:
            warn("late_first", n, {"line": f"{offset / 1000.0:.1f}",
                                   "beat": f"{first_beat:.1f}"})

    for n in range(1, len(points)):
        prev, point = points[n - 1], points[n]
        if prev.bpm <= 0 or not np.isfinite(prev.bpm) or not np.isfinite(point.bpm):
            continue
        gap_ms = point.offset_ms - prev.offset_ms
        beat_ms = 60000.0 / prev.bpm
        if gap_ms < DUPLICATE_BEATS * beat_ms:
            err("dup_points", n, {"gap": f"{gap_ms:.1f}"})
            continue
        if gap_ms < MIN_BEATS_PER_SECTION * beat_ms:
            warn("short_section", n - 1, {"beats": f"{gap_ms / beat_ms:.1f}"})
        ratio = point.bpm / prev.bpm
        if ratio >= IMPOSSIBLE_RATIO or ratio <= 1.0 / IMPOSSIBLE_RATIO:
            err("impossible_change", n,
                {"from": f"{prev.bpm:.2f}", "to": f"{point.bpm:.2f}"})
        elif min(abs(float(np.log2(ratio)) - 1.0),
                 abs(float(np.log2(ratio)) + 1.0)) <= OCTAVE_BAND_LOG:
            info("octave_check", n,
                 {"from": f"{prev.bpm:.2f}", "to": f"{point.bpm:.2f}"})

    # The last section runs to the end of the song: it can be short too.
    last = points[-1]
    if last.bpm > 0 and np.isfinite(last.bpm) and duration > 0:
        tail_beats = (duration - last.offset_ms / 1000.0) / (60.0 / last.bpm)
        if 0 <= tail_beats < MIN_BEATS_PER_SECTION:
            warn("short_section", len(points) - 1, {"beats": f"{tail_beats:.1f}"})
    return findings


def _finding_text(finding: dict) -> str:
    """One human line per validation finding (CLI --stats, GUI details)."""
    key, values = finding["key"], finding["values"]
    if key == "dup_points":
        return f"two red lines {values['gap']} ms apart — one is a duplicate"
    if key == "short_section":
        return f"section lasts {values['beats']} beats, less than a bar"
    if key == "impossible_change":
        return f"tempo {values['from']} → {values['to']} BPM is a detection error, not music"
    if key == "octave_check":
        return f"tempo {values['from']} → {values['to']} BPM: half-time or an octave mistake?"
    if key == "negative_offset":
        return f"offset {values['ms']} ms is before the audio starts"
    if key == "bad_number":
        return "no usable number — re-analyze or delete"
    if key == "late_first":
        return f"first red line at {values['line']} s, music starts at {values['beat']} s"
    if key == "past_end":
        return f"offset {values['ms']} ms is past the end of the audio"
    return f"{key} {values}"


# ---------------------------------------------------------------------------
# Manual timing-point editing (pure helpers — GUI calls these)
# ---------------------------------------------------------------------------

def _nearest_beat_index(beats: np.ndarray, offset_ms: float) -> int:
    if len(beats) == 0:
        return 0
    return int(np.argmin(np.abs(beats * 1000.0 - offset_ms)))


def add_timing_point(points: list[TimingPoint], beats: np.ndarray,
                     offset_ms: float, bpm: float) -> list[TimingPoint]:
    """Insert a hand-placed point, keeping the list sorted by offset.

    Hand-placed points carry confidence 1.0: the mapper — not the detector —
    vouches for them. Raises ``ValueError`` on non-positive BPM.
    """
    if not np.isfinite(offset_ms) or not np.isfinite(bpm) or bpm <= 0:
        raise ValueError("Offset must be finite and BPM positive.")
    merged = list(points) + [TimingPoint(float(offset_ms), float(bpm), 1.0,
                                         _nearest_beat_index(beats, offset_ms),
                                         manual=True)]
    merged.sort(key=lambda p: p.offset_ms)
    return merged


def update_timing_point(points: list[TimingPoint], beats: np.ndarray, index: int,
                        offset_ms: float, bpm: float) -> list[TimingPoint]:
    """Replace one point's offset/BPM (confidence preserved), re-sorted."""
    if not 0 <= index < len(points):
        raise ValueError("No timing point at that index.")
    if not np.isfinite(offset_ms) or not np.isfinite(bpm) or bpm <= 0:
        raise ValueError("Offset must be finite and BPM positive.")
    old = points[index]
    merged = list(points)
    # Editing a point's offset or BPM does not change its time signature, so
    # the bar it knows travels with it.
    merged[index] = TimingPoint(float(offset_ms), float(bpm), old.confidence,
                                _nearest_beat_index(beats, offset_ms),
                                old.meter, old.meter_known, manual=True)
    merged.sort(key=lambda p: p.offset_ms)
    return merged


def delete_timing_point(points: list[TimingPoint], index: int) -> list[TimingPoint]:
    """Remove one point. The first point (section 1) cannot be deleted."""
    if not 0 <= index < len(points):
        raise ValueError("No timing point at that index.")
    if index == 0:
        raise ValueError("The first timing point anchors the map and cannot be deleted.")
    return [p for n, p in enumerate(points) if n != index]


def nudge_timing_point(points: list[TimingPoint], beats: np.ndarray, index: int,
                       delta_ms: float) -> list[TimingPoint]:
    """Shift one point's offset by ``delta_ms``, beat index refreshed.

    A nudge stops at 0 ms rather than carry a point from the audio into the
    time before it. A point already before 0 ms (an anacrusis, or audio that
    opens on its first beat) moves by exactly ``delta_ms``: clamping it too
    turned a -1 ms nudge on a line at -20 ms into a +20 ms jump.
    """
    if not 0 <= index < len(points):
        raise ValueError("No timing point at that index.")
    old = points[index]
    offset = old.offset_ms + delta_ms
    if old.offset_ms >= 0.0 > offset:
        offset = 0.0
    merged = list(points)
    merged[index] = TimingPoint(offset, old.bpm, old.confidence,
                                _nearest_beat_index(beats, offset),
                                old.meter, old.meter_known, manual=True)
    merged.sort(key=lambda p: p.offset_ms)
    return merged


def rescale_section(points: list[TimingPoint], index: int, factor: float) -> list[TimingPoint]:
    """Multiply one section's BPM (per-section ×2/÷2 fix). Offset untouched."""
    if not 0 <= index < len(points):
        raise ValueError("No timing point at that index.")
    if factor not in (0.5, 2.0):
        raise ValueError("Section factor must be 2 or 1/2.")
    old = points[index]
    bpm = old.bpm * factor
    if not 30 <= bpm <= 600:
        raise ValueError(f"Resulting BPM {bpm:.1f} is outside 30–600.")
    merged = list(points)
    merged[index] = TimingPoint(old.offset_ms, bpm, old.confidence, old.beat_index,
                                old.meter, old.meter_known, manual=True)
    return merged


# ---------------------------------------------------------------------------
# Per-section pulse suggestions
# ---------------------------------------------------------------------------

def suggest_section_pulse(analysis: Analysis,
                          low_bpm: float = 120.0,
                          min_ratio: float = 0.55) -> list[tuple[int, int, float]]:
    """Flag sections that look like half-time tracker locks.

    Returns [(point_index, suggested_factor, support_ratio)]. Only *suggests*:
    a 112 BPM half-time *feel* section with busy hats is musically correct at
    112, so doubling stays a one-click manual decision (GUI "2× §"), never
    automatic. Sections already in map range are never flagged.
    """
    suggestions: list[tuple[int, int, float]] = []
    if analysis.base_frames is None or len(analysis.onset) < 8:
        return suggestions
    snapped = snap_timing_points(analysis.points)
    frame_rate = analysis.sample_rate / analysis.hop_length
    section_frames = np.rint(np.asarray(analysis.base_frames, dtype=float))
    section_frames = section_frames[(section_frames >= 0) & (section_frames < len(analysis.onset))]
    for idx, point in enumerate(snapped):
        if point.bpm >= low_bpm:
            continue
        doubled = point.bpm * 2
        if not 120 <= doubled <= 400:
            continue
        start_s = point.offset_ms / 1000.0
        end_s = snapped[idx + 1].offset_ms / 1000.0 if idx + 1 < len(snapped) else analysis.duration
        mask = (analysis.beats >= start_s) & (analysis.beats < end_s)
        grid = np.rint(analysis.beats[mask] * frame_rate).astype(int)
        grid = grid[(grid >= 0) & (grid < len(analysis.onset))]
        if len(grid) < 4:
            continue
        base_support = max(_subdivision_support(analysis.onset, grid, 1), 1e-9)
        ratio = _subdivision_support(analysis.onset, grid, 2) / base_support
        if ratio >= min_ratio:
            suggestions.append((idx, 2, float(ratio)))
    return suggestions


# ---------------------------------------------------------------------------
# .osz export
# ---------------------------------------------------------------------------

#: An .osz is a zip; a mistyped path should not turn into a gigabyte of audio.
MAX_OSZ_AUDIO_BYTES = 64 * 1024 * 1024
#: Characters Windows refuses in a filename, plus the ones osu! trips over.
_UNSAFE_FILENAME = str.maketrans({c: "_" for c in '<>:"/\\|?*'})


def _safe_component(text: str, fallback: str) -> str:
    """A filename piece that is safe on Windows and readable afterwards.

    Path separators are already replaced, so traversal is not reachable, but a
    run of dots is collapsed as well: ".." inside an archive entry is harmless
    here and alarming everywhere else, and some extractors refuse it outright.
    A single dot survives, because "Mr. Blue" is a legitimate artist.
    """
    cleaned = " ".join(str(text).translate(_UNSAFE_FILENAME).split())
    cleaned = re.sub(r"\.{2,}", "_", cleaned)
    # Trimmed again after the cut: 80 characters can end in a space or a dot,
    # which Windows drops on extraction.
    return cleaned.strip(". ")[:80].rstrip(". ") or fallback


def osu_beatmap_text(analysis: "Analysis", audio_filename: str,
                     metadata: dict | None = None, decimals: int = 0) -> str:
    """A complete, openable .osu carrying this analysis and nothing else.

    Timing a song from nothing is the one part of Tempora's workflow Overtone
    could not do: it could only inject red lines into a beatmap that already
    existed. This writes the beatmap.

    Deliberately minimal — no hit objects, no background, default difficulty
    settings. The point is a file a mapper can open in the editor with the
    timing already correct, not a playable map.
    """
    meta = {
        "title": "Untitled",
        "artist": "Unknown Artist",
        "creator": "Overtone",
        "version": "Timing",
        "source": "",
        "tags": "",
    }
    meta.update({k: v for k, v in (metadata or {}).items() if v is not None})

    timing = "\n".join(
        row for row in osu_timing_text(analysis, decimals).splitlines()
        if row and not row.startswith("//")
    )
    if not timing:
        raise ValueError("This analysis has no usable timing points to export.")

    return "\n".join([
        "osu file format v14",
        "",
        "[General]",
        f"AudioFilename: {audio_filename}",
        "AudioLeadIn: 0",
        "PreviewTime: -1",
        "Countdown: 0",
        "SampleSet: Normal",
        "StackLeniency: 0.7",
        "Mode: 0",
        "LetterboxInBreaks: 0",
        "WidescreenStoryboard: 0",
        "",
        "[Editor]",
        "DistanceSpacing: 1",
        "BeatDivisor: 4",
        "GridSize: 4",
        "TimelineZoom: 1",
        "",
        "[Metadata]",
        f"Title:{meta['title']}",
        f"TitleUnicode:{meta['title']}",
        f"Artist:{meta['artist']}",
        f"ArtistUnicode:{meta['artist']}",
        f"Creator:{meta['creator']}",
        f"Version:{meta['version']}",
        f"Source:{meta['source']}",
        f"Tags:{meta['tags']}",
        "BeatmapID:0",
        "BeatmapSetID:-1",
        "",
        "[Difficulty]",
        "HPDrainRate:5",
        "CircleSize:4",
        "OverallDifficulty:7",
        "ApproachRate:9",
        "SliderMultiplier:1.4",
        "SliderTickRate:1",
        "",
        "[Events]",
        "//Background and Video events",
        "//Break Periods",
        "//Storyboard Layer 0 (Background)",
        "//Storyboard Layer 1 (Fail)",
        "//Storyboard Layer 2 (Pass)",
        "//Storyboard Layer 3 (Foreground)",
        "//Storyboard Layer 4 (Overlay)",
        "//Storyboard Sound Samples",
        "",
        "[TimingPoints]",
        timing,
        "",
        "",
        "[HitObjects]",
        "",
    ])


def export_osz(analysis: "Analysis", destination: str | os.PathLike[str],
               audio_path: str | os.PathLike[str] | None = None,
               metadata: dict | None = None, decimals: int = 0) -> dict:
    """Write a .osz: the audio plus a beatmap carrying this timing.

    The archive is built in a temporary file and renamed into place, so an
    interrupted export cannot leave a half-written .osz that osu! will refuse
    and the user will not think to delete.
    """
    import zipfile

    source = Path(audio_path) if audio_path else Path(getattr(analysis, "source", ""))
    if not source.is_file():
        raise ValueError(f"Audio file not found: {source}")
    size = source.stat().st_size
    if size > MAX_OSZ_AUDIO_BYTES:
        raise ValueError(
            f"{source.name} is {size / 1e6:.0f} MB; that is not a beatmap's audio.")

    # Drop keys the caller passed as None -- a CLI flag that was not given
    # arrives as None, and keeping it would shadow the default with "None".
    meta = {k: v for k, v in (metadata or {}).items() if v is not None}
    meta.setdefault("title", source.stem)
    artist = _safe_component(meta.get("artist", "Unknown Artist"), "Unknown Artist")
    title = _safe_component(meta.get("title", "Untitled"), "Untitled")
    creator = _safe_component(meta.get("creator", "Overtone"), "Overtone")
    version = _safe_component(meta.get("version", "Timing"), "Timing")

    # Stem and extension apart: through _safe_component whole, a name over 80
    # characters lost its ".mp3", and "Title....mp3" came out "Title_mp3".
    suffix = re.sub(r"[^.a-z0-9]", "", source.suffix.lower())
    audio_name = _safe_component(source.stem, "audio") + suffix
    osu_name = f"{artist} - {title} ({creator}) [{version}].osu"
    text = osu_beatmap_text(analysis, audio_name, meta, decimals)

    target = Path(destination)
    temp = target.with_name(target.name + ".part")
    try:
        with open(temp, "wb") as handle:
            with zipfile.ZipFile(handle, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(osu_name, text.encode("utf-8"))
                archive.write(source, audio_name)
            _sync(handle)
        os.replace(temp, target)
    except BaseException:
        try:
            temp.unlink()
        except OSError:
            pass
        raise
    return {"osu": osu_name, "audio": audio_name,
            "points": len(snap_timing_points(list(analysis.points))),
            "bytes": target.stat().st_size}


# ---------------------------------------------------------------------------
# .osu injection
# ---------------------------------------------------------------------------

def _sync(handle) -> None:
    """Push a temp file's bytes to the disk before it is renamed into place.

    The OS may persist a rename before the data it points at. After a power
    cut or a crash between the two, the name then holds an empty or
    zero-filled file and the content it replaced is gone. Syncing first
    leaves the old file or the complete new one, never neither.
    """
    handle.flush()
    os.fsync(handle.fileno())


def _write_synced(path: Path, payload: bytes) -> None:
    with open(path, "wb") as handle:
        handle.write(payload)
        _sync(handle)


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    """Write via a sibling temp file, synced, then renamed.

    Injecting rewrites the user's beatmap in place. Truncating the real file
    and then failing mid-write would destroy work that may not exist anywhere
    else, so the new content is only ever swapped in once it is complete.
    """
    temp = path.with_name(path.name + ".part")
    try:
        _write_synced(temp, payload)
        os.replace(temp, path)
    except BaseException:
        try:
            temp.unlink()
        except OSError:
            pass
        raise


def _backup_before_write(path: Path, raw: bytes) -> Path:
    """Keep ``raw``, the bytes a write is about to replace; return where.

    The first backup is ``map.osu.bak`` and stays pristine for good. Each later
    write keeps what it replaces in the next free ``.bak2``, ``.bak3``... unless
    the newest backup already holds exactly those bytes. A backup is written
    to a temp file and renamed into place, so a full disk or a lock halfway
    through leaves no truncated ``.bak`` for a retry to trust; os.rename, not
    os.replace, because on Windows it refuses an existing target, so no
    backup is ever overwritten.
    """
    newest, number = None, 1
    while True:
        spare = Path(f"{path}.bak{number if number > 1 else ''}")
        if not spare.exists():
            break
        newest, number = spare, number + 1
    if newest is not None and newest.read_bytes() == raw:
        return newest
    temp = spare.with_name(spare.name + ".part")
    try:
        _write_synced(temp, raw)
        os.rename(temp, spare)
    except BaseException:
        try:
            temp.unlink()
        except OSError:
            pass
        raise
    return spare


def _is_red_line(line: str) -> bool:
    """True for an uninherited (red) timing line, across every .osu version.

    Format v3-v4 wrote only ``time,beatLength``; v5+ added the ``uninherited``
    flag in field 7. A negative beat length has always meant "inherited", and
    that beats a contradictory flag — otherwise a legacy map keeps its old red
    lines *and* gains the new ones.
    """
    fields = line.split(",")
    if len(fields) < 2:
        return False
    try:
        inherited_by_length = float(fields[1]) < 0
    except ValueError:
        return False
    if len(fields) >= 7:
        return fields[6].strip() == "1" and not inherited_by_length
    return not inherited_by_length


@dataclass(frozen=True)
class _PlayState:
    """What a timing point makes audible from its time on.

    Red lines reset slider velocity to 1.0; green lines set it. Both set the
    hitsound sample set, index, volume and kiai. Timing (BPM, meter) is not
    part of it: that is exactly what injection is asked to change.
    """
    sv: float
    sample_set: int
    sample_index: int
    volume: int
    kiai: bool

    def same_as(self, other: "_PlayState") -> bool:
        return (abs(self.sv - other.sv) <= 1e-9 * max(1.0, abs(other.sv))
                and (self.sample_set, self.sample_index, self.volume, self.kiai)
                == (other.sample_set, other.sample_index, other.volume, other.kiai))


def _timing_point_fields(line: str) -> dict | None:
    """One [TimingPoints] line with osu!'s defaults for the fields old formats omit."""
    fields = [f.strip() for f in line.split(",")]
    if len(fields) < 2:
        return None
    try:
        time = float(fields[0])
        beat_length = float(fields[1])

        def number(n: int, default: int) -> int:
            return int(float(fields[n])) if len(fields) > n and fields[n] else default

        return {"time": time, "beat_length": beat_length, "red": _is_red_line(line),
                "meter": number(2, 4), "sample_set": number(3, 0),
                "sample_index": number(4, 0), "volume": number(5, 100),
                "effects": number(7, 0)}
    except ValueError:
        return None


def _apply_point(state: "_PlayState | None", point: dict) -> _PlayState:
    if point["red"]:
        sv = 1.0
    elif point["beat_length"] < 0:
        sv = -100.0 / point["beat_length"]
    else:
        sv = state.sv if state is not None else 1.0
    return _PlayState(sv, point["sample_set"], point["sample_index"], point["volume"],
                      bool(point["effects"] & 1))


def _ordered(points: list[dict]) -> list[dict]:
    """Time order, a red before a green at the same time (osu!'s own order)."""
    return sorted(points, key=lambda q: (q["time"], 0 if q["red"] else 1, q["order"]))


def _states_at_events(points: list[dict], events: list[float]) -> list["_PlayState | None"]:
    """The audible state at each event time; before the first point, the first
    point's settings apply, as in osu!."""
    ordered = _ordered(points)
    first = _apply_point(None, ordered[0]) if ordered else None
    out: list[_PlayState | None] = []
    state, i = None, 0
    for time in events:
        while i < len(ordered) and ordered[i]["time"] <= time + 1e-6:
            state = _apply_point(state, ordered[i])
            i += 1
        out.append(state if state is not None else first)
    return out


def inject_osu_timing_points(osu_path: str | os.PathLike[str],
                             analysis: Analysis,
                             backup: bool = True,
                             dry_run: bool = False,
                             decimals: int = 0) -> dict:
    """Replace the red (uninherited) lines of an .osu with this analysis.

    Only the timing changes. Each new red line takes the sample set, index,
    volume and kiai the original map had at its time, and where moving the red
    lines would change what plays — slider velocity, which a red line resets,
    or the hitsound state an old red line set — a green line carrying the
    original values is added at that time. So the map sounds and scrolls as it
    did, with the new timing; nothing the user did not ask for changes.

    Green lines keep their exact bytes, and so does everything outside
    [TimingPoints]: the BOM, each line's own line ending, a missing final
    newline. The timing section is written in time order, a red before a green
    at the same time. Unless ``backup`` is False, what the write replaces is
    kept first (see _backup_before_write): the pristine ``.bak`` on the first
    inject, a ``.bak2``, ``.bak3``... after the mapper has worked on the map
    since; no backup is ever overwritten. With ``dry_run`` nothing is written.
    Returns ``reds_replaced``, ``reds_added``, ``greens_kept``,
    ``greens_added``, ``backup`` (the path holding the replaced bytes, or
    None) and an ``audio_mismatch`` warning when the .osu's AudioFilename
    differs from the analysed file.
    """
    path = Path(osu_path)
    if not path.is_file():
        raise ValueError(f"{path} is not a file.")
    size = path.stat().st_size
    if size > MAX_OSU_BYTES:
        raise ValueError(f"{path.name} is {size / 1e6:.1f} MB — that is not a beatmap.")
    new_rows = [row for row in osu_timing_text(analysis, decimals).splitlines()
                if row and not row.startswith("//")]
    if not new_rows:
        raise ValueError("This analysis has no usable timing points to inject.")

    raw = path.read_bytes()
    bom = raw.startswith(b"\xef\xbb\xbf")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError(f"Could not decode {path.name} as UTF-8.") from exc
    newline = "\r\n" if b"\r\n" in raw else "\n"
    lines = text.splitlines(keepends=True)  # every line keeps its own ending

    header_idx = next((n for n, line in enumerate(lines)
                       if line.strip() == "[TimingPoints]"), None)
    if header_idx is None:
        raise ValueError("No [TimingPoints] section found in this .osu file.")
    end_idx = len(lines)
    for n in range(header_idx + 1, len(lines)):
        stripped = lines[n].strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            end_idx = n
            break
    body = lines[header_idx + 1:end_idx]
    # Blank lines closing the section stay where they are; so do comments and
    # anything else that is not a point, above the points.
    tail_start = len(body)
    while tail_start > 0 and not body[tail_start - 1].strip():
        tail_start -= 1
    tail = body[tail_start:]
    others: list[str] = []
    originals: list[dict] = []
    for n, line in enumerate(body[:tail_start]):
        point = _timing_point_fields(line.strip()) if line.strip() else None
        if point is None:
            others.append(line)
        else:
            point.update(order=n, raw=line)
            originals.append(point)
    old_reds = [q for q in originals if q["red"]]
    greens = [q for q in originals if not q["red"]]

    # New reds carry the state the original map had at their own time.
    parsed = [(row, _timing_point_fields(row)) for row in new_rows]
    parsed = [(row, q) for row, q in parsed if q is not None]
    carried = _states_at_events(originals, [q["time"] for _row, q in parsed])
    omit_barline = {round(q["time"]) for q in old_reds if q["effects"] & 8}
    reds: list[dict] = []
    for (row, q), state in zip(parsed, carried):
        fields = [f.strip() for f in row.split(",")]
        if state is not None:
            effects = (1 if state.kiai else 0) | (8 if round(q["time"]) in omit_barline else 0)
            fields[3:6] = [str(state.sample_set), str(state.sample_index), str(state.volume)]
            fields[7] = str(effects)
            q.update(sample_set=state.sample_set, sample_index=state.sample_index,
                     volume=state.volume, effects=effects)
        q.update(order=-1, raw=",".join(fields) + newline)
        reds.append(q)

    # Wherever the new set would play differently, a green restores the original.
    events = sorted({q["time"] for q in originals} | {q["time"] for q in reds})
    wanted = _states_at_events(originals, events)
    added: list[dict] = []
    for time, want in zip(events, wanted):
        if want is None:
            continue
        have = _states_at_events(reds + greens + added, [time])[0]
        if have is not None and have.same_as(want):
            continue
        governing = [q for q in reds if q["time"] <= time + 1e-6] or reds[:1]
        meter = governing[-1]["meter"] if governing else 4
        stamp = (f"{time:.{int(decimals)}f}" if decimals > 0 else str(int(round(time))))
        row = (f"{stamp},{-100.0 / want.sv:.12g},{meter},{want.sample_set},"
               f"{want.sample_index},{want.volume},0,{1 if want.kiai else 0}")
        point = _timing_point_fields(row)
        point.update(order=len(body) + len(added), raw=row + newline)
        added.append(point)

    out_body = others + [q["raw"] for q in _ordered(reds + greens + added)] + tail
    # The last line of the section needs an ending even if the file's last
    # line did not have one (the section is followed by more content).
    if end_idx < len(lines) and out_body and not out_body[-1].endswith(("\n", "\r")):
        out_body[-1] += newline

    audio_name = ""
    for line in lines[:header_idx]:
        if line.startswith("AudioFilename:"):
            audio_name = line.split(":", 1)[1].strip()
            break
    analysed_name = Path(getattr(analysis, "source", "")).name

    spare = None
    if not dry_run:
        if backup:
            spare = _backup_before_write(path, raw)
        # Bytes, not write_text: on Windows, text mode would translate our
        # existing "\r\n" into "\r\r\n".
        payload = "".join(lines[:header_idx + 1] + out_body + lines[end_idx:]).encode("utf-8")
        if bom:
            payload = b"\xef\xbb\xbf" + payload
        _atomic_write_bytes(path, payload)

    return {"reds_replaced": len(old_reds), "reds_added": len(reds),
            "greens_kept": len(greens), "greens_added": len(added),
            "backup": str(spare) if spare else None,
            "audio_mismatch": bool(audio_name and analysed_name
                                   and audio_name.lower() != analysed_name.lower()),
            "osu_audio": audio_name, "analysed_audio": analysed_name}


# ---------------------------------------------------------------------------
# .osu red-line reading and map-vs-detected comparison (Phase 5)
# ---------------------------------------------------------------------------

def _load_osu_text(osu_path: str | os.PathLike[str]) -> tuple[str, bool]:
    """The whole .osu as text plus whether it carried a BOM.

    Size and encoding guards in one place; the writer needs the BOM flag so an
    untouched file comes back byte-identical.
    """
    path = Path(osu_path)
    if not path.is_file():
        raise ValueError(f"{path} is not a file.")
    size = path.stat().st_size
    if size > MAX_OSU_BYTES:
        raise ValueError(f"{path.name} is {size / 1e6:.1f} MB — that is not a beatmap.")
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8-sig"), raw.startswith(b"\xef\xbb\xbf")
    except UnicodeDecodeError as exc:
        raise ValueError(f"Could not decode {path.name} as UTF-8.") from exc


def _timing_section_lines(osu_path: str | os.PathLike[str]) -> list[str]:
    """Raw body lines of the .osu [TimingPoints] section."""
    text, _bom = _load_osu_text(osu_path)
    lines = text.splitlines()
    header_idx = next((n for n, line in enumerate(lines)
                       if line.strip() == "[TimingPoints]"), None)
    if header_idx is None:
        raise ValueError("No [TimingPoints] section found in this .osu file.")
    end_idx = len(lines)
    for n in range(header_idx + 1, len(lines)):
        stripped = lines[n].strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            end_idx = n
            break
    return [line for line in lines[header_idx + 1:end_idx] if line.strip()]


def _parse_red_line(line: str) -> tuple[float, float] | None:
    """One red line as ``(offset_ms, bpm)``, or None when it has no numbers."""
    if not _is_red_line(line.strip()):
        return None
    fields = line.strip().split(",")
    try:
        offset = float(fields[0])
        beat_length = float(fields[1])
    except (ValueError, IndexError):
        return None
    if not (np.isfinite(offset) and np.isfinite(beat_length)) or beat_length <= 0:
        return None
    return (offset, 60000.0 / beat_length)


def read_osu_red_lines(osu_path: str | os.PathLike[str]) -> list[tuple[float, float]]:
    """Every uninherited (red) timing line as ``(offset_ms, bpm)``.

    The first half of Phase 5's map-vs-detected compare, and the reader the
    full .osu work will grow into. Green (inherited) lines are timing-neutral
    by definition — negative slider-velocity multipliers, not tempo — so they
    are skipped, not parsed. Legacy v3-v4 two-field lines count when their
    beat length is positive; decimal offsets (osu!lazer) survive as floats.
    Lines with no usable numbers are skipped rather than fatal: one hand-broken
    line must not hide the rest of the map.
    """
    return [red for line in _timing_section_lines(osu_path)
            if (red := _parse_red_line(line)) is not None]


#: Past this octave-normalised BPM gap the map and the detection disagree
#: rather than round differently. Offsets reuse the benchmark's 5 ms bar.
MAP_BPM_TOLERANCE = 1.0
MAP_OFFSET_TOLERANCE_MS = 5.0


def compare_map_timing(osu_path: str | os.PathLike[str],
                       analysis: Analysis) -> dict:
    """Per-section map-vs-detected diff table (Phase 5, second row).

    For every detected section, the governing map line — the last red line at
    or before the section start, with half a beat of slack, exactly as the
    benchmark scores ground truth — and two questions: is its BPM right (up
    to an octave), and does its grid pass through the detected beats. Returns
    ``{"sections": [...], "findings": [...]}`` with plain JSON types; findings
    reuse the validation vocabulary (``map_octave`` is info, because the
    octave is a judgement call; the rest are warns, never errors — the map is
    someone's work, and disagreement is review material, not a verdict).
    """
    detected = snap_timing_points(list(getattr(analysis, "points", None) or []))
    if not detected:
        return {"sections": [], "findings": [
            {"level": "error", "key": "no_detected", "index": -1, "values": {}}]}
    try:
        reds = read_osu_red_lines(osu_path)
    except (ValueError, OSError) as exc:
        return {"sections": [], "findings": [
            {"level": "error", "key": "map_unreadable", "index": -1,
             "values": {"detail": str(exc)}}]}
    if not reds:
        return {"sections": [], "findings": [
            {"level": "error", "key": "map_no_reds", "index": -1, "values": {}}]}

    sections: list[dict] = []
    findings: list[dict] = []
    for n, point in enumerate(detected):
        start_s = point.offset_ms / 1000.0
        step = 60.0 / point.bpm if point.bpm > 0 else 0.0
        governing = reds[0]
        for offset_ms, _bpm in reds:
            if offset_ms / 1000.0 <= start_s + 0.5 * step:
                governing = (offset_ms, _bpm)
        map_offset, map_bpm = governing
        ratio = point.bpm / map_bpm if map_bpm > 0 else 1.0
        octave = 2.0 ** round(float(np.log2(ratio))) if ratio > 0 else 1.0
        bpm_error = abs(point.bpm / octave - map_bpm)
        beats = (map_offset / 1000.0 - start_s) / step if step > 0 else 0.0
        offset_error = abs(beats - round(beats)) * step * 1000.0
        sections.append({
            "index": n, "det_offset_ms": point.offset_ms, "det_bpm": point.bpm,
            "map_offset_ms": map_offset, "map_bpm": map_bpm,
            "bpm_error": bpm_error, "offset_error_ms": offset_error,
            "octave": octave,
        })
        if octave != 1:
            findings.append({"level": "info", "key": "map_octave", "index": n,
                             "values": {"map": f"{map_bpm:.2f}",
                                        "det": f"{point.bpm:.2f}",
                                        "octave": f"x{octave:g}"}})
        elif bpm_error > MAP_BPM_TOLERANCE:
            findings.append({"level": "warn", "key": "map_bpm", "index": n,
                             "values": {"map": f"{map_bpm:.2f}",
                                        "det": f"{point.bpm:.2f}",
                                        "err": f"{bpm_error:.2f}"}})
        if offset_error > MAP_OFFSET_TOLERANCE_MS:
            findings.append({"level": "warn", "key": "map_offset", "index": n,
                             "values": {"ms": f"{offset_error:.1f}"}})
    if len(reds) != len(detected):
        findings.append({"level": "info", "key": "map_count", "index": -1,
                         "values": {"map": len(reds), "det": len(detected)}})
    return {"sections": sections, "findings": findings}


#: Audio extensions Overtone can analyse, shared by the GUIs' file dialogs.
AUDIO_EXTENSIONS = (".wav", ".flac", ".ogg", ".mp3", ".m4a", ".aac", ".opus", ".aiff")


def scan_beatmap_folder(folder: str | os.PathLike[str]) -> dict:
    """Beatmap folder import, first half (Phase 5): audio plus difficulties.

    An osu! song folder holds one audio file and one .osu per difficulty.
    Returns ``{"folder", "audio" (path or None), "beatmaps" (sorted paths),
    "audio_from" (the beatmap that named the audio, or None)}`` with plain
    types. Audio choice: the first beatmap's AudioFilename when that file
    exists — the mapper's own word beats guessing; else the single audio file
    when there is exactly one; else None. Several candidates with no map to
    arbitrate is ambiguity, and guessing an audio file is worse than asking.
    Flat listing on purpose: osu! song folders are flat.
    """
    root = Path(folder)
    if not root.is_dir():
        raise ValueError(f"{root} is not a folder.")
    try:
        entries = sorted(p for p in root.iterdir() if p.is_file())
    except OSError as exc:
        raise ValueError(f"Could not list {root}: {exc}") from exc
    beatmaps = [str(p) for p in entries if p.suffix.lower() == ".osu"]
    audios = [p for p in entries if p.suffix.lower() in AUDIO_EXTENSIONS]
    audio: Path | None = None
    audio_from: str | None = None
    for beatmap in beatmaps:
        try:
            text = Path(beatmap).read_bytes().decode("utf-8-sig")
        except (OSError, ValueError):
            continue
        named = next((line.split(":", 1)[1].strip() for line in text.splitlines()
                      if line.startswith("AudioFilename:")), "")
        if named and (root / named).is_file():
            audio, audio_from = root / named, beatmap
            break
    if audio is None and len(audios) == 1:
        audio = audios[0]
    return {"folder": str(root), "audio": str(audio) if audio else None,
            "beatmaps": beatmaps, "audio_from": audio_from}


# ---------------------------------------------------------------------------
# Full .osu reading (Phase 5, first row)
# ---------------------------------------------------------------------------

def _split_osu_sections(text: str) -> tuple[int, list[str], list[dict]]:
    """Format version, pre-section head lines, and every section in file order.

    Unknown sections ride along verbatim in ``sections`` — the span-preserving
    writer's contract is that a field nobody asked to change comes out
    byte-identical, and that starts with the reader losing nothing, including
    the exact head lines before the first section.
    """
    version = 0
    head: list[str] = []
    sections: list[dict] = []
    current: dict | None = None
    for line in text.splitlines():
        stripped = line.strip()
        if version == 0 and stripped.startswith("osu file format v"):
            try:
                version = int(stripped.rsplit("v", 1)[1])
            except ValueError:
                pass
        if stripped.startswith("[") and stripped.endswith("]") and len(stripped) > 2:
            current = {"name": stripped[1:-1], "lines": []}
            sections.append(current)
            continue
        if current is None:
            head.append(line)
        else:
            current["lines"].append(line)
    return version, head, sections


def _osu_key_values(lines: list[str]) -> dict:
    """``Key: value`` pairs; comments and blanks skipped, last key wins."""
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("//") or ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
        values[key.strip()] = value.strip()
    return values


def _parse_hit_sample(text: str) -> dict:
    """``normal:addition:index:volume:file`` — short forms pad with silence."""
    parts = (text or "").split(":")
    while len(parts) < 5:
        parts.append("")
    out: dict = {"raw": text}
    for key, part in zip(("normal_set", "addition_set", "index", "volume"), parts[:4]):
        try:
            out[key] = int(part)
        except ValueError:
            out[key] = 0
    out["file"] = parts[4]
    return out


def _parse_slider_curve(data: str) -> dict:
    """``B|123:456|789:12`` — curve kind plus integer anchor points."""
    kind, _, rest = data.partition("|")
    points: list[tuple[int, int]] = []
    for token in rest.split("|"):
        if ":" not in token:
            continue
        try:
            px, py = token.split(":")
            points.append((int(px), int(py)))
        except ValueError:
            continue
    return {"curve_type": kind, "points": points}


def _parse_hit_object(line: str) -> dict:
    """One [HitObjects] line as plain types, always keeping the raw line.

    Circles, sliders (curve, slides, length, edges), spinners and mania holds;
    anything else — including a hand-broken line — comes back as ``unparsed``
    with its raw text, so one bad object never hides the rest of the map.
    """
    obj: dict = {"raw": line, "kind": "unparsed"}
    fields = line.split(",")
    if len(fields) < 5:
        return obj
    try:
        x, y = int(fields[0]), int(fields[1])
        time = float(fields[2])
        type_bits, hit_sound = int(fields[3]), int(fields[4])
    except ValueError:
        return obj
    if not np.isfinite(time):
        return obj
    obj.update({"x": x, "y": y, "time": time, "type": type_bits,
                "hit_sound": hit_sound, "new_combo": bool(type_bits & 4),
                "combo_skip": (type_bits >> 4) & 7})
    rest = fields[5:]
    if type_bits & 128:  # mania hold: endTime, then the sample
        try:
            end, _, sample = rest[0].partition(":")
            obj.update({"kind": "hold", "end_time": int(end),
                        "hit_sample": _parse_hit_sample(sample)})
        except (ValueError, IndexError):
            pass
    elif type_bits & 8:  # spinner: endTime, then the sample
        try:
            obj.update({"kind": "spinner", "end_time": int(rest[0]),
                        "hit_sample": _parse_hit_sample(rest[1] if len(rest) > 1 else "")})
        except (ValueError, IndexError):
            pass
    elif type_bits & 2:  # slider: curve, slides, length, then edges and sample
        try:
            curve = _parse_slider_curve(rest[0])
            obj.update({"kind": "slider", "curve": curve,
                        "slides": int(rest[1]), "length": float(rest[2])})
        except (ValueError, IndexError):
            return obj
        if len(rest) > 3:
            obj["edge_sounds"] = rest[3]
        if len(rest) > 4:
            obj["edge_sets"] = rest[4]
        if len(rest) > 5:
            obj["hit_sample"] = _parse_hit_sample(rest[5])
    elif type_bits & 1:
        obj.update({"kind": "circle",
                    "hit_sample": _parse_hit_sample(rest[0] if rest else "")})
    return obj


def read_osu_beatmap(osu_path: str | os.PathLike[str]) -> dict:
    """The whole beatmap as plain types (Phase 5, first row).

    ``sections`` carries every section in file order with raw lines, so
    unknown sections and keys survive even though only the known ones get
    parsed views (``general``/``editor``/``metadata``/``difficulty``,
    ``timing`` reds plus green raws, ``hitobjects``). Hit sounds parse into
    ``normal_set``/``addition_set``/``index``/``volume``/``file``. ``head``,
    ``newline`` and ``bom`` exist for one reason: the writer rebuilds from
    them, so an untouched file comes back byte-identical.
    """
    text, bom = _load_osu_text(osu_path)
    version, head, sections = _split_osu_sections(text)
    by_name: dict[str, dict] = {}
    for section in sections:
        by_name.setdefault(section["name"], section)

    def body(name: str) -> list[str]:
        return by_name.get(name, {}).get("lines", [])

    timing = [line for line in body("TimingPoints") if line.strip()
              and not line.strip().startswith("//")]
    objects = [line for line in body("HitObjects") if line.strip()
               and not line.strip().startswith("//")]
    return {
        "format": version,
        "head": head,
        "newline": "\r\n" if "\r\n" in text else "\n",
        "trailing_newline": text.endswith(("\n", "\r")),
        "bom": bom,
        "sections": sections,
        "general": _osu_key_values(body("General")),
        "editor": _osu_key_values(body("Editor")),
        "metadata": _osu_key_values(body("Metadata")),
        "difficulty": _osu_key_values(body("Difficulty")),
        "timing": {
            "reds": [red for line in timing if (red := _parse_red_line(line)) is not None],
            "greens": [line for line in timing if not _is_red_line(line.strip())],
        },
        "hitobjects": [_parse_hit_object(line) for line in objects],
    }


def set_beatmap_reds(beatmap: dict, new_reds: list[str]) -> int:
    """Replace the red raws in place; greens, comments and blanks stay put.

    New reds take the position of the first old red (same rule as inject, but
    on the parsed structure instead of the file); with no old reds they append
    at the end of the section. The ``timing`` view is refreshed, and the
    replaced red count returns.
    """
    section = next((s for s in beatmap["sections"] if s["name"] == "TimingPoints"), None)
    if section is None:
        raise ValueError("No [TimingPoints] section in this beatmap.")
    replaced = sum(1 for line in section["lines"]
                   if line.strip() and _is_red_line(line.strip()))
    out: list[str] = []
    done = False
    for line in section["lines"]:
        if line.strip() and _is_red_line(line.strip()):
            if not done:
                out.extend(new_reds)
                done = True
        else:
            out.append(line)
    if not done:
        out.extend(new_reds)
    section["lines"] = out
    timing = [line for line in out if line.strip() and not line.strip().startswith("//")]
    beatmap["timing"] = {
        "reds": [red for line in timing if (red := _parse_red_line(line)) is not None],
        "greens": [line for line in timing if not _is_red_line(line.strip())],
    }
    return replaced


def beatmap_text(beatmap: dict) -> str:
    """Head plus sections in order, raw lines untouched, original newline."""
    newline = beatmap.get("newline", "\n")
    text = newline.join(beatmap.get("head", []) +
                        [line for section in beatmap["sections"]
                         for line in [f"[{section['name']}]"] + section["lines"]])
    return text + newline if beatmap.get("trailing_newline", True) else text


def write_osu_beatmap(osu_path: str | os.PathLike[str], beatmap: dict,
                      backup: bool = True) -> dict:
    """Write a parsed beatmap back (Phase 5, writer row).

    Untouched sections come out byte-identical — same lines, same newline,
    same BOM — because the reader kept them all. Atomic temp-plus-rename, and
    backups follow inject's rules (_backup_before_write): written first, never
    overwritten, skipped when there is no original to protect. ``backup`` in
    the result is the path holding the replaced bytes, or None.
    """
    path = Path(osu_path)
    original = path.read_bytes() if path.is_file() else None
    payload = beatmap_text(beatmap).encode("utf-8-sig" if beatmap.get("bom") else "utf-8")
    spare = None
    if backup and original is not None:
        try:
            spare = _backup_before_write(path, original)
        except OSError as exc:
            raise ValueError(f"Could not back up {path.name}: {exc}") from exc
    try:
        _atomic_write_bytes(path, payload)
    except (OSError, ValueError) as exc:
        raise ValueError(f"Could not write {path.name}: {exc}") from exc
    return {"bytes": len(payload), "backup": str(spare) if spare else None}


# ---------------------------------------------------------------------------
# Attack object context (Phase 6: what the map was doing at each attack)
# ---------------------------------------------------------------------------

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


def attack_object_context(times: np.ndarray, weights: np.ndarray,
                          beatmap: dict,
                          tolerance_ms: float = OBJECT_WINDOW_MS) -> list[dict]:
    """Per-attack map context for the hitsound decision (Phase 6, first row).

    For every attack: the nearest hitobject start inside the tolerance (object
    starts only — slider ends and repeat hits stay future work, stated here so
    nobody assumes them), the object spacing around it, a coarse pattern class
    (stream/jump/single/none), the running combo, and the object's existing
    hitsound. Attack times arrive in seconds (engine convention, like beats)
    and are reported in milliseconds (map convention, like objects).
    Unparsed objects still match by time — their sound is unknown,
    not their position. Attacks with no object nearby come back with nulls,
    never invented context. All plain JSON types.
    """
    try:
        hitobjects = [o for o in beatmap.get("hitobjects", [])
                      if isinstance(o, dict) and np.isfinite(o.get("time", float("nan")))]
    except (TypeError, ValueError):
        hitobjects = []
    hitobjects.sort(key=lambda o: o["time"])

    combos: list[int] = []
    combo = 0
    for obj in hitobjects:
        if obj.get("new_combo"):
            combo += 1
        combos.append(combo)

    rows: list[dict] = []
    times = np.asarray(times, dtype=np.float64) * 1000.0
    weights = np.asarray(weights, dtype=np.float64)
    for n, attack in enumerate(times):
        weight = float(weights[n]) if n < weights.size else 0.0
        best, best_dt = -1, float("inf")
        for i, obj in enumerate(hitobjects):
            dt = abs(float(obj["time"]) - float(attack))
            if dt < best_dt:
                best, best_dt = i, dt
        if best < 0 or best_dt > tolerance_ms:
            rows.append({"time": float(attack), "weight": weight, "object": None,
                         "spacing_prev_ms": None, "spacing_next_ms": None,
                         "step_px": None, "pattern": "none", "combo": None,
                         "new_combo": False, "hitsound": {}})
            continue
        obj = hitobjects[best]
        prev = hitobjects[best - 1] if best > 0 else None
        nxt = hitobjects[best + 1] if best + 1 < len(hitobjects) else None
        gap_prev = float(obj["time"] - prev["time"]) if prev else None
        gap_next = float(nxt["time"] - obj["time"]) if nxt else None
        step_prev = _object_step(obj, prev)
        step_next = _object_step(obj, nxt)
        pattern, step_px = _pattern_class(gap_prev, step_prev, gap_next, step_next)
        if step_px is None:
            step_px = step_prev
        sample = obj.get("hit_sample") or {}
        rows.append({
            "time": float(attack), "weight": weight,
            "object": {"kind": obj.get("kind"), "time": float(obj["time"]),
                       "dt_ms": float(obj["time"]) - float(attack),
                       "x": obj.get("x"), "y": obj.get("y")},
            "spacing_prev_ms": gap_prev, "spacing_next_ms": gap_next,
            "step_px": step_prev,
            "pattern": pattern, "combo": combos[best],
            "new_combo": bool(obj.get("new_combo")),
            "hitsound": {"sound": int(obj.get("hit_sound", 0)),
                         "sample": {k: sample.get(k) for k in
                                    ("normal_set", "addition_set", "index", "volume", "file")}},
        })
    return rows


def _object_step(obj: dict, other: dict | None) -> float | None:
    """Playfield distance in pixels, None when either end lacks a position."""
    if other is None:
        return None
    try:
        return float(np.hypot(obj["x"] - other["x"], obj["y"] - other["y"]))
    except (TypeError, KeyError):
        return None


def _pattern_class(gap_prev: float | None, step_prev: float | None,
                   gap_next: float | None, step_next: float | None
                   ) -> tuple[str, float | None]:
    """Coarse pattern class plus the deciding step (nearest neighbour first).

    Shared by the object context and the density report so both mean the same
    thing by stream and jump. No neighbour with a position: single.
    """
    gaps = [(g, s) for g, s in ((gap_prev, step_prev), (gap_next, step_next))
            if g is not None and s is not None]
    if not gaps:
        return "single", None
    gap, step = min(gaps, key=lambda gs: gs[0])
    if gap < STREAM_GAP_MS and step < STREAM_STEP_PX:
        return "stream", step
    if step >= JUMP_STEP_PX and gap < JUMP_GAP_MS:
        return "jump", step
    return "single", step


def alignment_report(analysis: Analysis, beatmap: dict,
                     tolerance_ms: float = OBJECT_WINDOW_MS) -> dict:
    """Objects not on attacks; strong attacks with no object (Phase 7, row 3).

    Objects match their nearest attack start,     slider ends excluded like in the
    context — an end is a release, not a hit to land. Only attacks at half the
    strongest weight or above can leave an object uncovered: ghost notes stay
    unmapped on purpose, and flagging them would be noise, not signal. Attack
    times arrive in seconds (engine convention) and are reported in
    milliseconds (map convention). Findings
    stay summarized (counts plus worst case) rather than one banner per object
    because a real map holds hundreds. Legacy analyses carry no attacks, so
    they report that instead of inventing alignment. All plain JSON types.
    """
    times = np.asarray(getattr(analysis, "attack_times", []), dtype=np.float64) * 1000.0
    weights = np.asarray(getattr(analysis, "attack_weights", []), dtype=np.float64)
    try:
        objects = [(float(o["time"]), o.get("kind")) for o in beatmap.get("hitobjects", [])
                   if isinstance(o, dict) and np.isfinite(o.get("time", float("nan")))]
    except (TypeError, ValueError):
        objects = []
    objects.sort()
    otimes = np.array([t for t, _kind in objects])
    if times.size == 0:
        return {"objects": len(objects), "matched": 0, "attacks": 0, "covered": 0,
                "offenders": [], "uncovered": [],
                "findings": [{"level": "info", "key": "no_attacks",
                              "index": -1, "values": {}}]}

    offenders: list[dict] = []
    for time, kind in objects:
        near = _nearest_sorted(times, time)
        ms = abs(time - near)
        if ms > tolerance_ms:
            offenders.append({"time": time, "kind": kind, "ms": round(ms, 1)})

    peak = float(weights.max()) if weights.size else 0.0
    strong = times if peak <= 0 else times[np.asarray(weights) >= 0.5 * peak]
    uncovered: list[float] = []
    for attack in strong:
        if otimes.size == 0 or abs(float(attack) - _nearest_sorted(otimes, float(attack))) > tolerance_ms:
            uncovered.append(round(float(attack), 1))

    findings: list[dict] = []
    if offenders:
        worst = max(o["ms"] for o in offenders)
        findings.append({"level": "warn", "key": "objects_off_grid", "index": -1,
                         "values": {"n": len(offenders), "worst": worst}})
    if uncovered:
        findings.append({"level": "warn", "key": "attacks_without_objects", "index": -1,
                         "values": {"n": len(uncovered)}})
    return {"objects": len(objects), "matched": len(objects) - len(offenders),
            "attacks": int(times.size), "covered": int(len(strong) - len(uncovered)),
            "offenders": offenders, "uncovered": uncovered, "findings": findings}


def density_report(beatmap: dict, bucket_s: float = 5.0) -> dict:
    """Objects per second plus stream/jump/single breakdown over time (P7).

    Buckets cover the map from 0 to the last object; every bucket reports its
    count, rate and pattern split using the same rule as the object context.
    Spinners and holds count once at their start — the report measures hit
    density, not held time. Empty maps report zeros, and everything stays
    plain JSON types.
    """
    if bucket_s <= 0:
        raise ValueError("Bucket length must be positive.")
    try:
        objects = [o for o in beatmap.get("hitobjects", [])
                   if isinstance(o, dict) and np.isfinite(o.get("time", float("nan")))]
    except (TypeError, ValueError):
        objects = []
    objects.sort(key=lambda o: o["time"])
    if not objects:
        return {"objects": 0, "buckets": [], "peak_per_second": 0.0,
                "mean_per_second": 0.0, "stream": 0, "jump": 0, "single": 0}
    kinds: list[str] = []
    for i, obj in enumerate(objects):
        prev = objects[i - 1] if i > 0 else None
        nxt = objects[i + 1] if i + 1 < len(objects) else None
        gap_prev = float(obj["time"] - prev["time"]) if prev else None
        gap_next = float(nxt["time"] - obj["time"]) if nxt else None
        pattern, _step = _pattern_class(gap_prev, _object_step(obj, prev),
                                        gap_next, _object_step(obj, nxt))
        kinds.append(pattern)
    last_ms = float(objects[-1]["time"])
    span_s = last_ms / 1000.0
    count = max(1, int(np.ceil(span_s / bucket_s)))
    buckets: list[dict] = []
    for b in range(count):
        t0, t1 = b * bucket_s, (b + 1) * bucket_s
        in_bucket = [k for o, k in zip(objects, kinds)
                     if t0 <= o["time"] / 1000.0 < t1 or (b == count - 1 and o["time"] / 1000.0 == t1)]
        buckets.append({"t0": round(t0, 2), "t1": round(t1, 2), "objects": len(in_bucket),
                        "per_second": round(len(in_bucket) / bucket_s, 2),
                        "stream": in_bucket.count("stream"),
                        "jump": in_bucket.count("jump"),
                        "single": in_bucket.count("single")})
    rates = [b["per_second"] for b in buckets]
    totals = {kind: kinds.count(kind) for kind in ("stream", "jump", "single")}
    return {"objects": len(objects), "buckets": buckets,
            "peak_per_second": max(rates), "mean_per_second": round(sum(rates) / len(rates), 2),
            **totals}


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


def _snap_of(time_ms: float, reds: list[tuple[float, float]]) -> dict:
    """Where one time sits on a red-line grid: the coarsest divisor it hits
    within OBJECT_SNAP_TOLERANCE_MS, or the nearest tick it misses."""
    governing = reds[0]
    for red in reds:
        if red[0] <= time_ms + 1e-9:
            governing = red
    offset, bpm = governing
    beat_ms = 60000.0 / bpm
    position = (time_ms - offset) / beat_ms
    best = None
    for divisor in SNAP_DIVISORS:
        tick = round(position * divisor) / divisor
        off = time_ms - (offset + tick * beat_ms)
        if abs(off) <= OBJECT_SNAP_TOLERANCE_MS:
            return {"divisor": divisor, "off_ms": off, "snapped": True}
        if best is None or abs(off) < abs(best["off_ms"]) - 1e-9:
            best = {"divisor": divisor, "off_ms": off, "snapped": False}
    return best


def snap_audit(beatmap: dict, analysis: Analysis | None = None,
               duration_s: float | None = None) -> dict:
    """Objects off the map's own grid, and what a new timing would unsnap
    (Phase 7, "Snap audit").

    Every object start is placed on the red line governing it at the snap
    divisors the editor offers (1/1 to 1/16). An object on none of them within
    OBJECT_SNAP_TOLERANCE_MS is listed with the nearest tick and how far it misses.
    Objects before the first red line and, given the audio length, past its
    end are listed too. With an analysis, the same audit runs against the red
    lines an inject would write, and the report says how many objects that
    would move off the grid and how many it would put back on — the question
    to ask before injecting. Starts only, like the alignment check: slider
    ends follow from length and slider velocity, and spinner and hold ends are
    not audited yet. Nothing is changed. All plain JSON types.
    """
    reds = sorted(beatmap.get("timing", {}).get("reds", []))
    objects = [o for o in beatmap.get("hitobjects", []) if "time" in o]
    unparsed = sum(1 for o in beatmap.get("hitobjects", []) if "time" not in o)
    if not reds:
        return {"ok": False, "reason": "no_red_lines", "objects": len(objects),
                "unparsed": unparsed}
    audited, histogram = [], {str(d): 0 for d in SNAP_DIVISORS}
    for obj in objects:
        snap = _snap_of(float(obj["time"]), reds)
        audited.append((obj, snap))
        if snap["snapped"]:
            histogram[str(snap["divisor"])] += 1
    unsnapped = [{"time_ms": float(obj["time"]), "kind": obj.get("kind", "unparsed"),
                  "nearest_divisor": snap["divisor"], "off_ms": round(snap["off_ms"], 3)}
                 for obj, snap in audited if not snap["snapped"]]
    report = {
        "ok": True,
        "objects": len(objects),
        "unparsed": unparsed,
        "red_lines": len(reds),
        "snapped": len(objects) - len(unsnapped),
        "by_divisor": histogram,
        "unsnapped": unsnapped,
        "before_first_red": [float(o["time"]) for o in objects if o["time"] < reds[0][0]],
        "past_audio": ([float(o["time"]) for o in objects if o["time"] > duration_s * 1000.0]
                       if duration_s is not None else None),
    }
    if analysis is not None:
        detected = [(p.offset_ms, p.bpm) for p in snap_timing_points(analysis.points)
                    if np.isfinite(p.offset_ms) and p.bpm > 0]
        if detected:
            detected.sort()
            would_unsnap, would_snap = [], 0
            for obj, snap in audited:
                after = _snap_of(float(obj["time"]), detected)
                if snap["snapped"] and not after["snapped"]:
                    would_unsnap.append({"time_ms": float(obj["time"]),
                                         "nearest_divisor": after["divisor"],
                                         "off_ms": round(after["off_ms"], 3)})
                elif after["snapped"] and not snap["snapped"]:
                    would_snap += 1
            report["with_detected_timing"] = {"would_unsnap": would_unsnap,
                                              "would_snap": would_snap}
    return report


def suggest_missing_lines(analysis: Analysis, beatmap: dict,
                          tolerance_beats: float = 1.0) -> list[dict]:
    """Detected sections with no nearby map red (Phase 9: timing suggestions).

    For every detected point past the first, the nearest map red line; when
    none sits within ``tolerance_beats`` of the detected tempo, the detector
    hears a change the map does not have. Proposals, never auto-fixes — Phase 7
    consents first. Each is ``{"index", "offset_ms", "bpm", "nearest_ms"}``
    with plain JSON types; a map with no reds proposes every section past the
    first, which is exactly timing-from-scratch assistance.
    """
    if tolerance_beats <= 0:
        raise ValueError("Tolerance must be positive.")
    detected = snap_timing_points(list(getattr(analysis, "points", None) or []))
    try:
        reds = [float(offset) for offset, _bpm in beatmap.get("timing", {}).get("reds", [])]
    except (TypeError, ValueError):
        reds = []
    reds.sort()
    suggestions: list[dict] = []
    for n in range(1, len(detected)):
        point = detected[n]
        if not np.isfinite(point.bpm) or point.bpm <= 0 or not np.isfinite(point.offset_ms):
            continue
        beat_ms = 60000.0 / point.bpm
        nearest = min((abs(red - point.offset_ms) for red in reds), default=float("inf"))
        if nearest > tolerance_beats * beat_ms:
            suggestions.append({"index": n, "offset_ms": point.offset_ms,
                                "bpm": point.bpm,
                                # Infinity is not JSON: no red line reads as null.
                                "nearest_ms": None if nearest == float("inf") else nearest})
    return suggestions


def _nearest_sorted(values: np.ndarray, target: float) -> float:
    """Nearest entry of a sorted array (binary search, edges included)."""
    idx = int(np.searchsorted(values, target))
    candidates = [v for v in (idx - 1, idx) if 0 <= v < values.size]
    if not candidates:
        return float("inf")
    return float(min((values[v] for v in candidates), key=lambda v: abs(v - target)))


# ---------------------------------------------------------------------------
# Mapset check (proposal P1): what every difficulty of one set must share
# ---------------------------------------------------------------------------

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


def _mapset_difficulty_name(path: Path, beatmap: dict | None) -> str:
    """The difficulty name: ``Version`` when the map has one, else the file's."""
    version = str(((beatmap or {}).get("metadata") or {}).get("Version", "")).strip()
    if version:
        return version
    bracket = re.search(r"\[([^\]]+)\]\s*$", path.stem)
    return bracket.group(1) if bracket else path.stem


def _mapset_timing_lines(beatmap: dict) -> list[dict]:
    """Every timing line with usable numbers, red or green, in file order.

    The parsed ``timing`` view keeps reds as ``(offset, bpm)`` only; this
    check needs the beat length as written, the meter and the kiai bit, so it
    reads the raw section. Lines without numbers are skipped, never fatal.
    """
    section = next((s for s in beatmap.get("sections", [])
                    if s.get("name") == "TimingPoints"), None)
    lines: list[dict] = []
    for raw in (section or {}).get("lines", []):
        text = str(raw).strip()
        if not text or text.startswith("//"):
            continue
        fields = text.split(",")
        try:
            time_ms = float(fields[0])
            beat_length = float(fields[1])
        except (ValueError, IndexError):
            continue
        if not (np.isfinite(time_ms) and np.isfinite(beat_length)):
            continue
        meter: int | str = 4
        if len(fields) > 2 and fields[2].strip():
            try:
                meter = int(fields[2])
            except ValueError:
                meter = fields[2].strip()  # compared as written, not guessed
        try:
            effects = int(fields[7]) if len(fields) > 7 and fields[7].strip() else 0
        except ValueError:
            effects = 0
        lines.append({"time": time_ms, "beat_length": beat_length, "meter": meter,
                      "red": _is_red_line(text) and beat_length > 0,
                      "kiai": bool(effects & 1)})
    return lines


def _mapset_kiai_spans(lines: list[dict]) -> list[dict]:
    """Kiai on/off spans; ``end_ms`` None means kiai runs to the end of the map."""
    spans: list[dict] = []
    active, start = False, 0.0
    for line in sorted(lines, key=lambda item: item["time"]):  # stable: file order at ties
        if line["kiai"] == active:
            continue
        if line["kiai"]:
            start = line["time"]
        elif line["time"] > start:
            spans.append({"start_ms": start, "end_ms": line["time"]})
        active = line["kiai"]
    if active:
        spans.append({"start_ms": start, "end_ms": None})
    return spans


def _mapset_red_differences(reference: list[dict], other: list[dict]) -> list[dict]:
    """How ``other``'s red lines differ from ``reference``'s, one entry each.

    Lines pair on an identical offset first; a leftover within half a
    reference beat of a leftover is the same line moved (``offset``). Paired
    lines then compare beat length (within ``MAPSET_BEAT_TOLERANCE_MS``) and
    meter. Whatever stays unpaired is ``missing`` from, or ``extra`` in,
    ``other``. Sorted by offset.
    """
    ref_left, other_left = list(reference), list(other)
    pairs: list[tuple[dict, dict]] = []
    diffs: list[dict] = []
    for red in reference:
        match = next((o for o in other_left if o["time"] == red["time"]), None)
        if match is not None:
            other_left.remove(match)
            ref_left.remove(red)
            pairs.append((red, match))
    for red in sorted(ref_left, key=lambda item: item["time"]):
        near = min(other_left, key=lambda o: abs(o["time"] - red["time"]), default=None)
        if near is None or abs(near["time"] - red["time"]) > 0.5 * red["beat_length"]:
            continue
        other_left.remove(near)
        ref_left.remove(red)
        pairs.append((red, near))
        diffs.append({"offset_ms": red["time"], "kind": "offset",
                      "expected": red["time"], "found": near["time"]})
    for red, found in pairs:
        if abs(red["beat_length"] - found["beat_length"]) > MAPSET_BEAT_TOLERANCE_MS:
            diffs.append({"offset_ms": red["time"], "kind": "beat_length",
                          "expected": red["beat_length"], "found": found["beat_length"]})
        if red["meter"] != found["meter"]:
            diffs.append({"offset_ms": red["time"], "kind": "meter",
                          "expected": red["meter"], "found": found["meter"]})
    diffs += [{"offset_ms": red["time"], "kind": "missing", "expected": red["time"],
               "found": None} for red in ref_left]
    diffs += [{"offset_ms": extra["time"], "kind": "extra", "expected": None,
               "found": extra["time"]} for extra in other_left]
    return sorted(diffs, key=lambda d: d["offset_ms"])


def _mapset_field_key(field_name: str, value: str | None):
    """What two values of one field must share to count as the same setting."""
    if field_name in _MAPSET_GENERAL_DEFAULTS:
        if value is None or not value.strip():
            return _MAPSET_GENERAL_DEFAULTS[field_name]
        try:
            number = float(value)
        except ValueError:
            return value
        return number if np.isfinite(number) else value
    if field_name == "Tags" and value is not None:
        return frozenset(value.split())  # order and spacing carry no meaning
    return value


def mapset_report(folder: str | os.PathLike[str]) -> dict:
    """Every difficulty of one beatmap folder, checked for what must match.

    Read only: differences are listed, never fixed. Compared across
    difficulties: red lines (offset exactly as written, beat length within
    ``MAPSET_BEAT_TOLERANCE_MS``, meter), ``AudioFilename``/``PreviewTime``/
    ``AudioLeadIn`` (osu!'s defaults stand in for a missing number) and the
    metadata in ``MAPSET_METADATA_FIELDS`` (tags as a set of words). Reported
    per difficulty for information: kiai spans, and object density from
    ``density_report`` -- objects per second, not a star rating.

    Red lines are compared against one reference difficulty: the one the
    most others match exactly (first in file order on a tie), so a single
    odd difficulty is the one that shows up, not everything compared to it.
    Fields use the value most difficulties share. A file that cannot be read
    is reported with the reason and left out of the comparison; it never
    stops the rest. Raises ``ValueError`` only when ``folder`` is not a
    folder. Plain JSON types throughout.
    """
    scan = scan_beatmap_folder(folder)
    difficulties: list[dict] = []
    parsed: list[tuple[dict, dict, list[dict]]] = []
    for name in scan["beatmaps"]:
        path = Path(name)
        entry: dict = {"file": path.name}
        try:
            beatmap = read_osu_beatmap(path)
            lines = _mapset_timing_lines(beatmap)
            density = density_report(beatmap)
        except (ValueError, OSError, TypeError, KeyError) as exc:
            entry.update({"difficulty": _mapset_difficulty_name(path, None),
                          "readable": False, "detail": str(exc)})
            difficulties.append(entry)
            continue
        reds = [line for line in lines if line["red"]]
        entry.update({
            "difficulty": _mapset_difficulty_name(path, beatmap), "readable": True,
            "reference": False, "red_lines": len(reds),
            "kiai": _mapset_kiai_spans(lines),
            "density": {"objects": density["objects"],
                        "mean_per_second": density["mean_per_second"],
                        "peak_per_second": density["peak_per_second"]},
            "checks": {"red_lines": 0, "audio": [], "metadata": []},
        })
        difficulties.append(entry)
        parsed.append((entry, beatmap, reds))

    reference = None
    red_differences: list[dict] = []
    if parsed:
        def agreeing(candidate: list[dict]) -> int:
            return sum(1 for _e, _b, reds in parsed
                       if not _mapset_red_differences(candidate, reds))
        ref_index = max(range(len(parsed)), key=lambda n: (agreeing(parsed[n][2]), -n))
        ref_entry, _ref_map, ref_reds = parsed[ref_index]
        reference = ref_entry["file"]
        ref_entry["reference"] = True
        for entry, _beatmap, reds in parsed:
            if entry is ref_entry:
                continue
            found = _mapset_red_differences(ref_reds, reds)
            entry["checks"]["red_lines"] = len(found)
            red_differences += [{"file": entry["file"], "difficulty": entry["difficulty"],
                                 **diff} for diff in found]
        # The reference's value breaks ties, so it goes first.
        parsed = [parsed[ref_index]] + parsed[:ref_index] + parsed[ref_index + 1:]

    fields: list[dict] = []
    for section, names, check in (("General", MAPSET_AUDIO_FIELDS, "audio"),
                                  ("Metadata", MAPSET_METADATA_FIELDS, "metadata")):
        for field_name in names:
            values = [(entry, (beatmap.get(section.lower()) or {}).get(field_name))
                      for entry, beatmap, _reds in parsed]
            keys = [_mapset_field_key(field_name, value) for _entry, value in values]
            common = max(dict.fromkeys(keys), key=keys.count) if keys else None
            shown = next((value for (_entry, value), key in zip(values, keys)
                          if key == common), None)
            odd = []
            for (entry, value), key in zip(values, keys):
                if key != common:
                    entry["checks"][check].append(field_name)
                    odd.append({"file": entry["file"], "difficulty": entry["difficulty"],
                                "value": value})
            fields.append({"section": section, "field": field_name,
                           "identical": not odd, "value": shown, "differences": odd})

    unreadable = sum(1 for entry in difficulties if not entry["readable"])
    field_differences = sum(len(f["differences"]) for f in fields)
    return {"folder": scan["folder"], "reference": reference,
            "difficulties": difficulties, "red_lines": red_differences,
            "fields": fields, "unreadable": unreadable,
            "differences": len(red_differences) + field_differences,
            "consistent": not red_differences and not field_differences and not unreadable}


# ---------------------------------------------------------------------------
# Reference timing (proposal P1): any map's red lines, graded by the attacks
# ---------------------------------------------------------------------------

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


def _red_line_meter(line: str) -> int:
    """The meter field of one red line; 4 when it is missing or unreadable."""
    fields = line.strip().split(",")
    try:
        meter = int(fields[2])
    except (ValueError, IndexError):
        return 4
    return meter if meter > 0 else 4


def _beatmap_red_rows(beatmap: dict) -> list[tuple[float, float, int]]:
    """Every red line as ``(offset_ms, bpm, meter)``, sorted by offset."""
    lines = next((s.get("lines", []) for s in beatmap.get("sections", [])
                  if s.get("name") == "TimingPoints"), None)
    if lines is None:
        # A beatmap built by hand (tests, callers) may carry only the view.
        return sorted((float(o), float(b), 4) for o, b in beatmap.get("timing", {}).get("reds", []))
    rows = []
    for line in lines:
        red = _parse_red_line(line)
        if red is not None:
            rows.append((red[0], red[1], _red_line_meter(line)))
    return sorted(rows)


#: The first window a span is locked in, in beats of the map. The map's grid
#: is best known at its own red line, so the fit starts there and grows
#: forward; started mid-span, a BPM 1 % off has already walked a beat away.
REFERENCE_LOCK_BEATS = 8
#: How far the fit may move the map's beat. A typed BPM is off by tenths or
#: a few percent; a fit that wanders further has found another pulse (on one
#: real song it shrank each pass until the least squares overflowed), so the
#: last fit inside the band is kept and the share says how little it explains.
REFERENCE_PERIOD_BAND = (0.8, 1.25)


def _forward_fit(times: np.ndarray, weights: np.ndarray, period: float,
                 phase: float, start: float, stop: float, lock: float) -> tuple[float, float]:
    """Lock the phase on the span's first window, then refit on windows that
    double forward from the start, so beat indices never slip."""
    lo, hi = (period * r for r in REFERENCE_PERIOD_BAND)
    span = lock
    first = (times >= start) & (times <= start + span)
    phase = _recentre_phase(times[first], weights[first], period, phase)
    while True:
        window = (times >= start) & (times <= min(stop, start + span))
        if int(window.sum()) >= 8:
            fitted, moved, _ = _refine_grid(times[window], weights[window], period, phase)
            if not lo <= fitted <= hi:
                return period, phase
            period, phase = fitted, moved
        if start + span >= stop:
            return period, phase
        span *= 2.0


def _grade_span(times: np.ndarray, weights: np.ndarray, offset_s: float,
                beat_s: float, end_s: float) -> dict:
    """Fit one red line's span at each divisor and keep the coarsest that
    explains the attacks; errors are measured against the map's own grid."""
    fits = []
    for divisor in REFERENCE_DIVISORS:
        atom = beat_s / divisor
        period, phase = _forward_fit(times, weights, atom, offset_s, offset_s, end_s,
                                     REFERENCE_LOCK_BEATS * beat_s)
        share, _coverage, rms = _grid_quality(times, weights, period, phase)
        fits.append((divisor, atom, period, phase, share, rms))
    top = max(fit[4] for fit in fits)
    divisor, atom, period, phase, share, rms = next(
        fit for fit in fits if fit[4] >= REFERENCE_DIVISOR_SLACK * top)
    # The fitted tick nearest the red line, as an error in the map's frame:
    # E(k) = E0 + k * (period - atom) along the span.
    tick = phase + np.round((offset_s - phase) / period) * period
    atoms = (end_s - offset_s) / atom
    # Standard errors of a straight line through the inliers, sampled at the
    # red line and across the span: few attacks, or loose ones, cannot
    # vouch for a 5 ms error, and saying so is the point.
    k = np.round((times - phase) / period)
    inlier = np.abs(times - (phase + k * period)) <= max(0.12 * period, 0.006)
    x = times[inlier] - offset_s
    n = int(x.size)
    sxx = float(np.sum((x - x.mean()) ** 2)) if n else 0.0
    # Infinity is not JSON: an error with no spread to measure reads as null.
    offset_se = drift_se = None
    if n >= 3 and sxx > 0:
        sigma = rms / 1000.0
        offset_se = float(sigma * np.sqrt(1.0 / n + x.mean() ** 2 / sxx)) * 1000.0
        drift_se = float(sigma * (end_s - offset_s) / np.sqrt(sxx)) * 1000.0
    return {"divisor": divisor, "share": share, "residual_ms": rms, "inliers": n,
            "offset_error_ms": float(tick - offset_s) * 1000.0,
            "drift_ms": atoms * (period - atom) * 1000.0,
            "offset_se_ms": offset_se, "drift_se_ms": drift_se,
            "fitted_bpm": 60.0 / (period * divisor)}


def grade_reference_timing(beatmap: dict, attack_times: np.ndarray,
                           attack_weights: np.ndarray,
                           duration_s: float | None = None) -> dict:
    """Grade each red line of any .osu against the audio's attacks (P19).

    Every red line governs its span, up to the next red line (the last one up
    to its last attack). The attacks in a span are fitted with the engine's
    own tools, started from the map's grid: the phase goes to the densest
    cluster of attacks (``_recentre_phase``), then least squares
    (``_refine_grid``) follows the tempo the attacks keep, on windows that
    double forward from the red line. That is read at 1/1, 1/2, 1/3 and 1/4
    of the map's beat, and the coarsest subdivision that explains nearly as
    much weight as the best is kept.

    Per line: ``share`` of attack weight on the fitted grid, ``residual_ms``
    around it, ``offset_error_ms`` (positive: the attacks sit after the line,
    measured modulo one subdivision), ``drift_ms`` (how far the map's grid has
    walked from the attacks by the span's end) and ``fitted_bpm``. The map's
    common shift is the median offset, weighted by attacks; it is reported
    once (``ref_shift``) rather than on every line. A line whose offset leaves
    it (``relative_ms``), or whose drift grows, by more than 5 ms and more than
    two of its own standard errors is ``check``, with ``issues`` saying which. Lines with too few attacks, or a grid that
    explains too little, are ``too_few`` or ``weak`` instead of guessed.
    Nothing is changed and everything is plain JSON types.
    """
    rows = _beatmap_red_rows(beatmap)
    times = np.asarray(attack_times, dtype=np.float64)
    weights = np.asarray(attack_weights, dtype=np.float64)
    if not rows:
        return {"ok": False, "reason": "no_red_lines"}
    if times.size == 0:
        return {"ok": False, "reason": "no_attacks"}
    order = np.argsort(times)
    times, weights = times[order], weights[order]

    lines: list[dict] = []
    for n, (offset_ms, bpm, meter) in enumerate(rows):
        start_s = offset_ms / 1000.0
        beat_s = 60.0 / bpm
        # An attack up to half the finest subdivision early still belongs to
        # the line it opens, not to the one before.
        slack = 0.5 * beat_s / max(REFERENCE_DIVISORS)
        last = n + 1 == len(rows)
        lo = start_s - slack
        hi = np.inf if last else rows[n + 1][0] / 1000.0 - slack
        inside = (times >= lo) & (times < hi)
        span_t, span_w = times[inside], weights[inside]
        end_s = rows[n + 1][0] / 1000.0 if not last else (
            float(span_t[-1]) if span_t.size else start_s)
        if duration_s is not None and last:
            end_s = min(end_s, float(duration_s))
        line = {"index": n, "offset_ms": offset_ms, "bpm": bpm, "meter": meter,
                "end_ms": end_s * 1000.0, "attacks": int(span_t.size),
                "verdict": "too_few", "issues": []}
        if span_t.size >= REFERENCE_MIN_ATTACKS and end_s > start_s:
            line.update(_grade_span(span_t, span_w, start_s, beat_s, end_s))
            line["verdict"] = "weak" if line["share"] < REFERENCE_MIN_SHARE else "ok"
        lines.append(line)

    # Offsets are judged against the map's own common shift, not against
    # zero: on real songs every line of a ranked map reads 12-46 ms before
    # the attacks, MP3 and OGG alike, and that is not explained yet (roadmap,
    # Phase 22). The shift is reported once; a line that leaves it is flagged.
    graded = [line for line in lines if line["verdict"] == "ok"]
    common = (_weighted_median(np.array([line["offset_error_ms"] for line in graded]),
                               np.array([float(line["attacks"]) for line in graded]))
              if graded else None)

    def beyond(error: float, se: float | None) -> bool:
        # Past 5 ms and past twice its own standard error: a real error, not
        # the spread of a few loose attacks. No spread measured, no verdict.
        return se is not None and abs(error) > max(REFERENCE_TOLERANCE_MS,
                                                   REFERENCE_SIGMAS * se)

    for line in graded:
        line["relative_ms"] = line["offset_error_ms"] - common
        if beyond(line["relative_ms"], line["offset_se_ms"]):
            line["issues"].append("offset")
        if beyond(line["drift_ms"], line["drift_se_ms"]):
            line["issues"].append("drift")
        if line["issues"]:
            line["verdict"] = "check"
    findings: list[dict] = []
    if common is not None and abs(common) > REFERENCE_TOLERANCE_MS:
        findings.append({"level": "info", "key": "ref_shift", "index": -1,
                         "values": {"ms": f"{common:+.1f}"}})
    # Two lines 10 ms apart have no majority: the median takes one side and
    # flags the other, which may be the right one. Say that no side won.
    # Lines vote, not attacks: each is one decision of the mapper's.
    agree = sum(1 for line in graded if "offset" not in line["issues"])
    if len(graded) > 1 and 2 * agree <= len(graded):
        findings.append({"level": "warn", "key": "ref_split", "index": -1,
                         "values": {"n": len(graded)}})
    first_s, first_beat = rows[0][0] / 1000.0, 60.0 / rows[0][1]
    early = int(np.sum(times < first_s - 0.5 * first_beat / max(REFERENCE_DIVISORS)))
    if early:
        findings.append({"level": "info", "key": "ref_before", "index": -1,
                         "values": {"n": early}})
    counts = {verdict: sum(1 for line in lines if line["verdict"] == verdict)
              for verdict in ("ok", "check", "weak", "too_few")}
    return {"ok": True, "lines": lines, "common_offset_ms": common,
            "counts": counts, "findings": findings}


def reference_points(beatmap: dict, beats: np.ndarray | None = None) -> list[TimingPoint]:
    """A map's red lines as the working timing: the mapper vouches for them.

    Each becomes a hand-placed point (confidence 1.0, ``manual`` so export
    snapping never moves it) carrying the line's own meter as a known bar.
    Raises ``ValueError`` when the map has no red lines to load.
    """
    rows = _beatmap_red_rows(beatmap)
    if not rows:
        raise ValueError("This map has no red lines to load.")
    beats = np.zeros(0) if beats is None else np.asarray(beats, dtype=np.float64)
    return [TimingPoint(offset, bpm, 1.0, _nearest_beat_index(beats, offset),
                        meter, True, manual=True) for offset, bpm, meter in rows]


def _file_digest(path: Path) -> str:
    import hashlib
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def same_audio(osu_path: str | os.PathLike[str], beatmap: dict,
               audio_path: str | os.PathLike[str]) -> bool | None:
    """Whether a map's AudioFilename holds the same bytes as ``audio_path``.

    None when either file is missing: a name alone proves nothing, since two
    encodes of one song share names and offsets do not transfer between them.
    """
    named = str((beatmap.get("general") or {}).get("AudioFilename", "")).strip()
    mine, theirs = Path(audio_path), Path(osu_path).parent / named
    if not named or not mine.is_file() or not theirs.is_file():
        return None
    try:
        if mine.stat().st_size != theirs.stat().st_size:
            return False
        return _file_digest(mine) == _file_digest(theirs)
    except OSError:
        return None


def find_same_audio_maps(audio_path: str | os.PathLike[str],
                         root: str | os.PathLike[str]) -> dict:
    """Every beatmap under ``root`` whose audio is byte for byte this file.

    Walks ``root`` and one level of folders below it, the shape of an osu!
    Songs folder. Only audio files of the same size are hashed, so a whole
    Songs folder costs a directory listing plus a hash or two. Each match
    lists the .osu files in its folder that name that audio. Plain types.
    """
    audio = Path(audio_path)
    base = Path(root)
    if not audio.is_file():
        raise ValueError(f"{audio} is not a file.")
    if not base.is_dir():
        raise ValueError(f"{base} is not a folder.")
    size = audio.stat().st_size
    want: str | None = None
    # os.scandir, not Path.iterdir: on Windows each entry carries its size, so
    # a 4,800-set Songs folder (59,000 audio files with the hitsound samples)
    # costs a listing, not a stat per file. iterdir took 9-21 s on one.
    try:
        with os.scandir(base) as entries:
            folders = [base] + sorted(Path(e.path) for e in entries if e.is_dir())
    except OSError as exc:
        raise ValueError(f"Could not list {base}: {exc}") from exc
    scanned = same_size = 0
    matches: list[dict] = []
    for folder in folders:
        try:
            with os.scandir(folder) as entries:
                files = sorted((e for e in entries if e.is_file()), key=lambda e: e.name)
        except OSError:
            continue
        for entry in files:
            if os.path.splitext(entry.name)[1].lower() not in AUDIO_EXTENSIONS:
                continue
            scanned += 1
            try:
                if entry.stat().st_size != size:
                    continue
                same_size += 1
                want = want or _file_digest(audio)
                if _file_digest(Path(entry.path)) != want:
                    continue
            except OSError:
                continue
            candidate = Path(entry.path)
            beatmaps = []
            for osu in (Path(e.path) for e in files if e.name.lower().endswith(".osu")):
                try:
                    beatmap = read_osu_beatmap(osu)
                except (ValueError, OSError):
                    continue
                named = str(beatmap["general"].get("AudioFilename", "")).strip()
                if named.lower() == candidate.name.lower():
                    beatmaps.append({"path": str(osu),
                                     "difficulty": _mapset_difficulty_name(osu, beatmap)})
            matches.append({"folder": str(folder), "audio": str(candidate),
                            "beatmaps": beatmaps})
    return {"root": str(base), "scanned": scanned, "same_size": same_size,
            "matches": matches}


# ---------------------------------------------------------------------------
# Hitsounds (Phase 6, P-1): every object as the sounds osu! plays for it
# ---------------------------------------------------------------------------

#: hitSound bits. The normal sound always plays; these three are additions.
HIT_WHISTLE, HIT_FINISH, HIT_CLAP = 2, 4, 8
#: Sample sets as the format numbers them; 0 means "inherit".
SAMPLE_SET_NAMES = {1: "normal", 2: "soft", 3: "drum"}
#: A sound takes the timing point in force this long after it, as osu!lazer's
#: legacy decoder does, so a green line placed a hair late still reaches the
#: object it was meant for. Stable's own rule is not verified here.
SAMPLE_LENIENCY_MS = 5.0


def _addition_names(bits: int) -> list[str]:
    return [name for bit, name in ((HIT_WHISTLE, "whistle"), (HIT_FINISH, "finish"),
                                   (HIT_CLAP, "clap")) if bits & bit]


def _sample_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class _TimingCursor:
    """What the timing points say at any time, in any query order: the red
    line's beat length, slider velocity, sample set, index and volume.
    Before the first point, the first point's settings apply, as in osu!."""

    def __init__(self, beatmap: dict) -> None:
        import bisect
        self._bisect = bisect.bisect_right
        section = next((s for s in beatmap.get("sections", [])
                        if s.get("name") == "TimingPoints"), None)
        rows = []
        for order, raw in enumerate((section or {}).get("lines", [])):
            text = str(raw).strip()
            if not text or text.startswith("//"):
                continue
            fields = _timing_point_fields(text)
            if fields is None or not (np.isfinite(fields["time"])
                                      and np.isfinite(fields["beat_length"])):
                continue
            fields["order"] = order
            rows.append(fields)
        rows = _ordered(rows)
        self.times = [r["time"] for r in rows]
        self.states: list[tuple[float | None, _PlayState]] = []
        beat, state = None, None
        for r in rows:
            if r["red"] and r["beat_length"] > 0:
                beat = r["beat_length"]
            state = _apply_point(state, r)
            self.states.append((beat, state))
        first_beat = next((r["beat_length"] for r in rows if r["red"] and r["beat_length"] > 0),
                          None)
        # A green line before the first red one still needs a beat length.
        self.states = [(b if b is not None else first_beat, s) for b, s in self.states]

    def at(self, time_ms: float) -> tuple[float | None, "_PlayState | None"]:
        if not self.states:
            return None, None
        i = self._bisect(self.times, time_ms + 1e-6) - 1
        return self.states[max(i, 0)]


def _event_sample(state: "_PlayState | None", default_set: int, normal_raw: int,
                  addition_raw: int, index_raw: int, volume_raw: int, file: str) -> dict:
    """One sound's sample, resolved the way osu! resolves it: the object's own
    value where it set one, else the timing point's, else the map's default.
    The additions' set follows the normal sound's set when it is 0."""
    point_set = state.sample_set if state is not None and state.sample_set in SAMPLE_SET_NAMES \
        else default_set
    normal = normal_raw if normal_raw in SAMPLE_SET_NAMES else point_set
    addition = addition_raw if addition_raw in SAMPLE_SET_NAMES else normal
    return {"normal_set": SAMPLE_SET_NAMES[normal], "addition_set": SAMPLE_SET_NAMES[addition],
            "index": index_raw if index_raw > 0 else (state.sample_index if state else 0),
            "volume": volume_raw if volume_raw > 0 else (state.volume if state else 100),
            "file": file,
            "raw": {"normal_set": normal_raw, "addition_set": addition_raw,
                    "index": index_raw, "volume": volume_raw, "file": file}}


def sound_events(beatmap: dict) -> list[dict]:
    """Every sound a map's objects make, resolved to what osu! plays (P-1).

    A circle and a mania hold sound at their start; a spinner at its end. A
    slider sounds at each edge (head, every repeat, tail), each with its own
    ``edgeSounds`` bits and ``edgeSets`` sets where the map gives them, the
    slider's own otherwise, and its body carries the slide (plus the whistle
    slide when the slider's whistle bit is set). Slider ticks are not events:
    they take no hitsound of their own in the format.

    Resolution follows osu!lazer's legacy decoder: each sound reads the
    timing point in force ``SAMPLE_LENIENCY_MS`` after it (a body reads the
    slider's end); an object's set of 0 inherits the timing point's, and a
    timing point's 0 the map's ``SampleSet``; an addition set of 0 follows
    the normal set; index and volume of 0 inherit. A custom ``filename``
    plays alone, in place of the named samples. Every event keeps the raw
    values beside the resolved ones, so a copy or an edit writes what the
    map wrote, not what it resolved to. Plain JSON types, in object order.
    """
    cursor = _TimingCursor(beatmap)
    general = beatmap.get("general") or {}
    default_set = {"normal": 1, "soft": 2, "drum": 3}.get(
        str(general.get("SampleSet", "Normal")).strip().lower(), 1)
    try:
        multiplier = float((beatmap.get("difficulty") or {}).get("SliderMultiplier", 1.4))
    except (TypeError, ValueError):
        multiplier = 1.4
    if not np.isfinite(multiplier) or multiplier <= 0:
        multiplier = 1.4

    events: list[dict] = []

    def emit(obj_index: int, part: str, edge, time_ms: float, bits: int, normal_raw: int,
             addition_raw: int, sample: dict, resolve_at: float, end_ms=None) -> None:
        _beat, state = cursor.at(resolve_at + SAMPLE_LENIENCY_MS)
        resolved = _event_sample(state, default_set, normal_raw, addition_raw,
                                 _sample_int(sample.get("index")),
                                 _sample_int(sample.get("volume")), str(sample.get("file") or ""))
        if part == "body":
            names = ["slide"] + (["whistle"] if bits & HIT_WHISTLE else [])
        else:
            names = ["normal"] + _addition_names(bits)
        events.append({"object": obj_index, "part": part, "edge": edge,
                       "time": round(float(time_ms), 3),
                       "end": None if end_ms is None else round(float(end_ms), 3),
                       "bits": int(bits), "sounds": names, **resolved})

    for n, obj in enumerate(beatmap.get("hitobjects", [])):
        kind = obj.get("kind")
        if kind not in ("circle", "slider", "spinner", "hold") or "time" not in obj:
            continue
        sample = obj.get("hit_sample") or {}
        bits = _sample_int(obj.get("hit_sound"))
        normal_raw = _sample_int(sample.get("normal_set"))
        addition_raw = _sample_int(sample.get("addition_set"))
        start = float(obj["time"])
        if kind in ("circle", "hold"):
            emit(n, kind, None, start, bits, normal_raw, addition_raw, sample, start)
        elif kind == "spinner":
            end = float(obj.get("end_time", start))
            emit(n, "spinner_end", None, end, bits, normal_raw, addition_raw, sample, end)
        else:
            beat, state = cursor.at(start)
            sv = state.sv if state is not None else 1.0
            slides = max(1, _sample_int(obj.get("slides"), 1))
            length = float(obj.get("length", 0.0) or 0.0)
            span = (length / (multiplier * 100.0 * sv) * beat
                    if beat and sv > 0 and length > 0 and np.isfinite(length) else None)
            edge_bits = [_sample_int(b) for b in str(obj.get("edge_sounds") or "").split("|")
                         if b.strip()]
            edge_sets = []
            for pair in str(obj.get("edge_sets") or "").split("|"):
                if pair.strip():
                    normal, _, addition = pair.partition(":")
                    edge_sets.append((_sample_int(normal), _sample_int(addition)))
            for k in range(slides + 1):
                if span is None and k > 0:
                    break                       # no timing to place the edges on
                at = start + k * (span or 0.0)
                part = "head" if k == 0 else "tail" if k == slides else "repeat"
                e_normal, e_addition = edge_sets[k] if k < len(edge_sets) else (normal_raw,
                                                                                  addition_raw)
                emit(n, part, k, at, edge_bits[k] if k < len(edge_bits) else bits,
                     e_normal, e_addition, sample, at)
            if span is not None:
                end = start + slides * span
                emit(n, "body", None, start, bits, normal_raw, addition_raw, sample, end, end)
    return events


# -- P-2: the hitsound fields of a hit object line, and nothing else ---------

_SAMPLE_KEYS = ("normal_set", "addition_set", "index", "volume", "file")


def _check_hitsound_values(bits=None, sample=None, edges=None) -> None:
    """Refuse what osu! could not read, before anything is written."""
    if bits is not None and not (isinstance(bits, int) and 0 <= bits <= 15):
        raise ValueError(f"hitSound must be 0-15, got {bits!r}.")
    for key, value in (sample or {}).items():
        if key not in _SAMPLE_KEYS:
            raise ValueError(f"Unknown sample field {key!r}.")
        if key == "file":
            if any(c in str(value) for c in ",:|\r\n"):
                raise ValueError("A sample file name cannot hold , : | or a line break.")
        elif key in ("normal_set", "addition_set"):
            if value not in SAMPLE_SET_NAMES and value != 0:
                raise ValueError(f"{key} must be 0-3, got {value!r}.")
        elif key == "index" and not (isinstance(value, int) and value >= 0):
            raise ValueError(f"index must be 0 or more, got {value!r}.")
        elif key == "volume" and not (isinstance(value, int) and 0 <= value <= 100):
            raise ValueError(f"volume must be 0-100, got {value!r}.")
    for edge in edges or []:
        _check_hitsound_values(edge.get("bits"),
                               {k: v for k, v in edge.items() if k in ("normal_set", "addition_set")})


def _sample_text(original: str | None, changes: dict) -> str:
    """``normal:addition:index:volume:file`` with ``changes`` applied, the
    original text untouched when nothing in it changes."""
    parsed = _parse_hit_sample(original or "")
    if original is not None and all(parsed.get(k) == v for k, v in changes.items()):
        return original
    merged = {**{k: parsed.get(k) for k in _SAMPLE_KEYS}, **changes}
    return ":".join(str(merged[k] if merged[k] is not None else (0 if k != "file" else ""))
                    for k in _SAMPLE_KEYS)


def _edited_object_line(line: str, obj: dict, change: dict) -> str:
    fields = line.split(",")
    bits = change.get("bits")
    sample = change.get("sample") or {}
    edges = change.get("edges")
    old_bits = int(obj.get("hit_sound", 0))
    kind = obj.get("kind")
    if kind == "unparsed":
        raise ValueError(f"Object at line {line!r} cannot be read, so it is not edited.")
    if bits is not None and bits != old_bits:
        fields[4] = str(bits)
    if kind == "circle":
        where = 5
    elif kind == "spinner":
        where = 6
    elif kind == "hold":
        where = None
    else:                                           # slider
        where = 10
        slides = int(obj.get("slides", 1))
        old_sample = obj.get("hit_sample") or {}
        if edges is not None and len(edges) != slides + 1:
            raise ValueError(f"A slider with {slides} slide(s) has {slides + 1} edges, "
                             f"not {len(edges)}.")
        have_bits = [b for b in str(obj.get("edge_sounds") or "").split("|") if b.strip()]
        have_sets = [s for s in str(obj.get("edge_sets") or "").split("|") if s.strip()]
        # An edge without its own field plays the slider's bits and sets, so a
        # change to those would reach the edges too: fill the missing fields
        # first with what the edges play now, and the change stays the body's.
        # (A copy that removed a whistle only the body had took it off every
        # edge of 16 sliders on 300 local mapsets before this.)
        incomplete = len(have_bits) != slides + 1 or len(have_sets) != slides + 1
        body_changes = (bits is not None and bits != old_bits) or \
            any(k in sample for k in ("normal_set", "addition_set")) or (sample and len(fields) <= 8)
        if edges is not None or (incomplete and body_changes):
            cur_bits = [int(have_bits[k]) if k < len(have_bits) else old_bits
                        for k in range(slides + 1)]
            cur_sets = []
            for k in range(slides + 1):
                if k < len(have_sets):
                    normal, _, addition = have_sets[k].partition(":")
                    cur_sets.append((_sample_int(normal), _sample_int(addition)))
                else:
                    cur_sets.append((_sample_int(old_sample.get("normal_set")),
                                     _sample_int(old_sample.get("addition_set"))))
            new_bits, new_sets = list(cur_bits), list(cur_sets)
            for k, edge in enumerate(edges or []):
                if edge.get("bits") is not None:
                    new_bits[k] = edge["bits"]
                new_sets[k] = (edge.get("normal_set", new_sets[k][0]),
                               edge.get("addition_set", new_sets[k][1]))
            while len(fields) < 10:
                fields.append("")
            if new_bits != cur_bits or len(have_bits) != slides + 1:
                fields[8] = "|".join(str(b) for b in new_bits)
            if new_sets != cur_sets or len(have_sets) != slides + 1:
                fields[9] = "|".join(f"{n}:{a}" for n, a in new_sets)
    if sample:
        if where is None:                          # hold: endTime:sample in one field
            end, _, text = fields[5].partition(":")
            fields[5] = end + ":" + _sample_text(text, sample)
        else:
            while len(fields) <= where:
                fields.append(None)
            fields[where] = _sample_text(fields[where], sample)
    return ",".join("" if f is None else f for f in fields)


def set_object_hitsounds(beatmap: dict, changes: dict[int, dict]) -> dict:
    """Change the hitsounds of some objects, in place (P-2).

    ``changes`` maps an index into ``beatmap["hitobjects"]`` to what changes:
    ``bits`` (the hitSound field), ``sample`` (any of ``normal_set``,
    ``addition_set``, ``index``, ``volume``, ``file``) and, for a slider,
    ``edges``: one dict per edge, head to tail, with any of ``bits``,
    ``normal_set``, ``addition_set``. Only those fields of those lines are
    rewritten, and a line whose values do not change keeps its exact text,
    so a write of nothing is the file it read. Values osu! could not read
    are refused before anything changes. Returns the indices changed.
    """
    section = next((s for s in beatmap.get("sections", []) if s["name"] == "HitObjects"), None)
    if section is None:
        raise ValueError("No [HitObjects] section in this beatmap.")
    line_of = [i for i, line in enumerate(section["lines"])
               if line.strip() and not line.strip().startswith("//")]
    objects = beatmap.get("hitobjects", [])
    edits: dict[int, str] = {}
    for n, change in changes.items():
        if not (isinstance(n, int) and 0 <= n < len(objects) == len(line_of)):
            raise ValueError(f"No object {n!r} in this beatmap.")
        _check_hitsound_values(change.get("bits"), change.get("sample"), change.get("edges"))
        old = section["lines"][line_of[n]]
        new = _edited_object_line(old, objects[n], change)
        if new != old:
            edits[n] = new
    for n, new in edits.items():
        section["lines"][line_of[n]] = new
        objects[n] = _parse_hit_object(new)
    return {"changed": sorted(edits)}


def write_object_hitsounds(osu_path: str | os.PathLike[str], changes: dict[int, dict],
                           backup: bool = True, dry_run: bool = False) -> dict:
    """``set_object_hitsounds`` on a file, as edits over its own text (P-2).

    The file is not rebuilt: each changed object line is replaced where it
    stands, keeping its own line ending, and every other byte (BOM, stray
    line endings, sections the reader never looks at) stays as it was. No
    change, no write: the file and its backups are not touched. Otherwise the
    write is atomic and backed up by inject's rules (a pristine ``.bak``,
    then ``.bak2``... never overwritten). Returns ``changed`` (object
    indices), ``written`` and ``backup`` (the path holding the old bytes).
    """
    path = Path(osu_path)
    original = path.read_bytes() if path.is_file() else None
    beatmap = read_osu_beatmap(path)
    result = set_object_hitsounds(beatmap, changes)
    if not result["changed"] or dry_run:
        return {**result, "written": False, "backup": None}
    text, bom = _load_osu_text(path)
    lines = text.splitlines(keepends=True)
    start = next((i for i, line in enumerate(lines) if line.strip() == "[HitObjects]"), None)
    if start is None:
        raise ValueError("No [HitObjects] section in this beatmap.")
    object_lines = []
    for i in range(start + 1, len(lines)):
        stripped = lines[i].strip()
        if stripped.startswith("[") and stripped.endswith("]") and len(stripped) > 2:
            break
        if stripped and not stripped.startswith("//"):
            object_lines.append(i)
    section = next(s for s in beatmap["sections"] if s["name"] == "HitObjects")
    edited = [line for line in section["lines"] if line.strip() and not line.strip().startswith("//")]
    for n in result["changed"]:
        i = object_lines[n]
        body = lines[i].rstrip("\r\n")
        lines[i] = edited[n] + lines[i][len(body):]
    payload = "".join(lines).encode("utf-8-sig" if bom else "utf-8")
    spare = None
    if backup and original is not None:
        try:
            spare = _backup_before_write(path, original)
        except OSError as exc:
            raise ValueError(f"Could not back up {path.name}: {exc}") from exc
    try:
        _atomic_write_bytes(path, payload)
    except (OSError, ValueError) as exc:
        raise ValueError(f"Could not write {path.name}: {exc}") from exc
    return {**result, "written": True, "backup": str(spare) if spare else None}


# -- H1: one difficulty's hitsounds onto another -----------------------------

#: How far apart two sounds may be and still be one moment in two
#: difficulties. A set's difficulties share their timing, so their objects
#: land on the same milliseconds; 5 ms absorbs rounding and hand placement
#: and stays under a 1/16 at 240 BPM (15.6 ms).
COPY_TOLERANCE_MS = 5.0
_SET_NUMBER = {name: number for number, name in SAMPLE_SET_NAMES.items()}


def _copy_fields(source: dict, cursor: "_TimingCursor", default_set: int, at: float,
                 volumes: bool) -> tuple[dict, bool]:
    """What to write so a target sound at ``at`` resolves like ``source``.

    The source's own raw values when they resolve the same way under the
    target's timing points (a copy writes what the mapper wrote), explicit
    values where they would not. Returns the fields and whether the sample
    index could be matched: an object's index of 0 means "the timing
    point's", so an index-0 sound cannot be forced over a green line that
    sets another index.
    """
    _beat, state = cursor.at(at + SAMPLE_LENIENCY_MS)
    raw = source["raw"]

    def resolves(normal, addition, index, volume):
        got = _event_sample(state, default_set, normal, addition, index, volume, "")
        return got

    normal = raw["normal_set"] if raw["normal_set"] in (0, *SAMPLE_SET_NAMES) else 0
    addition = raw["addition_set"] if raw["addition_set"] in (0, *SAMPLE_SET_NAMES) else 0
    got = resolves(normal, addition, 0, 0)
    if got["normal_set"] != source["normal_set"]:
        normal = _SET_NUMBER[source["normal_set"]]
    got = resolves(normal, addition, 0, 0)
    if got["addition_set"] != source["addition_set"]:
        addition = 0 if source["addition_set"] == source["normal_set"] \
            else _SET_NUMBER[source["addition_set"]]
    fields = {"normal_set": normal, "addition_set": addition}
    index_ok = True
    index = raw["index"] if isinstance(raw["index"], int) and raw["index"] >= 0 else 0
    if resolves(normal, addition, index, 0)["index"] != source["index"]:
        if source["index"] > 0:
            index = source["index"]
        else:
            index_ok = False                     # 0 inherits; it cannot be forced
    fields["index"] = index
    if volumes:
        volume = raw["volume"] if isinstance(raw["volume"], int) and 0 <= raw["volume"] <= 100 else 0
        if resolves(normal, addition, index, volume)["volume"] != source["volume"]:
            volume = source["volume"]
        fields["volume"] = volume
    fields["file"] = source["file"]
    return fields, index_ok


def copy_hitsounds(source: dict, target: dict, tolerance_ms: float = COPY_TOLERANCE_MS,
                   volumes: bool = False) -> dict:
    """What makes ``target`` sound like ``source`` where their objects meet (H1).

    Each of the target's sounds (a circle, each slider edge, a spinner's
    end, a hold) takes the source sound at the same moment, within
    ``tolerance_ms``: its additions, its sample sets and index, its custom
    file, and its volume when ``volumes`` is set (off by default: volume is
    usually the green lines' job, and those are not copied). A slider's body
    takes the whistle of a source slider starting with it. Sounds with no
    source sound are left as they are. Only sounds that would change are
    written, so copying a difficulty onto itself changes nothing.

    Returns ``changes`` for ``set_object_hitsounds`` and the counts a
    preview shows: target sounds, matched, changed, unmatched (with the
    first times), source sounds nothing took, and index conflicts.
    """
    import bisect
    src_all = sound_events(source)
    src = sorted((e for e in src_all if e["part"] != "body"), key=lambda e: e["time"])
    src_times = [e["time"] for e in src]
    src_bodies = sorted((e for e in src_all if e["part"] == "body"), key=lambda e: e["time"])
    body_times = [e["time"] for e in src_bodies]
    used: set[int] = set()

    def nearest(times, t):
        i = bisect.bisect_left(times, t)
        best = None
        for j in (i - 1, i):
            if 0 <= j < len(times) and abs(times[j] - t) <= tolerance_ms + 1e-9:
                if best is None or abs(times[j] - t) < abs(times[best] - t):
                    best = j
        return best

    cursor = _TimingCursor(target)
    default_set = {"normal": 1, "soft": 2, "drum": 3}.get(
        str((target.get("general") or {}).get("SampleSet", "Normal")).strip().lower(), 1)
    keys = ("sounds", "normal_set", "addition_set", "index", "file") + (("volume",) if volumes else ())
    by_object: dict[int, list[dict]] = {}
    for event in sound_events(target):
        by_object.setdefault(event["object"], []).append(event)

    changes: dict[int, dict] = {}
    counts = {"target_sounds": 0, "matched": 0, "changed": 0, "index_conflicts": 0}
    unmatched: list[float] = []
    for n, events in by_object.items():
        obj = target["hitobjects"][n]
        points = [e for e in events if e["part"] != "body"]
        body = next((e for e in events if e["part"] == "body"), None)
        wanted: dict[int, tuple[dict, dict]] = {}          # edge (or 0) -> (event, source)
        for e in points:
            counts["target_sounds"] += 1
            j = nearest(src_times, e["time"])
            if j is None:
                unmatched.append(e["time"])
                continue
            counts["matched"] += 1
            used.add(j)
            if all(e[k] == src[j][k] for k in keys):
                continue
            counts["changed"] += 1
            wanted[e["edge"] or 0] = (e, src[j])
        body_bits = None
        if body is not None:
            b = nearest(body_times, body["time"])
            if b is not None and (src_bodies[b]["bits"] & HIT_WHISTLE) != (body["bits"] & HIT_WHISTLE):
                body_bits = (body["bits"] & ~HIT_WHISTLE) | (src_bodies[b]["bits"] & HIT_WHISTLE)
        if not wanted and body_bits is None:
            continue
        change: dict = {}
        if obj["kind"] == "slider":
            # One index for the whole slider: the head's. An edge whose source
            # sound uses another one cannot take it, and counts as a conflict.
            head = wanted.get(0)
            slider_index = (_copy_fields(head[1], cursor, default_set, head[0]["time"], volumes)[0]["index"]
                            if head else _sample_int((obj.get("hit_sample") or {}).get("index")))
            edges = []
            for e in points:
                edge = {"bits": e["bits"] & 15, "normal_set": e["raw"]["normal_set"],
                        "addition_set": e["raw"]["addition_set"]}
                if e["edge"] in wanted:
                    _e, s = wanted[e["edge"]]
                    fields, ok = _copy_fields(s, cursor, default_set, e["time"], volumes)
                    counts["index_conflicts"] += not ok or (e["edge"] != 0 and fields["index"] != slider_index)
                    edge = {"bits": (e["bits"] & 1) | (s["bits"] & 14),
                            "normal_set": fields["normal_set"], "addition_set": fields["addition_set"]}
                    if e["edge"] == 0:           # the slider's own sample: index, volume, file
                        change["sample"] = {k: fields[k] for k in fields
                                            if k in ("index", "volume", "file")}
                edges.append(edge)
            if wanted:
                change["edges"] = edges
            if body_bits is not None:
                change["bits"] = body_bits & 15
        else:
            e, s = wanted[0]
            fields, ok = _copy_fields(s, cursor, default_set, e["time"], volumes)
            counts["index_conflicts"] += not ok
            change = {"bits": (e["bits"] & 1) | (s["bits"] & 14), "sample": fields}
        changes[n] = change
    return {"changes": changes, **counts, "unmatched": len(unmatched),
            "unmatched_times": [round(t, 1) for t in unmatched[:20]],
            "source_sounds": len(src), "source_unused": len(src) - len(used)}


# ---------------------------------------------------------------------------
# Structure view (Phase 19): the Rust engine's phrases, on this song's bars
# ---------------------------------------------------------------------------

#: A phrase boundary moves to a proven downbeat at most this far. The
#: boundaries sit on a 0.5 s feature grid and the Rust tests hold them within
#: 1.5 s of the truth; past that, the nearest bar line is another phrase's.
STRUCTURE_SNAP_S = 1.5
#: Points the energy lane keeps: enough for a wide window, few for the bridge.
STRUCTURE_LANE_POINTS = 800


def downbeat_times(analysis: Analysis) -> list[tuple[float, bool]]:
    """Every bar line the red lines imply, as ``(seconds, proven)``.

    The bars ``click_schedule`` accents, by the same rules: each red line
    counts bars from its own offset, in its own meter when it proved one,
    else in the song's. ``proven`` is True where the line's bar was proved
    by the accents or set by the mapper; a bar counted on a guessed meter
    is a bar line, but not evidence for a phrase.
    """
    points = snap_timing_points(list(getattr(analysis, "points", None) or []))
    duration = float(getattr(analysis, "duration", 0.0) or 0.0)
    try:
        song_bar = max(1, min(16, int(str(getattr(analysis, "meter", "4/4")).split("/")[0])))
    except (ValueError, TypeError):
        song_bar = 4
    out: list[tuple[float, bool]] = []
    for s, point in enumerate(points):
        if not np.isfinite(point.bpm) or point.bpm <= 0 or not np.isfinite(point.offset_ms):
            continue
        proven = bool(point.meter_known or point.manual)
        bar = max(1, int(point.meter or 4)) if point.meter_known else song_bar
        start = point.offset_ms / 1000.0
        end = duration if s + 1 == len(points) else points[s + 1].offset_ms / 1000.0
        step = bar * 60.0 / point.bpm
        for k in range(MAX_CLICKS_PER_LINE):
            t = start + k * step
            if t >= end - 1e-6 and not (s + 1 == len(points) and t <= end + 1e-6):
                break
            out.append((t, proven))
    return out


def _pooled_lane(values: list[float], hop: float, points: int) -> dict:
    """The energy lane at most ``points`` long: each point the loudest of the
    windows it covers, so a short hit survives the pooling."""
    energy = np.asarray(values, dtype=np.float64)
    if energy.size == 0:
        return {"values": [], "hop": hop}
    factor = max(1, int(np.ceil(energy.size / points)))
    usable = energy[: energy.size - energy.size % factor] if factor > 1 else energy
    pooled = usable.reshape(-1, factor).max(axis=1) if factor > 1 else usable
    if factor > 1 and energy.size % factor:
        pooled = np.append(pooled, energy[energy.size - energy.size % factor:].max())
    peak = float(pooled.max()) or 1.0
    return {"values": [round(float(v) / peak, 4) for v in pooled], "hop": hop * factor}


def structure_view(report: dict, analysis: Analysis) -> dict:
    """The Structure view of one song: phrases snapped to proven downbeats,
    each label beside the evidence it rests on. Plain types.

    ``report`` is ``overtone-cli structure``'s JSON. Each inner boundary
    moves to the nearest proven downbeat within ``STRUCTURE_SNAP_S`` and
    says how far it moved; one with no proven downbeat that close stays on
    the 0.5 s feature grid and says so. The song's start and end never move.

    Labels are the Rust rules' (repetition, then level); ``why`` names the
    rule that decided each one, with the numbers it read. Groups are letters
    by first appearance, so "A B A B" reads at a glance whatever the labels.
    """
    duration = float(report.get("duration") or getattr(analysis, "duration", 0.0) or 0.0)
    bars = downbeat_times(analysis)
    proven = np.asarray([t for t, known in bars if known], dtype=np.float64)
    every = np.asarray([t for t, _known in bars], dtype=np.float64)
    raw = list(report.get("sections") or [])

    def snap(t: float) -> tuple[float, float | None]:
        if proven.size == 0:
            return t, None
        nearest = float(proven[np.argmin(np.abs(proven - t))])
        return (nearest, nearest - t) if abs(nearest - t) <= STRUCTURE_SNAP_S else (t, None)

    def bar_number(t: float) -> int | None:
        # 1 from the first red line's bar; None before it, where no bar is counted.
        count = int(np.searchsorted(every, t + 1e-6, side="right")) if every.size else 0
        return count or None

    def power(section: dict) -> float:
        return 10.0 ** (float(section["level_db"]) / 10.0)

    families: dict[int, list[dict]] = {}
    for section in raw:
        families.setdefault(int(section["group"]), []).append(section)
    family_db = {g: 10.0 * np.log10(max(np.mean([power(s) for s in members]), 1e-12))
                 for g, members in families.items()}
    repeated = sorted((g for g, members in families.items() if len(members) >= 2),
                      key=lambda g: family_db[g], reverse=True)

    sections: list[dict] = []
    for i, section in enumerate(raw):
        start, end = float(section["start_s"]), float(section["end_s"])
        start_to, start_moved = (start, None) if i == 0 else snap(start)
        end_to = end if i + 1 == len(raw) else snap(end)[0]
        kind, group = str(section["kind"]), int(section["group"])
        repeats = int(section["repeats"])
        if kind == "chorus":
            louder = family_db[group] - family_db[repeated[1]] if len(repeated) > 1 else None
            why = {"rule": "chorus_loudest", "repeats": repeats,
                   "over_db": None if louder is None else round(float(louder), 1)}
        elif kind == "verse" and len(raw) == 1:
            why = {"rule": "verse_single"}
        elif kind == "verse" and len(repeated) >= 2:
            why = {"rule": "verse_quieter", "repeats": repeats,
                   "under_db": round(float(family_db[repeated[0]] - family_db[group]), 1)}
        elif kind == "verse":
            why = {"rule": "verse_one_family", "repeats": repeats}
        elif kind == "intro":
            why = {"rule": "intro_first", "length_s": round(end - start, 1),
                   "max_s": (report.get("rules") or {}).get("intro_max_s")}
        elif kind == "outro":
            why = {"rule": "outro_last"}
        else:
            why = {"rule": "bridge_once"}
        sections.append({
            "index": i, "kind": kind, "group": chr(ord("A") + group) if group < 26 else str(group),
            "repeats": repeats, "level_db": round(float(section["level_db"]), 1),
            "start_s": round(start_to, 4), "end_s": round(end_to, 4),
            "raw_start_s": start, "moved_ms": None if start_moved is None else round(start_moved * 1000, 1),
            "snapped": i == 0 or start_moved is not None, "bar": bar_number(start_to),
            "why": why,
        })
    one_family = len(families) == 1 and len(raw) > 1
    return {
        "duration": duration,
        "sections": sections,
        "families": len(families),
        "one_family": one_family,
        "proven_bars": int(proven.size),
        "bars": int(every.size),
        "lane": _pooled_lane(report.get("energy") or [], float(report.get("energy_hop") or 0.5),
                             STRUCTURE_LANE_POINTS),
        "rules": report.get("rules") or {},
        "snap_s": STRUCTURE_SNAP_S,
        "timings_s": report.get("timings_s") or {},
    }


# ---------------------------------------------------------------------------
# Assisted timing (proposal P1): two marked downbeats seed the grid
# ---------------------------------------------------------------------------

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


def _snap_mark(times: np.ndarray, weights: np.ndarray, mark: float, reach: float) -> float:
    """The strongest attack within ``reach`` of a mark, or the mark itself."""
    near = np.abs(times - mark) <= reach
    if not near.any():
        return mark
    candidates = np.flatnonzero(near)
    return float(times[candidates[int(np.argmax(weights[candidates]))]])


def _chunk_fits(times: np.ndarray, weights: np.ndarray, period: float, phase: float,
                a: float, b: float, min_share: float) -> bool | None:
    """Whether the attacks in (a, b] land on the grid; None when too few to say."""
    chunk = (times > a) & (times <= b)
    if int(chunk.sum()) < 3:
        return None
    share, _coverage, rms = _grid_quality(times[chunk], weights[chunk], period, phase,
                                          tol_ratio=0.11)
    return share >= min_share and rms <= ASSISTED_GROW_RMS * period * 1000.0


def _another_grid(times: np.ndarray, weights: np.ndarray, period: float,
                  lo: float, hi: float) -> bool:
    """Whether a stretch the grid does not fit holds a grid of its own.

    The engine's seed search is run on it. A grid that explains the stretch as
    well as growth demands, at a tempo other than ours up to an octave, is a
    tempo change; anything less is a gap (a breakdown, a bar of vocals) that
    the same grid may resume after. Skipping gaps alone ran secs-3's first
    145 BPM line across its 152 BPM section into the 145 after it.
    """
    fresh = _seed_grid(times, weights, lo, hi, prior_period=period, widths=(12.0, 7.0, 4.5))
    if fresh is None:
        return False
    other, other_phase = fresh
    window = (times >= lo) & (times <= hi)
    share, _coverage, _rms = _grid_quality(times[window], weights[window], other, other_phase)
    if share < ASSISTED_GROW_SHARE:
        return False
    ratio = other / period
    ratio /= 2.0 ** round(float(np.log2(ratio)))
    return abs(ratio - 1.0) > ASSISTED_SAME_GRID


def _grow_assisted(times: np.ndarray, weights: np.ndarray, period: float, phase: float,
                   lo: float, hi: float, forward: bool,
                   min_share: float) -> tuple[float, float, float]:
    """Extend a seeded grid one way while fresh chunks keep landing on it,
    refitting on everything covered so far. Returns (period, phase, edge).

    A chunk that does not fit (a breakdown, a bar of vocals alone) ends the
    span only if the grid does not come back within ``ASSISTED_GAP_S``: on 30
    ranked maps, stopping at the first one covered a median 31 % of the line.
    """
    band = (period * REFERENCE_PERIOD_BAND[0], period * REFERENCE_PERIOD_BAND[1])
    finish = float(times[-1]) if forward else float(times[0])
    edge = hi if forward else lo
    while (edge < finish) if forward else (edge > finish):
        step = max(2.0, 4.0 * period)
        nxt = min(finish, edge + step) if forward else max(finish, edge - step)
        a, b = (edge, nxt) if forward else (nxt - 1e-9, edge - 1e-9)
        fits = _chunk_fits(times, weights, period, phase, a, b, min_share)
        if fits is False:
            # A stretch that holds another grid is a tempo change: stop there.
            window = ((edge, min(finish, edge + ASSISTED_CHANGE_WINDOW_S)) if forward
                      else (max(finish, edge - ASSISTED_CHANGE_WINDOW_S), edge))
            if _another_grid(times, weights, period, *window):
                break
            # One with no grid is a gap: resume where the same grid holds again.
            resume = None
            probe = nxt
            while resume is None and abs(probe - edge) <= ASSISTED_GAP_S and (
                    (probe < finish) if forward else (probe > finish)):
                after = min(finish, probe + step) if forward else max(finish, probe - step)
                pa, pb = (probe, after) if forward else (after - 1e-9, probe - 1e-9)
                if _chunk_fits(times, weights, period, phase, pa, pb, min_share):
                    resume = after
                probe = after
            if resume is None:
                break
            nxt, fits = resume, True
        if fits:
            if forward:
                whole = (times >= lo - 0.5 * period) & (times <= nxt)
            else:
                whole = (times >= nxt) & (times <= hi + 0.5 * period)
            fitted, moved, _ = _refine_grid(times[whole], weights[whole], period, phase)
            if not band[0] <= fitted <= band[1]:
                break
            period, phase = fitted, moved
        edge = nxt
        if forward:
            hi = edge
        else:
            lo = edge
    return period, phase, _settle_edge(times, weights, period, phase, edge, forward)


def _settle_edge(times: np.ndarray, weights: np.ndarray, period: float, phase: float,
                 edge: float, forward: bool) -> float:
    """Where the grid really stops, inside the last chunk that passed.

    A chunk passes with most, not all, of its weight on the grid, so the last
    one can carry up to a step of the next tempo: at a 150 -> 120 BPM change at 31 s
    the span ran to 32.2 s, and adding the line would have dropped the real
    change. The attacks of the last two steps are scored +weight on the grid
    and -weight off it; the edge is the attack that closes the best-scoring
    run from the inside.
    """
    reach = 2.0 * max(2.0, 4.0 * period)
    if forward:
        region = (times > edge - reach) & (times <= edge)
    else:
        region = (times >= edge) & (times < edge + reach)
    t, w = times[region], weights[region]
    if t.size == 0:
        return edge
    k = np.round((t - phase) / period)
    on = np.abs(t - (phase + k * period)) <= max(0.11 * period, 0.006)
    signed = np.where(on, w, -w)
    if not forward:
        t, signed = t[::-1], signed[::-1]
    run = np.cumsum(signed)
    best = int(np.argmax(run))
    return float(t[best]) if run[best] > 0 else edge


def assisted_grid(attack_times: np.ndarray, attack_weights: np.ndarray,
                  first_ms: float, second_ms: float, bars: int = 1,
                  meter: int = 4) -> dict:
    """One red line from two downbeats the user marked (P19, assisted timing).

    Where the detector refuses or reads the wrong octave or bar, the user
    knows two things it does not: where a bar starts, and how many bars lie
    between two marks. That fixes the beat, ``(second - first) / (bars *
    meter)``, and the downbeat. Each mark first snaps to the strongest attack
    near it. The attacks then do the rest: the seed is fitted around the marks
    exactly as a reference line is (the coarsest of 1/1-1/4 that explains
    them), and grows backward and forward while fresh chunks keep landing on
    it, as the engine grows a section. It crosses a stretch with no grid (a
    breakdown) when the same grid comes back, and stops at one that holds a
    grid of its own (a tempo change). The red line goes on the first downbeat
    of the span; how far each mark moved is reported, and a grid that held
    fewer than 16 bars is answered but marked ``short``.

    Refuses instead of guessing: marks out of order, a tempo outside 40-400
    BPM, too few attacks around the marks, a grid that explains too little of
    them, or one chance explains as well. The number of bars between the marks
    is the user's: two marks one bar apart called two bars read at double
    tempo, consistently, and nothing in the attacks can say otherwise.
    Plain JSON types.
    """
    times = np.asarray(attack_times, dtype=np.float64)
    weights = np.asarray(attack_weights, dtype=np.float64)

    def refuse(reason: str, **values) -> dict:
        return {"ok": False, "reason": reason, "values": values}

    try:
        first_s, second_s = float(first_ms) / 1000.0, float(second_ms) / 1000.0
        bars, meter = int(bars), int(meter)
    except (TypeError, ValueError):
        return refuse("bad_marks")
    if not (np.isfinite(first_s) and np.isfinite(second_s)) or second_s <= first_s:
        return refuse("bad_marks")
    if bars < 1 or meter < 1:
        return refuse("bad_marks")
    if times.size == 0:
        return refuse("no_attacks")
    order = np.argsort(times)
    times, weights = times[order], weights[order]
    # Each mark goes to the strongest attack near it before the beat is taken
    # from them, as the editor snaps a click. At 300 BPM one bar is 0.8 s, and
    # marks 15 ms late and 20 ms early made the seed 4.6 % fast: enough to slip
    # an index over the seed window and refuse a clean track.
    reach = min(ASSISTED_SNAP_BEATS * (second_s - first_s) / (bars * meter), ASSISTED_SNAP_S)
    marked = (first_s, second_s)
    first_s, second_s = (_snap_mark(times, weights, mark, reach) for mark in marked)
    if second_s <= first_s:
        return refuse("bad_marks")
    beat_s = (second_s - first_s) / (bars * meter)
    seed_bpm = 60.0 / beat_s
    if not ASSISTED_BPM_RANGE[0] <= seed_bpm <= ASSISTED_BPM_RANGE[1]:
        return refuse("bpm_range", bpm=f"{seed_bpm:.1f}")

    slack = 0.5 * beat_s / max(REFERENCE_DIVISORS)
    seed_hi = max(second_s, first_s + ASSISTED_SEED_BEATS * beat_s)
    seed = (times >= first_s - slack) & (times <= seed_hi + slack)
    if int(seed.sum()) < REFERENCE_MIN_ATTACKS:
        return refuse("too_few", n=int(seed.sum()))
    grade = _grade_span(times[seed], weights[seed], first_s, beat_s, seed_hi)
    if grade["share"] < REFERENCE_MIN_SHARE:
        return refuse("weak", share=f"{grade['share']:.2f}")
    divisor = grade["divisor"]
    period = 60.0 / (grade["fitted_bpm"] * divisor)
    phase = first_s + grade["offset_error_ms"] / 1000.0

    min_share = min(ASSISTED_GROW_SHARE,
                    max(REFERENCE_MIN_SHARE, ASSISTED_GROW_RATIO * grade["share"]))
    period, phase, lo = _grow_assisted(times, weights, period, phase,
                                       first_s, seed_hi, False, min_share)
    period, phase, hi = _grow_assisted(times, weights, period, phase,
                                       lo, seed_hi, True, min_share)
    span = (times >= lo - 0.5 * period) & (times <= hi + 0.5 * period)
    share, _coverage, rms = _grid_quality(times[span], weights[span], period, phase)
    # The engine's own test: a grid that chance explains as well is no grid,
    # whoever seeded it. Marks on white noise found a 157 BPM "grid" at 0.41.
    chance = _pulse_log10p(times[span], period, phase)
    if chance > ASSISTED_CHANCE_LOG10P:
        return refuse("chance", log10p=f"{chance:.1f}")

    beat = period * divisor
    bar = beat * meter
    downbeat = phase + np.round((first_s - phase) / period) * period
    # The red line opens the span on a downbeat: whole bars back from the mark,
    # never before the first attack the grid holds.
    offset = downbeat - np.floor((downbeat - (lo - 0.5 * period)) / bar) * bar
    second_tick = downbeat + bars * bar
    held = (hi - lo) / bar
    return {"ok": True, "offset_ms": float(offset) * 1000.0, "bpm": 60.0 / beat,
            "bars_held": float(held), "short": bool(held < ASSISTED_MIN_BARS),
            "meter": meter, "divisor": divisor, "seed_bpm": seed_bpm,
            "share": share, "residual_ms": rms,
            "start_ms": float(lo) * 1000.0, "end_ms": float(hi) * 1000.0,
            "first_shift_ms": float(downbeat - marked[0]) * 1000.0,
            "second_shift_ms": float(second_tick - marked[1]) * 1000.0}


def apply_assisted_grid(points: list[TimingPoint], fit: dict,
                        beats: np.ndarray | None = None) -> list[TimingPoint]:
    """The working timing with an assisted red line added.

    Points inside the span the grid holds are dropped: there the user's marks
    and the attacks agree on one tempo, so a detected line in between would
    only contradict it. Points outside stay, hand-placed ones included, and so
    do points in the span's last ``ASSISTED_EDGE_BEATS``: the end is known to a
    few beats (the grids of two close tempos agree that long), and a line
    there is most likely the change that ended it. On secs-3 the span ran
    0.4 s past the 152 -> 145 change and dropped its red line. The new line is
    hand-placed with its meter known.
    """
    if not fit.get("ok"):
        raise ValueError("That grid was refused; there is nothing to add.")
    start, end = float(fit["start_ms"]), float(fit["end_ms"])
    offset = float(fit["offset_ms"])
    edge = end - ASSISTED_EDGE_BEATS * 60000.0 / float(fit["bpm"])
    beats = np.zeros(0) if beats is None else np.asarray(beats, dtype=np.float64)
    kept = [p for p in points if not (min(start, offset) - 1.0 <= p.offset_ms < edge)]
    kept.append(TimingPoint(offset, float(fit["bpm"]), 1.0, _nearest_beat_index(beats, offset),
                            int(fit["meter"]), True, manual=True))
    kept.sort(key=lambda p: p.offset_ms)
    return kept


# ---------------------------------------------------------------------------
# Mod report (proposal P2): every finding as an osu! editor timestamp
# ---------------------------------------------------------------------------

#: A timestamp the osu! editor understands: minutes (any number), seconds and
#: milliseconds, then the combo numbers of the objects it names, if any.
MOD_STAMP = re.compile(r"^\d{2,}:\d{2}:\d{3}( \(\d+(,\d+)*\))?$")
#: The order sources are listed in when two findings share a moment.
MOD_SOURCES = ("reference", "suggestion", "snap", "alignment")


def mod_timestamp(time_ms: float, combo: list[int] | None = None) -> str:
    """``mm:ss:mmm (1,2)`` as modders write it; times before 0 clamp to 0."""
    whole = int(round(max(0.0, float(time_ms))))
    minutes, rest = divmod(whole, 60000)
    seconds, millis = divmod(rest, 1000)
    stamp = f"{minutes:02d}:{seconds:02d}:{millis:03d}"
    return f"{stamp} ({','.join(str(n) for n in combo)})" if combo else stamp


def mod_editor_link(stamp: str) -> str:
    """The ``osu://edit/`` link that opens the local editor at a timestamp.

    Only a well-formed timestamp becomes a link: it is handed to the shell.
    """
    if not MOD_STAMP.match(stamp or ""):
        raise ValueError(f"Not an osu! editor timestamp: {stamp!r}")
    return "osu://edit/" + stamp.replace(" ", "%20")


def _combo_numbers(objects: list[dict]) -> dict[float, int]:
    """Each object's number inside its combo, keyed by time, as the editor
    counts them: a new-combo object is 1, the next ones count up."""
    numbers: dict[float, int] = {}
    count = 0
    for obj in sorted((o for o in objects if "time" in o), key=lambda o: o["time"]):
        count = 1 if (obj.get("new_combo") or count == 0) else count + 1
        numbers.setdefault(float(obj["time"]), count)
    return numbers


def _mod_text(item: dict) -> str:
    """The English line a modder would post for one finding."""
    key, v = item["key"], item["values"]
    if key == "ref_offset":
        return (f"red line sits {v['ms']} ms from the rest of the map's offset "
                f"(±{v['se']} ms): check it by ear")
    if key == "ref_drift":
        return (f"by here the red line's grid is {v['ms']} ms off the music (±{v['se']} ms), "
                f"the attacks fit {v['bpm']} BPM")
    if key == "ref_weak":
        return f"the music does not follow this red line's grid ({v['share']}% of the attacks on it)"
    if key == "missing_line":
        return f"the tempo changes here to {v['bpm']} BPM and the map has no red line for it"
    if key == "unsnapped":
        return f"unsnapped: {v['ms']} ms off the nearest 1/{v['divisor']} tick"
    if key == "before_red":
        return "object before the first red line"
    if key == "past_audio":
        return "object after the audio ends"
    if key == "ref_split":
        return (f"the {v['n']} red lines do not agree on one offset and no majority says "
                "which are right: check them by ear")
    if key == "ref_shift":
        return (f"every red line sits {v['ms']} ms from the attacks; Overtone reads real songs "
                "about +26 ms here and why is not known, so check the offset by ear first")
    if key == "off_attack":
        # What is measured: quiet passages may hold sounds too soft to detect.
        return f"{v['ms']} ms from the nearest attack Overtone detects"
    return f"{key} {v}"


def mod_report(beatmap: dict, attack_times: np.ndarray, attack_weights: np.ndarray,
               duration_s: float | None = None, analysis: Analysis | None = None) -> dict:
    """Every finding about one difficulty, as the lines a modder would post.

    Gathers what the other checks already measure and nothing new:
    ``grade_reference_timing`` (red lines to check, with their error),
    ``suggest_missing_lines`` (tempo changes the map has no red line for;
    needs an analysis), ``snap_audit`` (objects off the map's own grid, before
    its first red line or past the audio) and ``alignment_report`` (objects
    away from any attack). Each item carries its time, an editor timestamp
    with the combo numbers of the objects it names, the number behind it, a
    level and the English line; ``text`` is the whole report, ready to paste.
    Plain JSON types. Nothing is changed.
    """
    objects = [o for o in beatmap.get("hitobjects", []) if "time" in o]
    combos = _combo_numbers(objects)
    items: list[dict] = []

    def add(source: str, level: str, key: str, time_ms: float | None, values: dict,
            on_object: bool = False) -> None:
        # No time: a finding about the whole map, posted under "General".
        if time_ms is None:
            items.append({"source": source, "level": level, "key": key, "time_ms": None,
                          "stamp": "General", "values": values})
            return
        combo = [combos[float(time_ms)]] if on_object and float(time_ms) in combos else None
        items.append({"source": source, "level": level, "key": key, "time_ms": float(time_ms),
                      "stamp": mod_timestamp(time_ms, combo), "values": values})

    times = np.asarray(attack_times, dtype=np.float64)
    weights = np.asarray(attack_weights, dtype=np.float64)
    graded = grade_reference_timing(beatmap, times, weights, duration_s)
    for finding in graded.get("findings", []):
        if finding["key"] in ("ref_split", "ref_shift"):
            add("reference", finding["level"], finding["key"], None, finding["values"])
    for line in graded.get("lines", []):
        if "offset" in line["issues"]:
            add("reference", "warn", "ref_offset", line["offset_ms"],
                {"ms": f"{line['relative_ms']:+.1f}", "se": f"{2 * line['offset_se_ms']:.1f}"})
        if "drift" in line["issues"]:
            add("reference", "warn", "ref_drift", line["end_ms"],
                {"ms": f"{line['drift_ms']:+.1f}", "se": f"{2 * line['drift_se_ms']:.1f}",
                 "bpm": f"{line['fitted_bpm']:.3f}"})
        if line["verdict"] == "weak":
            add("reference", "warn", "ref_weak", line["offset_ms"],
                {"share": f"{100 * line['share']:.0f}"})

    if analysis is not None:
        for suggestion in suggest_missing_lines(analysis, beatmap):
            add("suggestion", "info", "missing_line", suggestion["offset_ms"],
                {"bpm": f"{suggestion['bpm']:.3f}"})

    audit = snap_audit(beatmap, duration_s=duration_s)
    if audit.get("ok"):
        for obj in audit["unsnapped"]:
            add("snap", "warn", "unsnapped", obj["time_ms"],
                {"ms": f"{obj['off_ms']:+.1f}", "divisor": obj["nearest_divisor"]}, True)
        for time_ms in audit["before_first_red"]:
            add("snap", "warn", "before_red", time_ms, {}, True)
        for time_ms in audit["past_audio"] or []:
            add("snap", "warn", "past_audio", time_ms, {}, True)

    if times.size:
        from types import SimpleNamespace
        aligned = alignment_report(SimpleNamespace(attack_times=times, attack_weights=weights),
                                   beatmap)
        for obj in aligned["offenders"]:
            add("alignment", "info", "off_attack", obj["time"], {"ms": f"{obj['ms']:.1f}"}, True)

    items.sort(key=lambda item: (item["time_ms"] is not None, item["time_ms"] or 0.0,
                                 MOD_SOURCES.index(item["source"])))
    for item in items:
        item["text"] = _mod_text(item)
    counts = {source: sum(1 for item in items if item["source"] == source)
              for source in MOD_SOURCES}
    return {"items": items, "counts": counts,
            "text": "\n".join(f"{item['stamp']} - {item['text']}" for item in items)}


# ---------------------------------------------------------------------------
# Taskbar identity
# ---------------------------------------------------------------------------

#: The taskbar groups windows by application id. A process without one is
#: grouped under its executable, pythonw.exe, and shows the Python logo
#: instead of the window's own icon.
APP_USER_MODEL_ID = "Overtone.TimingWorkbench"


def claim_taskbar_identity() -> bool:
    """Give this process Overtone's own taskbar identity, so the taskbar shows
    the window's icon, not python.exe's. Call before the first window opens.
    True when Windows took it; False elsewhere or when it refused."""
    if sys.platform != "win32":
        return False
    try:
        import ctypes
        result = ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
    except (AttributeError, OSError):
        return False
    return result == 0      # S_OK


# ---------------------------------------------------------------------------
# Settings persistence
# ---------------------------------------------------------------------------

#: The type each saved preference must have. The classic window saves its
#: numbers as the text in its fields, the web shell as numbers; both are fine.
CONFIG_TYPES: dict[str, tuple[type, ...]] = {
    "cfg_version": (int,), "file": (str,), "language": (str,), "pulse": (str,),
    "delta": (int, float, str), "persistence": (int, float, str),
    "confidence": (int, float, str), "prefer_map_bpm": (bool,), "refine_beats": (bool,),
    "recent": (list,), "songs_folder": (str,),
    "song_volume": (int, float), "click_volume": (int, float), "tap_latency_ms": (int, float),
    "output_folder": (str,), "export_ask": (bool,), "offset_decimals": (int,),
    "click_subdivision": (int,), "click_accent": (bool,), "ui_scale": (int, float),
    "reduced_motion": (bool,), "theme": (str,),
}


def load_config() -> dict:
    """Read the saved preferences, tolerating anything that is not a dict.

    A truncated or hand-edited config used to crash the app on startup with an
    AttributeError, which is unrecoverable without deleting the file by hand.
    So did a value of the wrong type -- ``"cfg_version": "2"`` or
    ``"prefer_map_bpm": "on"`` stopped the classic window on every launch. A
    known key whose value has the wrong type is dropped, so its reader's
    default applies; unknown keys are kept as they are.
    """
    for path in (CONFIG_PATH, LEGACY_CONFIG_PATH):
        try:
            if not path.is_file() or path.stat().st_size > MAX_CONFIG_BYTES:
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            break
        except (OSError, ValueError):
            continue
    else:
        return {}
    if not isinstance(data, dict):
        return {}
    config = {}
    for key, value in data.items():
        key = str(key)
        allowed = CONFIG_TYPES.get(key)
        if allowed is not None:
            # bool is an int to Python; only a real bool is a flag, and a flag
            # is never a version or a number.
            if isinstance(value, bool) != (bool in allowed) or not isinstance(value, allowed):
                continue
            if key == "recent":
                value = [item for item in value if isinstance(item, str)]
        config[key] = value
    return config


def save_config(data: dict) -> None:
    """Persist preferences atomically; never let a failure break the app."""
    try:
        payload = json.dumps(data, indent=2).encode("utf-8")
        temp = CONFIG_PATH.with_name(CONFIG_PATH.name + ".part")
        temp.write_bytes(payload)
        os.replace(temp, CONFIG_PATH)
    except (OSError, TypeError, ValueError):
        pass


# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------

class TimingAnalyzerApp:
    TEXT = {
        "English": {
            "title": "Overtone", "subtitle": "Precise BPM and offsets for your beatmap",
            "source": "①  Source audio", "browse": "Browse…", "no_file": "No file selected",
            "detection": "②  Detection", "delta": "Min change (BPM)", "persistence": "Confirmation beats",
            "quality": "Min confidence (%)", "preference": "Prefer map BPM (120–300)",
            "refine": "Re-anchor beats to transients", "analyze": "⟳  Analyze",
            "tap": "Tap tempo", "tap_hint": "Click in rhythm, then compare with the result.",
            "taps": "Taps: {n}  •  {bpm}",
            "results": "③  Results", "global": "GLOBAL", "sections": "SECTIONS",
            "beats": "BEATS", "stability": "STABLE", "meter": "METER",
            "export_csv": "Export CSV", "copy": "Copy .osu", "click": "Click track…",
            "csv": "CSV",
            "inject": "Inject .osu…",
            "details": "Details…", "offset": "Offset (ms)", "beatlen": "Beat (ms)",
            "confidence": "Confidence", "overview": "TEMPO TRACE — click a row to highlight its section",
            "hint": "Tip: the presets set the trade-off — Variable catches short sections, Steady ignores wobble. BPM and offsets come from a least-squares grid fit, so they are exact to ~0.001 BPM when the song has a steady pulse; what stays a judgement call is the octave. If the BPM reads half or double (e.g. 112 instead of 225), hit ×2 or ÷2 — that is instant and exact. Export the click track and listen before mapping.",
            "pulse": "Pulse (octave)",
            "preset_variable": "⚡ Variable", "preset_steady": "🛡 Steady",
            "rescaled": "Pulse ×{factor}: {points} section(s) • {bpm} BPM. Verify with the click track.",
            "discard_title": "Discard manual edits?",
            "discard_edits": "You edited the timing points {n} time(s) since this result was made and have not exported them. This replaces them with the detected points. Continue?",
            "ready": "Choose an audio file, then press Analyze.",
            "bad_file": "Choose a valid audio file first.", "bad_values": "Parameters must be valid numbers.",
            "preparing": "Preparing analysis…", "error": "Error: {value}",
            "done": "Done: {points} timing point(s), {beats} beats • pulse {mode} • {bpm} BPM.",
            "first": "Analyze audio first.", "saved": "CSV saved: {path}",
            "click_saved": "Click track saved: {path}",
            "copied": "Red timing points copied — paste into [TimingPoints] in your .osu.",
            "normal": "normal", "confirmed": "×{factor} (confirmed subdivision)",
            "edit": "④  Edit timing points", "apply": "Apply", "add": "Add",
            "delete": "Delete", "sec_double": "2× §", "sec_halve": "÷2 §",
            "no_selection": "Select a table row first.",
            "bad_numbers": "Offset and BPM must be numbers, BPM above 0.",
            "first_locked": "§1 anchors the map and cannot be deleted.",
            "edited": "§{n} updated: {bpm} BPM @ {ms} ms.",
            "added_point": "Point added: {bpm} BPM @ {ms} ms.",
            "deleted_point": "§{n} deleted.",
            "section_rescaled": "§{n} now {bpm} BPM.",
            "suggest": "§{n} reads {bpm} BPM but off-beats suggest ×2 — press 2× § to fix.",
            "inject_confirm": "Replace {reds} red line(s), keep {greens} green line(s) in\n{file}?\nA .bak backup will be created.{warn}",
            "inject_warn": "\nWARNING: .osu audio is '{osu}', you analyzed '{src}'.",
            "inject_greens": "\nIt also adds {n} green line(s) so slider velocity and hitsounds play as before.",
            "injected": "Injected {added} red lines ({replaced} replaced, {greens} greens kept). Backup saved.",
            "all_audio": "Audio files", "all": "All files",
            "language": "Language", "file": "Audio file",
            "trace_title": "TEMPO TRACE",
            "trace_beat": "beat  {ms} ms", "trace_conf": "conf  {pct}",
            "trace_empty": "Analyze an audio file to preview its tempo trace",
            "section": "§{n}  {bpm} BPM @ {ms}",
            "menu_file": "File", "menu_export": "Export", "menu_help": "Help",
            "about": "About", "quit": "Quit",
            "about_text": "Overtone v{version}\nLocal BPM / offset detector for mapping.\nLeast-squares grid fitting; offsets exported as whole ms.\nAlways verify red lines in the osu! editor.",
            "stable_yes": "constant", "stable_var": "variable",
        },
        "Español": {
            "title": "Overtone", "subtitle": "BPM y offsets precisos para tu beatmap",
            "source": "①  Audio de origen", "browse": "Examinar…", "no_file": "Sin archivo seleccionado",
            "detection": "②  Detección", "delta": "Cambio mínimo (BPM)", "persistence": "Beats de confirmación",
            "quality": "Confianza mínima (%)", "preference": "Preferir BPM de mapa (120–300)",
            "refine": "Reanclar beats a transitorios", "analyze": "⟳  Analizar",
            "tap": "Tap tempo", "tap_hint": "Pulsa al ritmo y compara con el resultado.",
            "taps": "Toques: {n}  •  {bpm}",
            "results": "③  Resultados", "global": "GLOBAL", "sections": "SECCIONES",
            "beats": "BEATS", "stability": "ESTABLE", "meter": "COMPÁS",
            "export_csv": "Exportar CSV", "copy": "Copiar .osu", "click": "Click track…",
            "csv": "CSV", "inject": "Inyectar .osu…",
            "details": "Detalles…", "offset": "Offset (ms)", "beatlen": "Beat (ms)",
            "confidence": "Confianza", "overview": "CURVA DE TEMPO — clic en una fila para resaltar su sección",
            "hint": "Consejo: los presets fijan el equilibrio — Variable detecta secciones cortas, Estable ignora fluctuaciones. El BPM y los offsets salen de un ajuste por mínimos cuadrados, así que son exactos a ~0,001 BPM si la canción tiene pulso estable; lo que sigue siendo criterio es la octava. Si el BPM sale a la mitad o al doble (p. ej. 112 en vez de 225), pulsa ×2 o ÷2 — es instantáneo y exacto. Exporta el click track y escúchalo antes de mapear.",
            "pulse": "Pulso (octava)",
            "preset_variable": "⚡ Variable", "preset_steady": "🛡 Estable",
            "rescaled": "Pulso ×{factor}: {points} sección(es) • {bpm} BPM. Verifícalo con el click track.",
            "discard_title": "¿Descartar ediciones manuales?",
            "discard_edits": "Editaste los timing points {n} vez/veces desde este resultado y no los exportaste. Esto los reemplaza por los puntos detectados. ¿Continuar?",
            "ready": "Elige un audio y pulsa Analizar.",
            "bad_file": "Elige primero un archivo de audio válido.", "bad_values": "Los parámetros deben ser números válidos.",
            "preparing": "Preparando análisis…", "error": "Error: {value}",
            "done": "Listo: {points} punto(s), {beats} beats • pulso {mode} • {bpm} BPM.",
            "first": "Analiza un audio primero.", "saved": "CSV guardado: {path}",
            "click_saved": "Click track guardado: {path}",
            "copied": "Puntos rojos copiados — pégalos en [TimingPoints] de tu .osu.",
            "normal": "normal", "confirmed": "×{factor} (subdivisión confirmada)",
            "edit": "④  Editar timing points", "apply": "Aplicar", "add": "Añadir",
            "delete": "Borrar", "sec_double": "2× §", "sec_halve": "÷2 §",
            "no_selection": "Selecciona primero una fila de la tabla.",
            "bad_numbers": "Offset y BPM deben ser números, BPM mayor que 0.",
            "first_locked": "§1 ancla el mapa y no se puede borrar.",
            "edited": "§{n} actualizado: {bpm} BPM @ {ms} ms.",
            "added_point": "Punto añadido: {bpm} BPM @ {ms} ms.",
            "deleted_point": "§{n} borrado.",
            "section_rescaled": "§{n} ahora {bpm} BPM.",
            "suggest": "§{n} marca {bpm} BPM pero los contratiempos sugieren ×2 — pulsa 2× § para corregirlo.",
            "inject_confirm": "¿Reemplazar {reds} línea(s) roja(s), mantener {greens} verde(s) en\n{file}?\nSe creará backup .bak.{warn}",
            "inject_warn": "\nAVISO: el audio del .osu es '{osu}', analizaste '{src}'.",
            "inject_greens": "\nTambién agrega {n} línea(s) verde(s) para que la velocidad de sliders y los hitsounds suenen igual.",
            "injected": "Inyectadas {added} líneas rojas ({replaced} reemplazadas, {greens} verdes intactas). Backup guardado.",
            "all_audio": "Archivos de audio", "all": "Todos los archivos",
            "language": "Idioma", "file": "Archivo de audio",
            "trace_title": "CURVA DE TEMPO",
            "trace_beat": "beat  {ms} ms", "trace_conf": "confianza  {pct}",
            "trace_empty": "Analiza un audio para ver su curva de tempo",
            "section": "§{n}  {bpm} BPM @ {ms}",
            "menu_file": "Archivo", "menu_export": "Exportar", "menu_help": "Ayuda",
            "about": "Acerca de", "quit": "Salir",
            "about_text": "Overtone v{version}\nDetector local de BPM / offsets para mapping.\nAjuste de rejilla por mínimos cuadrados; offsets en ms enteros.\nVerifica siempre las líneas rojas en el editor de osu!.",
            "stable_yes": "constante", "stable_var": "variable",
        },
    }

    ACCENT = "#6EE7B7"

    #: Detection presets. VARIABLE is the default: tuned for songs whose BPM
    #: changes often (short sections, quick transitions). STEADY trades recall
    #: for precision on constant-tempo songs (ignores wobble, fewer red lines).
    PRESETS = {
        "variable": {"delta": "1.5", "persistence": "12", "confidence": "75"},
        "steady": {"delta": "2.0", "persistence": "20", "confidence": "85"},
    }
    CFG_VERSION = 2

    def __init__(self) -> None:
        import tkinter as tk
        from tkinter import ttk
        self.tk, self.ttk = tk, ttk
        cfg = load_config()
        claim_taskbar_identity()
        self.root = tk.Tk()
        # 1070: the Results header needs 1061 px in Spanish once its buttons
        # size to their labels (measured off-screen); at 1020 CSV was cut.
        self.root.minsize(1070, 680)
        self.root.geometry("1120x760")
        self._set_window_icon()
        # --- English is the default; Spanish stays available. ---
        # Old configs (v1) stored conservative steady-song values; migrate to
        # the variable-tempo defaults unless the user customized them in v2.
        if cfg.get("cfg_version", 1) < self.CFG_VERSION:
            fresh = {"file": cfg.get("file", ""), "language": cfg.get("language", DEFAULT_LANGUAGE),
                     "pulse": cfg.get("pulse", "Auto"),
                     "prefer_map_bpm": cfg.get("prefer_map_bpm", True),
                     "refine_beats": cfg.get("refine_beats", True)}
            cfg = fresh
        defaults = self.PRESETS["variable"]
        self.file = tk.StringVar(value=cfg.get("file", ""))
        self.delta = tk.StringVar(value=str(cfg.get("delta", defaults["delta"])))
        self.persistence = tk.StringVar(value=str(cfg.get("persistence", defaults["persistence"])))
        self.minimum_confidence = tk.StringVar(value=str(cfg.get("confidence", defaults["confidence"])))
        self.language = tk.StringVar(value=cfg.get("language", DEFAULT_LANGUAGE))
        if self.language.get() not in self.TEXT:
            self.language.set("English")
        self.pulse = tk.StringVar(value=cfg.get("pulse", "Auto"))
        self.prefer_map_bpm = tk.BooleanVar(value=cfg.get("prefer_map_bpm", True))
        self.refine_beats = tk.BooleanVar(value=cfg.get("refine_beats", True))
        self.status = tk.StringVar()
        self.tap_label = tk.StringVar()
        self.stat_vars = {key: tk.StringVar(value="—") for key in ("global", "sections", "beats", "stability")}
        self.analysis: Analysis | None = None
        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.widgets: dict[str, object] = {}
        self.taps: list[float] = []
        self.selected_section: int | None = None
        self.suggestions: dict[int, tuple[int, float]] = {}
        self._busy = False
        # Hand edits made since the last analysis, pulse change or export.
        # ×2/÷2 and Analyze rebuild the points from the detected sections, so
        # while this is non-zero they ask before throwing the edits away.
        self._manual_edits = 0
        self._theme()
        self._build()
        self._translate()
        self.root.protocol("WM_DELETE_WINDOW", self._quit)

    def _set_window_icon(self) -> None:
        """Window and taskbar icon from ``assets/``, generated by ``assets/logo.py``.

        Never allowed to break startup: a missing file, an old Tk without
        PNG support, or a headless session all fall through silently — the
        icon is decoration, the analysis is the product. The photo image is
        kept on ``self`` so Tk does not garbage-collect it mid-session.
        """
        try:
            import os
            here = os.path.dirname(os.path.abspath(__file__))
            png = os.path.join(here, "assets", "logo.png")
            if os.path.isfile(png):
                self._icon = self.tk.PhotoImage(file=png)  # kept: Tk drops it otherwise
                self.root.iconphoto(True, self._icon)
                return
            ico = os.path.join(here, "assets", "logo.ico")
            if os.path.isfile(ico):
                self.root.iconbitmap(ico)
        except Exception:
            pass

    # -- i18n ------------------------------------------------------------
    def tr(self, key: str, **values: object) -> str:
        table = self.TEXT.get(self.language.get(), self.TEXT["English"])
        return table.get(key, self.TEXT["English"].get(key, key)).format(**values)

    # -- theme -----------------------------------------------------------
    def _theme(self) -> None:
        style = self.ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        # Three greys instead of two -- cards blend into the page rather than
        # sitting on top of it. Every value chosen so a card outline of one
        # step darker is still readable.
        bg     = "#0F1420"
        panel  = "#151B28"
        panel2 = "#1B2231"
        field  = "#1F2735"
        fg     = "#E8ECF2"
        muted  = "#8892A5"
        dim    = "#5F6B80"
        border = "#232B3B"
        accent = self.ACCENT                                     # soft mint
        accent_ink = "#0A0D14"                                   # on-accent text
        accent_dim = "#3F8F73"                                   # accent, dulled
        # Tk cannot draw border-radius, so "rounded" is: taller padding, thin
        # outline, subdued hover -- reads as a pill next to the sharper table.
        self.C = {"bg": bg, "panel": panel, "panel2": panel2, "field": field,
                  "fg": fg, "muted": muted, "border": border, "accent": accent}
        self.root.configure(bg=bg)

        style.configure("TFrame", background=bg)
        style.configure("Card.TFrame", background=panel, borderwidth=1, relief="flat")
        style.configure("Stat.TFrame", background=panel2, borderwidth=1, relief="flat")

        style.configure("TLabel", background=bg, foreground=fg, font=("Segoe UI", 10))
        style.configure("Card.TLabel", background=panel, foreground=fg, font=("Segoe UI", 10))
        style.configure("Muted.TLabel", background=panel, foreground=muted, font=("Segoe UI", 9))
        style.configure("CardHead.TLabel", background=panel, foreground=fg,
                        font=("Segoe UI Semibold", 11))
        style.configure("Title.TLabel", background=bg, foreground=fg,
                        font=("Segoe UI Semibold", 22))
        style.configure("Subtitle.TLabel", background=bg, foreground=muted,
                        font=("Segoe UI", 10))
        # The version pill: an outline instead of a filled brand colour, so it
        # reads as metadata rather than a call to action.
        style.configure("Pill.TLabel", background=panel2, foreground=muted,
                        font=("Segoe UI Semibold", 9), padding=(11, 4),
                        borderwidth=1, relief="solid")
        style.configure("StatBig.TLabel", background=panel2, foreground=fg,
                        font=("Segoe UI Semibold", 22))
        style.configure("StatCap.TLabel", background=panel2, foreground=dim,
                        font=("Segoe UI Semibold", 9))
        style.configure("Status.TLabel", background=panel, foreground="#B8C1D2",
                        font=("Segoe UI", 10))

        style.configure("TEntry", fieldbackground=field, foreground=fg, insertcolor=fg,
                        borderwidth=1, relief="flat", padding=10)
        style.configure("TCombobox", fieldbackground=field, background=field,
                        foreground=fg, padding=8)
        style.map("TCombobox", fieldbackground=[("readonly", field)],
                  foreground=[("readonly", fg)])
        style.configure("TCheckbutton", background=panel, foreground=fg,
                        font=("Segoe UI", 10))
        style.map("TCheckbutton", background=[("active", panel)],
                  foreground=[("active", fg)])

        # Buttons: taller vertical padding, thin outline. Read as pills against
        # the flat table below them. Active state lifts one step; disabled
        # keeps the outline but drops the fill so it does not shout.
        # Padding tuned so the widest button row (Results: Export / Copy .osu /
        # Click track / ÷2 / ×2 / Inject / Details) still fits at the default
        # 1120 px window -- a taller value was tried and cropped "Export" to
        # "E>". A shorter one loses the pill shape. This is the compromise.
        style.configure("TButton", background=panel2, foreground=fg,
                        bordercolor=border, focuscolor=border,
                        borderwidth=1, relief="solid",
                        padding=(13, 10), font=("Segoe UI Semibold", 10))
        style.map("TButton",
                  background=[("active", "#232C40"), ("disabled", panel)],
                  foreground=[("disabled", dim)],
                  bordercolor=[("active", "#2E3852")])
        style.configure("Accent.TButton", background=accent, foreground=accent_ink,
                        borderwidth=0, relief="flat",
                        padding=(20, 12), font=("Segoe UI Semibold", 11))
        style.map("Accent.TButton",
                  background=[("active", "#8DEDC4"), ("disabled", accent_dim)],
                  foreground=[("disabled", "#22392E")])
        # Ghost buttons live in dense rows (the Results header carries seven
        # of them). width=0 lets each one size to its label: the clam theme
        # gives every TButton an 11-character minimum, so all seven asked for
        # 105 px (even ÷2 and ×2) and the header needed 1204 px (1259 in
        # Spanish) -- more than the window, which cut CSV to 21 px. Measured
        # after: 1052 px (1061 in Spanish), nothing cut at the default size.
        style.configure("Ghost.TButton", background=panel, foreground=muted,
                        bordercolor=border, borderwidth=1, relief="solid",
                        padding=(11, 8), width=0)
        style.map("Ghost.TButton",
                  background=[("active", panel2)],
                  foreground=[("active", fg)])

        style.configure("Treeview", background=panel, fieldbackground=panel,
                        foreground=fg, rowheight=32, borderwidth=0,
                        font=("Segoe UI", 10))
        style.configure("Treeview.Heading", background=panel2, foreground=muted,
                        relief="flat", font=("Segoe UI Semibold", 10),
                        padding=(12, 9))
        # Selection uses a tinted accent instead of purple -- keeps to the
        # single-accent rule.
        style.map("Treeview",
                  background=[("selected", "#1E3A32")],
                  foreground=[("selected", fg)])
        style.configure("Horizontal.TProgressbar", background=accent,
                        troughcolor=panel2, borderwidth=0, thickness=6)

    # -- layout ----------------------------------------------------------
    def _card(self, parent, title_key: str):
        frame = self.ttk.Frame(parent, style="Card.TFrame", padding=16)
        head = self.ttk.Label(frame, style="CardHead.TLabel")
        head.pack(anchor="w", pady=(0, 10))
        self.widgets[title_key] = head
        inner = self.ttk.Frame(frame, style="Card.TFrame")
        inner.pack(fill="both", expand=True)
        return frame, inner

    def _build(self) -> None:
        ttk = self.ttk
        # Menu (useful, minimal)
        import tkinter as tk
        menubar = tk.Menu(self.root)
        self.menubar = menubar
        self.menu_file = tk.Menu(menubar, tearoff=0)
        self.menu_export = tk.Menu(menubar, tearoff=0)
        self.menu_help = tk.Menu(menubar, tearoff=0)
        menubar.add_cascade(menu=self.menu_file, label="File")
        menubar.add_cascade(menu=self.menu_export, label="Export")
        menubar.add_cascade(menu=self.menu_help, label="Help")
        self.root.configure(menu=menubar)

        root = ttk.Frame(self.root, padding=(22, 18), style="TFrame")
        root.pack(fill="both", expand=True)

        # Header: accent dot + title + version pill + language
        header = ttk.Frame(root)
        header.pack(fill="x", pady=(0, 2))
        dot = tk.Canvas(header, width=26, height=26, bg=self.C["bg"], highlightthickness=0)
        dot.pack(side="left", padx=(0, 10))
        dot.create_oval(3, 3, 23, 23, fill=self.ACCENT, outline="")
        dot.create_oval(9, 9, 17, 17, fill="#FFFFFF", outline="")
        title_box = ttk.Frame(header)
        title_box.pack(side="left")
        ttk.Label(title_box, text="Overtone", style="Title.TLabel").pack(anchor="w")
        self.widgets["subtitle"] = ttk.Label(title_box, style="Subtitle.TLabel")
        self.widgets["subtitle"].pack(anchor="w")
        right = ttk.Frame(header)
        right.pack(side="right", anchor="e")
        self.widgets["pill"] = ttk.Label(right, text=f"v{APP_VERSION}", style="Pill.TLabel")
        self.widgets["pill"].pack(side="right", padx=(10, 0))
        lang = ttk.Combobox(right, textvariable=self.language, values=("English", "Español"),
                            state="readonly", width=10)
        lang.pack(side="right")
        lang.bind("<<ComboboxSelected>>", lambda _e: (self._translate(), self._save_prefs()))
        self.widgets["language_lbl"] = ttk.Label(right, style="TLabel", text="Language")
        self.widgets["language_lbl"].pack(side="right", padx=(0, 8))

        # Two-column body
        body = ttk.Frame(root)
        body.pack(fill="both", expand=True, pady=(12, 0))
        left = ttk.Frame(body)
        left.pack(side="left", fill="y", padx=(0, 14))
        center = ttk.Frame(body)
        center.pack(side="left", fill="both", expand=True)
        left.configure(width=330)

        # --- Source card ---
        card, inner = self._card(left, "source")
        card.pack(fill="x", pady=(0, 12))
        self.widgets["file_info"] = ttk.Label(inner, style="Muted.TLabel", text="—", wraplength=290)
        self.widgets["file_info"].pack(anchor="w", pady=(0, 8))
        ttk.Entry(inner, textvariable=self.file, width=34).pack(fill="x", pady=(0, 8))
        self.widgets["browse"] = ttk.Button(inner, command=self.choose)
        self.widgets["browse"].pack(fill="x")

        # --- Detection card ---
        card2, inner2 = self._card(left, "detection")
        card2.pack(fill="x", pady=(0, 12))
        grid = ttk.Frame(inner2, style="Card.TFrame")
        grid.pack(fill="x")
        self.widgets["delta"] = ttk.Label(grid, style="Muted.TLabel")
        self.widgets["delta"].grid(row=0, column=0, sticky="w")
        self.widgets["persistence"] = ttk.Label(grid, style="Muted.TLabel")
        self.widgets["persistence"].grid(row=0, column=1, sticky="w", padx=(12, 0))
        ttk.Entry(grid, textvariable=self.delta, width=9).grid(row=1, column=0, sticky="ew", pady=(4, 10))
        ttk.Entry(grid, textvariable=self.persistence, width=9).grid(row=1, column=1, sticky="ew", padx=(12, 0), pady=(4, 10))
        self.widgets["quality"] = ttk.Label(grid, style="Muted.TLabel")
        self.widgets["quality"].grid(row=2, column=0, sticky="w")
        self.widgets["pulse"] = ttk.Label(grid, style="Muted.TLabel")
        self.widgets["pulse"].grid(row=2, column=1, sticky="w", padx=(12, 0))
        ttk.Entry(grid, textvariable=self.minimum_confidence, width=9).grid(row=3, column=0, sticky="ew", pady=(4, 10))
        pulse_menu = ttk.Combobox(grid, textvariable=self.pulse,
                                  values=("Auto", "÷4", "÷2", "×1", "×2", "×4"),
                                  state="readonly", width=7)
        pulse_menu.grid(row=3, column=1, sticky="ew", padx=(12, 0), pady=(4, 10))
        pulse_menu.bind("<<ComboboxSelected>>", lambda _e: self._save_prefs())
        grid.columnconfigure(0, weight=1)
        grid.columnconfigure(1, weight=1)
        self.widgets["preference"] = ttk.Checkbutton(inner2, variable=self.prefer_map_bpm)
        self.widgets["preference"].pack(anchor="w", pady=(0, 2))
        self.widgets["refine"] = ttk.Checkbutton(inner2, variable=self.refine_beats)
        self.widgets["refine"].pack(anchor="w", pady=(0, 8))
        preset_row = ttk.Frame(inner2, style="Card.TFrame")
        preset_row.pack(fill="x", pady=(0, 10))
        self.widgets["preset_variable"] = ttk.Button(preset_row, command=lambda: self._apply_preset("variable"),
                                                     style="Ghost.TButton")
        self.widgets["preset_variable"].pack(side="left", fill="x", expand=True, padx=(0, 6))
        self.widgets["preset_steady"] = ttk.Button(preset_row, command=lambda: self._apply_preset("steady"),
                                                   style="Ghost.TButton")
        self.widgets["preset_steady"].pack(side="left", fill="x", expand=True)
        self.widgets["analyze"] = ttk.Button(inner2, command=self.run, style="Accent.TButton")
        self.widgets["analyze"].pack(fill="x")
        self.progress = ttk.Progressbar(inner2, mode="indeterminate", style="Horizontal.TProgressbar")
        self.progress.pack(fill="x", pady=(10, 0))

        # --- Tap tempo card (handy manual cross-check) ---
        card3, inner3 = self._card(left, "tap")
        card3.pack(fill="x")
        self.widgets["tap_btn"] = ttk.Button(inner3, command=self.tap, style="Ghost.TButton", text="Tap")
        self.widgets["tap_btn"].pack(fill="x")
        ttk.Label(inner3, textvariable=self.tap_label, style="Muted.TLabel").pack(anchor="w", pady=(6, 0))
        self.widgets["tap_hint"] = ttk.Label(inner3, style="Muted.TLabel", wraplength=290)
        self.widgets["tap_hint"].pack(anchor="w", pady=(2, 0))

        # --- Results column ---
        res_head = ttk.Frame(center)
        res_head.pack(fill="x", pady=(0, 8))
        self.widgets["results"] = ttk.Label(res_head, style="TLabel", font=("Segoe UI Semibold", 12))
        self.widgets["results"].pack(side="left")
        btns = ttk.Frame(res_head)
        btns.pack(side="right")
        self.widgets["details"] = ttk.Button(btns, command=self.show_details, style="Ghost.TButton")
        self.widgets["details"].pack(side="right", padx=(8, 0))
        self.widgets["inject"] = ttk.Button(btns, command=self.inject_osu, style="Ghost.TButton")
        self.widgets["inject"].pack(side="right", padx=(8, 0))
        self.widgets["double"] = ttk.Button(btns, command=lambda: self._rescale_pulse(2),
                                            style="Ghost.TButton", text="×2")
        self.widgets["double"].pack(side="right", padx=(8, 0))
        self.widgets["half"] = ttk.Button(btns, command=lambda: self._rescale_pulse(0.5),
                                          style="Ghost.TButton", text="÷2")
        self.widgets["half"].pack(side="right", padx=(8, 0))
        self.widgets["click"] = ttk.Button(btns, command=self.save_click, style="Ghost.TButton")
        self.widgets["click"].pack(side="right", padx=(8, 0))
        self.widgets["copy"] = ttk.Button(btns, command=self.copy_osu, style="Ghost.TButton")
        self.widgets["copy"].pack(side="right", padx=(8, 0))
        self.widgets["csv"] = ttk.Button(btns, command=self.save_csv, style="Ghost.TButton")
        self.widgets["csv"].pack(side="right")

        stats = ttk.Frame(center)
        stats.pack(fill="x", pady=(0, 10))
        self.stat_cards: dict[str, object] = {}
        for i, key in enumerate(("global", "sections", "beats", "stability")):
            cell = ttk.Frame(stats, style="Stat.TFrame", padding=(14, 10))
            cell.pack(side="left", fill="x", expand=True, padx=(0, 10) if i < 3 else (0, 0))
            cap = ttk.Label(cell, style="StatCap.TLabel")
            cap.pack(anchor="w")
            big = ttk.Label(cell, textvariable=self.stat_vars[key], style="StatBig.TLabel")
            big.pack(anchor="w")
            self.stat_cards[key] = cap
            self.widgets[f"stat_{key}"] = cap

        status_panel = ttk.Frame(center, padding=(14, 9), style="Card.TFrame")
        status_panel.pack(fill="x", pady=(0, 10))
        ttk.Label(status_panel, textvariable=self.status, style="Status.TLabel", wraplength=640).pack(anchor="w")

        self.widgets["overview"] = ttk.Label(center, style="TLabel", font=("Segoe UI Semibold", 10),
                                             foreground=self.C["muted"], background=self.C["bg"])
        self.widgets["overview"].pack(anchor="w", pady=(0, 4))
        table_frame = ttk.Frame(center)
        table_frame.pack(fill="both", expand=True)
        cols = ("n", "offset", "bpm", "beatlen", "confidence")
        self.table = ttk.Treeview(table_frame, columns=cols, show="headings", height=7)
        for col, w in (("n", 50), ("offset", 130), ("bpm", 130), ("beatlen", 110), ("confidence", 120)):
            self.table.column(col, width=w, anchor="center")
        self.table.pack(side="left", fill="both", expand=True)
        self.table.tag_configure("odd", background="#161D2D")
        self.table.bind("<<TreeviewSelect>>", lambda _e: self._on_row())
        scroll = ttk.Scrollbar(table_frame, orient="vertical", command=self.table.yview)
        scroll.pack(side="right", fill="y")
        self.table.configure(yscrollcommand=scroll.set)

        # --- Manual editor ------------------------------------------------
        editor = ttk.Frame(center, padding=(14, 10), style="Card.TFrame")
        editor.pack(fill="x", pady=(10, 0))
        self.widgets["edit"] = ttk.Label(editor, style="CardHead.TLabel")
        self.widgets["edit"].pack(anchor="w", pady=(0, 8))
        row1 = ttk.Frame(editor, style="Card.TFrame")
        row1.pack(fill="x")
        ttk.Label(row1, text="ms", style="Muted.TLabel").pack(side="left", padx=(0, 4))
        self.edit_offset = ttk.Entry(row1, width=12)
        self.edit_offset.pack(side="left", padx=(0, 10))
        ttk.Label(row1, text="BPM", style="Muted.TLabel").pack(side="left", padx=(0, 4))
        self.edit_bpm = ttk.Entry(row1, width=10)
        self.edit_bpm.pack(side="left", padx=(0, 10))
        self.widgets["apply"] = ttk.Button(row1, command=self.edit_apply, style="Ghost.TButton")
        self.widgets["apply"].pack(side="left", padx=(0, 6))
        self.widgets["add"] = ttk.Button(row1, command=self.edit_add, style="Ghost.TButton")
        self.widgets["add"].pack(side="left", padx=(0, 6))
        self.widgets["delete"] = ttk.Button(row1, command=self.edit_delete, style="Ghost.TButton")
        self.widgets["delete"].pack(side="left", padx=(0, 6))
        row2 = ttk.Frame(editor, style="Card.TFrame")
        row2.pack(fill="x", pady=(8, 0))
        for label, ms in (("−5", -5.0), ("−1", -1.0), ("+1", 1.0), ("+5", 5.0)):
            ttk.Button(row2, text=label, command=lambda v=ms: self.edit_nudge(v),
                       style="Ghost.TButton", width=4).pack(side="left", padx=(0, 6))
        self.widgets["sec_double"] = ttk.Button(row2, command=lambda: self.edit_rescale(2.0),
                                                style="Ghost.TButton", text="2× §")
        self.widgets["sec_double"].pack(side="left", padx=(12, 6))
        self.widgets["sec_halve"] = ttk.Button(row2, command=lambda: self.edit_rescale(0.5),
                                               style="Ghost.TButton", text="÷2 §")
        self.widgets["sec_halve"].pack(side="left")
        self.suggest_var = self.tk.StringVar()
        ttk.Label(editor, textvariable=self.suggest_var, style="Muted.TLabel",
                  wraplength=640).pack(anchor="w", pady=(6, 0))

        self.preview = tk.Canvas(center, height=208, bg=self.TRACE["bg"],
                                 highlightthickness=1,
                                 highlightbackground=self.C["border"])
        self.preview.pack(fill="both", expand=True, pady=(10, 0))
        self.preview.bind("<Configure>", lambda _e: self._draw_preview())
        self.preview.bind("<Motion>", self._trace_hover)
        self.preview.bind("<Leave>", lambda _e: self.preview.delete("hover"))
        self.widgets["hint"] = ttk.Label(center, style="Subtitle.TLabel", wraplength=720)
        self.widgets["hint"].pack(anchor="w", pady=(8, 0))

        self._build_menus()
        self._refresh_file_info()

    def _build_menus(self) -> None:
        self.menu_file.delete(0, "end")
        self.menu_file.add_command(label=self.tr("browse"), command=self.choose, accelerator="Ctrl+O")
        self.menu_file.add_separator()
        self.menu_file.add_command(label=self.tr("quit"), command=self._quit)
        self.menu_export.delete(0, "end")
        self.menu_export.add_command(label=self.tr("csv"), command=self.save_csv)
        self.menu_export.add_command(label=self.tr("copy"), command=self.copy_osu)
        self.menu_export.add_command(label=self.tr("click"), command=self.save_click)
        self.menu_export.add_command(label=self.tr("inject"), command=self.inject_osu)
        self.menu_help.delete(0, "end")
        self.menu_help.add_command(label=self.tr("about"), command=self._about)
        self.root.bind("<Control-o>", lambda _e: self.choose())
        self.root.bind("<Control-c>", self._copy_shortcut)
        self.root.bind("<F5>", lambda _e: self.run())

    # -- text / state ----------------------------------------------------
    def _translate(self) -> None:
        self.root.title(self.tr("title"))
        for key in ("subtitle", "source", "detection", "delta", "persistence", "quality",
                    "pulse", "preference", "refine", "preset_variable", "preset_steady",
                    "analyze", "tap", "tap_hint", "results",
                    "csv", "copy", "click", "inject", "details", "edit", "apply", "add",
                    "delete", "hint", "overview", "browse"):
            widget = self.widgets.get(key)
            if widget is not None:
                try:
                    widget.configure(text=self.tr(key))  # type: ignore[union-attr]
                except Exception:
                    pass
        for key in ("global", "sections", "beats", "stability"):
            cap = self.stat_cards.get(key)
            if cap is not None:
                try:
                    cap.configure(text=self.tr(key))  # type: ignore[union-attr]
                except Exception:
                    pass
        try:
            self.widgets["language_lbl"].configure(text=self.tr("language"))  # type: ignore[union-attr]
        except Exception:
            pass
        heads = {"n": "#", "offset": self.tr("offset"), "bpm": "BPM",
                 "beatlen": self.tr("beatlen"), "confidence": self.tr("confidence")}
        for col, text in heads.items():
            try:
                self.table.heading(col, text=text)
            except Exception:
                pass
        self.tap_label.set(self.tr("taps", n=len(self.taps), bpm="—"))
        try:
            self.menubar.entryconfigure(0, label=self.tr("menu_file"))
            self.menubar.entryconfigure(1, label=self.tr("menu_export"))
            self.menubar.entryconfigure(2, label=self.tr("menu_help"))
        except Exception:
            pass
        self._build_menus()
        if not self.analysis and not self._busy:
            self.status.set(self.tr("ready"))
        self._draw_preview()

    def _save_prefs(self) -> None:
        save_config({"cfg_version": self.CFG_VERSION,
                     "language": self.language.get(), "file": self.file.get(),
                     "delta": self.delta.get(), "persistence": self.persistence.get(),
                     "confidence": self.minimum_confidence.get(),
                     "pulse": self.pulse.get(),
                     "prefer_map_bpm": bool(self.prefer_map_bpm.get()),
                     "refine_beats": bool(self.refine_beats.get())})

    def _apply_preset(self, name: str) -> None:
        preset = self.PRESETS[name]
        self.delta.set(preset["delta"])
        self.persistence.set(preset["persistence"])
        self.minimum_confidence.set(preset["confidence"])
        self._save_prefs()

    def _refresh_file_info(self) -> None:
        path = Path(self.file.get()) if self.file.get() else None
        info = self.widgets.get("file_info")
        if info is None:
            return
        if path and path.is_file():
            try:
                size_mb = path.stat().st_size / 1e6
                info.configure(text=f"♪  {path.name}  •  {size_mb:.1f} MB")  # type: ignore[union-attr]
            except Exception:
                info.configure(text=f"♪  {path.name}")  # type: ignore[union-attr]
        else:
            info.configure(text=f"○  {self.tr('no_file')}")  # type: ignore[union-attr]

    # -- actions ---------------------------------------------------------
    def choose(self) -> None:
        from tkinter import filedialog
        value = filedialog.askopenfilename(
            filetypes=[(self.tr("all_audio"), "*.wav *.flac *.ogg *.mp3 *.m4a *.aac *.opus *.aiff"),
                       (self.tr("all") if "all" in self.TEXT["English"] else "All files", "*.*")])
        if value:
            self.file.set(value)
            self._refresh_file_info()
            self._save_prefs()

    def tap(self) -> None:
        now = time.perf_counter()
        if self.taps and now - self.taps[-1] > 2.5:
            self.taps.clear()
        self.taps.append(now)
        self.taps = self.taps[-16:]
        if len(self.taps) >= 3:
            intervals = np.diff(np.asarray(self.taps))
            bpm = 60.0 / max(float(np.median(intervals)), 1e-6)
            self.tap_label.set(self.tr("taps", n=len(self.taps), bpm=f"{bpm:.1f} BPM"))
        else:
            self.tap_label.set(self.tr("taps", n=len(self.taps), bpm="…"))

    def run(self) -> None:
        if self._busy:
            return
        if not self._confirm_discard():
            return
        if not Path(self.file.get()).is_file():
            self.status.set(self.tr("bad_file"))
            return
        try:
            delta, persistence = float(self.delta.get()), int(self.persistence.get())
            confidence = float(self.minimum_confidence.get()) / 100
            if not 0 <= confidence <= 1:
                raise ValueError
        except ValueError:
            self.status.set(self.tr("bad_values"))
            return
        self._busy = True
        self.selected_section = None
        try:
            self.widgets["analyze"].configure(state="disabled")  # type: ignore[union-attr]
        except Exception:
            pass
        self.progress.start(12)
        self.status.set(self.tr("preparing"))
        self._save_prefs()
        pulse_map = {"÷4": 0.25, "÷2": 0.5, "×1": 1.0, "×2": 2.0, "×4": 4.0}
        force = pulse_map.get(self.pulse.get(), 0.0)
        # Capture Tk state here: worker threads must not touch Tk variables.
        path = self.file.get()
        refine = bool(self.refine_beats.get())
        prefer = bool(self.prefer_map_bpm.get())
        threading.Thread(target=self._worker,
                         args=(path, delta, persistence, prefer, confidence,
                               force, refine),
                         daemon=True).start()
        self.root.after(100, self._poll)

    def _worker(self, path: str, delta: float, persistence: int, prefer_map_bpm: bool,
                confidence: float, force_subdivision: float = 0.0,
                refine_beats: bool = True) -> None:
        try:
            result = analyze_audio(path, delta, persistence, prefer_map_bpm,
                                   confidence, lambda x: self.events.put(("status", x)),
                                   force_subdivision, refine_beats)
            self.events.put(("done", result))
        except Exception as exc:
            self.events.put(("error", str(exc)))

    def _confirm_discard(self) -> bool:
        """True when nothing hand-edited would be lost, or the user agrees."""
        if not self._manual_edits:
            return True
        from tkinter import messagebox
        return bool(messagebox.askyesno(self.tr("discard_title"),
                                        self.tr("discard_edits", n=self._manual_edits)))

    def _current_params(self) -> tuple[float, int, float]:
        try:
            return (float(self.delta.get()), int(self.persistence.get()),
                    float(self.minimum_confidence.get()) / 100)
        except ValueError:
            return (1.5, 12, 0.75)

    def _rescale_pulse(self, mult: float) -> None:
        """Instant ×2 / ÷2 fix from the results header (no re-analysis)."""
        if not self.analysis:
            self.status.set(self.tr("first"))
            return
        if not self.analysis.sections and self.analysis.base_frames is None:
            self.status.set(self.tr("error", value="No stored beat grid — re-run Analyze first."))
            return
        if not self._confirm_discard():
            return
        target = float(self.analysis.subdivision) * mult
        factor = min(ALLOWED_FACTORS, key=lambda f: abs(np.log2(f / target)))
        delta, persistence, confidence = self._current_params()
        try:
            self.analysis = rebuild_with_subdivision(self.analysis, factor, delta,
                                                     persistence, confidence)
        except Exception as exc:
            self.status.set(self.tr("error", value=str(exc)))
            return
        self._manual_edits = 0
        self.selected_section = None
        self._render_results()
        self.status.set(self.tr("rescaled", factor=f"{factor:g}",
                                points=len(self.analysis.points),
                                bpm=f"{self.analysis.global_bpm:.2f}"))

    def _poll(self) -> None:
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "status":
                    self.status.set(self._localize_engine_message(str(value)))
                elif kind == "error":
                    self.status.set(self.tr("error", value=self._localize_engine_message(str(value))))
                    self._finish()
                else:
                    self.analysis = value  # type: ignore[assignment]
                    self._manual_edits = 0
                    self._render_results()
                    self._finish()
        except queue.Empty:
            if self._busy:
                self.root.after(100, self._poll)

    def _finish(self) -> None:
        self._busy = False
        try:
            self.progress.stop()
            self.widgets["analyze"].configure(state="normal")  # type: ignore[union-attr]
        except Exception:
            pass

    def _render_results(self) -> None:
        assert self.analysis is not None
        analysis = self.analysis
        for item in self.table.get_children():
            self.table.delete(item)
        snapped = snap_timing_points(analysis.points)
        for i, p in enumerate(snapped, 1):
            tag = ("odd",) if i % 2 == 0 else ()
            beat_len = f"{60000 / p.bpm:.2f}" if p.bpm > 0 else "—"
            self.table.insert("", "end",
                              values=(i, f"{p.offset_ms:.1f}", f"{p.bpm:.3f}",
                                      beat_len, f"{p.confidence:.0%}"),
                              tags=tag)
        stable_txt = self.tr("stable_yes") if analysis.stability >= 0.75 else self.tr("stable_var")
        self.stat_vars["global"].set(f"{analysis.global_bpm:.2f}")
        self.stat_vars["sections"].set(f"{len(analysis.points)}  ({analysis.meter})")
        self.stat_vars["beats"].set(f"{len(analysis.beats)}")
        self.stat_vars["stability"].set(f"{analysis.stability:.0%} {stable_txt}")
        mode = (self.tr("normal") if float(analysis.subdivision) == 1.0
                else self.tr("confirmed", factor=f"{float(analysis.subdivision):g}"))
        self.status.set(self.tr("done", points=len(analysis.points), beats=len(analysis.beats),
                                mode=mode, bpm=f"{analysis.global_bpm:.1f}"))
        if analysis.points:
            first = analysis.points[0]
            self._set_editor(f"{first.offset_ms:.1f}", f"{first.bpm:.2f}")
        self._refresh_suggestion()
        self._draw_preview()

    def _on_row(self) -> None:
        selection = self.table.selection()
        if not selection or not self.analysis:
            self.selected_section = None
        else:
            try:
                self.selected_section = self.table.index(selection[0])
            except Exception:
                self.selected_section = None
        if (self.selected_section is not None and self.analysis
                and 0 <= self.selected_section < len(self.analysis.points)):
            point = self.analysis.points[self.selected_section]
            self._set_editor(f"{point.offset_ms:.1f}", f"{point.bpm:.2f}")
        self._refresh_suggestion()
        self._draw_preview()

    # -- manual editor ---------------------------------------------------
    def _set_editor(self, offset: str, bpm: str) -> None:
        self.edit_offset.delete(0, "end")
        self.edit_offset.insert(0, offset)
        self.edit_bpm.delete(0, "end")
        self.edit_bpm.insert(0, bpm)

    def _editor_values(self) -> tuple[float, float]:
        try:
            return float(self.edit_offset.get()), float(self.edit_bpm.get())
        except ValueError as exc:
            raise ValueError(self.tr("bad_numbers")) from exc

    def _edited_index(self, before: list[TimingPoint]) -> int:
        """Where the point an edit made sits now, after the re-sort.

        The edit helpers copy every other point as it is, so the one object
        missing from ``before`` is the edited one; an offset search could land
        on a neighbour at the same time.
        """
        assert self.analysis is not None
        kept = {id(point) for point in before}
        return next((n for n, point in enumerate(self.analysis.points) if id(point) not in kept),
                    self.selected_section or 0)

    def _after_edit(self, message: str, select: int | None = None) -> None:
        """Redraw after a hand edit, keeping row ``select`` selected.

        Every edit used to clear the selection and refill the editor with §1,
        so a second press of +1 said "Select a table row first."
        """
        assert self.analysis is not None
        self._manual_edits += 1
        self.selected_section = None
        self._render_results()
        rows = self.table.get_children()
        if select is not None and 0 <= select < len(rows):
            self.table.selection_set(rows[select])
            self.table.see(rows[select])
            self._on_row()
        self.status.set(message)

    def edit_apply(self) -> None:
        if not self.analysis or self.selected_section is None:
            self.status.set(self.tr("no_selection"))
            return
        before = self.analysis.points
        try:
            offset, bpm = self._editor_values()
            self.analysis.points = update_timing_point(
                self.analysis.points, self.analysis.beats, self.selected_section, offset, bpm)
        except ValueError as exc:
            self.status.set(self.tr("error", value=str(exc)))
            return
        index = self._edited_index(before)
        point = self.analysis.points[index]
        self._after_edit(self.tr("edited", n=index + 1,
                                 bpm=f"{point.bpm:.3f}", ms=f"{point.offset_ms:.1f}"), index)

    def edit_add(self) -> None:
        if not self.analysis:
            self.status.set(self.tr("first"))
            return
        before = self.analysis.points
        try:
            offset, bpm = self._editor_values()
            self.analysis.points = add_timing_point(
                self.analysis.points, self.analysis.beats, offset, bpm)
        except ValueError as exc:
            self.status.set(self.tr("error", value=str(exc)))
            return
        self._after_edit(self.tr("added_point", bpm=f"{bpm:.2f}", ms=f"{offset:.1f}"),
                         self._edited_index(before))

    def edit_delete(self) -> None:
        if not self.analysis or self.selected_section is None:
            self.status.set(self.tr("no_selection"))
            return
        if self.selected_section == 0:
            # delete_timing_point refuses it too, but in English only.
            self.status.set(self.tr("first_locked"))
            return
        try:
            n = self.selected_section + 1
            self.analysis.points = delete_timing_point(self.analysis.points, self.selected_section)
        except ValueError as exc:
            self.status.set(self.tr("error", value=str(exc)))
            return
        self._after_edit(self.tr("deleted_point", n=n))

    def edit_nudge(self, delta_ms: float) -> None:
        if not self.analysis or self.selected_section is None:
            self.status.set(self.tr("no_selection"))
            return
        before = self.analysis.points
        try:
            self.analysis.points = nudge_timing_point(
                self.analysis.points, self.analysis.beats, self.selected_section, delta_ms)
        except ValueError as exc:
            self.status.set(self.tr("error", value=str(exc)))
            return
        index = self._edited_index(before)
        point = self.analysis.points[index]
        self._after_edit(self.tr("edited", n=index + 1,
                                 bpm=f"{point.bpm:.3f}", ms=f"{point.offset_ms:.1f}"), index)

    def edit_rescale(self, factor: float) -> None:
        if not self.analysis or self.selected_section is None:
            self.status.set(self.tr("no_selection"))
            return
        try:
            self.analysis.points = rescale_section(
                self.analysis.points, self.selected_section, factor)
        except ValueError as exc:
            self.status.set(self.tr("error", value=str(exc)))
            return
        index = self.selected_section
        point = self.analysis.points[index]
        self._after_edit(self.tr("section_rescaled", n=index + 1, bpm=f"{point.bpm:.2f}"), index)

    def _refresh_suggestion(self) -> None:
        try:
            suggestions = {idx: (factor, ratio) for idx, factor, ratio
                           in suggest_section_pulse(self.analysis)} if self.analysis else {}
        except Exception:
            suggestions = {}
        self.suggestions = suggestions
        if self.selected_section in suggestions:
            factor, ratio = suggestions[self.selected_section]
            point = self.analysis.points[self.selected_section] if self.analysis else None
            bpm = f"{point.bpm:.1f}" if point else "?"
            self.suggest_var.set(self.tr("suggest", n=self.selected_section + 1, bpm=bpm))
        else:
            self.suggest_var.set("")

    def inject_osu(self) -> None:
        if not self.analysis:
            self.status.set(self.tr("first"))
            return
        from tkinter import filedialog, messagebox
        target = filedialog.askopenfilename(filetypes=[("osu! beatmap", "*.osu")])
        if not target:
            return
        try:
            summary = inject_osu_timing_points(target, self.analysis, dry_run=True)
        except (ValueError, OSError) as exc:
            self.status.set(self.tr("error", value=str(exc)))
            return
        warn = ""
        if summary["audio_mismatch"]:
            warn = self.tr("inject_warn", osu=summary["osu_audio"], src=summary["analysed_audio"])
        if summary.get("greens_added"):
            warn += self.tr("inject_greens", n=summary["greens_added"])
        if not messagebox.askyesno(self.tr("inject"),
                                   self.tr("inject_confirm", reds=summary["reds_replaced"],
                                           greens=summary["greens_kept"],
                                           file=Path(target).name, warn=warn)):
            return
        try:
            done = inject_osu_timing_points(target, self.analysis, backup=True)
        except (ValueError, OSError) as exc:
            self.status.set(self.tr("error", value=str(exc)))
            return
        self._manual_edits = 0
        self.status.set(self.tr("injected", added=done["reds_added"],
                                replaced=done["reds_replaced"], greens=done["greens_kept"]))

    def save_csv(self) -> None:
        if not self.analysis:
            self.status.set(self.tr("first"))
            return
        from tkinter import filedialog
        target = filedialog.asksaveasfilename(defaultextension=".csv", filetypes=[("CSV", "*.csv")])
        if target:
            try:
                export_csv(self.analysis, target)
            except OSError as exc:
                # A CSV open in Excel is locked on Windows. Uncaught, the error
                # went to stderr -- invisible from a shortcut -- and the status
                # bar kept its last "Done" while nothing had been written.
                self.status.set(self.tr("error", value=str(exc)))
                return
            self._manual_edits = 0
            self.status.set(self.tr("saved", path=target))

    def save_click(self) -> None:
        if not self.analysis:
            self.status.set(self.tr("first"))
            return
        from tkinter import filedialog
        target = filedialog.asksaveasfilename(defaultextension=".wav", filetypes=[("WAV", "*.wav")])
        if target:
            try:
                export_click_track(self.analysis, target)
            except Exception as exc:
                self.status.set(self.tr("error", value=str(exc)))
                return
            self.status.set(self.tr("click_saved", path=target))

    #: Widgets whose own Ctrl+C copies what the user selected in them.
    TEXT_WIDGETS = ("Entry", "TEntry", "Text", "Spinbox", "TSpinbox", "TCombobox")

    def _copy_shortcut(self, event) -> None:
        """Ctrl+C copies the timing block -- unless it was pressed in a text field.

        Bound on the window, it ran after the field's own copy and replaced
        the offset the user had just selected with the whole [TimingPoints]
        block (and, before any analysis, the status with "Analyze first").
        """
        widget = getattr(event, "widget", None)
        if widget is not None and widget.winfo_class() in self.TEXT_WIDGETS:
            return
        self.copy_osu()

    def copy_osu(self) -> None:
        if not self.analysis:
            self.status.set(self.tr("first"))
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(osu_timing_text(self.analysis))
        self._manual_edits = 0
        self.status.set(self.tr("copied"))

    def show_details(self) -> None:
        import tkinter as tk
        if not self.analysis:
            self.status.set(self.tr("first"))
            return
        window = tk.Toplevel(self.root)
        window.title(analysis_summary(self.analysis).splitlines()[0][:60])
        window.configure(bg=self.C["bg"])
        text = tk.Text(window, width=72, height=24, bg=self.C["panel"], fg=self.C["fg"],
                       insertbackground=self.C["fg"], font=("Consolas", 10), padx=12, pady=12)
        text.pack(fill="both", expand=True, padx=12, pady=12)
        text.insert("1.0", analysis_summary(self.analysis))
        text.configure(state="disabled")

    def _about(self) -> None:
        from tkinter import messagebox
        messagebox.showinfo(self.tr("about"), self.tr("about_text", version=APP_VERSION))

    def _quit(self) -> None:
        self._save_prefs()
        self.root.destroy()

    def _localize_engine_message(self, message: str) -> str:
        if self.language.get() == "English":
            translations = {
                "Cargando y normalizando el audio…": "Loading and normalizing audio…",
                "Extrayendo transitorios y beats…": "Extracting attacks and beats…",
                "Extrayendo transitorios y hipótesis de tempo…": "Extracting transients and tempo hypotheses…",
                "Resolviendo si el pulso detectado es half-time…": "Resolving half/double-time pulse…",
                "Resolviendo el pulso half/double-time…": "Resolving half/double-time pulse…",
                "Calculando tempo local y cambios persistentes…": "Computing local tempo and persistent changes…",
                "Siguiendo beats (DP híbrida + PLP + picos)…": "Tracking beats (hybrid DP + PLP + peaks)…",
                "Detectando ataques con precisión de muestra…": "Detecting attacks at sample resolution…",
                "Buscando la coherencia del pulso…": "Scanning pulse coherence…",
                "Resolviendo la octava del beat…": "Resolving the beat octave…",
                "Ajustando las secciones de tempo…": "Fitting tempo sections…",
                "Sin rejilla ajustable — usando el rastreador de beats…":
                    "No fittable grid — falling back to the beat tracker…",
            }
            return translations.get(message, message)
        reverse = {
            "Loading and normalizing audio…": "Cargando y normalizando el audio…",
            "Extracting transients and tempo hypotheses…": "Extrayendo transitorios y beats…",
            "Tracking beats (hybrid DP + PLP + peaks)…": "Extrayendo transitorios y beats…",
            "Resolving half/double-time pulse…": "Resolviendo si el pulso detectado es half-time…",
            "Computing local tempo and persistent changes…": "Calculando tempo local y cambios persistentes…",
            "Detecting attacks at sample resolution…": "Detectando ataques con precisión de muestra…",
            "Scanning pulse coherence…": "Buscando la coherencia del pulso…",
            "Resolving the beat octave…": "Resolviendo la octava del beat…",
            "Fitting tempo sections…": "Ajustando las secciones de tempo…",
            "No fittable grid — falling back to the beat tracker…":
                "Sin rejilla ajustable — usando el rastreador de beats…",
        }
        return reverse.get(message, message)

    # -- tempo trace -----------------------------------------------------
    #: One palette for the trace, kept apart from the widget theme so the plot
    #: can be read as its own surface. Semantic only: red means a timing point,
    #: blue means tempo, amber means the current selection. Nothing is coloured
    #: for decoration.
    TRACE = {
        "bg": "#0F1420",
        "lane": "#151B28",
        "grid": "#232B3B",
        "grid_soft": "#1B2231",
        "bed": "#2A3244",
        "text": "#B8C1D2",
        "muted": "#8892A5",
        "dim": "#5F6B80",
        "tempo": "#7AA2F7",
        "tempo_fill": "#1A2437",
        "red": "#F0616D",
        "sel": "#FFD166",
    }

    @staticmethod
    def _tick_step(span: float, target: int = 6) -> float:
        """A round time step so axis labels land on values a human reads."""
        if span <= 0:
            return 1.0
        for step in (1, 2, 5, 10, 15, 30, 60, 120, 300, 600):
            if span / step <= target:
                return float(step)
        return 900.0

    @staticmethod
    def _mmss(seconds: float) -> str:
        seconds = max(0.0, seconds)
        return f"{int(seconds) // 60}:{int(seconds) % 60:02d}"

    def _trace_geometry(self):
        """Shared layout so hover and drawing cannot disagree."""
        canvas = self.preview
        width = max(canvas.winfo_width(), 1)
        height = max(canvas.winfo_height(), 1)
        pad_l, pad_r = 44, 14
        head = 24                      # title row
        axis = 18                      # time labels along the bottom
        body_top = head + 8
        body_bottom = height - axis - 6
        # The tempo curve gets the upper two thirds, the onset bed the lower.
        split = body_top + (body_bottom - body_top) * 0.62
        return {
            "w": width, "h": height, "l": pad_l, "r": width - pad_r,
            "top": body_top, "split": split, "bottom": body_bottom,
        }

    def _trace_scales(self):
        """(duration, low, high) for the current analysis, or None."""
        if not self.analysis or len(self.analysis.local_bpms) < 2:
            return None
        values = np.asarray(self.analysis.local_bpms, dtype=float)
        times = np.asarray(self.analysis.beats, dtype=float)
        if times.size < 2:
            return None
        low, high = (float(v) for v in np.quantile(values, [0.02, 0.98]))
        if high - low < 1.0:                     # a constant-tempo track
            centre = 0.5 * (low + high)
            low, high = centre - 1.5, centre + 1.5
        else:
            margin = 0.25 * (high - low)
            low, high = low - margin, high + margin
        duration = max(float(self.analysis.duration or times[-1]), 0.001)
        return duration, low, high

    def _draw_preview(self) -> None:
        """Tempo trace: onset bed, tempo curve, sections and red lines."""
        canvas = self.preview
        canvas.delete("all")
        C = self.TRACE
        g = self._trace_geometry()

        canvas.create_text(14, 13, anchor="w", fill=C["muted"],
                           font=("Segoe UI Semibold", 9), text=self.tr("trace_title"))

        scales = self._trace_scales()
        if scales is None:
            canvas.create_text(g["w"] / 2, g["h"] / 2, fill=C["dim"],
                               font=("Segoe UI", 10), text=self.tr("trace_empty"))
            return
        duration, low, high = scales
        values = np.asarray(self.analysis.local_bpms, dtype=float)
        times = np.asarray(self.analysis.beats, dtype=float)
        snapped = snap_timing_points(self.analysis.points)

        def x_of(t: float) -> float:
            return g["l"] + (g["r"] - g["l"]) * min(max(float(t) / duration, 0.0), 1.0)

        def y_of(bpm: float) -> float:
            frac = (float(bpm) - low) / max(high - low, 1e-9)
            return g["split"] - (g["split"] - g["top"]) * min(max(frac, 0.0), 1.0)

        # -- lanes ------------------------------------------------------
        canvas.create_rectangle(g["l"], g["top"], g["r"], g["bottom"],
                                fill=C["lane"], outline="")

        # -- section shading, behind everything else --------------------
        edges = [0.0] + [p.offset_ms / 1000.0 for p in snapped[1:]] + [duration]
        for i in range(len(edges) - 1):
            if i == self.selected_section:
                fill = "#1D2740"
            elif i % 2 == 1:
                fill = "#18202F"
            else:
                continue
            canvas.create_rectangle(x_of(edges[i]), g["top"], x_of(edges[i + 1]),
                                    g["bottom"], fill=fill, outline="")

        # -- BPM grid ---------------------------------------------------
        for frac in (0.0, 0.5, 1.0):
            bpm = low + (high - low) * frac
            y = y_of(bpm)
            canvas.create_line(g["l"], y, g["r"], y, fill=C["grid_soft"])
            canvas.create_text(g["l"] - 7, y, anchor="e", fill=C["dim"],
                               font=("Consolas", 8), text=f"{bpm:.0f}")

        # -- onset bed, max-pooled per pixel column ---------------------
        # One sample per column would miss the peaks entirely and draw noise;
        # taking the maximum over each column's frames is what makes the bed
        # look like the music instead of like static.
        try:
            bed = np.asarray(self.analysis.onset, dtype=float)
            columns = int(g["r"] - g["l"])
            if bed.size > 8 and columns > 8:
                bins = np.minimum((np.arange(bed.size) * columns) // bed.size,
                                  columns - 1)
                pooled = np.zeros(columns)
                np.maximum.at(pooled, bins, bed)
                peak = max(float(pooled.max()), 1e-9)
                floor = g["bottom"]
                span = (g["bottom"] - g["split"]) - 4
                points = [g["l"], floor]
                for c in range(columns):
                    points.extend((g["l"] + c, floor - span * pooled[c] / peak))
                points.extend((g["r"], floor))
                canvas.create_polygon(*points, fill=C["bed"],
                                      outline="")
        except Exception:
            pass
        canvas.create_line(g["l"], g["split"], g["r"], g["split"], fill=C["grid"])

        # -- tempo curve ------------------------------------------------
        # No spline smoothing: a smoothed curve through hundreds of beats
        # invents wiggles the engine never reported. Decimated to about two
        # points per pixel so long tracks stay responsive.
        step = max(1, times.size // max(int(g["r"] - g["l"]) * 2, 1))
        coords: list[float] = []
        for t, bpm in zip(times[::step], values[::step]):
            coords.extend((x_of(t), y_of(bpm)))
        if len(coords) >= 4:
            fill_pts = [coords[0], g["split"]] + coords + [coords[-2], g["split"]]
            canvas.create_polygon(*fill_pts, fill=C["tempo_fill"], outline="")
            canvas.create_line(*coords, fill=C["tempo"], width=2)

        # -- red lines and their section chips --------------------------
        for i, point in enumerate(snapped):
            x = x_of(point.offset_ms / 1000.0)
            selected = self.selected_section == i
            colour = C["sel"] if selected else C["red"]
            canvas.create_line(x, g["top"], x, g["bottom"], fill=colour,
                               width=2 if selected else 1)
            canvas.create_polygon(x - 4, g["top"], x + 4, g["top"], x, g["top"] + 6,
                                  fill=colour, outline="")
            label = f"{point.bpm:.3f}"
            tx = min(max(x + 6, g["l"] + 2), g["r"] - 54)
            canvas.create_rectangle(tx - 3, g["top"] + 3, tx + 50, g["top"] + 19,
                                    fill=C["bg"], outline=colour)
            canvas.create_text(tx, g["top"] + 11, anchor="w", fill=colour,
                               font=("Consolas", 8), text=label)

        # -- time axis --------------------------------------------------
        step_s = self._tick_step(duration)
        tick = 0.0
        while tick <= duration + 1e-6:
            x = x_of(tick)
            canvas.create_line(x, g["bottom"], x, g["bottom"] + 4, fill=C["grid"])
            canvas.create_text(x, g["bottom"] + 12, fill=C["dim"],
                               font=("Consolas", 8), text=self._mmss(tick))
            tick += step_s

    def _trace_hover(self, event) -> None:
        """Read out the time, tempo and section under the cursor."""
        canvas = self.preview
        canvas.delete("hover")
        scales = self._trace_scales()
        if scales is None:
            return
        duration, _low, _high = scales
        g = self._trace_geometry()
        if not (g["l"] <= event.x <= g["r"] and g["top"] <= event.y <= g["bottom"]):
            return
        C = self.TRACE
        at = duration * (event.x - g["l"]) / max(g["r"] - g["l"], 1)

        snapped = snap_timing_points(self.analysis.points)
        section = 0
        for i, point in enumerate(snapped):
            if point.offset_ms / 1000.0 <= at + 1e-9:
                section = i
        point = snapped[section] if snapped else None

        canvas.create_line(event.x, g["top"], event.x, g["bottom"],
                           fill=C["muted"], dash=(2, 3), tags="hover")
        if point is None:
            return
        beat_ms = 60000.0 / point.bpm if point.bpm > 0 else float("nan")
        lines = [
            self._mmss(at),
            f"{point.bpm:.3f} BPM",
            self.tr("trace_beat", ms=f"{beat_ms:.3f}"),
            self.tr("trace_conf", pct=f"{point.confidence:.0%}"),
        ]
        box_w, box_h = 118, 14 * len(lines) + 10
        bx = event.x + 10
        if bx + box_w > g["r"]:
            bx = event.x - 10 - box_w
        by = min(max(g["top"] + 2, event.y - box_h - 8), g["bottom"] - box_h)
        canvas.create_rectangle(bx, by, bx + box_w, by + box_h, fill=C["bg"],
                                outline=C["grid"], tags="hover")
        for n, text in enumerate(lines):
            canvas.create_text(bx + 8, by + 12 + n * 14, anchor="w",
                               fill=C["text"] if n else C["sel"],
                               font=("Consolas", 8), text=text, tags="hover")

    def start(self) -> None:
        self.root.mainloop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Overtone — BPM and offset detector for osu! mapping")
    parser.add_argument("audio", nargs="?", help="Audio file to analyze (a folder analyses every audio file in it; no argument opens the GUI)")
    parser.add_argument("--delta", type=float, default=1.5, help="Minimum BPM change (default 1.5)")
    parser.add_argument("--persistence", type=int, default=12, help="Beats required to confirm a change (default 12; 20+ for steady songs)")
    parser.add_argument("--min-confidence", type=float, default=75, help="Minimum confidence of exported points (0-100; default 75)")
    parser.add_argument("--csv", help="Output CSV path")
    parser.add_argument("--click", help="Output click-track WAV path (metronome aligned to red lines)")
    parser.add_argument("--stats", action="store_true", help="Print a human-readable summary table")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON instead of the human report")
    parser.add_argument("--subdivision", choices=("auto", "0.25", "0.5", "1", "2", "4"), default="auto",
                        help="Multiply the detected beat rate: 2 doubles (fixes a half-time read), 0.5 halves. Default: auto.")
    parser.add_argument("--engine", choices=("auto", "precision", "legacy"), default="auto",
                        help="auto (default) fits the grid and falls back to the v2 tracker; "
                             "precision refuses to fall back; legacy forces the v2 tracker.")
    parser.add_argument("--decimal-offsets", type=int, default=0, metavar="N",
                        help="Write N decimals on offsets (default 0 — whole ms, what osu!stable expects)")
    parser.add_argument("--no-refine", action="store_true", help="Skip sample-resolution attack re-timing (diagnostic)")
    parser.add_argument("--osz", metavar="OUT.OSZ", help="Write a complete beatmap archive: the audio plus an .osu carrying this timing")
    parser.add_argument("--artist", help="Artist for --osz metadata (default: unknown)")
    parser.add_argument("--title", help="Title for --osz metadata (default: the audio filename)")
    parser.add_argument("--creator", help="Creator for --osz metadata (default: Overtone)")
    parser.add_argument("--inject", metavar="MAP.OSU", help="Inject red lines into an .osu [TimingPoints] (backup .bak, greens kept)")
    parser.add_argument("--no-backup", action="store_true", help="Skip the .bak backup when injecting")
    parser.add_argument("--no-map-preference", action="store_true", help="Do not prefer 120-300 mapping BPM when resolving the octave")
    args = parser.parse_args()

    def note(message: str) -> None:
        """Progress, status and errors go to stderr: stdout carries only the
        red lines (or the JSON), so `> timing.txt` holds nothing else."""
        print(message, file=sys.stderr)

    # A flag that cannot act is refused, never dropped: --inject with the
    # audio forgotten opened the window, and --title without --osz wrote
    # nothing anywhere, both without a word.
    given = sorted("--" + name.replace("_", "-") for name, value in vars(args).items()
                   if name != "audio" and value != parser.get_default(name))
    if not args.audio:
        if given:
            parser.error(f"{', '.join(given)} {'needs' if len(given) == 1 else 'need'} an "
                         "audio file to analyze; with no arguments at all the window opens")
        TimingAnalyzerApp().start()
        return
    metadata = [flag for flag in ("--artist", "--title", "--creator") if flag in given]
    if metadata and not args.osz:
        parser.error(f"{', '.join(metadata)} only {'names' if len(metadata) == 1 else 'name'} "
                     "what --osz writes; add --osz OUT.osz")
    if args.no_backup and not args.inject:
        parser.error("--no-backup only applies to --inject; nothing else makes a backup")
    if not 0 <= args.decimal_offsets <= 6:
        note("Error: --decimal-offsets must be between 0 and 6")
        raise SystemExit(2)
    force = 0.0 if args.subdivision == "auto" else float(args.subdivision)
    if Path(args.audio).is_dir():
        single = [flag for flag in ("--click", "--osz", "--inject", "--stats", "--decimal-offsets")
                  if flag in given]
        if single:
            note(f"Error: {'/'.join(single)} need a single audio file, not a folder")
            raise SystemExit(2)
        try:
            rows = analyze_batch(args.audio, args.delta, args.persistence, not args.no_map_preference,
                                 args.min_confidence / 100, force, refine_beats=not args.no_refine,
                                 engine=args.engine)
        except ValueError as exc:
            note(f"Error: {exc}")
            raise SystemExit(1)
        failures = sum(not row["ok"] for row in rows)
        if args.json:
            print(json.dumps(rows, indent=2))
        else:
            print(f"{'file':<32} {'bpm':>10} {'points':>7} {'seconds':>8}  status")
            for row in rows:
                status = "ok" if row["ok"] else f"FAILED: {row['error']}"
                print(f"{row['file']:<32} {row['global_bpm']:>10.2f} {row['points']:>7d} "
                      f"{row['duration']:>8.1f}  {status}")
        if args.csv:
            try:
                with open(args.csv, "w", newline="", encoding="utf-8") as handle:
                    writer = csv.writer(handle)
                    writer.writerow(["file", "ok", "global_bpm", "points", "duration", "error"])
                    writer.writerows([[row["file"], row["ok"], row["global_bpm"],
                                       row["points"], row["duration"], row["error"]] for row in rows])
            except OSError as exc:
                note(f"Error writing output: {exc}")
                raise SystemExit(1)
        raise SystemExit(1 if failures else 0)
    try:
        analysis = analyze_audio(args.audio, args.delta, args.persistence, not args.no_map_preference,
                                 args.min_confidence / 100, note, force,
                                 refine_beats=not args.no_refine, engine=args.engine)
    except (ValueError, RuntimeError, OSError) as exc:
        note(f"Error: {exc}")
        raise SystemExit(1)
    if args.json:
        print(json.dumps(analysis_report(analysis), indent=2))
    else:
        if args.stats:
            print(analysis_summary(analysis))
            print()
        print(osu_timing_text(analysis, args.decimal_offsets))
    try:
        if args.csv:
            export_csv(analysis, args.csv)
        if args.click:
            export_click_track(analysis, args.click)
        if args.osz:
            written = export_osz(
                analysis, args.osz, args.audio,
                {"artist": args.artist, "title": args.title, "creator": args.creator},
                args.decimal_offsets)
            note(f"Wrote {args.osz}: {written['osu']} "
                 f"({written['points']} red line(s), {written['bytes'] / 1e6:.1f} MB)")
    except (OSError, ValueError, RuntimeError) as exc:  # soundfile's errors are RuntimeErrors
        note(f"Error writing output: {exc}")
        raise SystemExit(1)
    if args.inject:
        try:
            summary = inject_osu_timing_points(args.inject, analysis, backup=not args.no_backup,
                                               decimals=args.decimal_offsets)
        except (ValueError, OSError) as exc:
            note(f"Error injecting into {args.inject}: {exc}")
            raise SystemExit(1)
        note(f"Injected {summary['reds_added']} red lines "
             f"({summary['reds_replaced']} replaced, {summary['greens_kept']} greens kept, "
             f"{summary['greens_added']} greens added to keep SV and hitsounds)"
             + (" [audio mismatch!]" if summary["audio_mismatch"] else ""))
        if summary["backup"]:
            note(f"Backup: {summary['backup']}")


if __name__ == "__main__":
    main()
