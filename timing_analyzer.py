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


def _onset_envelope(y: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """Normalized onset-strength envelope (librosa first, flux fallback)."""
    try:
        env = librosa.onset.onset_strength(
            y=y.astype(np.float32), sr=sr, hop_length=hop,
            aggregate=np.median, fmax=11025, n_mels=128,
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


def _track_beats_hybrid(onset: np.ndarray, sr: int, hop: int,
                        prior_tempo: float | None = None) -> np.ndarray:
    """Combine librosa trackers with the peak fallback; keep the steadiest."""
    candidates: list[np.ndarray] = []
    # 1) Dynamic-programming beat tracker (tight: less drift on steady music).
    try:
        _tempo, lib_frames = librosa.beat.beat_track(
            onset_envelope=onset, sr=sr, hop_length=hop,
            tightness=100, trim=False)
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
                                return_float: bool = False) -> np.ndarray:
    """Re-anchor each beat to its strongest nearby transient.

    Parabolic interpolation gives sub-frame precision. With integer frames
    (``return_float=False``) the correction is rounded back so downstream
    code stays frame-exact; with ``return_float=True`` the fractional part is
    kept — essential above ~200 BPM, where a single 5.8 ms frame already spans
    ~2 % of tempo and would make 225 vs 222 BPM sections flip-flop.
    ``radius_ms`` widens after subdivision inserts, whose interpolated
    positions can sit far from the true attack.
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


def _global_tempo_guides(onset: np.ndarray, sr: int, hop: int) -> list[tuple[float, float]]:
    """Return [(bpm, weight)] tempo hypotheses from a tempogram + tracker.

    Legacy (v2) path only; the v3 engine uses ``_tempo_hints`` instead.
    """
    guides: list[tuple[float, float]] = []
    try:
        # aggregate=None returns one estimate per frame (shape 2×T); collapse
        # across time with a median — never just read the first frames, which
        # cover the (often unrepresentative) song intro.
        tempo_frames = librosa.feature.rhythm.tempo(onset_envelope=onset, sr=sr,
                                                    hop_length=hop, aggregate=None,
                                                    std_bpm=1.0)
        tempo_frames = np.atleast_2d(np.asarray(tempo_frames, dtype=float))
        for value in np.median(tempo_frames, axis=1):
            if 30 <= value <= 600 and np.isfinite(value):
                guides.append((float(value), 1.0))
    except Exception:
        pass
    try:
        tempogram = librosa.feature.tempogram(onset_envelope=onset, sr=sr,
                                              hop_length=hop, win_length=384)
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
    # Octave-down safety net: if the tracker locked onto double-time while the
    # tempogram strongly prefers half, halve back — but only with evidence.
    if best_factor == 1 and base_bpm > 300:
        half_support = _subdivision_support(onset, beat_frames[::2], 1)
        if half_support >= base_support * 0.9:
            return 1  # keep grid; tempo halves naturally via local BPM median
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
        # Sub-sample retiming can collide two neighbours; keep the stronger.
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
    """Candidate atomic pulses as [(period, phase, coherence)], slowest first.

    ``R`` is high at the atomic pulse *and at every multiple of it*, and low at
    sub-multiples — so the fundamental is the slowest strong peak, which is
    exactly what we want to hand to the least-squares stage.
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
            best_meter, best_class, best_contrast = meter, r, contrast
    if best_contrast < 1.20:
        return "4/4", 0, 1                    # no usable accent: do not move the offset
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
    while start < finish - 1.0 and guard < 64:
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
                break
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


def _points_from_sections(sections: list[GridSection], first_sound: float,
                          persistence: int, downbeat_class: int, meter: int,
                          factor: float = 1.0) -> list[TimingPoint]:
    """Turn fitted grids into osu! red lines, each on a (down)beat of its own grid."""
    points: list[TimingPoint] = []
    for n, section in enumerate(sections):
        period = section.period / factor
        if not np.isfinite(period) or period <= 0:
            continue
        bpm = 60.0 / period
        if not 20.0 <= bpm <= 900.0:
            continue
        anchor = section.phase
        if n == 0:
            # The first red line should land on a downbeat so osu!'s bar lines
            # match the music — but only when the accents prove where the bar
            # starts. ``meter`` is 1 when they do not.
            anchor = section.phase + downbeat_class * section.period
            span = section.period * max(1, meter)
            start = max(section.start_s, first_sound) - 0.25 * period
            offset = anchor + np.ceil((start - anchor) / span - 1e-9) * span
            while offset < first_sound - 0.55 * period:
                offset += span
        else:
            k = np.ceil((section.start_s - anchor) / period - 1e-9)
            offset = anchor + k * period
        points.append(TimingPoint(float(offset * 1000.0), float(bpm),
                                  _section_confidence(section, persistence), n))
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
    sections = _beat_sections(atom_sections, times, weights, m, first_class)
    sections = _settle_boundaries(times, weights, sections)
    meter_text, downbeat, bar_beats = _meter_from_grid(
        times, weights, sections[0].period, sections[0].phase)
    return {"times": times, "weights": weights, "env": env, "sections": sections,
            "meter": meter_text, "meter_beats": bar_beats, "downbeat": downbeat,
            "atoms_per_beat": m, "first_sound": float(times[0])}


# ---------------------------------------------------------------------------
# Main analysis entry point
# ---------------------------------------------------------------------------

def _load_audio(path: str | os.PathLike[str],
                say: Callable[[str], None]) -> tuple[np.ndarray, int]:
    """Decode to mono float32 at 44.1 kHz, peak-normalized."""
    say("Loading and normalizing audio…")
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
            raise RuntimeError(
                "Could not decode audio. For MP3/M4A/AAC install FFmpeg and add it to PATH; "
                "WAV/FLAC/OGG should open directly."
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
    points = _points_from_sections(sections, fit["first_sound"], persistence,
                                   fit["downbeat"], fit["meter_beats"], factor)
    kept = [p for p in points if p.confidence >= min_confidence]
    if not kept and points:
        # Never hand back an empty map when a grid was clearly found.
        kept = [max(points, key=lambda p: p.confidence)]
    # Two sections can converge once each is refitted on its own attacks.
    final: list[TimingPoint] = kept[:1]
    for point in kept[1:]:
        if abs(point.bpm - final[-1].bpm) >= min_delta:
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


def _legacy_analysis(path: str | os.PathLike[str], y: np.ndarray, sr: int,
                     min_delta: float, persistence: int, prefer_map_bpm: bool,
                     min_confidence: float, say: Callable[[str], None],
                     force_subdivision: int, refine_beats: bool) -> Analysis:
    """v2 tracker path: used when no regular pulse grid can be fitted."""
    say("Extracting transients and tempo hypotheses…")
    hop = HOP
    onset = _onset_envelope(y, sr, hop)
    if onset.size < 8:
        raise ValueError("Not enough beats detected. Try a file with clearer percussion.")
    guides = _global_tempo_guides(onset, sr, hop)
    prior = guides[0][0] if guides else None

    say("Tracking beats (hybrid DP + PLP + peaks)…")
    beat_frames = _track_beats_hybrid(onset, sr, hop, prior)
    if len(beat_frames) < 8:
        raise ValueError("Not enough beats detected. Try a file with clearer percussion.")
    if refine_beats:
        beat_frames = _refine_beats_to_transients(beat_frames, onset, sr, hop)

    say("Resolving half/double-time pulse…")
    if force_subdivision in (1, 2, 4):
        subdivision = int(force_subdivision)
    else:
        subdivision = _choose_subdivision(onset, beat_frames, prefer_map_bpm, guides)
    beat_frames_raw = np.asarray(beat_frames, dtype=float).copy()
    beat_frames = _insert_subdivisions(beat_frames, subdivision)
    if refine_beats:
        # Interpolated midpoints can sit up to half a beat away from the true
        # attack, so widen the snap window proportionally to the beat length.
        median_gap_s = float(np.median(np.diff(np.asarray(beat_frames, dtype=float)))) * hop / sr if len(beat_frames) > 1 else 0.5
        beat_frames = _refine_beats_to_transients(
            beat_frames, onset, sr, hop,
            radius_ms=float(np.clip(0.30 * median_gap_s * 1000, 25, 90)),
            return_float=True)
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

    global_bpm = float(np.median(local_v)) if len(local_v) else 0.0
    if guides:
        for tempo_hint, _w in guides[:3]:
            for mult in (0.5, 1.0, 2.0):
                if abs(tempo_hint * mult - global_bpm) <= max(2.0, global_bpm * 0.02):
                    global_bpm = float((global_bpm + tempo_hint * mult) / 2.0)
                    break
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
    legacy_force = int(force_subdivision) if float(force_subdivision) in (1, 2, 4) else 0
    return _legacy_analysis(path, y, sr, min_delta, persistence, prefer_map_bpm,
                            min_confidence, say, legacy_force, refine_beats)


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
               "first_sound": float(analysis.attack_times[0]) if analysis.attack_times.size
               else float(analysis.sections[0].start_s)}
        rebuilt = _assemble_analysis(analysis.source, np.zeros(1), analysis.sample_rate,
                                     fit, min_delta, persistence, min_confidence, factor)
        return Analysis(analysis.source, analysis.duration, rebuilt.beats,
                        rebuilt.local_bpms, rebuilt.points, rebuilt.hop_length,
                        rebuilt.sample_rate, factor,
                        rebuilt.global_bpm, rebuilt.stability, rebuilt.meter,
                        rebuilt.onset, rebuilt.base_frames, rebuilt.attack_times,
                        rebuilt.attack_weights, rebuilt.sections, rebuilt.meter_beats,
                        rebuilt.downbeat_class, rebuilt.fit_residual_ms, "precision")
    if factor not in (1.0, 2.0, 4.0):
        raise ValueError("Legacy analyses only support factors 1, 2 and 4.")
    if analysis.base_frames is None or len(analysis.base_frames) < 4:
        raise ValueError("This analysis has no stored beat grid to rebuild from.")
    frames = _insert_subdivisions(np.asarray(analysis.base_frames, dtype=float), int(factor))
    median_gap_s = (float(np.median(np.diff(np.asarray(frames, dtype=float)))) * analysis.hop_length
                    / analysis.sample_rate) if len(frames) > 1 else 0.5
    frames = _refine_beats_to_transients(
        frames, analysis.onset, analysis.sample_rate, analysis.hop_length,
        radius_ms=float(np.clip(0.30 * median_gap_s * 1000, 25, 90)),
        return_float=True)
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
                    analysis.hop_length, analysis.sample_rate, int(factor), global_bpm,
                    _stability(local_v),
                    _guess_meter(beats_v, analysis.onset, analysis.sample_rate,
                                 analysis.hop_length),
                    analysis.onset, np.asarray(analysis.base_frames, dtype=float))


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------

def export_csv(analysis: Analysis, destination: str | os.PathLike[str]) -> None:
    with open(destination, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["offset_ms", "bpm", "beat_index", "confidence"])
        writer.writerows((f"{p.offset_ms:.3f}", f"{p.bpm:.6f}", p.beat_index, f"{p.confidence:.3f}") for p in analysis.points)


def export_click_track(analysis: Analysis, destination: str | os.PathLike[str],
                       sr: int = 44100) -> None:
    """Write a metronome WAV aligned to the detected red lines.

    Import it as a second track (or whistle-test it against the song) to
    *hear* whether the timing map drifts. Accent = section start / downbeat.
    """
    if not analysis.points:
        raise ValueError("Analyze audio first — there are no timing points.")
    if not 8000 <= sr <= 192000:
        raise ValueError("Click-track sample rate must be between 8 and 192 kHz.")
    duration = float(min(max(analysis.duration, 1.0), MAX_CLICK_SECONDS))
    total = int((duration + 1.0) * sr)
    click = np.zeros(total, dtype=np.float32)
    # Pre-render both clicks once: rebuilding them per beat costs more than the
    # rest of the export put together on a long map.
    length = max(1, int(0.045 * sr))
    decay = np.exp(-np.arange(length) / (0.008 * sr))
    steps = np.arange(length) / sr
    tones = {True: (np.sin(2 * np.pi * 2093.0 * steps) * decay).astype(np.float32),
             False: (np.sin(2 * np.pi * 1568.0 * steps) * decay * 0.7).astype(np.float32)}

    def place(time_s: float, accent: bool) -> None:
        idx = int(time_s * sr)
        if not 0 <= idx < total:
            return
        tone = tones[accent]
        end = min(total, idx + length)
        click[idx:end] += tone[:end - idx]

    snapped = snap_timing_points(analysis.points)
    for s, point in enumerate(snapped):
        if not np.isfinite(point.bpm) or point.bpm <= 0:
            continue
        start = point.offset_ms / 1000.0
        end = snapped[s + 1].offset_ms / 1000.0 if s + 1 < len(snapped) else duration
        beat_len = 60.0 / point.bpm
        k = 0
        t = start
        while t <= end + 1e-6:
            place(t, accent=(k % 4 == 0))
            t += beat_len
            k += 1
            if k > 20000:
                break
    peak = float(np.max(np.abs(click)))
    if peak > 1e-9:
        click = (click / peak * 0.9).astype(np.float32)
    sf.write(destination, click, sr)


def snap_timing_points(points: list[TimingPoint]) -> list[TimingPoint]:
    """Place each tempo change on the previous section's beat grid.

    osu! continues a red-line grid until the next red line. Audio detection
    can find a transition a few milliseconds beside the attack; snapping it
    to the nearest beat of the preceding section avoids accumulated phase
    errors without inserting a timing point for every beat.
    """
    if not points:
        return []
    snapped = [points[0]]
    for point in points[1:]:
        previous = snapped[-1]
        if previous.bpm <= 0:
            snapped.append(point)
            continue
        beat_length = 60000.0 / previous.bpm
        beat_count = max(1, round((point.offset_ms - previous.offset_ms) / beat_length))
        offset = previous.offset_ms + beat_count * beat_length
        # The v3 engine fits every section on its own attacks, so its offsets
        # are already exact. Only nudge one onto the previous grid when the two
        # nearly agree — a large "correction" means the change genuinely does
        # not fall on the old grid, and moving it there would invent an error.
        if abs(offset - point.offset_ms) > 0.25 * beat_length:
            snapped.append(point)
            continue
        snapped.append(TimingPoint(offset, point.bpm, point.confidence, point.beat_index))
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
        meter = max(1, min(16, int(str(getattr(analysis, "meter", "4/4")).split("/")[0])))
    except (ValueError, TypeError):
        meter = 4
    for p in snap_timing_points(list(getattr(analysis, "points", None) or [])):
        if not np.isfinite(p.bpm) or p.bpm <= 0 or not np.isfinite(p.offset_ms):
            continue
        beat_length = 60000.0 / p.bpm
        offset = (f"{p.offset_ms:.{int(decimals)}f}" if decimals > 0
                  else str(int(round(p.offset_ms))))
        rows.append(f"{offset},{beat_length:.12f},{meter},1,0,100,1,0")
    return "\n".join(rows)


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
    return "\n".join(lines)


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
                                         _nearest_beat_index(beats, offset_ms))]
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
    merged[index] = TimingPoint(float(offset_ms), float(bpm), old.confidence,
                                _nearest_beat_index(beats, offset_ms))
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
    """Shift one point's offset, clamped at 0 ms, beat index refreshed."""
    if not 0 <= index < len(points):
        raise ValueError("No timing point at that index.")
    old = points[index]
    offset = max(0.0, old.offset_ms + delta_ms)
    merged = list(points)
    merged[index] = TimingPoint(offset, old.bpm, old.confidence,
                                _nearest_beat_index(beats, offset))
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
    merged[index] = TimingPoint(old.offset_ms, bpm, old.confidence, old.beat_index)
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
# .osu injection
# ---------------------------------------------------------------------------

def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    """Write via a sibling temp file + rename.

    Injecting rewrites the user's beatmap in place. Truncating the real file
    and then failing mid-write would destroy work that may not exist anywhere
    else, so the new content is only ever swapped in once it is complete.
    """
    temp = path.with_name(path.name + ".part")
    try:
        temp.write_bytes(payload)
        os.replace(temp, path)
    except BaseException:
        try:
            temp.unlink()
        except OSError:
            pass
        raise


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


def inject_osu_timing_points(osu_path: str | os.PathLike[str],
                             analysis: Analysis,
                             backup: bool = True,
                             dry_run: bool = False,
                             decimals: int = 0) -> dict:
    """Replace the red (uninherited) lines of an .osu with this analysis.

    Green lines, metadata, hit objects — everything else — are preserved
    byte-for-byte, including the file's CRLF/LF style. A ``.bak`` copy is
    written first unless ``backup`` is False, and an existing ``.bak`` is never
    overwritten: the pristine original is the one worth keeping. With
    ``dry_run`` nothing is written (used for the GUI confirmation dialog).
    Returns a summary dict with ``reds_replaced``, ``reds_added``,
    ``greens_kept`` and an ``audio_mismatch`` warning when the .osu's
    AudioFilename differs from the analyzed file.
    """
    path = Path(osu_path)
    if not path.is_file():
        raise ValueError(f"{path} is not a file.")
    size = path.stat().st_size
    if size > MAX_OSU_BYTES:
        raise ValueError(f"{path.name} is {size / 1e6:.1f} MB — that is not a beatmap.")
    new_reds = [row for row in osu_timing_text(analysis, decimals).splitlines()
                if row and not row.startswith("//")]
    if not new_reds:
        raise ValueError("This analysis has no usable timing points to inject.")

    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError(f"Could not decode {path.name} as UTF-8.") from exc
    newline = "\r\n" if b"\r\n" in raw else "\n"
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
    body = lines[header_idx + 1:end_idx]

    greens = [line for line in body if line.strip() and not _is_red_line(line.strip())]
    old_reds = sum(1 for line in body if line.strip() and _is_red_line(line.strip()))

    if old_reds:
        # Replace in place: new reds take the position of the first old red,
        # remaining old reds are dropped, greens keep their exact lines.
        out_body: list[str] = []
        replaced = False
        for line in body:
            if line.strip() and _is_red_line(line.strip()):
                if not replaced:
                    out_body.extend(new_reds)
                    replaced = True
            else:
                out_body.append(line)
    else:
        out_body = list(body) + new_reds

    audio_name = ""
    for line in lines[:header_idx]:
        if line.startswith("AudioFilename:"):
            audio_name = line.split(":", 1)[1].strip()
            break
    analysed_name = Path(getattr(analysis, "source", "")).name

    if not dry_run:
        if backup:
            spare = Path(str(path) + ".bak")
            if not spare.exists():
                spare.write_bytes(raw)
        # Bytes, not write_text: on Windows, text mode would translate our
        # existing "\r\n" into "\r\r\n".
        payload = (newline.join(lines[:header_idx + 1] + out_body + lines[end_idx:])
                   + newline).encode("utf-8")
        _atomic_write_bytes(path, payload)

    return {"reds_replaced": old_reds, "reds_added": len(new_reds),
            "greens_kept": len([l for l in greens if l.strip()]),
            "backup": bool(backup),
            "audio_mismatch": bool(audio_name and analysed_name
                                   and audio_name.lower() != analysed_name.lower()),
            "osu_audio": audio_name, "analysed_audio": analysed_name}


# ---------------------------------------------------------------------------
# Settings persistence
# ---------------------------------------------------------------------------

def load_config() -> dict:
    """Read the saved preferences, tolerating anything that is not a dict.

    A truncated or hand-edited config used to crash the app on startup with an
    AttributeError, which is unrecoverable without deleting the file by hand.
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
    return {str(key): value for key, value in data.items()}


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
            "csv": "Export CSV",
            "inject": "Inject .osu…",
            "details": "Details…", "offset": "Offset (ms)", "beatlen": "Beat (ms)",
            "confidence": "Confidence", "overview": "TEMPO TRACE — click a row to highlight its section",
            "hint": "Tip: the presets set the trade-off — Variable catches short sections, Steady ignores wobble. BPM and offsets come from a least-squares grid fit, so they are exact to ~0.001 BPM when the song has a steady pulse; what stays a judgement call is the octave. If the BPM reads half or double (e.g. 112 instead of 225), hit ×2 or ÷2 — that is instant and exact. Export the click track and listen before mapping.",
            "pulse": "Pulse (octave)",
            "preset_variable": "⚡ Variable", "preset_steady": "🛡 Steady",
            "rescaled": "Pulse ×{factor}: {points} section(s) • {bpm} BPM. Verify with the click track.",
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
            "injected": "Injected {added} red lines ({replaced} replaced, {greens} greens kept). Backup saved.",
            "all_audio": "Audio files", "all": "All files",
            "language": "Language", "file": "Audio file",
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
            "csv": "Exportar CSV", "inject": "Inyectar .osu…",
            "details": "Detalles…", "offset": "Offset (ms)", "beatlen": "Beat (ms)",
            "confidence": "Confianza", "overview": "CURVA DE TEMPO — clic en una fila para resaltar su sección",
            "hint": "Consejo: los presets fijan el equilibrio — Variable detecta secciones cortas, Estable ignora fluctuaciones. El BPM y los offsets salen de un ajuste por mínimos cuadrados, así que son exactos a ~0,001 BPM si la canción tiene pulso estable; lo que sigue siendo criterio es la octava. Si el BPM sale a la mitad o al doble (p. ej. 112 en vez de 225), pulsa ×2 o ÷2 — es instantáneo y exacto. Exporta el click track y escúchalo antes de mapear.",
            "pulse": "Pulso (octava)",
            "preset_variable": "⚡ Variable", "preset_steady": "🛡 Estable",
            "rescaled": "Pulso ×{factor}: {points} sección(es) • {bpm} BPM. Verifícalo con el click track.",
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
            "injected": "Inyectadas {added} líneas rojas ({replaced} reemplazadas, {greens} verdes intactas). Backup guardado.",
            "all_audio": "Archivos de audio", "all": "Todos los archivos",
            "language": "Idioma", "file": "Archivo de audio",
            "trace_empty": "Analiza un audio para ver su curva de tempo",
            "section": "§{n}  {bpm} BPM @ {ms}",
            "menu_file": "Archivo", "menu_export": "Exportar", "menu_help": "Ayuda",
            "about": "Acerca de", "quit": "Salir",
            "about_text": "Overtone v{version}\nDetector local de BPM / offsets para mapping.\nAjuste de rejilla por mínimos cuadrados; offsets en ms enteros.\nVerifica siempre las líneas rojas en el editor de osu!.",
            "stable_yes": "constante", "stable_var": "variable",
        },
    }

    ACCENT = "#FF66AA"
    ACCENT2 = "#7C5CFF"

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
        self.root = tk.Tk()
        self.root.minsize(1020, 680)
        self.root.geometry("1120x760")
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
        self._theme()
        self._build()
        self._translate()
        self.root.protocol("WM_DELETE_WINDOW", self._quit)

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
        bg, panel, panel2, field = "#0B0E14", "#131926", "#182032", "#1E2738"
        fg, muted, border, accent = "#F2F5FA", "#8B98AD", "#263044", self.ACCENT
        self.C = {"bg": bg, "panel": panel, "panel2": panel2, "field": field,
                  "fg": fg, "muted": muted, "border": border, "accent": accent}
        self.root.configure(bg=bg)
        style.configure("TFrame", background=bg)
        style.configure("Card.TFrame", background=panel, borderwidth=1, relief="flat")
        style.configure("Stat.TFrame", background=panel2, borderwidth=1, relief="flat")
        style.configure("TLabel", background=bg, foreground=fg, font=("Segoe UI", 10))
        style.configure("Card.TLabel", background=panel, foreground=fg, font=("Segoe UI", 10))
        style.configure("Muted.TLabel", background=panel, foreground=muted, font=("Segoe UI", 9))
        style.configure("CardHead.TLabel", background=panel, foreground=fg, font=("Segoe UI Semibold", 11))
        style.configure("Title.TLabel", background=bg, foreground=fg, font=("Segoe UI Semibold", 22))
        style.configure("Subtitle.TLabel", background=bg, foreground=muted, font=("Segoe UI", 10))
        style.configure("Pill.TLabel", background=accent, foreground="#FFFFFF", font=("Segoe UI Semibold", 9), padding=(10, 3))
        style.configure("StatBig.TLabel", background=panel2, foreground=fg, font=("Segoe UI Semibold", 20))
        style.configure("StatCap.TLabel", background=panel2, foreground=muted, font=("Segoe UI Semibold", 9))
        style.configure("Status.TLabel", background=panel, foreground="#C4D0E2", font=("Segoe UI", 10))
        style.configure("TEntry", fieldbackground=field, foreground=fg, insertcolor=fg,
                        borderwidth=1, relief="flat", padding=9)
        style.configure("TCombobox", fieldbackground=field, background=field, foreground=fg, padding=6)
        style.map("TCombobox", fieldbackground=[("readonly", field)], foreground=[("readonly", fg)])
        style.configure("TCheckbutton", background=panel, foreground=fg, font=("Segoe UI", 10))
        style.map("TCheckbutton", background=[("active", panel)], foreground=[("active", fg)])
        style.configure("TButton", background="#242E44", foreground=fg, borderwidth=0,
                        relief="flat", padding=(14, 9), font=("Segoe UI Semibold", 10))
        style.map("TButton", background=[("active", "#303C57"), ("disabled", "#1A2130")])
        style.configure("Accent.TButton", background=accent, foreground="#FFFFFF", borderwidth=0,
                        relief="flat", padding=(18, 11), font=("Segoe UI Semibold", 11))
        style.map("Accent.TButton", background=[("active", "#FF85BE"), ("disabled", "#5A3348")])
        style.configure("Ghost.TButton", background=panel2, foreground=fg, borderwidth=1, relief="flat", padding=(12, 8))
        style.configure("Treeview", background=panel, fieldbackground=panel, foreground=fg,
                        rowheight=30, borderwidth=0, font=("Segoe UI", 10))
        style.configure("Treeview.Heading", background="#1D2639", foreground=muted, relief="flat",
                        font=("Segoe UI Semibold", 10), padding=(10, 8))
        style.map("Treeview", background=[("selected", "#3A2B4D")], foreground=[("selected", fg)])
        style.configure("Horizontal.TProgressbar", background=accent, troughcolor=panel2,
                        borderwidth=0, thickness=6)

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

        # Header: pink dot + title + version pill + language
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
        self.table = ttk.Treeview(table_frame, columns=cols, show="headings", height=9)
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

        self.preview = tk.Canvas(center, height=132, bg="#131926", highlightthickness=1,
                                 highlightbackground=self.C["border"])
        self.preview.pack(fill="x", pady=(10, 0))
        self.preview.bind("<Configure>", lambda _e: self._draw_preview())
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
        self.root.bind("<Control-c>", lambda _e: self.copy_osu())
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
        target = float(self.analysis.subdivision) * mult
        factor = min(ALLOWED_FACTORS, key=lambda f: abs(np.log2(f / target)))
        delta, persistence, confidence = self._current_params()
        try:
            self.analysis = rebuild_with_subdivision(self.analysis, factor, delta,
                                                     persistence, confidence)
        except Exception as exc:
            self.status.set(self.tr("error", value=str(exc)))
            return
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

    def _after_edit(self, message: str) -> None:
        assert self.analysis is not None
        self.selected_section = None
        self._render_results()
        self.status.set(message)

    def edit_apply(self) -> None:
        if not self.analysis or self.selected_section is None:
            self.status.set(self.tr("no_selection"))
            return
        try:
            offset, bpm = self._editor_values()
            self.analysis.points = update_timing_point(
                self.analysis.points, self.analysis.beats, self.selected_section, offset, bpm)
        except ValueError as exc:
            self.status.set(self.tr("error", value=str(exc)))
            return
        index = min(range(len(self.analysis.points)),
                    key=lambda n: abs(self.analysis.points[n].offset_ms - offset))
        point = self.analysis.points[index]
        self._after_edit(self.tr("edited", n=index + 1,
                                 bpm=f"{point.bpm:.3f}", ms=f"{point.offset_ms:.1f}"))

    def edit_add(self) -> None:
        if not self.analysis:
            self.status.set(self.tr("first"))
            return
        try:
            offset, bpm = self._editor_values()
            self.analysis.points = add_timing_point(
                self.analysis.points, self.analysis.beats, offset, bpm)
        except ValueError as exc:
            self.status.set(self.tr("error", value=str(exc)))
            return
        self._after_edit(self.tr("added_point", bpm=f"{bpm:.2f}", ms=f"{offset:.1f}"))

    def edit_delete(self) -> None:
        if not self.analysis or self.selected_section is None:
            self.status.set(self.tr("no_selection"))
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
        try:
            before = self.analysis.points[self.selected_section].offset_ms
            self.analysis.points = nudge_timing_point(
                self.analysis.points, self.analysis.beats, self.selected_section, delta_ms)
        except ValueError as exc:
            self.status.set(self.tr("error", value=str(exc)))
            return
        target = before + delta_ms
        index = min(range(len(self.analysis.points)),
                    key=lambda n: abs(self.analysis.points[n].offset_ms - target))
        point = self.analysis.points[index]
        self._after_edit(self.tr("edited", n=index + 1,
                                 bpm=f"{point.bpm:.3f}", ms=f"{point.offset_ms:.1f}"))

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
        point = self.analysis.points[self.selected_section]
        self._set_editor(f"{point.offset_ms:.1f}", f"{point.bpm:.2f}")
        self._after_edit(self.tr("section_rescaled", n=self.selected_section + 1,
                                 bpm=f"{point.bpm:.2f}"))

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
        self.status.set(self.tr("injected", added=done["reds_added"],
                                replaced=done["reds_replaced"], greens=done["greens_kept"]))

    def save_csv(self) -> None:
        if not self.analysis:
            self.status.set(self.tr("first"))
            return
        from tkinter import filedialog
        target = filedialog.asksaveasfilename(defaultextension=".csv", filetypes=[("CSV", "*.csv")])
        if target:
            export_csv(self.analysis, target)
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

    def copy_osu(self) -> None:
        if not self.analysis:
            self.status.set(self.tr("first"))
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(osu_timing_text(self.analysis))
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

    def _draw_preview(self) -> None:
        """Tempo trace with section shading, red-line markers and selection."""
        canvas = self.preview
        canvas.delete("all")
        width, height = max(canvas.winfo_width(), 1), max(canvas.winfo_height(), 1)
        canvas.create_text(14, 13, anchor="w", fill="#8B98AD", font=("Segoe UI Semibold", 9),
                           text="TEMPO TRACE · BPM")
        if not self.analysis or len(self.analysis.local_bpms) < 2:
            canvas.create_text(width / 2, height / 2 + 8, fill="#5B6678",
                               font=("Segoe UI", 10), text=self.tr("trace_empty"))
            return
        values = np.asarray(self.analysis.local_bpms, dtype=float)
        times = np.asarray(self.analysis.beats, dtype=float)
        snapped = snap_timing_points(self.analysis.points)
        low, high = np.quantile(values, [0.05, 0.95])
        if high - low < 0.5:
            low, high = low - 1, high + 1
        pad_x, top, bottom = 16, 30, height - 14
        duration = max(float(times[-1]), 0.001)

        def x_of(t: float) -> float:
            return pad_x + (width - pad_x * 2) * float(t) / duration

        def y_of(bpm: float) -> float:
            return bottom - (bottom - top) * float(np.clip((bpm - low) / (high - low), 0, 1))

        # Section shading (alternating) + faint onset bed.
        bounds = [0.0] + [p.offset_ms / 1000.0 for p in snapped[1:]] + [duration]
        for s in range(len(bounds) - 1):
            if s % 2 == 1:
                canvas.create_rectangle(x_of(bounds[s]), top, x_of(bounds[s + 1]), bottom,
                                        fill="#182032", outline="")
        try:
            bed = np.asarray(self.analysis.onset, dtype=float)
            if bed.size > 8:
                xs = np.linspace(pad_x, width - pad_x, min(400, bed.size))
                idx = np.linspace(0, bed.size - 1, len(xs)).astype(int)
                peak = max(float(np.max(bed)), 1e-9)
                for x, b in zip(xs, bed[idx]):
                    h = (bottom - top) * 0.35 * float(b) / peak
                    canvas.create_line(x, bottom, x, bottom - h, fill="#2A3550")
        except Exception:
            pass
        # Tempo line.
        coords: list[float] = []
        for t, bpm in zip(times, values):
            coords.extend((x_of(float(t)), y_of(float(bpm))))
        if len(coords) >= 4:
            canvas.create_line(*coords, fill="#FF66AA", width=2, smooth=True)
        # Red lines + labels.
        for s, point in enumerate(snapped):
            x = x_of(point.offset_ms / 1000.0)
            selected = self.selected_section == s
            canvas.create_line(x, top, x, bottom, fill="#FFD166" if selected else "#3DDC84",
                               width=2 if selected else 1)
            label = f"{point.bpm:.0f}"
            canvas.create_text(min(max(x + 4, pad_x + 20), width - 30), top + 9, anchor="w",
                               fill="#FFD166" if selected else "#7EE2B0",
                               font=("Segoe UI Semibold", 9), text=label)

    def start(self) -> None:
        self.root.mainloop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Overtone — BPM and offset detector for osu! mapping")
    parser.add_argument("audio", nargs="?", help="Audio file to analyze (no argument opens the GUI)")
    parser.add_argument("--delta", type=float, default=1.5, help="Minimum BPM change (default 1.5)")
    parser.add_argument("--persistence", type=int, default=12, help="Beats required to confirm a change (default 12; 20+ for steady songs)")
    parser.add_argument("--min-confidence", type=float, default=75, help="Minimum confidence of exported points (0-100; default 75)")
    parser.add_argument("--csv", help="Output CSV path")
    parser.add_argument("--click", help="Output click-track WAV path (metronome aligned to red lines)")
    parser.add_argument("--stats", action="store_true", help="Print a human-readable summary table")
    parser.add_argument("--subdivision", choices=("auto", "0.25", "0.5", "1", "2", "4"), default="auto",
                        help="Multiply the detected beat rate: 2 doubles (fixes a half-time read), 0.5 halves. Default: auto.")
    parser.add_argument("--engine", choices=("auto", "precision", "legacy"), default="auto",
                        help="auto (default) fits the grid and falls back to the v2 tracker; "
                             "precision refuses to fall back; legacy forces the v2 tracker.")
    parser.add_argument("--decimal-offsets", type=int, default=0, metavar="N",
                        help="Write N decimals on offsets (default 0 — whole ms, what osu!stable expects)")
    parser.add_argument("--no-refine", action="store_true", help="Skip sample-resolution attack re-timing (diagnostic)")
    parser.add_argument("--inject", metavar="MAP.OSU", help="Inject red lines into an .osu [TimingPoints] (backup .bak, greens kept)")
    parser.add_argument("--no-backup", action="store_true", help="Skip the .bak backup when injecting")
    parser.add_argument("--no-map-preference", action="store_true", help="Do not prefer 120-300 mapping BPM when resolving the octave")
    args = parser.parse_args()
    if not args.audio:
        TimingAnalyzerApp().start()
        return
    if not 0 <= args.decimal_offsets <= 6:
        print("Error: --decimal-offsets must be between 0 and 6")
        raise SystemExit(2)
    force = 0.0 if args.subdivision == "auto" else float(args.subdivision)
    try:
        analysis = analyze_audio(args.audio, args.delta, args.persistence, not args.no_map_preference,
                                 args.min_confidence / 100, print, force,
                                 refine_beats=not args.no_refine, engine=args.engine)
    except (ValueError, RuntimeError, OSError) as exc:
        print(f"Error: {exc}")
        raise SystemExit(1)
    if args.stats:
        print(analysis_summary(analysis))
        print()
    print(osu_timing_text(analysis, args.decimal_offsets))
    try:
        if args.csv:
            export_csv(analysis, args.csv)
        if args.click:
            export_click_track(analysis, args.click)
    except (OSError, ValueError) as exc:
        print(f"Error writing output: {exc}")
        raise SystemExit(1)
    if args.inject:
        try:
            summary = inject_osu_timing_points(args.inject, analysis, backup=not args.no_backup,
                                               decimals=args.decimal_offsets)
        except (ValueError, OSError) as exc:
            print(f"Error injecting into {args.inject}: {exc}")
            raise SystemExit(1)
        print(f"Injected {summary['reds_added']} red lines "
              f"({summary['reds_replaced']} replaced, {summary['greens_kept']} greens kept)"
              + (" [audio mismatch!]" if summary["audio_mismatch"] else ""))


if __name__ == "__main__":
    main()
