"""Tempo map analyser for osu! beatmapping (v2.1).

Pipeline
--------
1. Load mono audio at 44.1 kHz (SoundFile fast-path, librosa fallback).
2. Build a normalized onset-strength envelope (librosa, STFT-flux fallback).
3. Track beats with a hybrid engine: librosa ``beat_track`` + PLP + a
   peak-picking fallback. The most regular candidate wins, then beats are
   re-anchored to transients with parabolic sub-frame correction, trimmed
   out of leading silence, and locally gap-filled (missed beats rebuilt only
   when both sides agree on the tempo).
4. Derive local tempo from the median of neighbouring beat intervals with
   MAD-based outlier rejection (far less jumpy than single-interval BPM).
5. Resolve half/double-time octaves with onset evidence at subdivided grid
   positions plus tempogram hypotheses — never by blind multiplication.
6. Segment stable tempo regions with persistence + minimum-change filters,
   one-outlier tolerance and midpoint backtracking, then snap red lines to
   the previous section's beat grid for osu!.

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

APP_VERSION = "2.2"
DEFAULT_LANGUAGE = "English"  # English is the default UI language.
CONFIG_PATH = Path.home() / ".timing_analyzer.json"
TARGET_SR = 44100
HOP = 256  # ~5.8 ms at 44.1 kHz: timing-grid resolution suited to mapping.


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
    subdivision: int
    # v2 enrichment (defaults keep old pickles/callers working)
    global_bpm: float = 0.0
    stability: float = 0.0
    meter: str = "4/4"
    onset: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    # Pre-subdivision beat grid (frames): lets the GUI/CLI re-resolve ×1/×2/×4
    # without re-tracking beats.
    base_frames: np.ndarray | None = None


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
        count = max(1, int(round((right - left) / typical)))
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
        return np.asarray(beat_frames, dtype(float if return_float else int))
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
    """Return [(bpm, weight)] tempo hypotheses from a tempogram + tracker."""
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
# Main analysis entry point
# ---------------------------------------------------------------------------

def analyze_audio(path: str | os.PathLike[str], min_delta: float = 1.5,
                  persistence: int = 12, prefer_map_bpm: bool = True,
                  min_confidence: float = 0.75,
                  progress: Callable[[str], None] | None = None,
                  force_subdivision: int = 0, refine_beats: bool = True) -> Analysis:
    """Analyse an audio file and return stable timing points.

    Most common formats work when libsndfile supports them. For MP3/M4A and
    other compressed formats, install FFmpeg so librosa can use its fallback.

    ``force_subdivision`` overrides the automatic half/double-time decision
    (0 = auto, otherwise 1, 2 or 4). Use it when you *know* the song's octave
    — e.g. a 225 BPM stream detected as 112 BPM — or from the GUI ×2 button.
    ``refine_beats`` re-anchors beats to transients with sub-frame precision;
    disable it only to diagnose whether snapping itself causes drift.
    """
    if min_delta <= 0 or persistence < 2 or not 0 <= min_confidence <= 1:
        raise ValueError("Minimum delta must be positive, persistence at least 2, confidence between 0 and 1.")
    say = progress or (lambda _message: None)
    say("Loading and normalizing audio…")
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
    if len(y) < sr * 2:
        raise ValueError("Audio must be at least two seconds long.")
    y = np.asarray(y, dtype=np.float32)
    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    if peak > 1e-9:
        y = (y / peak * 0.99).astype(np.float32)

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
        subdivision = force_subdivision
    else:
        subdivision = _choose_subdivision(onset, beat_frames, prefer_map_bpm, guides)
    beat_frames_raw = np.asarray(beat_frames, dtype=float).copy()
    beat_frames = _insert_subdivisions(beat_frames, subdivision)
    if refine_beats:
        # Interpolated midpoints can sit up to half a beat away from the true
        # attack, so widen the snap window proportionally to the beat length.
        # Float frames preserve sub-frame transient corrections (≈ms accuracy at
        # 225 BPM, where one integer frame already spans ~2 % of tempo).
        median_gap_s = float(np.median(np.diff(np.asarray(beat_frames, dtype=float)))) * hop / sr if len(beat_frames) > 1 else 0.5
        beat_frames = _refine_beats_to_transients(
            beat_frames, onset, sr, hop,
            radius_ms=float(np.clip(0.30 * median_gap_s * 1000, 25, 90)),
            return_float=True)
    beat_frames = _trim_leading_silence(beat_frames, onset)
    # Rebuild bars the tracker skipped over (sparse breakdowns, ghost notes):
    # without this, a thin section reads as half tempo and becomes a phantom
    # red line. Long silences are intentionally left unfilled (grid restarts).
    beat_frames = _fill_missed_beats(beat_frames)
    beat_times = np.asarray(beat_frames, dtype=np.float64) * hop / sr

    say("Computing local tempo and persistent changes…")
    local = _robust_local_bpms(beat_times)
    # Remove clearly impossible detections before segmentation; osu! maps rarely use these.
    valid = (local >= 30) & (local <= 600)
    if int(valid.sum()) < 8:
        raise ValueError("Detected tempo is outside the usable range.")
    beats_v, local_v = beat_times[valid], local[valid]
    candidates = _segment_tempi(beats_v, local_v, min_delta, persistence)
    points = [point for point in candidates if point.confidence >= min_confidence]
    if not points and candidates:
        # Never return an empty map when a tempo was clearly found: keep the
        # strongest candidate so CLI/GUI users always get a usable red line.
        points = [max(candidates, key=lambda p: p.confidence)]

    global_bpm = float(np.median(local_v)) if len(local_v) else 0.0
    if guides:
        # Nudge the headline number toward the tempogram hypothesis only when
        # it agrees with the beat grid (octave-aware), otherwise trust beats.
        for tempo_hint, _w in guides[:3]:
            for mult in (0.5, 1.0, 2.0):
                if abs(tempo_hint * mult - global_bpm) <= max(2.0, global_bpm * 0.02):
                    global_bpm = float((global_bpm + tempo_hint * mult) / 2.0)
                    break
    return Analysis(str(path), len(y) / sr, beats_v, local_v, points, hop, sr,
                    subdivision, global_bpm, _stability(local_v),
                    _guess_meter(beats_v, onset, sr, hop), onset, beat_frames_raw)


def rebuild_with_subdivision(analysis: Analysis, factor: int,
                             min_delta: float = 1.5, persistence: int = 12,
                             min_confidence: float = 0.75) -> Analysis:
    """Re-resolve an existing analysis at ×1/×2/×4 without re-tracking beats.

    Powers the GUI "×2 / ÷2" quick fix: instant, no audio reload. Raises
    ``ValueError`` if the analysis has no stored base grid (e.g. built by
    very old code).
    """
    if factor not in (1, 2, 4):
        raise ValueError("Subdivision factor must be 1, 2 or 4.")
    if analysis.base_frames is None or len(analysis.base_frames) < 4:
        raise ValueError("This analysis has no stored beat grid to rebuild from.")
    frames = _insert_subdivisions(np.asarray(analysis.base_frames, dtype=float), factor)
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
                    analysis.hop_length, analysis.sample_rate, factor, global_bpm,
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
    total = int((analysis.duration + 1.0) * sr)
    click = np.zeros(total, dtype=np.float32)

    def place(time_s: float, accent: bool) -> None:
        idx = int(time_s * sr)
        if not 0 <= idx < total:
            return
        freq = 2093.0 if accent else 1568.0
        n = int(0.045 * sr)
        tone = np.sin(2 * np.pi * freq * np.arange(n) / sr) * np.exp(-np.arange(n) / (0.008 * sr))
        end = min(total, idx + n)
        click[idx:end] += tone[:end - idx] * (1.0 if accent else 0.7)

    snapped = snap_timing_points(analysis.points)
    for s, point in enumerate(snapped):
        start = point.offset_ms / 1000.0
        end = snapped[s + 1].offset_ms / 1000.0 if s + 1 < len(snapped) else analysis.duration
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
        beat_length = 60000.0 / previous.bpm
        beat_count = max(1, round((point.offset_ms - previous.offset_ms) / beat_length))
        offset = previous.offset_ms + beat_count * beat_length
        snapped.append(TimingPoint(offset, point.bpm, point.confidence, point.beat_index))
    return snapped


def osu_timing_text(analysis: Analysis) -> str:
    """Return uninherited (red) timing points ready for an .osu [TimingPoints] section."""
    # osu! only guarantees comments on their own lines. Do not append a human
    # annotation after the Effects field: some parsers treat it as invalid.
    rows = ["// Generated by osu! Timing Analyzer v" + APP_VERSION]
    for p in snap_timing_points(analysis.points):
        beat_length = 60000.0 / p.bpm
        rows.append(f"{p.offset_ms:.3f},{beat_length:.12f},4,1,0,100,1,0")
    return "\n".join(rows)


def analysis_summary(analysis: Analysis) -> str:
    """One-page human-readable report (CLI --stats and GUI details)."""
    lines = [
        f"Source:      {analysis.source}",
        f"Duration:    {analysis.duration:.2f} s   •   {len(analysis.beats)} beats",
        f"Global BPM:  {analysis.global_bpm:.2f}   •   meter {analysis.meter}   •   pulse x{analysis.subdivision}",
        f"Stability:   {analysis.stability:.0%}   •   sections {len(analysis.points)}",
        "",
        f"{'#':>3}  {'offset_ms':>10}  {'bpm':>10}  {'beat_len':>9}  {'conf':>6}",
    ]
    for i, p in enumerate(snap_timing_points(analysis.points), 1):
        lines.append(f"{i:>3}  {p.offset_ms:10.1f}  {p.bpm:10.2f}  {60000 / p.bpm:9.2f}  {p.confidence:6.0%}")
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

def inject_osu_timing_points(osu_path: str | os.PathLike[str],
                             analysis: Analysis,
                             backup: bool = True,
                             dry_run: bool = False) -> dict:
    """Replace the red (uninherited) lines of an .osu with this analysis.

    Green lines, metadata, hit objects — everything else — are preserved
    byte-for-byte, including the file's CRLF/LF style. A ``.bak`` copy is
    written first unless ``backup`` is False. With ``dry_run`` nothing is
    written (used for the GUI confirmation dialog). Returns a summary dict
    with ``reds_replaced``, ``reds_added``, ``greens_kept`` and an
    ``audio_mismatch`` warning when the .osu's AudioFilename differs from the
    analyzed file.
    """
    raw = Path(osu_path).read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError(f"Could not decode {osu_path} as UTF-8.") from exc
    newline = "\r\n" if b"\r\n" in raw else "\n"
    lines = text.splitlines()

    header_idx = next((n for n, line in enumerate(lines)
                       if line.strip() == "[TimingPoints]"), None)
    if header_idx is None:
        raise ValueError("No [TimingPoints] section found in this .osu file.")
    end_idx = len(lines)
    for n in range(header_idx + 1, len(lines)):
        if lines[n].startswith("[") and lines[n].strip().endswith("]"):
            end_idx = n
            break
    body = lines[header_idx + 1:end_idx]

    def is_red(line: str) -> bool:
        fields = line.split(",")
        return len(fields) >= 8 and fields[6].strip() == "1"

    greens = [line for line in body if line.strip() and not is_red(line.strip())]
    old_reds = sum(1 for line in body if line.strip() and is_red(line.strip()))
    new_reds = [row for row in osu_timing_text(analysis).splitlines()
                if row and not row.startswith("//")]

    if old_reds:
        # Replace in place: new reds take the position of the first old red,
        # remaining old reds are dropped, greens keep their exact lines.
        out_body: list[str] = []
        replaced = False
        for line in body:
            if line.strip() and is_red(line.strip()):
                if not replaced:
                    out_body.extend(new_reds)
                    replaced = True
            else:
                out_body.append(line)
    else:
        out_body = list(body) + new_reds

    if backup and not dry_run:
        Path(str(osu_path) + ".bak").write_bytes(raw)
    # Bytes, not write_text: on Windows, text mode would translate our
    # existing "\r\n" into "\r\r\n".
    if not dry_run:
        Path(osu_path).write_bytes((newline.join(lines[:header_idx + 1] + out_body + lines[end_idx:]) + newline).encode("utf-8"))

    audio_name = ""
    for line in lines:
        if line.startswith("AudioFilename:"):
            audio_name = line.split(":", 1)[1].strip()
            break
    analysed_name = Path(analysis.source).name
    return {"reds_replaced": old_reds, "reds_added": len(new_reds),
            "greens_kept": len([l for l in greens if l.strip()]),
            "backup": bool(backup),
            "audio_mismatch": bool(audio_name and audio_name.lower() != analysed_name.lower()),
            "osu_audio": audio_name, "analysed_audio": analysed_name}


# ---------------------------------------------------------------------------
# Settings persistence
# ---------------------------------------------------------------------------

def load_config() -> dict:
    try:
        if CONFIG_PATH.is_file():
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def save_config(data: dict) -> None:
    try:
        CONFIG_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------

class TimingAnalyzerApp:
    TEXT = {
        "English": {
            "title": "osu! Timing Analyzer", "subtitle": "Precise BPM and offsets for your beatmap",
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
            "hint": "Tip: presets below set the trade-off. Variable catches short sections (songs that change often); Steady ignores wobble. If the BPM reads HALF (e.g. 112 instead of 225), hit ×2. Export the click track and listen for drift before mapping.",
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
            "about_text": "osu! Timing Analyzer v{version}\nLocal BPM / offset detector for mapping.\nAlways verify red lines in the osu! editor.",
            "stable_yes": "constant", "stable_var": "variable",
        },
        "Español": {
            "title": "osu! Timing Analyzer", "subtitle": "BPM y offsets precisos para tu beatmap",
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
            "hint": "Consejo: los presets fijan el equilibrio. Variable detecta secciones cortas (temas que cambian seguido); Steady ignora fluctuaciones. Si el BPM sale a la MITAD (p. ej. 112 en vez de 225), pulsa ×2. Exporta el click track y escucha derivas antes de mapear.",
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
            "about_text": "osu! Timing Analyzer v{version}\nDetector local de BPM / offsets para mapping.\nVerifica siempre las líneas rojas en el editor de osu!.",
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
        ttk.Label(title_box, text="osu! Timing Analyzer", style="Title.TLabel").pack(anchor="w")
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
        pulse_menu = ttk.Combobox(grid, textvariable=self.pulse, values=("Auto", "×1", "×2", "×4"),
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
        pulse_map = {"×1": 1, "×2": 2, "×4": 4}
        force = pulse_map.get(self.pulse.get(), 0)
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
                confidence: float, force_subdivision: int = 0,
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
        if self.analysis.base_frames is None:
            self.status.set(self.tr("error", value="No stored beat grid — re-run Analyze first."))
            return
        target = self.analysis.subdivision * mult
        factor = 4 if target >= 4 else (2 if target >= 2 else 1)
        delta, persistence, confidence = self._current_params()
        try:
            self.analysis = rebuild_with_subdivision(self.analysis, factor, delta,
                                                     persistence, confidence)
        except Exception as exc:
            self.status.set(self.tr("error", value=str(exc)))
            return
        self.selected_section = None
        self._render_results()
        self.status.set(self.tr("rescaled", factor=factor, points=len(self.analysis.points),
                                bpm=f"{self.analysis.global_bpm:.1f}"))

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
            self.table.insert("", "end",
                              values=(i, f"{p.offset_ms:.1f}", f"{p.bpm:.2f}",
                                      f"{60000 / p.bpm:.2f}", f"{p.confidence:.0%}"),
                              tags=tag)
        stable_txt = self.tr("stable_yes") if analysis.stability >= 0.75 else self.tr("stable_var")
        self.stat_vars["global"].set(f"{analysis.global_bpm:.1f}")
        self.stat_vars["sections"].set(f"{len(analysis.points)}  ({analysis.meter})")
        self.stat_vars["beats"].set(f"{len(analysis.beats)}")
        self.stat_vars["stability"].set(f"{analysis.stability:.0%} {stable_txt}")
        mode = self.tr("normal") if analysis.subdivision == 1 else self.tr("confirmed", factor=analysis.subdivision)
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
        point = min(self.analysis.points, key=lambda p: abs(p.offset_ms - offset))
        self._after_edit(self.tr("edited", n=self.analysis.points.index(point) + 1,
                                 bpm=f"{point.bpm:.2f}", ms=f"{point.offset_ms:.1f}"))

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
        point = min(self.analysis.points, key=lambda p: abs(p.offset_ms - (before + delta_ms)))
        self._after_edit(self.tr("edited", n=self.analysis.points.index(point) + 1,
                                 bpm=f"{point.bpm:.2f}", ms=f"{point.offset_ms:.1f}"))

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
            }
            return translations.get(message, message)
        reverse = {
            "Loading and normalizing audio…": "Cargando y normalizando el audio…",
            "Extracting transients and tempo hypotheses…": "Extrayendo transitorios y beats…",
            "Tracking beats (hybrid DP + PLP + peaks)…": "Extrayendo transitorios y beats…",
            "Resolving half/double-time pulse…": "Resolviendo si el pulso detectado es half-time…",
            "Computing local tempo and persistent changes…": "Calculando tempo local y cambios persistentes…",
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
    parser = argparse.ArgumentParser(description="osu! Timing Analyzer — BPM and offset detector for mapping")
    parser.add_argument("audio", nargs="?", help="Audio file to analyze (no argument opens the GUI)")
    parser.add_argument("--delta", type=float, default=1.5, help="Minimum BPM change (default 1.5)")
    parser.add_argument("--persistence", type=int, default=12, help="Beats required to confirm a change (default 12; 20+ for steady songs)")
    parser.add_argument("--min-confidence", type=float, default=75, help="Minimum confidence of exported points (0-100; default 75)")
    parser.add_argument("--csv", help="Output CSV path")
    parser.add_argument("--click", help="Output click-track WAV path (metronome aligned to red lines)")
    parser.add_argument("--stats", action="store_true", help="Print a human-readable summary table")
    parser.add_argument("--subdivision", choices=("auto", "1", "2", "4"), default="auto",
                        help="Force pulse octave: 2 fixes half-time locks (e.g. 112 read instead of 225). Default: auto.")
    parser.add_argument("--no-refine", action="store_true", help="Skip transient re-anchoring (diagnose snapping drift)")
    parser.add_argument("--inject", metavar="MAP.OSU", help="Inject red lines into an .osu [TimingPoints] (backup .bak, greens kept)")
    parser.add_argument("--no-backup", action="store_true", help="Skip the .bak backup when injecting")
    parser.add_argument("--no-map-preference", action="store_true", help="Do not prefer 120-300 mapping BPM when resolving half-time")
    args = parser.parse_args()
    if not args.audio:
        TimingAnalyzerApp().start()
        return
    force = int(args.subdivision) if args.subdivision in ("1", "2", "4") else 0
    try:
        analysis = analyze_audio(args.audio, args.delta, args.persistence, not args.no_map_preference,
                                 args.min_confidence / 100, print, force,
                                 refine_beats=not args.no_refine)
    except (ValueError, RuntimeError, OSError) as exc:
        print(f"Error: {exc}")
        raise SystemExit(1)
    if args.stats:
        print(analysis_summary(analysis))
        print()
    print(osu_timing_text(analysis))
    try:
        if args.csv:
            export_csv(analysis, args.csv)
        if args.click:
            export_click_track(analysis, args.click)
    except OSError as exc:
        print(f"Error writing output: {exc}")
        raise SystemExit(1)
    if args.inject:
        try:
            summary = inject_osu_timing_points(args.inject, analysis, backup=not args.no_backup)
        except (ValueError, OSError) as exc:
            print(f"Error injecting into {args.inject}: {exc}")
            raise SystemExit(1)
        print(f"Injected {summary['reds_added']} red lines "
              f"({summary['reds_replaced']} replaced, {summary['greens_kept']} greens kept)"
              + (" [audio mismatch!]" if summary["audio_mismatch"] else ""))


if __name__ == "__main__":
    main()
