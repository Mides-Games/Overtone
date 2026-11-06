"""The precision grid engine (v3): coherence sweep, IRLS fit, seeds, sections."""
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

from . import data_model, hybrid_tracker, onsets, params


# ---------------------------------------------------------------------------
# Precision grid engine (v3)
# ---------------------------------------------------------------------------


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
        if i % 1024 == 0:
            data_model.checkpoint()
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


def _detect_attacks(y: np.ndarray, sr: int, hop: int = params.FIT_HOP,
                    retime: bool = True) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (times, weights, envelope) for every detected attack."""
    env = onsets._onset_envelope(y, sr, hop)
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
        data_model.checkpoint()
        chunk = freqs[start:start + block]
        angle = 2.0 * np.pi * np.outer(t, chunk)
        out[start:start + chunk.size] = np.hypot(w @ np.cos(angle), w @ np.sin(angle))
    return out / total


def map_frequencies(width: float = params.MAP_WIDTH_S) -> np.ndarray:
    """The frequency grid every column shares, so columns compare.

    Stepped at ``0.2 / width``: one window resolves two lobes no closer than
    that, which is the candidate sweep's own rule.
    """
    lo, hi = 1.0 / params.MAP_PERIOD_RANGE[1], 1.0 / params.MAP_PERIOD_RANGE[0]
    step = max(0.2 / max(width, 1e-9), 1e-4)
    return np.arange(lo, hi + 1e-12, step)


def coherence_map(times: np.ndarray, weights: np.ndarray,
                  width: float = params.MAP_WIDTH_S,
                  hop: float = params.MAP_HOP_S) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """``R(t, f)`` over the track: (centres_s, freqs_hz, columns).

    One row of ``columns`` per window, each the phase agreement of that
    window's attacks at every swept rate. A window with fewer than
    :data:`MAP_MIN_ATTACKS` carries no peak worth tracking and is skipped
    rather than given a noisy one.
    """
    times = np.asarray(times, dtype=np.float64)
    weights = np.asarray(weights, dtype=np.float64)
    freqs = map_frequencies(width)
    if times.size == 0 or width <= 0 or hop <= 0 or weights.shape != times.shape:
        return np.zeros(0), freqs, np.zeros((0, freqs.size), dtype=np.float32)
    order = np.argsort(times)
    times, weights = times[order], weights[order]
    centres, columns = [], []
    edge = float(times[0])
    last = float(times[-1])
    while edge + width <= last + 1e-9:
        data_model.checkpoint()
        inside = (times >= edge) & (times < edge + width)
        if int(inside.sum()) >= params.MAP_MIN_ATTACKS:
            columns.append(_coherence_curve(times[inside], weights[inside], freqs))
            centres.append(edge + 0.5 * width)
        edge += hop
    if not columns:
        return np.zeros(0), freqs, np.zeros((0, freqs.size), dtype=np.float32)
    return (np.asarray(centres), freqs,
            np.asarray(columns, dtype=np.float32))


def map_ridge(centres: np.ndarray, freqs: np.ndarray,
              columns: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Follow the strongest peak through the map: (centres, periods, R).

    Each window takes the peak nearest the last one in log2, among those
    above :data:`MAP_PEAK_FLOOR` of its column's best. Without that
    continuity a window whose 2x harmonic momentarily wins reads as a tempo
    doubling; at a real change the old multiple collapses outright, so
    stickiness cannot hide one.
    """
    out_at, out_period, out_r = [], [], []
    previous = None
    for centre, column in zip(np.asarray(centres), np.asarray(columns)):
        best = float(column.max()) if column.size else 0.0
        if not np.isfinite(best) or best <= 1e-6:
            continue
        rises = np.flatnonzero((column[1:-1] >= column[:-2]) & (column[1:-1] > column[2:])) + 1
        peaks = rises[column[rises] >= params.MAP_PEAK_FLOOR * best]
        if peaks.size == 0:
            peaks = np.array([int(np.argmax(column))])
        if previous is None:
            chosen = int(peaks[np.argmax(column[peaks])])
        else:
            chosen = int(peaks[np.argmin(np.abs(np.log2(1.0 / freqs[peaks]) - previous))])
        previous = float(np.log2(1.0 / freqs[chosen]))
        out_at.append(float(centre))
        out_period.append(float(1.0 / freqs[chosen]))
        out_r.append(float(column[chosen]))
    return np.asarray(out_at), np.asarray(out_period), np.asarray(out_r)


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
    if times.size > params.MAX_SCAN_ONSETS:        # bound the scan on very dense audio
        # Must not be called `keep`: that is the parameter naming how many
        # candidates to return, and rebinding it here made the final
        # `strong[:keep]` slice raise TypeError on dense tracks.
        dense = np.sort(np.argsort(weights)[-params.MAX_SCAN_ONSETS:])
        times, weights = times[dense], weights[dense]
    span = float(times[-1] - times[0])
    if span <= 1.0:
        return []
    lo_f, hi_f = 1.0 / period_range[1], 1.0 / period_range[0]
    step = 0.2 / span                      # keeps the coherence lobe resolvable
    freqs = np.arange(lo_f, hi_f, max(step, 1e-4))
    if freqs.size < 4:
        return []
    if freqs.size > params.MAX_SCAN_FREQS:
        # Only reachable if someone widens the seed windows; the sweep cost is
        # onsets x frequencies, so cap it rather than stall on a long window.
        freqs = np.linspace(lo_f, hi_f, params.MAX_SCAN_FREQS)
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
    if times.size > params.MAX_SCAN_ONSETS:
        # The kernel scan is onsets x shifts; the mode does not need every
        # attack, so score it on the strongest ones.
        keep = np.sort(np.argsort(weights)[-params.MAX_SCAN_ONSETS:])
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
        # librosa's tempogram, joined from blocks before the mean is taken, so
        # a stop is asked between them: one call took up to a second. The
        # blocks are TEMPOGRAM_BLOCK columns wide for the reason that constant
        # gives -- the column FFTs stay in cache. This asked for eight times
        # that, on the grounds that short windows make a wide block nearly
        # free; they do not. A six-minute song is 31,008 columns, and at 192
        # lags of float64 the eight-wide block is 12.6 MB whose FFT axis is
        # strided 64 KB apart, with a 47.6 MB join after it: 1.094 s of CPU
        # against 0.359 s at TEMPOGRAM_BLOCK (and 0.188 s at 256, left alone
        # because this constant already carries the reason). Blocks join bit
        # for bit, so the aggregate is unchanged -- checked array_equal at
        # every width from 64 to 8192 on edm-174 and long-6min.
        gram = np.concatenate(list(hybrid_tracker._tempogram(coarse.astype(np.float32), sr, step, 192)),
                              axis=-1)
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
    for m in params.BEAT_MULTIPLES:
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
        if best_means[best_class] < params.HALF_BAR_CONTRAST * opposite:
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
            data_model.checkpoint()
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
        data_model.checkpoint()
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
            # Each step refits the whole section so far: on a long song at one
            # tempo, most of this stage's time.
            data_model.checkpoint()
            nxt = min(finish, edge + max(step_s, 4 * local_period))
            chunk = (times > edge) & (times <= nxt)
            if int(chunk.sum()) < 3:
                edge = nxt
                continue
            share, _cov, rms = _grid_quality(times[chunk], weights[chunk],
                                             local_period, local_phase, tol_ratio=0.11)
            if share < 0.55 or rms > 0.09 * local_period * 1000.0:
                break
            # The grid carried forward is refit on a trailing window, not on
            # everything since the section began: it only has to be good
            # enough to judge the next chunk and to seed the final fit, and
            # that one runs on the whole span anyway. A section shorter than
            # the window is fitted exactly as it was.
            from_s = max(start, nxt - params.GROWTH_WINDOW_BEATS * local_period)
            recent = (times >= from_s - 0.5 * local_period) & (times <= nxt)
            local_period, local_phase, _ = _refine_grid(times[recent], weights[recent],
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
        data_model.checkpoint()
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
        data_model.checkpoint()
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
            data_model.checkpoint()
            split = _tune_boundary(times, weights, sections[i], sections[i + 1])
            left, right = sections[i], sections[i + 1]
            sections[i] = GridSection(left.start_s, split, left.period, left.phase,
                                      left.inliers, left.residual_ms, left.coverage)
            sections[i + 1] = GridSection(split, right.end_s, right.period, right.phase,
                                          right.inliers, right.residual_ms, right.coverage)
        refitted: list[GridSection] = []
        for section in sections:
            data_model.checkpoint()
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


def _one_octave(sections: list[GridSection], times: np.ndarray,
                weights: np.ndarray) -> list[GridSection]:
    """Read every section at the octave of the longest one.

    Sections seed their own grids, and a near-tie can seed one at twice or
    half the beat of its neighbours: on the anime single-tempo stage
    (2026-10-22) songs came out as 145, 290, 145, 290 ... BPM, and the red
    line written was the 290. Music changes tempo by a few BPM, not by an
    octave, so a section a whole octave away is re-read at the longest
    section's octave: a faster one keeps whichever of its beats carries the
    accents, a slower one has its beat split.
    """
    if len(sections) < 2:
        return sections
    ref = max(sections, key=lambda s: s.end_s - s.start_s).period
    out: list[GridSection] = []
    for section in sections:
        k = int(round(np.log2(ref / section.period)))
        if k == 0:
            out.append(section)
            continue
        period, phase = section.period, section.phase
        if k > 0:                         # read too fast: keep the accented beat
            m = 2 ** k
            window = (times >= section.start_s - period) & (times <= section.end_s + period)
            r = _phase_class(times[window], weights[window], period, phase, m)
            period, phase = period * m, phase + r * period
        else:                             # read too slow: split the beat
            period = period / 2 ** (-k)
        out.append(replace(section, period=period, phase=phase))
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
    for m in params.BAR_MULTIPLES:
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
        if contrast < params.BAR_CONTRAST:
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
            for beats in params.BEATS_PER_BAR:
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
    merged = [r for r in runs if len(r[3]) * window_bars >= params.MIN_METER_BARS]
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
        if round(beats) < 1 or abs(beats - round(beats)) > params.BAR_TILE_TOL:
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
        points.append(data_model.TimingPoint(float(start * 1000.0), float(bpm),
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

        points.append(data_model.TimingPoint(float(offset * 1000.0), float(bpm),
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
    times, weights, env = _detect_attacks(y, sr, params.FIT_HOP, retime=retime)
    if times.size < 24:
        return None

    say("Scanning pulse coherence…")
    span_lo = float(times[0])
    span_hi = float(times[-1])
    # Anchor on the densest window: intros, outros and breakdowns are the least
    # informative places to decide what the beat is.
    anchor = span_lo
    if span_hi - span_lo > params.SCAN_SPAN_S:
        edges = np.arange(span_lo, span_hi - params.SCAN_SPAN_S + 1e-9, params.SCAN_SPAN_S / 3.0)
        if edges.size:
            counts = [int(np.sum((times >= e) & (times < e + params.SCAN_SPAN_S))) for e in edges]
            anchor = float(edges[int(np.argmax(counts))])
    anchor_hi = min(span_hi, anchor + params.SCAN_SPAN_S)
    seed = _seed_grid(times, weights, anchor, anchor_hi)
    if seed is None:
        return None
    atom_period, atom_phase = seed
    window = (times >= anchor) & (times <= anchor_hi)
    share, _coverage, _rms = _grid_quality(times[window], weights[window],
                                           atom_period, atom_phase)
    if share < 0.40:
        return None                       # no regular pulse: let the tracker try
    if (_pulse_log10p(times[window], atom_period, atom_phase) > params.WEAK_PULSE_LOG10P
            and hybrid_tracker._fit_pulse_gap(env, sr) < params.STRONG_PULSE_GAP):
        return None                       # chance explains the grid and the envelope agrees

    say("Resolving the beat octave…")
    hints = _tempo_hints(env, sr, params.FIT_HOP)
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
    sections = _one_octave(sections, times, weights)
    sections = _settle_boundaries(times, weights, sections)
    meter_text, downbeat, bar_beats = _meter_from_grid(
        times, weights, sections[0].period, sections[0].phase)
    return {"times": times, "weights": weights, "env": env, "sections": sections,
            "meter": meter_text, "meter_beats": bar_beats, "downbeat": downbeat,
            "atoms_per_beat": m, "first_sound": _first_on_grid(times, sections[0])}
