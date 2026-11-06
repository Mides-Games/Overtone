"""Beat This!: the model session, its activation, beats, judge and vote."""
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

from . import data_model, params, pipeline, red_lines


def _beat_this_frames(heard, sr: int, hop: int, frames: int) -> np.ndarray | None:
    """Beat This!'s beats as onset-envelope frames, or None without them."""
    if heard is None:
        return None
    beats = heard()
    if beats is None or len(beats) < 8:
        return None
    out = np.unique(np.round(np.asarray(beats, dtype=float) * sr / hop).astype(int))
    out = out[(out >= 0) & (out < frames)]
    return out if out.size >= 8 else None


def _beat_this_activation(y: np.ndarray, sr: int, session=None) -> np.ndarray | None:
    """Beat This!'s beat probability per 50 fps frame, or None without the model."""
    if session is None:
        if not params._BEAT_THIS_JUDGE:
            params._BEAT_THIS_JUDGE.append(_load_beat_this())
        session = params._BEAT_THIS_JUDGE[0]
    if session is None or y.size == 0:
        return None
    import soxr
    signal = soxr.resample(np.asarray(y, dtype=np.float64), sr, params.BEAT_THIS_SR) \
        if sr != params.BEAT_THIS_SR else np.asarray(y, dtype=np.float64)
    logits = _beat_this_logits(session, _beat_this_spectrogram(signal)).astype(np.float64)
    return 1.0 / (1.0 + np.exp(-np.clip(logits, -50.0, 50.0)))


def _beat_this_judge_beats(y: np.ndarray, sr: int):
    """Beat This!'s beats (s) by the judge's own session (the vote's switch
    aside); None without the model or the runtime."""
    if not params._BEAT_THIS_JUDGE:
        params._BEAT_THIS_JUDGE.append(_load_beat_this())
    if params._BEAT_THIS_JUDGE[0] is None:
        return None
    key = (id(y), int(y.size), int(sr))
    if params._BEAT_THIS_HEARD and params._BEAT_THIS_HEARD[0][0] == key and params._BEAT_THIS_HEARD[0][1] is y:
        return params._BEAT_THIS_HEARD[0][2]
    beats = _beat_this_beats(y, sr, session=params._BEAT_THIS_JUDGE[0])
    params._BEAT_THIS_HEARD[:] = [(key, y, beats)]
    return beats


def _song_octave_by_beat_this(analysis: Analysis, heard) -> Analysis:
    """Every red line at Beat This!'s octave when it hears the song near 2x
    or 1/2 of its own tempo (SONG_OCTAVE_BEAT_THIS); a halved line keeps the
    phase nearest Beat This!'s beats."""
    points = list(getattr(analysis, "points", None) or [])
    if not params.SONG_OCTAVE_BEAT_THIS or not points:
        return analysis
    duration_ms = float(analysis.duration) * 1000.0
    song = red_lines._song_tempo(points, duration_ms)
    found = heard() if song else None
    if found is None or len(found) < 16:
        return analysis
    beats = np.sort(np.asarray(found, dtype=float) * 1000.0)
    tempo = 60000.0 / float(np.median(np.diff(beats)))
    ratio = tempo / song
    factor = (2.0 if abs(ratio / 2.0 - 1.0) <= params.LOCAL_OCTAVE_SLACK
              else 0.5 if abs(ratio / 0.5 - 1.0) <= params.LOCAL_OCTAVE_SLACK else None)
    if factor is None:
        return analysis
    out = []
    for n, point in enumerate(points):
        end = points[n + 1].offset_ms if n + 1 < len(points) else duration_ms
        target = point.bpm * factor
        offset = point.offset_ms
        inside = beats[(beats >= point.offset_ms) & (beats <= end)]
        if factor < 1.0 and inside.size >= 2:
            period = 60000.0 / target

            def distance(start: float) -> float:
                grid = start + np.arange(max(1, int((end - start) / period) + 1)) * period
                i = np.clip(np.searchsorted(inside, grid), 1, inside.size - 1)
                return float(np.median(np.minimum(np.abs(inside[i - 1] - grid),
                                                  np.abs(inside[i] - grid))))

            offset = min((point.offset_ms, point.offset_ms + 60000.0 / point.bpm), key=distance)
        out.append(replace(point, bpm=target, offset_ms=offset))
    return replace(analysis, points=out)


def _load_beat_this():
    """A new ONNX Runtime session on the model; None without one or the other."""
    path = params.ROOT / "assets" / "models" / params.BEAT_THIS_MODEL
    try:
        import onnxruntime
        if not path.is_file():
            return None
        options = onnxruntime.SessionOptions()
        options.log_severity_level = 3
        # The memory pattern plans one buffer layout per input shape, and every
        # song's last chunk is a new shape. Off, the peak working set over three
        # songs (135, 257 and 477 s) fell 1904 -> 1278 MB with every beat
        # within 1 ms and no more CPU (2026-10-27, docs/17-stack-alternatives.md).
        options.enable_mem_pattern = False
        return onnxruntime.InferenceSession(str(path), options,
                                            providers=["CPUExecutionProvider"])
    except Exception:  # noqa: BLE001 -- no runtime or no model: nothing to ask
        return None


def _beat_this_session():
    """The vote's ONNX Runtime session, loaded once; None without the model
    or the runtime, or where the vote is turned off."""
    if not params._BEAT_THIS_SESSION:
        params._BEAT_THIS_SESSION.append(_load_beat_this())
    return params._BEAT_THIS_SESSION[0]


def _beat_this_mel_filters() -> np.ndarray:
    """Slaney mel filters without area normalisation, as torchaudio builds them."""
    f_sp, min_log_hz = 200.0 / 3, 1000.0
    min_log_mel, logstep = min_log_hz / f_sp, np.log(6.4) / 27.0

    def to_mel(f):
        f = np.asarray(f, dtype=float)
        return np.where(f >= min_log_hz,
                        min_log_mel + np.log(np.maximum(f, 1e-9) / min_log_hz) / logstep, f / f_sp)

    def to_hz(m):
        m = np.asarray(m, dtype=float)
        return np.where(m >= min_log_mel, min_log_hz * np.exp(logstep * (m - min_log_mel)), f_sp * m)

    freqs = np.linspace(0, params.BEAT_THIS_SR // 2, params.BEAT_THIS_FFT // 2 + 1)
    lo, hi = params.BEAT_THIS_BAND_HZ
    edges = to_hz(np.linspace(to_mel(lo), to_mel(hi), params.BEAT_THIS_MELS + 2))
    gaps = np.diff(edges)
    slopes = edges[None, :] - freqs[:, None]
    return np.maximum(0.0, np.minimum(-slopes[:, :-2] / gaps[:-1], slopes[:, 2:] / gaps[1:]))


def _beat_this_spectrogram(signal: np.ndarray) -> np.ndarray:
    """Beat This!'s input: log(1 + 1000 * mel magnitude), (frames, 128)."""
    pad = params.BEAT_THIS_FFT // 2
    x = np.pad(np.asarray(signal, dtype=np.float32), pad, mode="reflect")
    window = np.hanning(params.BEAT_THIS_FFT + 1)[:-1].astype(np.float32)     # periodic Hann
    count = 1 + (len(x) - params.BEAT_THIS_FFT) // params.BEAT_THIS_HOP
    if count < 1:
        return np.zeros((0, params.BEAT_THIS_MELS), dtype=np.float32)
    mel = _beat_this_mel_filters().astype(np.float32)
    out = np.empty((count, params.BEAT_THIS_MELS), dtype=np.float32)
    for lo in range(0, count, 4096):            # a few thousand frames at a time
        hi = min(count, lo + 4096)
        idx = np.arange(params.BEAT_THIS_FFT)[None, :] + params.BEAT_THIS_HOP * np.arange(lo, hi)[:, None]
        # torchaudio's normalized="frame_length" divides by sqrt(n_fft)
        magnitude = np.abs(np.fft.rfft(x[idx] * window, axis=1)) / np.sqrt(params.BEAT_THIS_FFT)
        out[lo:hi] = np.log1p(1000.0 * (magnitude @ mel))
    return out


def _beat_this_logits(session, spect: np.ndarray) -> np.ndarray:
    """Frame-wise beat logits over the whole song, chunk by chunk."""
    frames = len(spect)
    step = params.BEAT_THIS_CHUNK - 2 * params.BEAT_THIS_BORDER
    starts = np.arange(-params.BEAT_THIS_BORDER, frames - params.BEAT_THIS_BORDER, step)
    if frames > step:
        starts[-1] = frames - (params.BEAT_THIS_CHUNK - params.BEAT_THIS_BORDER)
    logits = np.full(frames, -1000.0, dtype=np.float32)
    for start in starts[::-1]:                  # earlier chunks win their overlap
        a, b = max(int(start), 0), min(int(start) + params.BEAT_THIS_CHUNK, frames)
        chunk = np.pad(spect[a:b], ((max(0, -int(start)),
                                     max(0, min(params.BEAT_THIS_BORDER, int(start) + params.BEAT_THIS_CHUNK - frames))),
                                    (0, 0)))
        data_model.checkpoint()
        out = session.run(None, {"spect": chunk[None]})[0][0][params.BEAT_THIS_BORDER:-params.BEAT_THIS_BORDER]
        lo = int(start) + params.BEAT_THIS_BORDER
        keep = max(0, min(len(out), frames - lo))
        logits[lo:lo + keep] = out[:keep]
    return logits


def _beat_this_beats(y: np.ndarray, sr: int, session=None) -> np.ndarray | None:
    """Beat times (s) by Beat This!, or None when the network is unavailable;
    ``session`` instead of the vote's."""
    session = session if session is not None else _beat_this_session()
    if session is None or y.size == 0:
        return None
    import soxr
    signal = soxr.resample(np.asarray(y, dtype=np.float64), sr, params.BEAT_THIS_SR) \
        if sr != params.BEAT_THIS_SR else np.asarray(y, dtype=np.float64)
    logits = _beat_this_logits(session, _beat_this_spectrogram(signal))
    padded = np.pad(logits, 3, constant_values=-1000.0)
    local_max = np.lib.stride_tricks.sliding_window_view(padded, 7).max(axis=1)
    frames = np.flatnonzero((logits == local_max) & (logits > 0))
    beats: list[float] = []
    mean, count = None, 0
    for f in frames:                            # adjacent peaks become their mean
        if mean is not None and f - mean <= 1:
            count += 1
            mean += (f - mean) / count
        else:
            if mean is not None:
                beats.append(mean)
            mean, count = float(f), 1
    if mean is not None:
        beats.append(mean)
    return np.asarray(beats, dtype=float) * params.BEAT_THIS_HOP / params.BEAT_THIS_SR


def _grid_fit_score(beats: np.ndarray, times: np.ndarray, weights: np.ndarray,
                    tol_ms: float) -> float:
    """How well a beat grid explains the attacks: F-measure of attack weight
    within ``tol_ms`` of a beat and beats within ``tol_ms`` of an attack."""
    if beats.size < 4 or times.size < 2:
        return 0.0
    i = np.clip(np.searchsorted(beats, times), 1, beats.size - 1)
    d = np.minimum(np.abs(beats[i - 1] - times), np.abs(beats[i] - times)) * 1000.0
    recall = float(np.sum(weights[d <= tol_ms]) / max(float(np.sum(weights)), 1e-12))
    j = np.clip(np.searchsorted(times, beats), 1, times.size - 1)
    e = np.minimum(np.abs(times[j - 1] - beats), np.abs(times[j] - beats)) * 1000.0
    precision = float(np.mean(e <= tol_ms))
    return 0.0 if recall + precision == 0 else 2 * recall * precision / (recall + precision)


def _beat_this_vote(analysis: Analysis, y: np.ndarray, sr: int) -> Analysis:
    """The precision analysis, or Beat This!'s lines where they fit the attacks
    clearly better (BEAT_THIS_MARGIN). Never runs on a fallback analysis."""
    if analysis.engine != "precision" or not analysis.points:
        return analysis
    times = np.asarray(analysis.attack_times, dtype=float)
    weights = np.asarray(analysis.attack_weights, dtype=float)
    if times.size < 8:
        return analysis
    beats = _beat_this_beats(y, sr)
    if beats is None or beats.size < 8:
        return analysis
    duration = float(analysis.duration)
    lines = red_lines._beats_to_lines(beats, params.LOCAL_LINE_TOL_MS)
    if not lines:
        return analysis
    ours = _grid_fit_score(red_lines._beats_of([(p.offset_ms, p.bpm) for p in analysis.points], duration),
                           times, weights, params.BEAT_THIS_TOL_MS)
    theirs = _grid_fit_score(red_lines._beats_of(lines, duration), times, weights, params.BEAT_THIS_TOL_MS)
    if theirs <= ours + params.BEAT_THIS_MARGIN:
        return analysis
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
