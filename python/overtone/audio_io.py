"""Loading audio: decode, resample, gapless MP3 and the file report."""
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
# Main analysis entry point
# ---------------------------------------------------------------------------


def _decode(path: str | os.PathLike[str]) -> tuple[np.ndarray, int]:
    """``sf.read(path, dtype="float32")`` mixed down to mono, a block at a time.

    The one call decoded a whole song before a stop could land (1.0 s for an
    eight-minute MP3, and 0.8 s more to mix it down). The blocks are read as
    sf.read reads, from the start and no further than the header's length,
    and each is mixed down on its own, row by row as the whole array was.
    libsndfile seeks between blocks, which is exact for PCM; for MP3 and Ogg
    the samples came out identical on all 20 Corpus B files.
    """
    with sf.SoundFile(path) as handle:
        frames, channels = handle.frames, handle.channels
        if handle.seekable():
            handle.seek(0)
        mono = np.empty(frames, dtype=np.float32)
        done = 0
        while done < frames:
            data_model.checkpoint()
            want = min(params.DECODE_BLOCK, frames - done)
            if channels == 1:
                got = len(handle.read(want, dtype="float32", out=mono[done:done + want]))
            else:
                block = handle.read(want, dtype="float32")
                got = len(block)
                mono[done:done + got] = np.mean(block, axis=1, dtype=np.float32)
            done += got
            if got < want:
                break                 # the header promised more than the stream holds
        return mono[:done], handle.samplerate


def _load_audio(path: str | os.PathLike[str],
                say: Callable[[str], None]) -> tuple[np.ndarray, int]:
    """Decode to mono float32 at 44.1 kHz, peak-normalized."""
    say("Loading and normalizing audio…")
    # A missing or empty file is not a codec problem. All three used to read
    # "Could not decode audio ... install FFmpeg", which sends the user off to
    # install a program that cannot help.
    name = os.path.basename(os.fspath(path))
    if not os.path.isfile(path):
        raise RuntimeError(f"No audio file at {os.fspath(path)}.")
    if os.path.getsize(path) == 0:
        raise RuntimeError(f"{name} is empty (0 bytes).")
    try:
        # Ask libsndfile for the header first: a mistyped path to a multi-hour
        # file should cost nothing, not gigabytes of decoded samples.
        info = sf.info(str(path))
        if info.samplerate > 0 and info.frames / info.samplerate > params.MAX_AUDIO_SECONDS:
            raise ValueError(
                f"Audio is longer than {params.MAX_AUDIO_SECONDS / 60:.0f} minutes; "
                "trim the file before analysing it.")
    except ValueError:
        raise
    except Exception:
        pass                          # unreadable header: the decoders below decide
    try:
        # SoundFile decodes WAV/FLAC/OGG/MP3 directly and avoids an
        # unnecessary, expensive resample when already at 44.1 kHz.
        y, sr = _decode(path)
        if sr != params.TARGET_SR:
            data_model.checkpoint()
            y = librosa.resample(y, orig_sr=sr, target_sr=params.TARGET_SR, res_type="soxr_hq")
            sr = params.TARGET_SR
    except Exception:
        try:
            y, sr = librosa.load(path, sr=params.TARGET_SR, mono=True, res_type="soxr_hq")
        except Exception as exc:
            if Path(name).suffix.lower() in (".mp3", ".m4a", ".aac", ".mp4", ".wma"):
                raise RuntimeError(
                    "Could not decode audio. For MP3/M4A/AAC install FFmpeg and add it to "
                    "PATH; WAV/FLAC/OGG open directly."
                ) from exc
            # WAV, FLAC, OGG and AIFF need no FFmpeg: this file is damaged or
            # is not the audio its name says.
            raise RuntimeError(
                f"Could not decode {name}: it is not audio this program can read, "
                "or it is damaged."
            ) from exc
    data_model.checkpoint()
    y = np.asarray(y, dtype=np.float32).reshape(-1)
    if not np.all(np.isfinite(y)):
        y = np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0)
    if y.size < sr * 2:
        raise ValueError("Audio must be at least two seconds long.")
    if y.size > sr * params.MAX_AUDIO_SECONDS:
        # A cap keeps a mistyped path (or a hostile multi-hour file) from
        # turning into gigabytes of intermediate arrays.
        raise ValueError(
            f"Audio is longer than {params.MAX_AUDIO_SECONDS / 60:.0f} minutes; "
            "trim the file before analysing it.")
    peak = float(np.max(np.abs(y)))
    if peak > 1e-9:
        y = (y / peak * 0.99).astype(np.float32)
    return y, int(sr)


def percussive_wav(y: np.ndarray, sr: int) -> bytes:
    """The percussive stem as 16-bit mono WAV bytes (Phase 4, audition).

    librosa's HPSS, same length in and out, peak-normalized like a decode.
    Thin on purpose: the bridge caches the bytes per analysis, and the only
    promise made here is bytes that decode — attack preservation is measured
    where it is used, not asserted here.
    """
    import io
    _harmonic, percussive = librosa.effects.hpss(np.asarray(y, dtype=np.float32))
    peak = float(np.max(np.abs(percussive)))
    if peak > 1e-9:
        percussive = (percussive / peak * 0.99).astype(np.float32)
    buffer = io.BytesIO()
    sf.write(buffer, np.asarray(percussive, dtype=np.float32), int(sr),
             format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def mp3_gapless_info(path: str | os.PathLike[str]) -> dict:
    """The MP3's own gapless numbers, read from its header (Phase 19, lab).

    Skips an ID3v2 tag, finds the first frame, reads the MPEG version for
    the Xing offset, and unpacks the LAME tag's encoder delay and padding
    (12 bits each at LAME+21). Returns encoder string, delay and padding in
    samples and milliseconds at the file's own rate, or ``present`` False
    for anything without a LAME tag — Fraunhofer and old encoders write
    none, and that is reported, not guessed. Read only; plain JSON types.
    """
    name = str(path)
    if Path(name).suffix.lower() != ".mp3":
        return {"present": False}
    try:
        with open(path, "rb") as handle:
            head = handle.read(8192)
    except OSError:
        return {"present": False}
    pos = 0
    if head[:3] == b"ID3":
        if len(head) < 10:
            return {"present": False}
        size = 0
        for byte in head[6:10]:
            size = (size << 7) | (byte & 0x7F)
        pos = 10 + size
    sync = -1
    for i in range(pos, min(pos + 256, len(head) - 4)):
        if head[i] == 0xFF and head[i + 1] & 0xE0 == 0xE0:
            sync = i
            break
    if sync < 0:
        return {"present": False}
    version = (head[sync + 1] >> 3) & 0x03
    mono = ((head[sync + 3] >> 6) & 0x03) == 3
    if version == 3:
        xing_at = sync + 4 + (17 if mono else 32)
        rates = (44100, 48000, 32000, 0)
    elif version in (2, 0):
        xing_at = sync + 4 + (9 if mono else 17)
        rates = (22050, 24000, 16000, 0) if version == 2 else (11025, 12000, 8000, 0)
    else:
        return {"present": False}
    sample_rate = rates[(head[sync + 2] >> 2) & 0x03]
    if not sample_rate or head[xing_at:xing_at + 4] not in (b"Xing", b"Info"):
        return {"present": False}
    lame_at = head.find(b"LAME", xing_at + 4, xing_at + 240)
    if lame_at < 0 or lame_at + 24 > len(head):
        return {"present": False}
    lame = head[lame_at:lame_at + 24]
    raw = int.from_bytes(lame[21:24], "big")
    delay, padding = (raw >> 12) & 0xFFF, raw & 0xFFF
    encoder = lame[0:9].decode("ascii", "replace").strip("\x00")
    if not encoder.startswith("LAME"):
        return {"present": False}
    scale = 1000.0 / sample_rate
    return {"present": True, "encoder": encoder, "sample_rate": sample_rate,
            "delay_samples": delay, "padding_samples": padding,
            "delay_ms": round(delay * scale, 3), "padding_ms": round(padding * scale, 3)}


def audio_file_report(path: str | os.PathLike[str]) -> dict:
    """Bitrate, sample rate, length, clipping and lead-in of one audio file
    (Phase 21, Audio file check).

    Header facts come from libsndfile: rate, channels, duration. Bitrate is
    exact for PCM (rate × bits × channels) and a file-size average otherwise,
    labeled which. Peak, clipped share (samples at full scale) and leading
    near-silence (first 100 ms window peaking past -60 dBFS) are measured on
    the raw decode — never the peak-normalized analysis buffer, which would
    hide every one of them. Findings carry the tool's own bars, stated in the
    constants above: ranking numbers were not verifiable offline and are not
    encoded here. Read only, plain JSON types.
    """
    file = Path(path)
    if not file.is_file():
        raise ValueError(f"{file} is not a file.")
    try:
        info = sf.info(str(file))
    except Exception as exc:
        raise ValueError(f"Could not read {file.name}: {exc}") from exc
    if info.samplerate <= 0 or info.frames <= 0:
        raise ValueError(f"{file.name} has no audio in it.")
    duration_s = info.frames / info.samplerate
    subtype = str(info.subtype or "").upper()
    bits = {"PCM_16": 16, "PCM_24": 24, "PCM_32": 32,
            "FLOAT": 32, "DOUBLE": 64}.get(subtype)
    if bits is not None:
        bitrate_kbps = int(round(info.samplerate * bits * info.channels / 1000.0))
        bitrate_how = "header"
    else:
        size = file.stat().st_size
        bitrate_kbps = int(round(size * 8.0 / duration_s / 1000.0)) if duration_s > 0 else 0
        bitrate_how = "average"
    try:
        raw, _rate = sf.read(str(file), dtype="float32", always_2d=False)
    except Exception as exc:
        raise ValueError(f"Could not decode {file.name}: {exc}") from exc
    mono = np.abs(np.asarray(raw, dtype=np.float64))
    mono = mono.max(axis=1) if mono.ndim == 2 else mono
    peak = float(mono.max(initial=0.0))
    peak_db = round(20.0 * np.log10(peak), 1) if peak > 0 else None
    clipped_share = round(float(np.mean(mono >= 0.999)) if mono.size else 0.0, 6)
    window = max(1, int(info.samplerate // 10))
    lead_ms = round(duration_s * 1000.0, 1)
    for start in range(0, mono.size, window):
        if float(mono[start:start + window].max(initial=0.0)) > 0.001:
            lead_ms = round(start / info.samplerate * 1000.0, 1)
            break
    findings = []
    if clipped_share > params.AUDIO_CLIP_SHARE:
        findings.append({"key": "clipping", "level": "warn",
                         "share_pct": round(clipped_share * 100.0, 2)})
    if lead_ms > params.AUDIO_LEAD_WARN_MS:
        findings.append({"key": "long_lead", "level": "warn", "lead_ms": lead_ms})
    if info.samplerate < params.AUDIO_RATE_FLOOR:
        findings.append({"key": "low_rate", "level": "info",
                         "sample_rate": int(info.samplerate)})
    return {"file": file.name, "format": str(info.format or ""), "subtype": subtype,
            "sample_rate": int(info.samplerate), "channels": int(info.channels),
            "duration_s": round(duration_s, 3), "bitrate_kbps": bitrate_kbps,
            "bitrate_how": bitrate_how, "peak_db": peak_db,
            "clipped_share": clipped_share, "lead_ms": lead_ms, "findings": findings}
