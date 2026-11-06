"""The drum signal: percussive separation, stems and the drummer guard."""
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

from . import params, phrases, red_lines


def _drum_signal(y: np.ndarray, sr: int) -> np.ndarray:
    """Kick, snare and hats out of ``y``'s percussive part, peak-normalized."""
    import librosa
    from scipy.signal import butter, sosfiltfilt
    perc = librosa.effects.percussive(np.asarray(y, dtype=np.float32), margin=1.0).astype(np.float64)
    kick = sosfiltfilt(butter(4, 120.0, "lowpass", fs=sr, output="sos"), perc)
    snare = sosfiltfilt(butter(4, (150.0, 400.0), "bandpass", fs=sr, output="sos"), perc)
    hats = sosfiltfilt(butter(4, 6000.0, "highpass", fs=sr, output="sos"), perc)
    wk, ws, wh = params.DRUM_BAND_WEIGHTS

    def unit(x: np.ndarray) -> np.ndarray:
        peak = float(np.max(np.abs(x))) if x.size else 0.0
        return x / peak if peak > 0 else x

    out = wk * unit(kick) + ws * unit(snare) + wh * unit(hats)
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    return (out / peak).astype(np.float32) if peak > 0 else np.asarray(y, dtype=np.float32)


def _guard_tracker(analysis: Analysis, heard) -> Analysis:
    """The tracker's lines that leave Beat This!'s tempo, rewritten from its
    beats (TRACKER_GUARD); the analysis as it was otherwise."""
    points = list(getattr(analysis, "points", None) or [])
    if not params.TRACKER_GUARD or len(points) < 2 or any(getattr(p, "manual", False) for p in points):
        return analysis
    found = heard()
    if found is None:
        return analysis
    bt = np.sort(np.asarray(found, dtype=float) * 1000.0)
    if bt.size < 32:
        return analysis
    song = 60000.0 / float(np.median(np.diff(bt)))
    end_ms = float(analysis.duration) * 1000.0
    ends = [points[n + 1].offset_ms if n + 1 < len(points) else end_ms for n in range(len(points))]
    target, bad = [], []
    for p, end in zip(points, ends):
        inside = bt[(bt >= p.offset_ms - 2000.0) & (bt <= end + 2000.0)]
        local = 60000.0 / float(np.median(np.diff(inside))) if inside.size >= 6 else song
        if abs(np.log2(local / song)) > 0.85:
            local = song
        target.append(local)
        bad.append(abs(np.log2(p.bpm / local)) > np.log2(1.0 + params.TRACKER_GUARD_OFF))
    spans = np.array(ends) - np.array([p.offset_ms for p in points])
    if spans[np.array(bad)].sum() < params.TRACKER_GUARD_SHARE * spans.sum():
        return analysis
    lines: list[tuple[float, float]] = []
    n = 0
    while n < len(points):
        if not bad[n]:
            lines.append((points[n].offset_ms, points[n].bpm))
            n += 1
            continue
        m = n
        while m + 1 < len(points) and bad[m + 1]:
            m += 1
        a, b = points[n].offset_ms, ends[m]
        inside = bt[(bt >= a) & (bt < b)]
        period = 60000.0 / float(np.median(target[n:m + 1]))
        if inside.size >= 4:
            x = np.concatenate([[0.0], np.cumsum(np.maximum(1.0, np.round(np.diff(inside) / period)))])
            fitted, start = np.polyfit(x, inside, 1)
            if abs(fitted / period - 1.0) < 0.1:
                period = float(fitted)
            lines.append((float(start), 60000.0 / period))
        else:
            lines.append((a, 60000.0 / period))
        n = m + 1
    lines = red_lines._merge_lines(sorted(lines))
    return phrases._with_lines(analysis, lines, beats=red_lines._beats_of(lines, float(analysis.duration)))


def _follow_drummer(analysis: Analysis, y: np.ndarray, sr: int) -> Analysis:
    """The tracker's red lines re-read off the drummer (DRUMMER_FOLLOW)."""
    points = list(getattr(analysis, "points", None) or [])
    if not params.DRUMMER_FOLLOW or not points or any(getattr(p, "manual", False) for p in points):
        return analysis
    import librosa
    drums = _drum_signal(y, sr)
    env = librosa.onset.onset_strength(y=drums, sr=sr, hop_length=256)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=256, units="frames")
    if frames.size < 32:
        return analysis
    times = librosa.frames_to_time(frames, sr=sr, hop_length=256) * 1000.0
    weights = env[frames].astype(float)
    duration_ms = float(analysis.duration) * 1000.0
    song = red_lines._song_tempo(points, duration_ms) or float(points[0].bpm)
    index, found = red_lines._follow_attacks(times, weights, points[0].offset_ms, 60000.0 / song, duration_ms)
    if found.size < 32:
        return analysis
    beats = np.interp(np.arange(int(index[0]), int(index[-1]) + 1), index, found) / 1000.0
    lines = red_lines._beats_to_lines(beats, params.LOCAL_LINE_TOL_MS)
    if not lines or len(lines) > len(points):
        return analysis
    old = red_lines._attack_rms_ms(red_lines._beats_of([(p.offset_ms, p.bpm) for p in points], float(analysis.duration)),
                         times / 1000.0, weights)
    new = red_lines._attack_rms_ms(red_lines._beats_of(lines, float(analysis.duration)), times / 1000.0, weights)
    if not new < params.DRUMMER_GAIN * old:
        return analysis
    return phrases._with_lines(analysis, lines, beats=red_lines._beats_of(lines, float(analysis.duration)))


def _percussive_blocks(y: np.ndarray, sr: int, margin: float) -> np.ndarray:
    """librosa's percussive part of ``y``, a block at a time."""
    import librosa
    hop = 512  # librosa's STFT hop: blocks on its frames read the same frames
    block, pad = (int(s * sr) // hop * hop for s in (params.PERCUSSIVE_BLOCK_S, params.PERCUSSIVE_PAD_S))
    out = np.zeros_like(y)
    for start in range(0, y.size, block):
        lo, hi = max(0, start - pad), min(y.size, start + block + pad)
        part = librosa.effects.percussive(y[lo:hi], margin=margin)
        stop = min(y.size, start + block)
        out[start:stop] = part[start - lo:stop - lo]
    return out


class SeparatorFailed(RuntimeError):
    """The drums separator (STEMS_DRUMS) is missing, failed or ran out of time
    or memory: the one failure a caller may answer by reading the mix."""


def _stems_drums(y: np.ndarray, sr: int) -> np.ndarray:
    """``y``'s drums stem through the stemsplit CLI, mono and peak-normalized.
    Any failure of the separator is a SeparatorFailed."""
    try:
        return _stems_drums_run(y, sr)
    except SeparatorFailed:
        raise
    except Exception as exc:  # noqa: BLE001 -- timeout, killed, unreadable output
        raise SeparatorFailed(f"The separator failed: {type(exc).__name__}: {exc}") from exc


def _stems_drums_run(y: np.ndarray, sr: int) -> np.ndarray:
    import shutil
    import subprocess
    import tempfile
    import soundfile
    binary = shutil.which(params.STEMSPLIT_CLI) or (params.STEMSPLIT_CLI if os.path.isfile(params.STEMSPLIT_CLI) else None)
    if binary is None:
        raise SeparatorFailed(f"STEMS_DRUMS is on but the separator ({params.STEMSPLIT_CLI}) is not installed")
    model = params.STEMSPLIT_MODEL or os.fspath(params.ROOT / "assets" / "models" / params.STEMSPLIT_WEIGHTS)
    if not os.path.isfile(model):
        raise SeparatorFailed(f"STEMS_DRUMS is on but the separator's weights are missing ({model})")
    with tempfile.TemporaryDirectory() as scratch:
        mix = os.path.join(scratch, "mix.wav")
        soundfile.write(mix, np.asarray(y, dtype=np.float32), sr, subtype="FLOAT")
        done = subprocess.run([binary, "separate", mix, "--out", scratch, "--stems", "drums",
                               "--model", model], capture_output=True,
                              timeout=params.STEMSPLIT_TIMEOUT_S,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if done.returncode != 0:
            detail = done.stderr.decode("utf-8", "replace").strip()[-300:]
            raise SeparatorFailed(f"The separator failed (exit {done.returncode}): {detail}")
        drums, _ = soundfile.read(os.path.join(scratch, "drums.wav"), dtype="float32", always_2d=True)
    out = drums.mean(axis=1)[: len(y)]
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    return (out / peak).astype(np.float32) if peak > 0 else np.asarray(y, dtype=np.float32)


def _percussive(y: np.ndarray, sr: int) -> np.ndarray:
    """The percussive part of ``y`` at PERCUSSIVE_INPUT's margin, peak-normalized
    as the loader leaves audio; ``y`` itself when off."""
    if params.STEMS_DRUMS:
        return _stems_drums(y, sr)
    if params.DRUM_BANDS:
        return _drum_signal(y, sr)
    if not params.PERCUSSIVE_INPUT:
        return y
    out = _percussive_blocks(np.asarray(y, dtype=np.float32), sr, float(params.PERCUSSIVE_INPUT))
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    return (out / peak).astype(np.float32) if peak > 0 else np.asarray(y, dtype=np.float32)
