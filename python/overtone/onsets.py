"""The onset envelope and the spectrogram it is built on."""
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

from . import data_model, params


# ---------------------------------------------------------------------------
# Onset envelope
# ---------------------------------------------------------------------------

def _fast_onset_envelope(y: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """Fast spectral-flux envelope, independent of the slow beat tracker."""
    _, _, spectrum = signal.stft(y, fs=sr, nperseg=1024, noverlap=1024 - hop,
                                 boundary=None, padded=False)
    magnitude = np.abs(spectrum)
    return np.maximum(np.diff(magnitude, axis=1), 0).mean(axis=0).astype(np.float32)


def _block_power(segment: np.ndarray, hop: int) -> np.ndarray:
    """``|stft(segment)| ** 2``, uncentred: the power librosa's melspectrogram
    computes from ``y=segment`` before its mel projection, a run of frames at
    a time with a stop asked between runs.

    librosa.stft hands scipy's FFT a fixed number of columns at a time
    (MAX_MEM_BLOCK bytes of frames: 32 here). Runs of whole batches make
    exactly its calls on exactly its frames, so the matrix is its matrix,
    bit for bit; a test holds the result to librosa's own.
    """
    frames = 1 + (segment.size - params.ONSET_N_FFT) // hop
    batch = max(1, librosa.util.MAX_MEM_BLOCK // (params.ONSET_N_FFT * segment.itemsize))
    run = max(batch, params.STFT_RUN // batch * batch)
    matrix = np.empty((1 + params.ONSET_N_FFT // 2, frames), dtype=np.complex64, order="F")
    for first in range(0, frames, run):
        data_model.checkpoint()
        last = min(frames, first + run)
        librosa.stft(segment[first * hop:(last - 1) * hop + params.ONSET_N_FFT], n_fft=params.ONSET_N_FFT,
                     hop_length=hop, center=False, out=matrix[:, first:last])
    power = np.abs(matrix) ** 2.0
    data_model.checkpoint()                  # the mel projection comes next, a step of its own
    return power


def _mel_power(y: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """librosa's centred 128-band mel power spectrogram, a block at a time.

    Each frame is the same zero-padded slice of the signal as in the one-shot
    call, so only the mel projection's float32 summation order can differ:
    at most ~2e-6 of the envelope's range, measured on a real song.
    """
    padded = np.pad(y.astype(np.float32), params.ONSET_N_FFT // 2, mode="constant")
    frames = 1 + y.size // hop
    blocks = []
    for first in range(0, frames, params.SPECTROGRAM_BLOCK):
        last = min(frames, first + params.SPECTROGRAM_BLOCK)
        blocks.append(librosa.feature.melspectrogram(
            S=_block_power(padded[first * hop:(last - 1) * hop + params.ONSET_N_FFT], hop),
            sr=sr, n_fft=params.ONSET_N_FFT, fmax=11025, n_mels=128))
    return np.concatenate(blocks, axis=-1)


def band_edges() -> np.ndarray:
    """The seven bands' eight edges in Hz."""
    edges = params.BAND_LO_HZ * (params.BAND_HI_HZ / params.BAND_LO_HZ) ** (np.arange(params.BAND_COUNT + 1) / params.BAND_COUNT)
    edges[params.BAND_COUNT] = params.BAND_HI_HZ
    return edges


def mel_frequencies() -> np.ndarray:
    """The centre frequency of each mel band, in Hz, for the axis labels."""
    return librosa.mel_frequencies(n_mels=params.MEL_BANDS, fmax=params.MEL_FMAX_HZ)


def loudness_curve(y: np.ndarray, sr: int, columns: int) -> tuple[np.ndarray, float]:
    """How loud the song is over time: ``columns`` values in 0..1, and its peak.

    Root-mean-square per column, in dB under the loudest column, then mapped
    so 0 is :data:`LOUDNESS_FLOOR_DB` under that peak and 1 is the peak
    itself. RMS and not a sample maximum: a curve about how loud a *stretch*
    is should not be set by one sample of one hit.
    """
    y = np.asarray(y, dtype=np.float32)
    columns = max(1, int(columns))
    if y.size == 0 or sr <= 0:
        return np.zeros(0, dtype=np.float32), 0.0
    columns = min(columns, y.size)
    edges = np.linspace(0, y.size, columns + 1).astype(int)
    power = np.empty(columns, dtype=np.float64)
    for i in range(columns):
        lo, hi = edges[i], max(edges[i + 1], edges[i] + 1)
        block = y[lo:hi].astype(np.float64)
        power[i] = float(np.dot(block, block) / block.size)
    decibels = 10.0 * np.log10(np.maximum(power, 1e-12))
    peak = float(decibels.max())
    if peak <= params.LOUDNESS_SILENT_DB:
        return np.zeros(columns, dtype=np.float32), round(peak, 3)
    scaled = (decibels - peak + params.LOUDNESS_FLOOR_DB) / params.LOUDNESS_FLOOR_DB
    return np.clip(scaled, 0.0, 1.0).astype(np.float32), round(peak, 3)


def percussive_balance(y: np.ndarray, sr: int, columns: int,
                       hop: int = params.HPSS_HOP) -> tuple[np.ndarray, np.ndarray, float]:
    """How much of each moment is a hit rather than a note.

    Returns ``columns`` shares in 0..1, the same columns' **loudness** as a
    fraction of the loudest one, and the whole song's own share. Everything
    is weighted by energy: a silent frame has no balance to report, and
    averaging it in as zero would make a quiet song read tonal.

    The loudness comes back because a silent column's share is 0 and 0 means
    "all notes" on the lane, which is a claim about silence rather than a
    reading of it. What is drawn is broken where nothing was heard.
    """
    y = np.asarray(y, dtype=np.float32)
    columns = max(1, int(columns))
    empty = (np.zeros(0, dtype=np.float32), np.zeros(0, dtype=np.float32), 0.0)
    if y.size < params.ONSET_N_FFT or hop < 1:
        return empty
    power = _mel_power(y, sr, hop)                      # (bands, frames)
    if power.shape[1] == 0:
        return empty
    data_model.checkpoint()
    span = max(3, int(round(params.HPSS_KERNEL_MS / 1000.0 * sr / hop)) | 1)
    harmonic = median_filter(power, size=(1, span), mode="nearest")
    data_model.checkpoint()
    percussive = median_filter(power, size=(params.HPSS_KERNEL_BANDS, 1), mode="nearest")
    denominator = harmonic * harmonic + percussive * percussive
    mask = np.where(denominator > 0, (percussive * percussive)
                    / np.maximum(denominator, 1e-30), 0.0)
    energy = power.sum(axis=0)
    share = np.where(energy > 0, (power * mask).sum(axis=0)
                     / np.maximum(energy, 1e-30), 0.0)
    columns = min(columns, share.size)
    edges = np.linspace(0, share.size, columns + 1).astype(int)
    pooled = np.zeros(columns, dtype=np.float32)
    loudness = np.zeros(columns, dtype=np.float32)
    for i in range(columns):
        lo, hi = edges[i], max(edges[i + 1], edges[i] + 1)
        weight = float(energy[lo:hi].sum())
        loudness[i] = weight / max(hi - lo, 1)
        if weight > 0:
            pooled[i] = (share[lo:hi] * energy[lo:hi]).sum() / weight
    peak = float(loudness.max())
    if peak > 0:
        loudness /= peak
    whole = float((share * energy).sum() / energy.sum()) if energy.sum() > 0 else 0.0
    return pooled, loudness, whole


def mel_image(y: np.ndarray, sr: int, columns: int, hop: int | None = None) -> np.ndarray:
    """The song's mel spectrogram in dB, pooled to ``columns``: (bands, columns).

    Pooled by **maximum**, not by mean: a column of a drawn spectrogram stands
    for tens of frames, and a mean turns every transient into a smear — the
    opposite of what the picture is looked at for. Values are dB under the
    loudest cell, clipped at :data:`MEL_TOP_DB`, so 0 is the loudest moment of
    this song and the scale is the song's own.
    """
    hop = params.FIT_HOP if hop is None else hop
    y = np.asarray(y, dtype=np.float32)
    columns = max(1, int(columns))
    if y.size < params.ONSET_N_FFT or hop < 1:
        return np.zeros((params.MEL_BANDS, 0), dtype=np.float32)
    power = _mel_power(y, sr, hop)                      # (bands, frames)
    frames = power.shape[1]
    if frames == 0:
        return np.zeros((params.MEL_BANDS, 0), dtype=np.float32)
    columns = min(columns, frames)
    edges = np.linspace(0, frames, columns + 1).astype(int)
    pooled = np.empty((power.shape[0], columns), dtype=np.float32)
    for i in range(columns):
        data_model.checkpoint()
        pooled[:, i] = power[:, edges[i]:max(edges[i + 1], edges[i] + 1)].max(axis=1)
    decibels = 10.0 * np.log10(np.maximum(pooled, 1e-10))
    return np.maximum(decibels - decibels.max(), -params.MEL_TOP_DB).astype(np.float32)


def band_flux(y: np.ndarray, sr: int, hop: int | None = None) -> np.ndarray:
    """Rectified dB flux per band: ``(frames, BAND_COUNT)``.

    On the same frames, pad and hop as :func:`_onset_envelope`, so a peak at
    row k is the same moment of audio in both and the lanes line up with the
    attacks. Values are absolute dB flux, comparable between bands: no
    per-band normalisation, which would invent peaks in a silent one.

    ``hop`` defaults to the fitting envelope's ``FIT_HOP``, resolved here
    because that constant is defined further down the module.
    """
    hop = params.FIT_HOP if hop is None else hop
    y = np.asarray(y, dtype=np.float32)
    if y.size < params.ONSET_N_FFT or hop < 1:
        return np.zeros((0, params.BAND_COUNT), dtype=np.float32)
    padded = np.pad(y, params.ONSET_N_FFT // 2, mode="constant")
    frames = 1 + y.size // hop
    bin_hz = sr / params.ONSET_N_FFT
    edges = band_edges()
    ranges = []
    for b in range(params.BAND_COUNT):
        lo = max(1, int(np.floor(edges[b] / bin_hz)))
        hi = min(params.ONSET_N_FFT // 2 + 1, int(np.ceil(edges[b + 1] / bin_hz)))
        ranges.append((lo, max(hi, lo + 1)))
    energy = np.empty((frames, params.BAND_COUNT), dtype=np.float64)
    for first in range(0, frames, params.SPECTROGRAM_BLOCK):
        data_model.checkpoint()
        last = min(frames, first + params.SPECTROGRAM_BLOCK)
        power = _block_power(padded[first * hop:(last - 1) * hop + params.ONSET_N_FFT], hop)
        for b, (lo, hi) in enumerate(ranges):
            energy[first:last, b] = power[lo:hi, :].sum(axis=0)
    energy = 10.0 * np.log10(np.maximum(energy, params.BAND_AMIN))
    peak = float(energy.max()) if energy.size else 0.0
    if np.isfinite(peak):
        np.maximum(energy, peak - params.BAND_TOP_DB, out=energy)
    # Front-padded exactly as the default envelope is, so row k means the same
    # audio moment in both curves.
    pad = 1 + params.ONSET_N_FFT // (2 * hop)
    out = np.zeros((frames, params.BAND_COUNT), dtype=np.float32)
    rise = np.maximum(np.diff(energy, axis=0), 0.0)
    room = max(0, frames - min(pad, frames))
    out[min(pad, frames):] = rise[:room]
    return out


def _onset_envelope(y: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """Normalized onset-strength envelope (librosa first, flux fallback).

    The flux envelope is for what librosa refuses as audio (samples that are
    not finite, which the loader already zeroes). It used to take any failure,
    a MemoryError included, and a different envelope means different attacks
    and a different grid, with nothing said: a failure now reaches the caller.
    """
    try:
        # The two whole-track calls after the blocks take about half a second
        # each on an eight-minute song, so a stop is asked before each. The
        # power is rebound, not kept: it is let go once it is in decibels.
        spectrum = _mel_power(y, sr, hop)
        data_model.checkpoint()
        spectrum = librosa.power_to_db(spectrum)
        data_model.checkpoint()
        env = librosa.onset.onset_strength(
            S=spectrum, sr=sr, hop_length=hop, n_fft=params.ONSET_N_FFT, aggregate=np.median,
        ).astype(np.float32)
    except librosa.util.exceptions.ParameterError:
        env = _fast_onset_envelope(y, sr, hop)
    if env.size == 0:
        return env
    # Normalize to [0, 1] with a robust ceiling so thresholds are portable
    # across quiet/loud masters.
    ceiling = float(np.percentile(env, 99.5))
    if ceiling > 1e-9:
        env = env / ceiling
    return np.clip(env, 0.0, 1.5).astype(np.float32)
