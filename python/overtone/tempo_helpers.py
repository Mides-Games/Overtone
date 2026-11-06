"""Tempo helpers: tempogram hints and attack detection."""
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

from . import data_model, hybrid_tracker, params


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
            frame_tempi = hybrid_tracker._tempo_readings(onset, sr, hop)[0]
        tempo_frames = np.atleast_2d(np.asarray(frame_tempi, dtype=float))
        for value in np.median(tempo_frames, axis=1):
            if 30 <= value <= 600 and np.isfinite(value):
                guides.append((float(value), 1.0))
    except Exception:
        pass
    try:
        tempogram = np.concatenate(list(hybrid_tracker._tempogram(onset, sr, hop, 384)), axis=-1)
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
        points.append(data_model.TimingPoint(float(beats[index] * 1000), float(tempo), confidence, index))

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
        refined.append(data_model.TimingPoint(point.offset_ms, tempo, confidence, point.beat_index))
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
    frame_rate = params.TARGET_SR / params.HOP
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
