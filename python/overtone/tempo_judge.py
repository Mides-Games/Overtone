"""The song's octave by a model of mapped tempi (TEMPO_JUDGE, roadmap 27.8).

A small network (bench/tempo_model.py) trained on 2,698 ranked songs' dominant
red-line BPM reads four views of the onset envelope (whole-song autocorrelation,
its spectrum, and the median and upper decile of 12 s windows) and rates 128
log-spaced tempi. Given the engine's reading, it may move every red line by x2
or x1/2, and only when it rates that tempo TEMPO_JUDGE_MARGIN times higher than
the reading as it stands.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Callable

import numpy as np

from . import params

BPM_LO, BPM_HI, PER_OCTAVE = 30.0, 480.0, 32
BINS = int(round(np.log2(BPM_HI / BPM_LO) * PER_OCTAVE))
CENTRES = BPM_LO * 2.0 ** (np.arange(BINS) / PER_OCTAVE)
WINDOW_S, STEP_S = 12.0, 6.0
FEATURE_SR, FEATURE_HOP = 22050, 512


def bpm_bin(bpm: float) -> float:
    return float(np.log2(bpm / BPM_LO) * PER_OCTAVE)


def _acf_at_bins(env: np.ndarray, fps: float) -> np.ndarray:
    x = env - env.mean()
    n = 1 << int(np.ceil(np.log2(2 * x.size)))
    spec = np.fft.rfft(x, n)
    acf = np.fft.irfft(np.abs(spec) ** 2, n)[: x.size]
    acf /= acf[0] if acf[0] > 0 else 1.0
    lags = 60.0 * fps / CENTRES
    return np.interp(lags, np.arange(acf.size), acf, right=0.0)


def _spectrum_at_bins(env: np.ndarray, fps: float) -> np.ndarray:
    x = (env - env.mean()) * np.hanning(env.size)
    mag = np.abs(np.fft.rfft(x))
    freqs = np.fft.rfftfreq(x.size, 1.0 / fps) * 60.0
    out = np.interp(CENTRES, freqs, mag)
    return out / (out.max() or 1.0)


def song_features(y: np.ndarray, sr: int) -> np.ndarray:
    """4 x BINS: whole-song autocorrelation and spectrum of the onset envelope,
    and the median and upper decile of the windowed autocorrelation."""
    import librosa
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=FEATURE_HOP).astype(np.float64)
    fps = sr / FEATURE_HOP
    whole = _acf_at_bins(env, fps)
    spectrum = _spectrum_at_bins(env, fps)
    w, s = int(WINDOW_S * fps), int(STEP_S * fps)
    wins = [_acf_at_bins(env[a:a + w], fps) for a in range(0, max(1, env.size - w + 1), s)] \
        if env.size > w else [whole]
    wins = np.asarray(wins)
    return np.concatenate([whole, spectrum, np.median(wins, 0), np.quantile(wins, 0.9, 0)]).astype(np.float32)


def mix_features(y: np.ndarray, sr: int) -> np.ndarray:
    """The features of a mix at any rate, read at the rate the model learnt."""
    if sr != FEATURE_SR:
        import soxr
        y = soxr.resample(np.asarray(y, np.float64), sr, FEATURE_SR)
    return song_features(np.asarray(y, np.float32), FEATURE_SR)


def forward(m: dict, x: np.ndarray) -> np.ndarray:
    """The model's probability over the tempo classes, one row per song."""
    z = (np.atleast_2d(x) - m["mu"]) / m["sd"]
    h = np.maximum(0.0, z @ m["w1"] + m["b1"])
    logits = h @ m["w2"] + m["b2"]
    logits -= logits.max(1, keepdims=True)
    p = np.exp(logits)
    return p / p.sum(1, keepdims=True)


def rating(p: np.ndarray, bpm: float) -> float:
    """One song's probability at ``bpm``, between its two nearest classes."""
    if not BPM_LO <= bpm <= BPM_HI:
        return -1.0
    b = min(max(bpm_bin(bpm), 0.0), BINS - 1.0)
    lo = int(b)
    hi, w = min(lo + 1, BINS - 1), b - lo
    return float((1 - w) * p[lo] + w * p[hi])


def factor(m: dict, x: np.ndarray, reading: float, margin: float) -> float:
    """x1/2, x1 or x2: the model's pick, kept only when it rates it ``margin``
    times higher than the reading as it stands."""
    p = forward(m, x)[0]
    best = max((0.5, 1.0, 2.0), key=lambda f: rating(p, reading * f))
    keep = max(rating(p, reading), 1e-9)
    return best if best != 1.0 and rating(p, reading * best) > margin * keep else 1.0


@lru_cache(maxsize=1)
def model() -> dict:
    with np.load(params.ROOT / "assets" / "models" / params.TEMPO_JUDGE_MODEL) as data:
        return {k: data[k].astype(np.float64) for k in ("mu", "sd", "w1", "b1", "w2", "b2")}


def _tempo_judge(analysis, audio: Callable[[], tuple[np.ndarray, int]]):
    """Every red line at x2 or x1/2 where the model says the song was read an
    octave out; a halved line keeps the beats that carry more of the attacks."""
    from . import octave_choice, phrases, red_lines
    points = list(getattr(analysis, "points", None) or [])
    if not params.TEMPO_JUDGE or not points or any(getattr(p, "manual", False) for p in points):
        return analysis
    reading = float(analysis.global_bpm) or float(points[0].bpm)
    f = factor(model(), mix_features(*audio()), reading, params.TEMPO_JUDGE_MARGIN)
    if f == 2.0:
        lines = [(p.offset_ms, p.bpm * 2.0) for p in points]
    elif f == 0.5:
        lines = octave_choice._halved_lines(analysis, points)
    else:
        return analysis
    return phrases._with_lines(analysis, lines, beats=red_lines._beats_of(lines, float(analysis.duration)))
