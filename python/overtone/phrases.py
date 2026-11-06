"""Phrases and bars: line beats, phrase octaves and lines, tidy BPMs."""
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

from . import beat_this, map_objects, params, pipeline, precision_grid, red_lines


def _line_beats(offset: float, bpm: float, start: float, stop: float) -> np.ndarray:
    """Beat times (s) of one line's grid between start and stop (ms)."""
    step = 60000.0 / bpm
    k0 = np.ceil((start - offset) / step)
    k1 = np.ceil((stop - offset) / step)
    return (offset + np.arange(k0, max(k0, k1)) * step) / 1000.0


def _span_fit(lines, start: float, stop: float, times, weights) -> float:
    """PHRASE_TOL_MS F of these lines' grids on the attacks between start and
    stop (ms), on any number of beats: _grid_fit_score reads under four
    beats as 0, which priced every merge of a short line out."""
    parts = []
    for n, (offset, bpm) in enumerate(lines):
        a = start if n == 0 else max(start, offset)
        b = stop if n + 1 == len(lines) else min(stop, lines[n + 1][0])
        if b > a:
            parts.append(_line_beats(offset, bpm, a, b))
    beats = np.concatenate(parts) if parts else np.zeros(0)
    inside = (times >= start / 1000.0) & (times < stop / 1000.0)
    t, w = times[inside], weights[inside]
    if beats.size == 0 or t.size == 0:
        return 0.0
    beats = np.sort(beats)
    i = np.clip(np.searchsorted(beats, t), 1, max(1, beats.size - 1))
    d = np.minimum(np.abs(beats[i - 1] - t), np.abs(beats[np.minimum(i, beats.size - 1)] - t)) * 1000.0
    recall = float(w[d <= params.PHRASE_TOL_MS].sum() / max(float(w.sum()), 1e-12))
    j = np.clip(np.searchsorted(t, beats), 1, max(1, t.size - 1))
    e = np.minimum(np.abs(t[j - 1] - beats), np.abs(t[np.minimum(j, t.size - 1)] - beats)) * 1000.0
    precision = float(np.mean(e <= params.PHRASE_TOL_MS))
    return 0.0 if recall + precision == 0 else 2 * recall * precision / (recall + precision)


def _fit_line(times: np.ndarray, weights: np.ndarray, start: float, stop: float,
              bpm: float) -> tuple[float, float]:
    """One line (offset ms, bpm) over the span, refitted on the attacks near
    its grid by weighted least squares, starting from ``bpm``. The fit grows
    from 16 beats to the whole span, so a start a few BPM off (217 for 220)
    cannot slip a beat before it is corrected."""
    inside = (times >= start / 1000.0) & (times < stop / 1000.0)
    t, w = times[inside] * 1000.0, weights[inside]
    step = 60000.0 / bpm
    if t.size < 6:
        return float(start), bpm
    offset = float(t[np.argmax(w[: max(1, min(t.size, 8))])])
    for reach in (16, 32, 64, 128, 256, 1 << 30):
        for _ in range(3):
            k = np.round((t - offset) / step)
            near = (np.abs(t - offset - k * step) <= 0.2 * step) & (np.abs(k) <= reach)
            if near.sum() < 6 or np.ptp(k[near]) < 4:
                break
            slope, icpt = np.polyfit(k[near], t[near], 1, w=np.sqrt(w[near]))
            if not (0.95 * step < slope < 1.05 * step):
                break
            offset, step = float(icpt), float(slope)
        if reach * step > (stop - start) * 2:
            break
    first = offset + np.ceil((start - offset) / step) * step
    return float(first), 60000.0 / step


def _phrase_octaves(lines, times, weights, end_ms):
    """Lines folded to the song's octave (the duration-weighted median BPM)."""
    spans = np.diff([o for o, _ in lines] + [end_ms])
    song = pipeline._weighted_median(np.array([b for _, b in lines]), np.maximum(spans, 1e-6))
    out = []
    for n, (offset, bpm) in enumerate(lines):
        r = bpm / song
        stop = lines[n + 1][0] if n + 1 < len(lines) else end_ms
        if abs(r - 2.0) <= 2.0 * params.PHRASE_OCTAVE_TOL:
            step = 60000.0 / bpm
            inside = (times >= offset / 1000.0) & (times < stop / 1000.0)

            def weight(o):
                ph = np.mod((times[inside] * 1000.0 - o) / (2 * step), 1.0)
                return float(weights[inside][(ph < 0.06) | (ph > 0.94)].sum())

            out.append((max((offset, offset + step), key=weight), bpm / 2.0))
        elif abs(r - 0.5) <= 0.5 * params.PHRASE_OCTAVE_TOL:
            out.append((offset, bpm * 2.0))
        else:
            out.append((offset, bpm))
    return out


def _with_attacks(analysis: Analysis, y: np.ndarray, sr: int) -> Analysis:
    """The analysis with the song's attacks, where the tracker left none: the
    legacy tracker fills no attack_times, so _phrase_lines had nothing to
    weigh a merge on and left every jittery line where it was (152 lines on
    Senses Fail - Angela Baker, the owner's report of 2026-10-31)."""
    if np.size(analysis.attack_times) or not params.PHRASE_LINES:
        return analysis
    try:
        times, weights, _ = precision_grid._detect_attacks(y, sr, params.FIT_HOP)
    except Exception:
        return analysis
    return replace(analysis, attack_times=times, attack_weights=weights)


def _half_beat_ratio(times, weights, offset: float, bpm: float, start: float, stop: float):
    """Attack weight on the half beats over the weight on the beats in a span."""
    m = (times * 1000.0 >= start) & (times * 1000.0 < stop)
    ph = np.mod((times[m] * 1000.0 - offset) / (60000.0 / bpm), 1.0)
    on = float(weights[m][(ph < 0.1) | (ph > 0.9)].sum())
    return float(weights[m][np.abs(ph - 0.5) < 0.1].sum()) / on if on > 0 else None


def _phrase_halves(lines, times, weights, end_ms):
    """Lines read at double halved, by their half beats against the song's."""
    spans = [((lines[n + 1][0] if n + 1 < len(lines) else end_ms) - o) for n, (o, _) in enumerate(lines)]
    ratios = [_half_beat_ratio(times, weights, o, b, o, o + d) for (o, b), d in zip(lines, spans)]
    out = list(lines)
    for n, ((offset, bpm), span, r) in enumerate(zip(lines, spans, ratios)):
        if bpm <= params.PHRASE_HALVE_BPM or span < params.PHRASE_HALVE_S * 1000.0 or r is None or r >= params.PHRASE_HALVE_RATIO:
            continue
        rest = [(x, d) for m, (x, d) in enumerate(zip(ratios, spans)) if m != n and x is not None]
        if not rest:
            continue
        song = pipeline._weighted_median(np.array([x for x, _ in rest]), np.array([d for _, d in rest]))
        if r >= params.PHRASE_HALVE_REL * song:
            continue
        # a part at the rest of the song's tempo is not read at double: a 217 intro
        # before a 226 song (Pierce The Veil - King For A Day) keeps its BPM, while a
        # 235 part of a 200 song (Alesana - Seduction from 3:29) is a 118 one
        others = [(b, d) for m, ((_, b), d) in enumerate(zip(lines, spans)) if m != n]
        tempo = pipeline._weighted_median(np.array([b for b, _ in others]), np.array([d for _, d in others]))
        if abs(np.log(bpm / tempo)) < np.log(1.0 + params.PHRASE_HALVE_SAME):
            continue
        step = 60000.0 / bpm
        inside = (times * 1000.0 >= offset) & (times * 1000.0 < offset + span)

        def weight(o):
            ph = np.mod((times[inside] * 1000.0 - o) / (2 * step), 1.0)
            return float(weights[inside][(ph < 0.06) | (ph > 0.94)].sum())

        out[n] = (max((offset, offset + step), key=weight), bpm / 2.0)
    return out


def _phrase_phase(times, weights, offset: float, stop: float, bpm: float) -> tuple[float, float]:
    """The line with its grid moved onto the middle of its strong attacks."""
    step = 60000.0 / bpm
    m = (times * 1000.0 >= offset - 0.5 * step) & (times * 1000.0 < stop)
    if m.sum() < 8:
        return offset, bpm
    t, w = times[m] * 1000.0, weights[m]
    big = w >= np.median(w)
    r = t[big] - offset - np.round((t[big] - offset) / step) * step
    keep = np.abs(r) <= 0.15 * step
    if keep.sum() < 6:
        return offset, bpm
    order = np.argsort(r[keep])
    cum = np.cumsum(w[big][keep][order])
    shift = float(r[keep][order][np.searchsorted(cum, cum[-1] / 2.0)])
    if abs(shift) > params.PHRASE_PHASE_MAX * step:
        return offset, bpm
    return offset + shift, bpm


def _first_on_attack(line, strong: np.ndarray, stop: float) -> tuple[float, float]:
    """The first line moved by whole beats to its first beat on a strong attack."""
    offset, bpm = line
    step = 60000.0 / bpm
    for k in range(0, 64):
        at = offset + k * step
        if at >= stop - step:
            break
        if strong.size and float(np.min(np.abs(strong - at))) <= params.PHRASE_ONSET_MS:
            return at, bpm
    return line


def _lands_cleanly(prev, at: float) -> bool:
    """Whether a change at ``at`` ticks once after the previous line."""
    step = 60000.0 / prev[1]
    gap = (at - prev[0]) % step
    return gap <= params.PHRASE_TICK_ON_MS or step - gap <= params.PHRASE_TICK_ON_MS or gap >= params.PHRASE_TICK_GAP * step


def _stretch_miss(prev, at: float) -> float:
    """How far ``at`` sits from the previous grid's nearest beat (ms)."""
    step = 60000.0 / prev[1]
    return at - prev[0] - round((at - prev[0]) / step) * step


def _one_tick(prev, line, stop: float, times, weights):
    """The cheaper of stretching the previous grid onto the change and moving
    the change back onto the previous grid's beat, within PHRASE_STRETCH_MS
    and PHRASE_STRETCH_LOSS of 10 ms F; else both as they were."""
    offset, bpm = prev
    at, new_bpm = line
    step = 60000.0 / bpm
    beats = round((at - offset) / step)
    miss = at - offset - beats * step
    if beats < 2 or abs(miss) < 0.5 or abs(miss) > params.PHRASE_STRETCH_MS:
        return prev, line

    def f(lines, a, b):
        m = (times * 1000.0 >= a) & (times * 1000.0 < b)
        parts = [_line_beats(o, x, max(a, o) if k else a, lines[k + 1][0] if k + 1 < len(lines) else b)
                 for k, (o, x) in enumerate(lines)]
        return beat_this._grid_fit_score(np.concatenate(parts), times[m], weights[m], 10.0)

    base = f([prev, line], offset, stop)
    stretched = [(offset, 60000.0 * beats / (at - offset)), line]
    moved = [prev, (offset + beats * step, new_bpm)]
    best = max((f(c, offset, stop), n, c) for n, c in enumerate((stretched, moved)))
    if best[0] >= base - params.PHRASE_STRETCH_LOSS:
        return best[2][0], best[2][1]
    return prev, line


def _phrase_drift_split(lines, times, weights, end_ms: float, meter: int):
    """Lines split at the bar where a second line explains the attacks best.

    Each line tries a cut at every bar leaving PHRASE_DRIFT_BARS bars either
    side, both sides refitted on their attacks, and takes the best cut when it
    raises the line's 10 ms F by PHRASE_DRIFT_GAIN; the halves try again. A
    band that drifts or jumps a few ms (a merged line sitting between two
    phases, which 20 ms F let through) gets its line back."""
    out = []
    queue = list(lines)
    budget = 2 * len(lines) + 16
    while queue:
        offset, bpm = queue.pop(0)
        stop = queue[0][0] if queue else end_ms
        step = 60000.0 / bpm
        bar = meter * step
        m = (times * 1000.0 >= offset) & (times * 1000.0 < stop)
        t, w = times[m], weights[m]
        bars = int((stop - offset) // bar)
        best = None
        if budget > 0 and bars >= 2 * params.PHRASE_DRIFT_BARS and t.size >= 16:
            base = beat_this._grid_fit_score(_line_beats(offset, bpm, offset, stop), t, w, 10.0)
            for k in range(params.PHRASE_DRIFT_BARS, bars - params.PHRASE_DRIFT_BARS + 1):
                at = offset + k * bar
                left = _fit_line(times, weights, offset, at, bpm)
                left = (offset, bpm) if abs(left[0] - offset) > 0.25 * step else left
                right = _fit_line(times, weights, at, stop, bpm)
                if not (offset < right[0] < stop - bar):
                    continue
                lstep = 60000.0 / left[1]
                slip = (right[0] - left[0]) % lstep
                slip = min(slip, lstep - slip)
                if abs(right[1] - left[1]) < 0.1 and slip < params.PHRASE_DRIFT_MIN_MS:
                    continue
                if not _lands_cleanly(left, right[0]):
                    left, right = _one_tick(left, right, stop, times, weights)
                    if not _lands_cleanly(left, right[0]) and abs(_stretch_miss(left, right[0])) > 0.5:
                        continue
                two = np.concatenate([_line_beats(left[0], left[1], offset, right[0]),
                                      _line_beats(right[0], right[1], right[0], stop)])
                gain = beat_this._grid_fit_score(two, t, w, 10.0) - base
                if gain >= params.PHRASE_DRIFT_GAIN and (best is None or gain > best[0]):
                    best = (gain, left, right)
        if best is not None:
            budget -= 1
            queue[:0] = [best[1], best[2]]
            continue
        out.append((offset, bpm))
    return out


def _phrase_bars(lines, times, weights, end_ms: float, meter: int):
    """Each phrase as bar-long lines following its downbeats (PHRASE_BARS)."""
    strong = weights >= np.median(weights)
    st, sw = times[strong] * 1000.0, weights[strong]
    out = []
    for n, (offset, bpm) in enumerate(lines):
        stop = lines[n + 1][0] if n + 1 < len(lines) else end_ms
        step = 60000.0 / bpm
        bar = meter * step
        count = int((stop - offset) // bar)
        if count < 2:
            out.append((offset, bpm))
            continue
        downs = [offset]
        for k in range(1, count + 1):
            g = offset + k * bar
            m = (st >= g - 0.5 * step) & (st < g + bar - 0.5 * step)
            r = st[m] - g
            r = r - np.round(r / step) * step
            near = np.abs(r) <= params.PHRASE_BAR_SHIFT * step
            if near.sum() >= 2:
                order = np.argsort(r[near])
                cum = np.cumsum(sw[m][near][order])
                shift = float(r[near][order][np.searchsorted(cum, cum[-1] / 2.0)])
            else:
                shift = downs[-1] - (offset + (k - 1) * bar)
            downs.append(max(downs[-1] + 0.5 * bar, g + shift))
        if downs[-1] >= stop:
            downs.pop()
        i = 0
        while i < len(downs) - 1:
            j = i + 1
            while j + 1 < len(downs):
                beat = (downs[j + 1] - downs[i]) / (meter * (j + 1 - i))
                if all(abs(downs[i] + meter * (q - i) * beat - downs[q]) <= params.PHRASE_BAR_TOL_MS
                       for q in range(i + 1, j + 1)):
                    j += 1
                else:
                    break
            out.append((downs[i], 60000.0 * meter * (j - i) / (downs[j] - downs[i])))
            i = j
        # the last bar ends exactly where the next phrase starts: no double tick
        beats = round((stop - downs[-1]) / step)
        if n + 1 < len(lines) and beats >= 1 and abs((stop - downs[-1]) / beats - step) <= params.PHRASE_BAR_SHIFT * step:
            out.append((downs[-1], 60000.0 * beats / (stop - downs[-1])))
        else:
            out.append((downs[-1], bpm))
    # a line the one before already plays to within PHRASE_BAR_TOL_MS is dropped
    kept = out[:1]
    for k, (offset, bpm) in enumerate(out[1:], start=1):
        end = out[k + 1][0] if k + 1 < len(out) else end_ms
        o, b = kept[-1]
        step = 60000.0 / b
        on = abs(o + round((offset - o) / step) * step - offset) <= 1.0
        far = (end - offset) * bpm / 60000.0 * abs(60000.0 / bpm - step)
        if on and far <= params.PHRASE_BAR_TOL_MS:
            continue
        kept.append((offset, bpm))
    return kept


def _phrase_lines(analysis: Analysis) -> Analysis:
    """Red lines merged into phrases and their changes on phrase points (PHRASE_LINES)."""
    points = list(getattr(analysis, "points", None) or [])
    if (not params.PHRASE_LINES or len(points) < 2
            or any(getattr(p, "manual", False) for p in points)
            # a signature change is a line the bar needs; merging would erase it
            or len({getattr(p, "meter", 4) for p in points}) > 1):
        return analysis
    times = np.asarray(analysis.attack_times, dtype=float)
    weights = np.asarray(analysis.attack_weights, dtype=float)
    if times.size < 8:
        return analysis
    duration = float(analysis.duration)
    end_ms = duration * 1000.0
    original = [(float(p.offset_ms), float(p.bpm)) for p in points]
    meter = max(1, int(getattr(points[0], "meter", 4) or 4))
    lines = _phrase_octaves(list(original), times, weights, end_ms)

    def stop_of(ls, n):
        return ls[n + 1][0] if n + 1 < len(ls) else end_ms

    # 1. merge, cheapest first
    def pair(ls, n):
        a, b, c = ls[n][0], ls[n + 1][0], stop_of(ls, n + 1)
        span_bpm = (ls[n][1] * (b - a) + ls[n + 1][1] * (c - b)) / max(c - a, 1e-9)
        merged = _fit_line(times, weights, a, c, span_bpm)
        loss = _span_fit(ls[n:n + 2], a, c, times, weights) - _span_fit([merged], a, c, times, weights)
        bars = min((b - a) * ls[n][1], (c - b) * ls[n + 1][1]) / 60000.0 / meter
        close = abs(ls[n][1] - ls[n + 1][1]) <= params.PHRASE_CLOSE * max(ls[n][1], ls[n + 1][1])
        allowed = params.PHRASE_LOSS * (3.0 if close else 2.0 if bars < params.PHRASE_MIN_BARS else 1.0)
        return (loss, merged) if loss <= allowed else None

    def merge(lines):
        costs = [pair(lines, n) for n in range(len(lines) - 1)]
        while any(costs):
            n = min((m for m, c in enumerate(costs) if c), key=lambda m: costs[m][0])
            lines = lines[:n] + [costs[n][1]] + lines[n + 2:]
            costs = (costs[:max(0, n - 1)]
                     + [pair(lines, m) for m in range(max(0, n - 1), min(n + 1, len(lines) - 1))]
                     + costs[n + 2:])
        return lines

    lines = merge(lines)
    halved = _phrase_halves(lines, times, weights, end_ms)
    if halved != lines:
        lines = merge(halved)

    # 1b. every line refitted on its attacks, then whole where they agree
    refit = []
    for n, (off, bpm) in enumerate(lines):
        stop = stop_of(lines, n)
        new = _fit_line(times, weights, off, stop, bpm)
        keep = (abs(new[1] - bpm) <= 0.02
                or _span_fit([new], off, stop, times, weights) < _span_fit([(off, bpm)], off, stop, times, weights))
        refit.append((off, bpm) if keep else new)
    lines = refit
    lines = red_lines._snap_whole_lines(lines, times, weights, duration)
    lines = _phrase_drift_split(lines, times, weights, end_ms, meter)
    lines = [_phrase_phase(times, weights, off, stop_of(lines, n), bpm)
             for n, (off, bpm) in enumerate(lines)]

    # 2. each change on a downbeat or after the music eases off
    per_beat = float(weights.sum()) / max(1.0, end_ms / (60000.0 / lines[0][1]))
    strong = times[weights >= np.median(weights)] * 1000.0
    lines[0] = _first_on_attack(lines[0], strong, stop_of(lines, 0))
    origin = lines[0][0]
    # the precision engine finds its change points exactly; only a tracked (legacy)
    # boundary is loose enough for the downbeat, quiet and onset bonuses to move it
    loose = analysis.engine == "legacy"
    for n in range(1, len(lines)):
        prev_offset, prev_bpm = lines[n - 1]
        offset, bpm = lines[n]
        step, bar = 60000.0 / bpm, meter * 60000.0 / prev_bpm
        stop = stop_of(lines, n)
        lo, hi = lines[n - 1][0], stop
        scored = []
        for j in range(-meter, meter + 1):
            at = offset + j * step
            if not (prev_offset + step < at < stop - step):
                continue
            trial = [lines[n - 1], (at, bpm)]
            score = _span_fit(trial, lo, hi, times, weights)
            if loose:
                off_bar = (at - origin) % bar
                if min(off_bar, bar - off_bar) <= 0.25 * step:
                    score += params.PHRASE_DOWNBEAT_BONUS
                before = (times >= (at - step) / 1000.0) & (times < at / 1000.0 - 0.03)
                if per_beat > 0 and float(weights[before].sum()) < params.PHRASE_QUIET * per_beat:
                    score += params.PHRASE_QUIET_BONUS
                if strong.size and float(np.min(np.abs(strong - at))) <= params.PHRASE_ONSET_MS:
                    score += params.PHRASE_ONSET_BONUS
            if not _lands_cleanly(lines[n - 1], at):
                score -= 1.0
            scored.append((score, -abs(j), at))
        if scored:
            lines[n] = (max(scored)[2], bpm)
        if not _lands_cleanly(lines[n - 1], lines[n][0]):
            lines[n - 1], lines[n] = _one_tick(lines[n - 1], lines[n], stop, times, weights)
        origin = lines[n][0]
    if params.PHRASE_BARS and analysis.engine == "legacy":
        lines = _phrase_bars(lines, times, weights, end_ms, meter)
    if lines == original:
        return analysis
    beats = red_lines._beats_of(lines, duration)
    starts = np.array([o for o, _ in lines]) / 1000.0
    which = np.clip(np.searchsorted(starts, beats, side="right") - 1, 0, len(lines) - 1)
    return _with_lines(analysis, lines, beats=beats,
                       local_bpms=np.array([b for _, b in lines], dtype=float)[which])


def _with_lines(analysis: Analysis, lines: list[tuple[float, float]], **changes) -> Analysis:
    """The analysis with these red lines, each keeping the meter and kiai of
    the point that governed its offset."""
    points = []
    for offset, bpm in lines:
        governing = analysis.points[0]
        for point in analysis.points:
            if point.offset_ms <= offset:
                governing = point
        points.append(replace(governing, offset_ms=float(offset), bpm=float(bpm)))
    bpms = np.array([p.bpm for p in points])
    spans = np.diff([p.offset_ms for p in points] + [float(analysis.duration) * 1000.0])
    return replace(analysis, points=points, **changes,
                   global_bpm=pipeline._weighted_median(bpms, np.maximum(spans, 1e-6)))


def _tidy_bpm(bpm: float, beats: float = 0.0) -> float:
    """One decimal where it holds over the line (the owner's request of
    2026-10-30: 233.433 is written 233.4, as mappers write it), else two.
    Rounding moves the line's ends by half its beats times the period's
    change; past TIDY_BPM_DRIFT_MS a real decimal tempo (128.37) would drift
    off its attacks, so it keeps its second decimal."""
    two = round(float(bpm), 2)
    if params.TIDY_BPM_DECIMALS >= 2:
        return two
    one = round(float(bpm), 1)
    drift = (beats / 2.0) * abs(60000.0 / float(bpm) - 60000.0 / one)
    return one if drift <= params.TIDY_BPM_DRIFT_MS else two


def _cap_octaves(analysis: Analysis) -> Analysis:
    """Lines above OCTAVE_CAP_BPM at half their BPM. The half grid takes the
    beat with the stronger attacks; a run of capped lines keeps one grid, so a
    change between two of them never lands on the other half's beat."""
    points = list(getattr(analysis, "points", None) or [])
    if (not params.OCTAVE_CAP or not points or any(getattr(p, "manual", False) for p in points)
            or all(p.bpm <= params.OCTAVE_CAP_BPM for p in points)):
        return analysis
    raw = getattr(analysis, "attack_times", None)
    times = np.zeros(0) if raw is None else np.asarray(raw, dtype=float) * 1000.0
    raw = getattr(analysis, "attack_weights", None)
    weights = np.ones(times.size) if raw is None else np.asarray(raw, dtype=float)
    if weights.size != times.size:
        weights = np.ones(times.size)
    end_ms = float(analysis.duration) * 1000.0
    lines, halved = [], None  # halved: the previous line's half grid (offset, step)
    for n, p in enumerate(points):
        offset, bpm = float(p.offset_ms), float(p.bpm)
        if bpm <= params.OCTAVE_CAP_BPM:
            lines.append((offset, bpm))
            halved = None
            continue
        step = 60000.0 / bpm
        stop = float(points[n + 1].offset_ms) if n + 1 < len(points) else end_ms
        if halved is not None:
            # on the previous half grid, or one of its beats on
            k = round((offset - halved[0]) / halved[1])
            start = offset if abs(halved[0] + k * halved[1] - offset) <= 0.25 * step else offset + step
        else:
            inside = (times >= offset - 0.5 * step) & (times < stop)

            def weight(o):
                ph = np.mod((times[inside] - o) / (2 * step), 1.0)
                return float(weights[inside][(ph < 0.06) | (ph > 0.94)].sum())

            start = max((offset, offset + step), key=weight)
        if start >= stop - 2 * step:
            start = offset
        lines.append((start, bpm / 2.0))
        halved = (start, 2 * step)
    beats = red_lines._beats_of(lines, float(analysis.duration))
    starts = np.array([o for o, _ in lines]) / 1000.0
    which = np.clip(np.searchsorted(starts, beats, side="right") - 1, 0, len(lines) - 1)
    return _with_lines(analysis, lines, beats=beats,
                       local_bpms=np.array([b for _, b in lines], dtype=float)[which])


def _tidy_bpms(analysis: Analysis) -> Analysis:
    """The finished red lines at the BPMs _tidy_bpm reads (TIDY_BPM), after
    the octave cap (OCTAVE_CAP): every engine path ends here."""
    analysis = _cap_octaves(analysis)
    points = list(getattr(analysis, "points", None) or [])
    if not params.TIDY_BPM or not points or any(getattr(p, "manual", False) for p in points):
        return analysis
    end_ms = float(analysis.duration) * 1000.0
    out = []
    for n, point in enumerate(points):
        stop = points[n + 1].offset_ms if n + 1 < len(points) else end_ms
        bpm = _tidy_bpm(point.bpm, max(0.0, stop - point.offset_ms) * point.bpm / 60000.0)
        if bpm == point.bpm:
            out.append(point)
            continue
        was, now = 60000.0 / point.bpm, 60000.0 / bpm
        k = max(0, int((stop - point.offset_ms) / was) // 2)
        out.append(replace(point, bpm=bpm, offset_ms=point.offset_ms + k * (was - now)))
    if all(a is b for a, b in zip(out, points)):
        return analysis
    lines = [(p.offset_ms, p.bpm) for p in out]
    return replace(analysis, points=out, beats=red_lines._beats_of(lines, float(analysis.duration)))


def _snap_whole_points(analysis: Analysis) -> Analysis:
    """The finished red lines read at whole BPMs where the attacks agree.

    Drift following and the Beat This! vote write lines a few hundredths off
    the whole BPM a mapper uses (142.08 / 141.94 / 141.75 for one 142 line),
    which _snap_whole_bpm, running on the sections before them, never sees.
    """
    if analysis.engine != "precision" or not analysis.points:
        return analysis
    lines = [(p.offset_ms, p.bpm) for p in analysis.points]
    snapped = red_lines._snap_whole_lines(lines, np.asarray(analysis.attack_times, dtype=float),
                                np.asarray(analysis.attack_weights, dtype=float),
                                float(analysis.duration))
    if snapped == lines:
        return analysis
    return _with_lines(analysis, snapped,
                       beats=red_lines._beats_of(snapped, float(analysis.duration)))


def _swings(analysis: Analysis) -> bool:
    """Whether most of the song's swing-lane windows swing or play triplets."""
    try:
        windows = map_objects.swing_lane(analysis.points, analysis.attack_times,
                             analysis.attack_weights, analysis.duration)["windows"]
    except (ValueError, TypeError):
        return False
    swung = sum(w["feel"] in ("swing", "triplets") for w in windows)
    return bool(windows) and swung >= 0.5 * len(windows)
