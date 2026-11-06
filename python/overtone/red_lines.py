"""Red lines from beats: octave folding, drift, local tempo and piecewise grids."""
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

from . import beat_this, params, phrases, pipeline, precision_grid


def _fold_to_map_octave(analysis: Analysis, min_delta: float, persistence: int,
                        min_confidence: float) -> Analysis:
    """Read the analysis at the octave osu! maps use (MAP_OCTAVE_RANGE).

    The grids are kept; only the pulse they are read at changes, exactly as
    the ×2 / ÷2 quick fix does, so the user can still undo it there. A BPM
    already in range, or one whose fold would leave ALLOWED_FACTORS, is
    returned as it is.
    """
    bpm = float(analysis.global_bpm)
    if not np.isfinite(bpm) or bpm <= 0:
        return analysis
    lo, hi = params.MAP_OCTAVE_RANGE
    step = 1.0
    # A hair of slack: 59.9999 BPM doubled is 120, not a reason to double again.
    while bpm * step < lo - 0.01:
        step *= 2.0
    while bpm * step > hi + 0.01:
        step /= 2.0
    target = float(analysis.subdivision) * step
    if step == 1.0 or target not in params.ALLOWED_FACTORS:
        return analysis
    if step > 1.0 and phrases._swings(analysis):
        # A swung beat's off-beat sits at two thirds, not halfway: doubled,
        # every other "beat" would land on nothing (shuffle-96 read at 192).
        return analysis
    return pipeline.rebuild_with_subdivision(analysis, target, min_delta, persistence, min_confidence)


def _grid_rms(times: np.ndarray, weights: np.ndarray, period: float,
              phase: float) -> tuple[float, float, int]:
    """(rms ms, best phase, inliers) of a grid with its phase refitted."""
    k = np.round((times - phase) / period)
    res = times - (phase + k * period)
    inlier = np.abs(res) <= 0.15 * period
    if int(inlier.sum()) < 8:
        return float("inf"), phase, 0
    w = weights[inlier]
    shift = float(np.average(res[inlier], weights=w))
    res = res[inlier] - shift
    return float(np.sqrt(np.average(res ** 2, weights=w)) * 1000.0), phase + shift, int(inlier.sum())


def _snap_whole_bpm(analysis: Analysis, min_delta: float, persistence: int,
                    min_confidence: float) -> Analysis:
    """Read each section at the whole BPM next to it when its attacks agree.

    A fractional BPM the music really has (decimal-128.37) fits its attacks
    clearly better than the whole number beside it and is kept; a section a
    few tenths off a whole BPM only because its fit was short is moved.
    """
    if not analysis.sections:
        return analysis
    factor = float(analysis.subdivision) or 1.0
    times = np.asarray(analysis.attack_times, dtype=float)
    weights = np.asarray(analysis.attack_weights, dtype=float)
    grow, add = params.WHOLE_BPM_SLACK
    changed, out = False, []
    for section in analysis.sections:
        shown = section.bpm * factor
        whole = round(shown)
        if whole <= 0 or abs(shown - whole) > params.WHOLE_BPM_REACH or abs(shown - whole) < 1e-6:
            out.append(section)
            continue
        window = (times >= section.start_s) & (times <= section.end_s)
        rms, _, n = _grid_rms(times[window], weights[window], section.period, section.phase)
        period = 60.0 / (whole / factor)
        rms2, phase2, n2 = _grid_rms(times[window], weights[window], period, section.phase)
        if n and n2 >= 0.95 * n and rms2 <= rms * grow + add:
            out.append(replace(section, period=period, phase=phase2))
            changed = True
        else:
            out.append(section)
    if not changed:
        return analysis
    return pipeline.rebuild_with_subdivision(replace(analysis, sections=out), factor,
                                    min_delta, persistence, min_confidence)


def _beats_of(lines: list[tuple[float, float]], duration_s: float) -> np.ndarray:
    """Beat times (s) of red lines, the first run back to 0 s as osu! does."""
    out: list[float] = []
    for n, (offset, bpm) in enumerate(lines):
        step = 60000.0 / bpm
        end = lines[n + 1][0] if n + 1 < len(lines) else duration_s * 1000.0
        k = -np.floor(offset / step) if n == 0 else 0.0
        while offset + k * step < end:
            out.append((offset + k * step) / 1000.0)
            k += 1
    return np.asarray(out, dtype=float)


def _attack_rms_ms(beats: np.ndarray, times: np.ndarray, weights: np.ndarray) -> float:
    """Weighted RMS of attacks to their nearest beat, within a quarter beat."""
    if beats.size < 2 or times.size == 0:
        return float("inf")
    i = np.clip(np.searchsorted(beats, times), 1, beats.size - 1)
    d = np.minimum(np.abs(beats[i - 1] - times), np.abs(beats[i] - times))
    near = d <= 0.25 * float(np.median(np.diff(beats)))
    if not near.any():
        return float("inf")
    return float(np.sqrt(np.average(d[near] ** 2, weights=weights[near])) * 1000.0)


def _follow_drift(analysis: Analysis) -> Analysis:
    """Write a red line wherever the song's tempo drifted off the fixed grid."""
    if not analysis.sections or not analysis.points:
        return analysis
    times = np.asarray(analysis.attack_times, dtype=float)
    weights = np.asarray(analysis.attack_weights, dtype=float)
    factor = float(analysis.subdivision) or 1.0
    duration = float(analysis.duration)
    lines: list[tuple[float, float]] = []
    for n, section in enumerate(analysis.sections):
        period = section.period / factor
        end = analysis.sections[n + 1].start_s if n + 1 < len(analysis.sections) else duration
        if n == 0:
            # Start at the first attack, a whole number of bars before the
            # first red line, so the lines stay on the bar it proved.
            first = analysis.points[0].offset_ms / 1000.0
            t = section.phase + round((first - section.phase) / period) * period
            if times.size:
                bar = max(1, int(analysis.points[0].meter)) * period
                t -= max(0.0, np.floor((t - times[0]) / bar)) * bar
        else:
            t = section.phase + np.ceil((section.start_s - section.phase) / period - 1e-9) * period
        while t < end - period:
            hi = min(end, t + params.DRIFT_WINDOW_BEATS * period)
            window = (times >= t - 0.5 * period) & (times < hi + 0.5 * period)
            if int(window.sum()) >= 6:
                fitted, phase, _ = precision_grid._refine_grid(times[window], weights[window], period, t)
                if abs(fitted - period) / period < params.DRIFT_MAX_STEP:
                    moved = phase + round((t - phase) / fitted) * fitted
                    if abs(moved - t) < 0.25 * period:
                        period, t = fitted, moved
            lines.append((t * 1000.0, 60.0 / period))
            t = t + max(1, round((hi - t) / period)) * period
    if len(lines) < 2:
        return analysis
    merged = [lines[0]]
    for offset, bpm in lines[1:]:
        last_offset, last_bpm = merged[-1]
        step = 60000.0 / last_bpm
        if (abs(bpm - last_bpm) < 0.05
                and abs(last_offset + round((offset - last_offset) / step) * step - offset) < 2.0):
            continue
        merged.append((offset, bpm))
    fixed = _beats_of([(p.offset_ms, p.bpm) for p in analysis.points], duration)
    followed = _beats_of(merged, duration)
    followed = followed[followed >= merged[0][0] / 1000.0 - 1e-9]
    if followed.size == 0 or fixed.size < 2:
        return analysis
    i = np.clip(np.searchsorted(fixed, followed), 1, fixed.size - 1)
    apart = np.minimum(np.abs(fixed[i - 1] - followed), np.abs(fixed[i] - followed)) * 1000.0
    if float(np.percentile(apart, 90)) <= params.DRIFT_MIN_MS:
        return analysis
    if _attack_rms_ms(_beats_of(merged, duration), times, weights) >= params.DRIFT_MIN_GAIN *             _attack_rms_ms(_beats_of([(p.offset_ms, p.bpm) for p in analysis.points], duration),
                           times, weights):
        return analysis
    points = []
    for offset, bpm in merged:
        governing = analysis.points[0]
        for point in analysis.points:
            if point.offset_ms <= offset + 30000.0 / bpm:
                governing = point
        points.append(replace(governing, offset_ms=float(offset), bpm=float(bpm)))
    return replace(analysis, points=points, beats=_beats_of(merged, duration))


def _window_tempi(env: np.ndarray, fps: float, k: int = 6) -> list[tuple[float, float]]:
    """A window's autocorrelation tempi (bpm, strength) and their octaves."""
    lo_bpm, hi_bpm = 55.0, 330.0
    seg = env - env.mean()
    if seg.size < 8 or not np.any(seg):
        return []
    n = seg.size
    spec = np.fft.rfft(seg, 2 * n)
    ac = np.fft.irfft(spec * np.conj(spec))[:n]
    ac = ac / max(float(ac[0]), 1e-12)
    out = []
    for i in range(max(int(60 * fps / hi_bpm), 2), min(n - 2, int(np.ceil(60 * fps / lo_bpm)))):
        if ac[i] > ac[i - 1] and ac[i] >= ac[i + 1] and ac[i] > 0:
            d = 0.5 * (ac[i - 1] - ac[i + 1]) / (ac[i - 1] - 2 * ac[i] + ac[i + 1] + 1e-12)
            out.append((60 * fps / (i + d), float(ac[i])))
    out.sort(key=lambda c: -c[1])
    out = out[:k]
    extra = []
    for bpm, strength in out:
        for f in (0.5, 2.0):
            if lo_bpm <= bpm * f <= hi_bpm and not any(abs(bpm * f / b - 1) < 0.03 for b, _ in out):
                extra.append((bpm * f, 0.6 * strength))
    return out + extra


def _octave_up(path: list[float]) -> list[float]:
    """The path with its X/2 windows read at X (LOCAL_OCTAVE_UP)."""
    if not params.LOCAL_OCTAVE_UP or len(path) < 2:
        return list(path)
    tempi = np.asarray(path, dtype=float)
    out = tempi.copy()
    hi = params.MAP_OCTAVE_RANGE[1]
    for i, slow in enumerate(tempi):
        fast = 2.0 * slow
        if fast > hi * (1.0 + params.LOCAL_OCTAVE_UP_TOL):
            continue
        near = np.abs(np.log2(tempi / fast)) < np.log2(1.0 + params.LOCAL_OCTAVE_UP_TOL)
        if near.mean() >= params.LOCAL_OCTAVE_UP_SHARE:
            out[i] = float(np.median(tempi[near]))
    return [float(t) for t in out]


def _tempo_curve(x: np.ndarray, centres: np.ndarray, tempi: list[float]) -> np.ndarray:
    """The tempo at each frame time: a straight line between window centres,
    or with LOCAL_STEP_JUMPS a step half-way where the change is larger than
    LOCAL_STEP_RATIO."""
    tempi = np.asarray(tempi, dtype=float)
    curve = np.interp(x, centres, tempi)
    if not params.LOCAL_STEP_JUMPS:
        return curve
    for i in range(len(tempi) - 1):
        if abs(np.log2(tempi[i + 1] / tempi[i])) > np.log2(params.LOCAL_STEP_RATIO):
            inside = (x >= centres[i]) & (x < centres[i + 1])
            mid = 0.5 * (centres[i] + centres[i + 1])
            curve[inside] = np.where(x[inside] < mid, tempi[i], tempi[i + 1])
    return curve


def _tempo_path(cands: list[list[tuple[float, float]]]) -> list[float]:
    """The cheapest tempo per window (Viterbi), as LOCAL_COSTS weigh it."""
    lo, hi = params.LOCAL_RANGE_BPM

    def node(bpm: float, strength: float) -> float:
        return (-strength + params.LOCAL_COSTS["prior"] * (max(0.0, np.log2(lo / bpm))
                                                    + max(0.0, np.log2(bpm / hi)))
                - params.LOCAL_COSTS["bias"] * np.log2(bpm / 120.0))

    def trans(a: float, b: float) -> float:
        r = abs(np.log2(b / a))
        return params.LOCAL_COSTS["octave"] if abs(r - 1.0) < 0.04 else params.LOCAL_COSTS["jump"] * r

    cost = [node(b, s) for b, s in cands[0]]
    back = []
    for w in range(1, len(cands)):
        new, ptr = [], []
        for b, s in cands[w]:
            best = min(range(len(cands[w - 1])),
                       key=lambda i: cost[i] + trans(cands[w - 1][i][0], b))
            new.append(cost[best] + trans(cands[w - 1][best][0], b) + node(b, s))
            ptr.append(best)
        cost = new
        back.append(ptr)
    i = int(np.argmin(cost))
    path = [i]
    for ptr in reversed(back):
        i = ptr[i]
        path.append(i)
    path.reverse()
    return [cands[w][path[w]][0] for w in range(len(cands))]


def _beats_to_lines(beats: np.ndarray, tol_ms: float) -> list[tuple[float, float]]:
    """Red lines through beat times (s). A line grows beat by beat, refitted
    on every beat it holds, while the next beat lands within ``tol_ms`` of
    where the fit puts it; the beat that does not starts the next line."""
    lines: list[tuple[float, float]] = []
    n = beats.size
    i = 0
    while i < n - 1:
        k = i + 1                         # the line holds beats[i..k]
        while k + 1 < n:
            idx = np.arange(k - i + 1)
            if k - i >= 2:
                slope, icpt = np.polyfit(idx, beats[i:k + 1], 1)
            else:
                slope, icpt = beats[k] - beats[i], beats[i]
            if abs(icpt + slope * (k - i + 1) - beats[k + 1]) * 1000.0 > tol_ms:
                break
            k += 1
        idx = np.arange(k - i + 1)
        if k - i >= 2:
            slope, icpt = np.polyfit(idx, beats[i:k + 1], 1)
        else:
            slope, icpt = beats[k] - beats[i], beats[i]
        lines.append((float(icpt) * 1000.0, 60.0 / float(slope)))
        i = k + 1 if k - i < 1 else k
        if i == k and k + 1 >= n:
            break
    return _merge_lines(lines)


def _merge_lines(lines: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Drop a red line that only continues the one before it."""
    merged = lines[:1]
    for offset, bpm in lines[1:]:
        last_offset, last_bpm = merged[-1]
        step = 60000.0 / last_bpm
        if (abs(bpm / last_bpm - 1) < 0.002
                and abs(last_offset + round((offset - last_offset) / step) * step - offset) < 2.0):
            continue
        merged.append((offset, bpm))
    return merged


def _snap_whole_lines(lines: list[tuple[float, float]], times: np.ndarray,
                      weights: np.ndarray, duration_s: float) -> list[tuple[float, float]]:
    """Red lines read at the whole BPM beside them where their attacks agree,
    by _snap_whole_bpm's test; lines that then continue each other merge."""
    grow, add = params.WHOLE_BPM_SLACK
    out = []
    for n, (offset, bpm) in enumerate(lines):
        whole = round(bpm)
        if whole <= 0 or abs(bpm - whole) > params.WHOLE_BPM_REACH or abs(bpm - whole) < 1e-6:
            out.append((offset, bpm))
            continue
        end = lines[n + 1][0] / 1000.0 if n + 1 < len(lines) else duration_s
        window = (times >= offset / 1000.0) & (times <= end)
        rms, _, k = _grid_rms(times[window], weights[window], 60.0 / bpm, offset / 1000.0)
        rms2, phase2, k2 = _grid_rms(times[window], weights[window], 60.0 / whole, offset / 1000.0)
        if k and k2 >= 0.95 * k and rms2 <= rms * grow + add:
            out.append((phase2 * 1000.0, float(whole)))
        else:
            out.append((offset, bpm))
    return _merge_lines(out)


def _local_tempo_track(analysis: Analysis) -> Analysis | None:
    """Red lines for a fallback analysis from a tempo that may move."""
    env = np.asarray(analysis.onset, dtype=float)
    fps = analysis.sample_rate / analysis.hop_length
    duration = float(analysis.duration)
    if env.size < 4 or duration < params.LOCAL_WINDOW_S or not analysis.points:
        return None
    starts = np.arange(0.0, duration - params.LOCAL_WINDOW_S + 1e-9, params.LOCAL_HOP_S)
    cands = [_window_tempi(env[int(lo * fps):int((lo + params.LOCAL_WINDOW_S) * fps)], fps)
             for lo in starts]
    good = [c for c in cands if c]
    if not good:
        return None
    cands = [c if c else good[0] for c in cands]
    curve = _tempo_curve(np.arange(env.size) / fps, starts + params.LOCAL_WINDOW_S / 2, _octave_up(_tempo_path(cands)))
    _, beats = librosa.beat.beat_track(onset_envelope=env, sr=analysis.sample_rate,
                                       hop_length=analysis.hop_length, bpm=curve,
                                       tightness=params.LOCAL_TIGHTNESS, units="time")
    # The envelope's peaks lag the attacks; the v2 tracker read that lag on
    # the waveform for this song (beat_shift_s) and the same lag applies here.
    beats = np.asarray(beats, dtype=float) + float(getattr(analysis, "beat_shift_s", 0.0))
    if beats.size < 8:
        return None
    lines = _beats_to_lines(beats, params.LOCAL_LINE_TOL_MS)
    if not lines:
        return None
    points = []
    for offset, bpm in lines:
        governing = analysis.points[0]
        for point in analysis.points:
            if point.offset_ms <= offset:
                governing = point
        points.append(replace(governing, offset_ms=float(offset), bpm=float(bpm)))
    bpms = np.array([p.bpm for p in points])
    spans = np.diff([p.offset_ms for p in points] + [duration * 1000.0])
    return replace(analysis, points=points, beats=beats, local_tempo=True,
                   global_bpm=pipeline._weighted_median(bpms, np.maximum(spans, 1e-6)))


def _rescale_local(analysis: Analysis, factor: float) -> Analysis:
    """A local-tempo analysis read at another pulse: every line's BPM scaled,
    beats split or thinned; the same factor back gives the analysis back."""
    ratio = factor / (float(analysis.subdivision) or 1.0)
    if ratio == 1.0:
        return analysis
    beats = np.asarray(analysis.beats, dtype=float)
    if ratio > 1.0 and beats.size > 1:
        m = int(round(ratio))
        steps = np.arange(m) / m
        beats = (beats[:-1, None] + np.diff(beats)[:, None] * steps).ravel()
    elif ratio < 1.0:
        beats = beats[::int(round(1.0 / ratio))]
    points = [replace(p, bpm=p.bpm * ratio) for p in analysis.points]
    return replace(analysis, points=points, beats=beats, subdivision=factor,
                   global_bpm=float(analysis.global_bpm) * ratio)


def _fold_local_to_map_octave(analysis: Analysis, reference: float | None = None,
                              reference_beats=None, judge=None) -> Analysis:
    """A local-tempo analysis read at the octave osu! maps use, as
    _fold_to_map_octave reads a grid (LOCAL_OCTAVE_FOLD; off, it is
    returned as it is).

    Below MAP_OCTAVE_RANGE it is doubled. With LOCAL_OCTAVE_HALVE, one at 2x
    or 4x of ``reference`` (the reading it replaced, when that sat in the
    range) is read back at that octave, keeping the beats nearest
    ``reference_beats`` (_thin_local): Ado - unravel, read 134.9 by the
    tracker and mapped at 135, came out at 269.9. With LOCAL_OCTAVE_JUDGE that
    halving waits for ``judge()``, a tempo heard by Beat This!, to sit nearer
    the slower reading; no judge or no answer, no halving."""
    if not params.LOCAL_OCTAVE_FOLD or not analysis.local_tempo:
        return analysis
    bpm = float(analysis.global_bpm)
    if not np.isfinite(bpm) or bpm <= 0:
        return analysis
    lo, hi = params.MAP_OCTAVE_RANGE
    step = 1.0
    # Doubling only on the local BPM itself: halved on that alone, the fast
    # bands (DragonForce, ~200-280 BPM) lost their octave (S3 held out
    # 73.7 -> 59.2 %, 2026-10-25).
    while bpm * step < lo - 0.01:
        step *= 2.0
    if (step == 1.0 and params.LOCAL_OCTAVE_HALVE and reference is not None
            and np.isfinite(reference) and lo - 0.01 <= reference <= hi + 0.01):
        for up in (2.0, 4.0):
            if abs(bpm / (reference * up) - 1.0) <= params.LOCAL_OCTAVE_SLACK:
                if not params.LOCAL_OCTAVE_JUDGE:
                    step = 1.0 / up
                else:
                    heard = judge() if judge is not None else None
                    if (heard is not None and np.isfinite(heard) and heard > 0
                            and abs(np.log2(heard / (bpm / up))) < abs(np.log2(heard / bpm))):
                        step = 1.0 / up
                break
    if step == 1.0:
        return analysis
    if step < 1.0:
        return _thin_local(analysis, step, reference_beats)
    return _rescale_local(analysis, (float(analysis.subdivision) or 1.0) * step)


def _thin_local(analysis: Analysis, step: float, reference_beats=None) -> Analysis:
    """A local-tempo analysis read at 1/2 or 1/4 of its pulse, keeping the
    beats that fall on the reference's.

    Every other beat of a doubled tempo is an off-beat. Keeping the first
    whatever it is put half the songs half a beat off the map (Astrosexy:
    66 -> 12 % of beats within 10 ms, server stages 2026-10-26), so the kept
    phase is the one nearest the reference reading's own beats, which were
    at this octave, and each red line moves onto a kept beat."""
    beats = np.asarray(analysis.beats, dtype=float)
    every = int(round(1.0 / step))
    phase = 0
    reference = (np.asarray(reference_beats, dtype=float) if reference_beats is not None
                 else np.zeros(0))
    if beats.size >= 2 * every and reference.size >= 8:
        reference = np.sort(reference)

        def distance(kept: np.ndarray) -> float:
            i = np.clip(np.searchsorted(reference, kept), 1, reference.size - 1)
            return float(np.median(np.minimum(np.abs(reference[i - 1] - kept),
                                              np.abs(reference[i] - kept))))

        phase = min(range(every), key=lambda k: distance(beats[k::every]))
    points = []
    for point in analysis.points:
        offset = point.offset_ms
        if beats.size:
            i = int(np.argmin(np.abs(beats - offset / 1000.0)))
            j = i + (phase - i) % every
            if abs(beats[i] * 1000.0 - offset) <= 0.25 * 60000.0 / point.bpm and j < beats.size:
                offset = float(beats[j] * 1000.0)
        points.append(replace(point, offset_ms=offset, bpm=point.bpm * step))
    factor = (float(analysis.subdivision) or 1.0) * step
    return replace(analysis, points=points, beats=beats[phase::every], subdivision=factor,
                   global_bpm=float(analysis.global_bpm) * step)


def _beat_this_tempo(y: np.ndarray, sr: int) -> float | None:
    """The tempo Beat This! hears (BPM, from its beats' median spacing), for
    LOCAL_OCTAVE_JUDGE: loaded on its own, so the judge works where the vote
    is off; None without the model, the runtime or enough beats."""
    beats = beat_this._beat_this_judge_beats(y, sr)
    if beats is None or beats.size < 16:
        return None
    return 60.0 / float(np.median(np.diff(beats)))


def _piecewise_segments(beats_ms: np.ndarray, index: np.ndarray | None = None,
                        sigma_ms: float | None = None,
                        least: int | None = None) -> list[tuple[int, int, float, float]]:
    """(first, end, period ms, start ms) per steady stretch of the beats, by
    optimal partitioning; each stretch holds PIECEWISE_MIN_BEATS or more.
    ``index`` gives each beat's number on the grid when it is known (gaps
    allowed); otherwise it is read from the local beat spacing."""
    t = np.asarray(beats_ms, dtype=float)
    n = t.size
    least = params.PIECEWISE_MIN_BEATS if least is None else least
    if n < 2 * least:
        return []
    if index is not None:
        x = np.asarray(index, dtype=float) - float(index[0])
    else:
        gaps = np.diff(t)
        from scipy.ndimage import median_filter
        local = np.maximum(median_filter(gaps, size=17, mode="nearest"), 1e-6)
        x = np.concatenate([[0.0], np.cumsum(np.maximum(1.0, np.round(gaps / local)))])
    # Residuals from one line over the whole song keep the sums small, so
    # the closed-form errors below lose nothing to cancellation.
    slope, intercept = np.polyfit(x, t, 1)
    r = t - (intercept + slope * x)
    z = np.zeros(1)
    s1, sr = np.concatenate([z, np.cumsum(x)]), np.concatenate([z, np.cumsum(r)])
    sxx = np.concatenate([z, np.cumsum(x * x)])
    sxr = np.concatenate([z, np.cumsum(x * r)])
    srr = np.concatenate([z, np.cumsum(r * r)])
    penalty = params.PIECEWISE_PENALTY * (params.PIECEWISE_SIGMA_MS if sigma_ms is None else sigma_ms) ** 2
    best = np.full(n + 1, np.inf)
    best[0] = 0.0
    back = np.zeros(n + 1, dtype=int)
    for j in range(least, n + 1):
        i = np.arange(0, j - least + 1)
        i = i[np.isfinite(best[i])]
        if not i.size:
            continue
        m = (j - i).astype(float)
        mx, mr = (s1[j] - s1[i]) / m, (sr[j] - sr[i]) / m
        vxx = (sxx[j] - sxx[i]) - m * mx * mx
        vxr = (sxr[j] - sxr[i]) - m * mx * mr
        vrr = (srr[j] - srr[i]) - m * mr * mr
        sse = np.maximum(vrr - np.where(vxx > 0, vxr * vxr / np.where(vxx > 0, vxx, 1.0), 0.0), 0.0)
        cost = best[i] + sse + penalty
        k = int(np.argmin(cost))
        best[j], back[j] = cost[k], int(i[k])
    if not np.isfinite(best[n]):
        return []
    cuts, j = [], n
    while j > 0:
        cuts.append((back[j], j))
        j = back[j]
    out = []
    for i, j in reversed(cuts):
        period, start = np.polyfit(x[i:j] - x[i], t[i:j], 1)
        out.append((int(x[i]), int(x[j - 1]) + 1, float(period), float(start)))
    return out


def _follow_attacks(times_ms: np.ndarray, weights: np.ndarray, start_ms: float,
                    period_ms: float, end_ms: float) -> tuple[np.ndarray, np.ndarray]:
    """(beat numbers, times ms) of the beats an attack confirms, followed from
    ``start_ms``: each expected beat takes the strongest attack within a fifth
    of a beat, and the expected spacing follows the confirmed ones slowly."""
    strong = weights >= np.median(weights) if weights.size else weights.astype(bool)
    t, w = times_ms[strong], weights[strong]
    index, found = [], []
    pos, step, k = float(start_ms), float(period_ms), 0
    last_k, last_t = None, None
    while pos < end_ms + 0.5 * step:
        lo, hi = np.searchsorted(t, [pos - 0.2 * step, pos + 0.2 * step])
        if hi > lo:
            j = lo + int(np.argmax(w[lo:hi] - np.abs(t[lo:hi] - pos) / (0.2 * step) * w[lo:hi].max() * 0.5))
            hit = float(t[j])
            if last_k is not None and k > last_k:
                seen = (hit - last_t) / (k - last_k)
                if abs(seen / period_ms - 1.0) < 0.08:
                    step = 0.8 * step + 0.2 * seen
            index.append(k)
            found.append(hit)
            last_k, last_t = k, hit
            pos = hit + step
        else:
            pos += step
        k += 1
    return np.asarray(index, dtype=float), np.asarray(found, dtype=float)


def _change_points(analysis: Analysis) -> Analysis:
    """A one-line precision analysis split where its attacks change tempo
    (CHANGE_POINTS); the analysis as it was otherwise."""
    points = list(getattr(analysis, "points", None) or [])
    if (not params.CHANGE_POINTS or len(points) != 1 or analysis.engine != "precision"
            or getattr(points[0], "manual", False)):
        return analysis
    times = np.asarray(analysis.attack_times, dtype=float)
    weights = np.asarray(analysis.attack_weights, dtype=float)
    if times.size < 4 * params.CHANGE_MIN_BEATS:
        return analysis
    duration_ms = float(analysis.duration) * 1000.0
    period = 60000.0 / float(points[0].bpm)
    start = points[0].offset_ms
    index, beats = _follow_attacks(times * 1000.0, weights, start, period, duration_ms)
    segments = _piecewise_segments(beats, index=index, sigma_ms=params.CHANGE_SIGMA_MS,
                                   least=params.CHANGE_MIN_BEATS)
    if len(segments) < 2:
        return analysis
    lines = []
    for first, _end, step, origin in segments:
        offset, bpm = origin, 60000.0 / step
        if lines and abs(bpm / lines[-1][1] - 1.0) < params.CHANGE_MIN_STEP:
            continue
        lines.append((float(offset), float(bpm)))
    if len(lines) < 2:
        return analysis
    # The first line keeps the bar the analysis found, on its new grid.
    first_period = 60000.0 / lines[0][1]
    lines[0] = (lines[0][0] + round((start - lines[0][0]) / first_period) * first_period, lines[0][1])
    while len(lines) > 1 and lines[0][0] >= lines[1][0]:
        lines[0] = (lines[0][0] - first_period, lines[0][1])
    lines = _snap_whole_lines(lines, times, weights, float(analysis.duration))
    if len(lines) < 2:
        return analysis
    old = _attack_rms_ms(_beats_of([(start, points[0].bpm)], float(analysis.duration)), times, weights)
    new = _attack_rms_ms(_beats_of(lines, float(analysis.duration)), times, weights)
    if not new < params.CHANGE_GAIN * old:
        return analysis
    return phrases._with_lines(analysis, lines, beats=_beats_of(lines, float(analysis.duration)))


def _piecewise_grid(analysis: Analysis, heard) -> Analysis:
    """Red lines from the steady stretches of Beat This!'s beats
    (PIECEWISE_GRID), each at the octave of the song's own tempo. The tracker
    path only: splitting the precision grid's one line this way lost 119
    bands dev maps (2026-10-27), Beat This!'s jitter read as tempo changes."""
    points = list(getattr(analysis, "points", None) or [])
    if not params.PIECEWISE_GRID or not points or any(getattr(p, "manual", False) for p in points):
        return analysis
    found = heard()
    if found is None:
        return analysis
    segments = _piecewise_segments(np.sort(np.asarray(found, dtype=float) * 1000.0))
    if not segments:
        return analysis
    song = _song_tempo(points, float(analysis.duration) * 1000.0) or 60000.0 / segments[0][2]
    lines = []
    for first, _end, period, start in segments:
        bpm = 60000.0 / period
        fold = 2.0 ** round(float(np.log2(song / bpm)))
        if abs(np.log2(bpm * fold / song)) < 0.25:
            bpm *= fold
        lines.append((start, bpm, first))
    out = []
    for n, (start, bpm, first) in enumerate(lines):
        if n == 0:
            # The first line keeps the bar the analysis found, on this grid.
            period = 60000.0 / bpm
            start += round((points[0].offset_ms - start) / period) * period
            while len(lines) > 1 and start >= lines[1][0]:
                start -= period
        out.append(replace(points[0], bpm=float(bpm), offset_ms=float(start), beat_index=int(first)))
    return replace(analysis, points=out)


def _constant_grid(analysis: Analysis, heard) -> Analysis:
    """One red line where one steady grid explains Beat This!'s beats over
    the whole song (CONSTANT_GRID); the analysis as it was otherwise."""
    points = list(getattr(analysis, "points", None) or [])
    if not params.CONSTANT_GRID or len(points) < 2:
        return analysis
    found = heard()
    if found is None:
        return analysis
    beats = np.sort(np.asarray(found, dtype=float) * 1000.0)
    if beats.size < 32:
        return analysis
    grid = _steady_grid(beats, params.CONSTANT_GRID_TOL_MS)
    if grid is None:
        return analysis
    period, start, miss = grid
    if float(np.mean(miss <= params.CONSTANT_GRID_TOL_MS)) < params.CONSTANT_GRID_SHARE:
        return analysis
    bpm = 60000.0 / float(period)
    song = _song_tempo(points, float(analysis.duration) * 1000.0) or bpm
    bpm *= min((0.5, 1.0, 2.0), key=lambda f: abs(np.log2(bpm * f / song)))
    period = 60000.0 / bpm
    # The grid's beat nearest the first red line, so its bar stays where it was.
    first = points[0].offset_ms
    offset = start + round((first - start) / period) * period
    while offset - period >= 0.0 and offset > first + period / 2.0:
        offset -= period
    line = replace(points[0], bpm=bpm, offset_ms=float(offset))
    return phrases._snap_whole_points(replace(analysis, points=[line]))


def _steady_grid(beats: np.ndarray, tol_ms: float):
    """The one grid (period, start, |miss| per beat, all ms) that most of the
    beats sit on, or None. Beat This! marks a song's half-time parts every
    other beat: the grid's pulse is the faster one when a fair share of the
    gaps is at it. Each beat is numbered by the grid it is tested on, never by
    adding up gaps, where one miscounted beat moved every beat after it:
    Calm Down Juliet (212 with parts at 106) counted its 280 ms gaps as 560 ms
    beats, landed seconds off and fitted 0.5 % of its beats."""
    gaps = np.diff(beats)
    step = float(np.median(gaps))
    if step <= 0:
        return None
    while float(np.mean(np.abs(gaps / (step / 2.0) - 1.0) <= params.STEADY_GRID_HALF_TOL)) >= params.STEADY_GRID_HALF_SHARE:
        step /= 2.0
    # phase histograms in 1 ms bins, a period every ~2 ms of drift over the song
    width = int(round(tol_ms))
    best = (-1.0, step, 0.0)
    for period in np.arange(step * (1.0 - params.STEADY_GRID_RANGE), step * (1.0 + params.STEADY_GRID_RANGE),
                            max(1e-3, 2.0 * step / max(beats[-1] - beats[0], step))):
        bins = int(period)
        hist = np.bincount(np.minimum(np.mod(beats, period).astype(int), bins - 1), minlength=bins)
        near = np.convolve(np.concatenate([hist, hist[:2 * width]]), np.ones(2 * width + 1), "valid")[:bins]
        k = int(np.argmax(near))
        if near[k] > best[0]:
            best = (float(near[k]), float(period), (k + width + 0.5) % period)  # the window's centre
    _, period, start = best
    index = np.round((beats - start) / period)
    keep = np.abs(beats - (start + period * index)) <= 2.0 * tol_ms
    for _ in range(3):  # least squares, then without the beats it misses by far
        if keep.sum() < 32:
            return None
        period, start = np.polyfit(index[keep], beats[keep], 1)
        miss = np.abs(beats - (start + period * index))
        keep = miss <= 2.0 * tol_ms
    return float(period), float(start), miss


def _snap_constant_line(analysis: Analysis) -> Analysis:
    """A fallback song's one red line at the whole BPM beside it, on its
    attacks' phase, where they agree (_snap_whole_lines). _constant_grid reads
    the BPM off Beat This!'s 20 ms frames, a few hundredths from the mapper's
    whole one (220.05 for 220), which drifts its beats 40 ms off over a song;
    _snap_whole_points only snaps the precision engine's lines."""
    points = list(getattr(analysis, "points", None) or [])
    if len(points) != 1 or not np.size(analysis.attack_times):
        return analysis
    lines = [(float(points[0].offset_ms), float(points[0].bpm))]
    snapped = _snap_whole_lines(lines, np.asarray(analysis.attack_times, dtype=float),
                                np.asarray(analysis.attack_weights, dtype=float),
                                float(analysis.duration))
    if snapped == lines:
        return analysis
    return phrases._with_lines(analysis, snapped, beats=_beats_of(snapped, float(analysis.duration)))


def _song_tempo(points: list, duration_ms: float) -> float | None:
    """The BPM that holds the most of the song's length, by red line span."""
    spans: dict[float, float] = {}
    for n, point in enumerate(points):
        end = points[n + 1].offset_ms if n + 1 < len(points) else duration_ms
        if point.bpm > 0 and end > point.offset_ms:
            key = round(float(point.bpm), 1)
            spans[key] = spans.get(key, 0.0) + (end - point.offset_ms)
    return max(spans, key=spans.get) if spans else None


def _fold_lines_to_song_octave(analysis: Analysis, heard) -> Analysis:
    """Lines an octave off their song read back at its octave, when Beat This!
    agrees (SECTION_OCTAVE_JUDGE). ``heard()`` gives Beat This!'s beats (s),
    asked once and only when a line is off; a halved line keeps the phase
    nearest those beats, so it is not left half a beat off the map."""
    points = list(getattr(analysis, "points", None) or [])
    if not params.SECTION_OCTAVE_JUDGE or len(points) < 2:
        return analysis
    duration_ms = float(analysis.duration) * 1000.0
    song = _song_tempo(points, duration_ms)
    if not song:
        return analysis
    beats = None
    out, changed = [], False
    for n, point in enumerate(points):
        end = points[n + 1].offset_ms if n + 1 < len(points) else duration_ms
        ratio = point.bpm / song
        factor = (0.5 if abs(ratio / 2.0 - 1.0) <= params.LOCAL_OCTAVE_SLACK
                  else 2.0 if abs(ratio / 0.5 - 1.0) <= params.LOCAL_OCTAVE_SLACK else None)
        if factor is None or getattr(point, "manual", False) or end <= point.offset_ms:
            out.append(point)
            continue
        if beats is None:
            found = heard()
            beats = np.asarray(found, dtype=float) * 1000.0 if found is not None else np.zeros(0)
        inside = beats[(beats >= point.offset_ms) & (beats <= end)]
        target = point.bpm * factor
        if inside.size < 8:
            if not params.OCTAVE_CONTINUITY:
                out.append(point)
                continue
        elif not params.OCTAVE_CONTINUITY:
            tempo = 60000.0 / float(np.median(np.diff(inside)))
            if abs(np.log2(tempo / target)) >= abs(np.log2(tempo / point.bpm)):
                out.append(point)
                continue
        offset = point.offset_ms
        if factor < 1.0:
            # Of the two beats a halved line could start on, the one whose
            # grid sits nearest Beat This!'s.
            period = 60000.0 / target

            def distance(start: float) -> float:
                grid = start + np.arange(int((end - start) / period) + 1) * period
                i = np.clip(np.searchsorted(inside, grid), 1, inside.size - 1)
                return float(np.median(np.minimum(np.abs(inside[i - 1] - grid),
                                                  np.abs(inside[i] - grid))))

            if inside.size >= 8:
                offset = min((point.offset_ms, point.offset_ms + 60000.0 / point.bpm), key=distance)
        out.append(replace(point, bpm=target, offset_ms=offset))
        changed = True
    if not changed:
        return analysis
    return replace(analysis, points=out)
