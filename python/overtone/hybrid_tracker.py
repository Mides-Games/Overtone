"""The fallback beat tracker (v2 hybrid), its lag and the DBN decoder."""
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

from . import data_model, params, precision_grid, tempo_helpers


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


def _tempogram(onset: np.ndarray, sr: int, hop: int, win_length: int,
               columns: int | None = None):
    """librosa.feature.tempogram(onset, center=True), in blocks of columns
    (``columns`` each, TEMPOGRAM_BLOCK unless given).

    The envelope is padded once exactly as librosa pads it, and each block is
    the uncentred tempogram of its own slice: every column is the same window
    of the same signal, so the blocks join bit for bit into the one-shot array
    (checked on fixtures and a real song) without its FFT buffers.
    """
    n = onset.shape[-1]
    half = win_length // 2
    padded = np.pad(onset, (half, half), mode="linear_ramp", end_values=[0, 0])
    step = columns or params.TEMPOGRAM_BLOCK
    for first in range(0, n, step):
        data_model.checkpoint()
        last = min(n, first + step)
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
    data_model.checkpoint()
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
    data_model.checkpoint()
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
    data_model.checkpoint()
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


def _pulse_clarity(onset: np.ndarray, sr: int, hop: int) -> float:
    """Median over the track of the best 40-300 BPM self-similarity.

    librosa.feature.tempogram's autocorrelation (periodic Hann, centred with a
    linear ramp, each window normalised by its peak) written in numpy and
    evaluated every PULSE_STRIDE frames; with a stride of 1 it matches librosa
    to 6e-16. It must not *call* librosa: a tempogram computed before the
    fallback tracker's first call changed that tracker's global BPM on a real
    song (198.07 -> 199.27), and a safeguard must not move a result.
    """
    data_model.checkpoint()          # a whole-track pass, called six times in a row
    env = np.asarray(onset, dtype=np.float64)
    k = np.arange(params.PULSE_WINDOW)
    half = params.PULSE_WINDOW // 2
    padded = np.pad(env, (half, half), mode="linear_ramp", end_values=(0, 0))
    hann = 0.5 - 0.5 * np.cos(2.0 * np.pi * k / params.PULSE_WINDOW)
    starts = np.arange(0, env.size, params.PULSE_STRIDE)
    frames = padded[starts[:, None] + k[None, :]] * hann[None, :]
    nfft = 1 << int(np.ceil(np.log2(2 * params.PULSE_WINDOW - 1)))
    spectrum = np.fft.rfft(frames, n=nfft, axis=1)
    lagged = np.fft.irfft(spectrum * np.conj(spectrum), n=nfft, axis=1)[:, :params.PULSE_WINDOW]
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
    shuffled = [_pulse_clarity(rng.permutation(onset), sr, hop) for _ in range(params.PULSE_SHUFFLES)]
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
    hop = 2 * params.FIT_HOP
    index = np.arange(onset.size, dtype=np.uint64)
    shuffled = []
    for shuffle in range(params.PULSE_SHUFFLES):
        keys = _splitmix64(index + np.uint64(shuffle << 32))
        shuffled.append(_pulse_clarity(onset[np.argsort(keys, kind="stable")], sr, hop))
    return _pulse_clarity(onset, sr, hop) - float(np.mean(shuffled))


def _tracker_lag(y: np.ndarray, sr: int, beat_times: np.ndarray) -> float:
    """The shift (s) that puts the fallback tracker's beats on their attacks.

    The tracker follows the onset envelope and ends each beat on one of its
    peaks, which come after the sound starts: with the tracker forced, the
    beats of Corpus A's fixtures landed a median 7.4-8.9 ms after their hits
    (13 and 17 ms under noise), and on the four Corpus B songs that fall back
    to it the sound starts 21-24 ms before its beats. Each beat is re-timed
    on the waveform as the precision engine re-times its attacks
    (_retime_onsets), and the median shift of the beats that moved is the
    song's lag.

    One median for the song, not each beat's own re-timing: on those four
    songs a beat's own reading scattered the beats (the interquartile width
    of their distance to the maps' hand-timed beats grew from 5.1 to 8.6, 9.6
    to 16.3 and 5.8 to 13.7 ms on three of them), and a fallback red line
    sits on a single beat. 0 when too few beats sit on an attack to read it.
    """
    beat_times = np.asarray(beat_times, dtype=np.float64)
    if beat_times.size == 0 or y.size == 0:
        return 0.0
    shift = precision_grid._retime_onsets(y, sr, beat_times) - beat_times
    moved = shift[shift != 0.0]
    if moved.size < max(params.MIN_LAG_BEATS, 0.5 * beat_times.size):
        return 0.0
    return float(np.median(moved))


def _tracker_result(source: str, duration: float, onset: np.ndarray,
                    base_frames: np.ndarray, sr: int, hop: int, subdivision: float,
                    auto_subdivision: float, min_delta: float, persistence: int,
                    min_confidence: float, refine: bool = True) -> Analysis:
    """The fallback tracker's result at ``subdivision`` times the pulse of the
    beats it tracked (``base_frames``), before its lag is taken off (_moved_by).

    The analysis and the ×2 / ÷2 rebuild both end here, so a rebuild at the
    analysis's own pulse gives the analysis back. Each used to run its own
    copy of these steps, and the copies held a beat with no peak under it
    differently: where the tracker doubled its own pulse, 11 of 32 fallback
    analyses came back from ÷2 then ×2 changed, Calm Down Juliet with 10 red
    lines for 3. ``refine`` is the analysis's refine_beats, which the result
    keeps: without it the beats stay where the split put them, in a rebuild
    as in the analysis.
    """
    frames = tempo_helpers._resubdivide(base_frames, subdivision)
    if refine:
        # Interpolated midpoints can sit up to half a beat away from the true
        # attack, so widen the snap window proportionally to the beat length.
        median_gap_s = (float(np.median(np.diff(np.asarray(frames, dtype=float)))) * hop / sr
                        if len(frames) > 1 else 0.5)
        frames = _refine_beats_to_transients(
            frames, onset, sr, hop,
            radius_ms=float(np.clip(0.30 * median_gap_s * 1000, 25, 90)),
            # A beat with no peak under it is held only away from the pulse
            # the tracker chose itself, where the user asked for the beats. On
            # the tracker's own doubling holding changed 9 of 27 real songs
            # with no net gain against their ranked maps (within 10 ms 0.128
            # -> 0.125).
            return_float=True,
            hold_without_peak=subdivision > 1 and subdivision != auto_subdivision)
    frames = tempo_helpers._trim_leading_silence(frames, onset)
    frames = tempo_helpers._fill_missed_beats(frames)
    beat_times = np.asarray(frames, dtype=np.float64) * hop / sr
    local = tempo_helpers._robust_local_bpms(beat_times)
    valid = (local >= 30) & (local <= 600)
    beats_v, local_v = beat_times[valid], local[valid]
    candidates = tempo_helpers._segment_tempi(beats_v, local_v, min_delta, persistence)
    points = [point for point in candidates if point.confidence >= min_confidence]
    if not points and candidates:
        points = [max(candidates, key=lambda p: p.confidence)]
    # The median of the measured beats. Averaging it with a nearby tempogram
    # guide was tried: a guide is a bin a few tenths of a BPM wide, and on 16
    # single-tempo corpus cases the average was further from the truth 14
    # times (median error 0.39 against 0.17 BPM).
    global_bpm = float(np.median(local_v)) if len(local_v) else 0.0
    return data_model.Analysis(source, duration, beats_v, local_v, points, hop, sr, subdivision,
                    global_bpm, tempo_helpers._stability(local_v), tempo_helpers._guess_meter(beats_v, onset, sr, hop),
                    onset, np.asarray(base_frames, dtype=float),
                    auto_subdivision=auto_subdivision, refine_beats=refine)


def _moved_by(result: Analysis, shift: float) -> Analysis:
    """The fallback tracker's result with its beats moved by ``shift`` (none
    before 0 s), and each red line with the beat it sits on. The tempo is
    untouched."""
    moved = np.maximum(np.asarray(result.beats, dtype=np.float64) + shift, 0.0)
    points = [replace(p, offset_ms=float(moved[p.beat_index] * 1000.0)) for p in result.points]
    return replace(result, beats=moved, points=points, beat_shift_s=shift)


def _dbn_beats(activation: np.ndarray, fps: float) -> np.ndarray:
    """Beat times (s) decoded from a beat activation sampled at ``fps``.

    Viterbi over the (interval, position) states. Within an interval the path
    has one way forward, so only a beat's choice of the next interval is kept
    per frame: memory is frames x DBN_TEMPI, time frames x states."""
    act = np.asarray(activation, dtype=np.float64)
    if fps != params.DBN_FPS:
        t_in = np.arange(act.size) / fps
        t_out = np.arange(int(act.size * params.DBN_FPS / fps)) / params.DBN_FPS
        act = np.interp(t_out, t_in, act)
    frames = act.size
    lo, hi = params.DBN_BPM_RANGE
    taus = np.unique(np.round(np.geomspace(60.0 * params.DBN_FPS / hi, 60.0 * params.DBN_FPS / lo,
                                           params.DBN_TEMPI)).astype(int))
    taus = taus[taus >= 2]
    if frames < 2 * taus[0] or taus.size == 0:
        return np.zeros(0)
    n = taus.size
    first = np.concatenate([[0], np.cumsum(taus)[:-1]])          # phase-0 state of each tempo
    last = first + taus - 1
    states = int(taus.sum())
    tempo_of = np.repeat(np.arange(n), taus)
    phase_of = np.arange(states) - first[tempo_of]
    on_beat = phase_of < np.maximum(1, np.round(taus[tempo_of] * params.DBN_BEAT_SHARE))

    ratio = taus[None, :] / taus[:, None]
    log_t = -params.DBN_TRANSITION_LAMBDA * np.abs(ratio - 1.0)
    log_t -= np.logaddexp.reduce(log_t, axis=1, keepdims=True)
    bpm = 60.0 * params.DBN_FPS / taus
    log_prior = -0.5 * (np.log2(bpm / params.DBN_PRIOR_BPM) / params.DBN_PRIOR_OCTAVES) ** 2
    log_t = log_t + log_prior[None, :] - np.max(log_prior)

    eps = 1e-6
    a = np.clip(act, eps, 1.0 - eps)
    obs_on, obs_off = np.log(a), np.log((1.0 - a) / (params.DBN_OBSERVATION_LAMBDA - 1.0))
    delta = np.where(on_beat, obs_on[0], obs_off[0]) + log_prior[tempo_of] - np.log(states)
    back = np.empty((frames, n), dtype=np.int16)
    shifted = np.empty(states)
    for f in range(1, frames):
        shifted[1:] = delta[:-1]                                   # position advances
        cand = delta[last][:, None] + log_t                        # last position -> a beat
        back[f] = np.argmax(cand, axis=0)
        shifted[first] = cand[back[f], np.arange(n)]
        delta = shifted + np.where(on_beat, obs_on[f], obs_off[f])
        delta -= delta.max()
    s = int(np.argmax(delta))
    beats, beat_tempi = [], []
    for f in range(frames - 1, 0, -1):
        k = tempo_of[s]
        if s == first[k]:
            beats.append(f)
            beat_tempi.append(k)
            s = int(last[back[f, k]])
        else:
            s -= 1
    if s == first[tempo_of[s]]:
        beats.append(0)
        beat_tempi.append(tempo_of[s])
    # The path enters a beat anywhere in its on-beat window; each beat goes to
    # the activation's peak inside the window it chose.
    widths = np.maximum(1, np.round(taus * params.DBN_BEAT_SHARE)).astype(int)
    peaks = []
    for f, k in zip(beats[::-1], beat_tempi[::-1]):
        seg = act[f:f + widths[k]]
        peaks.append(f + int(np.argmax(seg)) if seg.size else f)
    return np.asarray(peaks, dtype=float) / params.DBN_FPS


def _dbn_frames(activation, sr: int, hop: int, frames: int) -> np.ndarray | None:
    """The DBN's beats as onset-envelope frames, or None without an activation."""
    if activation is None:
        return None
    act = activation()
    if act is None or len(act) < 16:
        return None
    beats = _dbn_beats(act, params.BEAT_THIS_SR / params.BEAT_THIS_HOP)
    out = np.unique(np.round(beats * sr / hop).astype(int))
    out = out[(out >= 0) & (out < frames)]
    return out if out.size >= 8 else None
