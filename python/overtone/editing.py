"""Manual timing-point editing and per-section pulse suggestions."""
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

from . import data_model, exports, params, reference_timing, tempo_helpers


# ---------------------------------------------------------------------------
# Manual timing-point editing (pure helpers — an editor calls these)
# ---------------------------------------------------------------------------

def _nearest_beat_index(beats: np.ndarray, offset_ms: float) -> int:
    if len(beats) == 0:
        return 0
    return int(np.argmin(np.abs(beats * 1000.0 - offset_ms)))


def add_timing_point(points: list[TimingPoint], beats: np.ndarray,
                     offset_ms: float, bpm: float) -> list[TimingPoint]:
    """Insert a hand-placed point, keeping the list sorted by offset.

    Hand-placed points carry confidence 1.0: the mapper — not the detector —
    vouches for them. Raises ``ValueError`` on non-positive BPM.
    """
    if not np.isfinite(offset_ms) or not np.isfinite(bpm) or bpm <= 0:
        raise ValueError("Offset must be finite and BPM positive.")
    merged = list(points) + [data_model.TimingPoint(float(offset_ms), float(bpm), 1.0,
                                         _nearest_beat_index(beats, offset_ms),
                                         manual=True)]
    merged.sort(key=lambda p: p.offset_ms)
    return merged


def update_timing_point(points: list[TimingPoint], beats: np.ndarray, index: int,
                        offset_ms: float, bpm: float) -> list[TimingPoint]:
    """Replace one point's offset/BPM (confidence preserved), re-sorted."""
    if not 0 <= index < len(points):
        raise ValueError("No timing point at that index.")
    if not np.isfinite(offset_ms) or not np.isfinite(bpm) or bpm <= 0:
        raise ValueError("Offset must be finite and BPM positive.")
    old = points[index]
    merged = list(points)
    # Editing a point's offset or BPM does not change its time signature, so
    # the bar it knows travels with it.
    merged[index] = data_model.TimingPoint(float(offset_ms), float(bpm), old.confidence,
                                _nearest_beat_index(beats, offset_ms),
                                old.meter, old.meter_known, manual=True)
    merged.sort(key=lambda p: p.offset_ms)
    return merged


def delete_timing_point(points: list[TimingPoint], index: int) -> list[TimingPoint]:
    """Remove one point. The first point (section 1) cannot be deleted."""
    if not 0 <= index < len(points):
        raise ValueError("No timing point at that index.")
    if index == 0:
        raise ValueError("The first timing point anchors the map and cannot be deleted.")
    return [p for n, p in enumerate(points) if n != index]


def _shown_offset(points: list[TimingPoint], index: int) -> float:
    """Where the table shows point ``index`` and the .osu writes it: a detected
    line within SNAP_TOLERANCE_MS of the previous grid sits on that grid.

    An edit makes a point hand-placed, and snapping skips those, so an edit
    that starts from the raw offset moves the line by up to that tolerance
    before doing what was asked: a -1 ms nudge on a line shown at 5000.0 but
    detected at 5000.6 showed 4999.6 and still wrote 5000. Edits that keep a
    line where it is, or move it by a step, start from here instead.
    """
    return exports.snap_timing_points(points)[index].offset_ms


def nudge_timing_point(points: list[TimingPoint], beats: np.ndarray, index: int,
                       delta_ms: float) -> list[TimingPoint]:
    """Shift one point's offset by ``delta_ms`` from where it is shown
    (``_shown_offset``), beat index refreshed.

    A nudge stops at 0 ms rather than carry a point from the audio into the
    time before it. A point already before 0 ms (an anacrusis, or audio that
    opens on its first beat) moves by exactly ``delta_ms``: clamping it too
    turned a -1 ms nudge on a line at -20 ms into a +20 ms jump.
    """
    if not 0 <= index < len(points):
        raise ValueError("No timing point at that index.")
    old = points[index]
    shown = _shown_offset(points, index)
    offset = shown + delta_ms
    if shown >= 0.0 > offset:
        offset = 0.0
    merged = list(points)
    merged[index] = data_model.TimingPoint(offset, old.bpm, old.confidence,
                                _nearest_beat_index(beats, offset),
                                old.meter, old.meter_known, manual=True)
    merged.sort(key=lambda p: p.offset_ms)
    return merged


def set_meter(points: list[TimingPoint], index: int, meter: int) -> list[TimingPoint]:
    """Change one red line's bar length, in beats, keeping its beat: the BPM
    and the offset where it is shown (``_shown_offset``). The bars from it to
    the next line are counted in the new length, and since the mapper said so
    the meter is known from here on."""
    if not 0 <= index < len(points):
        raise ValueError("No timing point at that index.")
    if isinstance(meter, bool) or int(meter) != meter or int(meter) not in params.EDIT_METERS:
        raise ValueError(f"A bar holds {params.EDIT_METERS.start} to {params.EDIT_METERS.stop - 1} beats.")
    old = points[index]
    merged = list(points)
    merged[index] = data_model.TimingPoint(_shown_offset(points, index), old.bpm, old.confidence,
                                old.beat_index, int(meter), True, manual=True)
    return merged


def rescale_section(points: list[TimingPoint], index: int, factor: float) -> list[TimingPoint]:
    """Multiply one section's BPM (per-section ×2/÷2 fix). The line stays
    where it is shown (``_shown_offset``)."""
    if not 0 <= index < len(points):
        raise ValueError("No timing point at that index.")
    if factor not in (0.5, 2.0):
        raise ValueError("Section factor must be 2 or 1/2.")
    old = points[index]
    bpm = old.bpm * factor
    if not 30 <= bpm <= 600:
        raise ValueError(f"Resulting BPM {bpm:.1f} is outside 30–600.")
    merged = list(points)
    merged[index] = data_model.TimingPoint(_shown_offset(points, index), bpm, old.confidence,
                                old.beat_index, old.meter, old.meter_known, manual=True)
    return merged


def _refit_section(times: np.ndarray, weights: np.ndarray, offset_ms: float, bpm: float,
                   end_ms: float) -> dict:
    """One section's beat refitted to the attacks it spans, its red line held.

    The reference grading's fit (``_grade_span``), started from the section's
    own grid: the BPM follows the attacks, never further than
    ``REFERENCE_PERIOD_BAND`` from where it started. Fewer than
    ``REFERENCE_MIN_ATTACKS`` attacks (``kept: "few"``), or a grid explaining
    less than ``REFERENCE_MIN_SHARE`` of their weight (``kept: "weak"``),
    keeps the BPM as it was and says why, instead of guessing.
    """
    start_s, beat_s, end_s = offset_ms / 1000.0, 60.0 / bpm, end_ms / 1000.0
    # An attack up to half the finest subdivision early belongs to the line it opens.
    slack = 0.5 * beat_s / max(params.REFERENCE_DIVISORS)
    inside = (times >= start_s - slack) & (times < end_s - slack)
    span_t, span_w = times[inside], weights[inside]
    row = {"offset_ms": float(offset_ms), "bpm_before": float(bpm), "bpm": float(bpm),
           "attacks": int(span_t.size), "share": None, "kept": None}
    if span_t.size < params.REFERENCE_MIN_ATTACKS or end_s <= start_s:
        row["kept"] = "few"
        return row
    graded = reference_timing._grade_span(span_t, span_w, start_s, beat_s, end_s)
    row["share"] = float(graded["share"])
    if graded["share"] < params.REFERENCE_MIN_SHARE:
        row["kept"] = "weak"
        return row
    row["bpm"] = float(graded["fitted_bpm"])
    return row


def split_section(points: list[TimingPoint], beats: np.ndarray, index: int, at_ms: float,
                  attack_times, attack_weights, end_ms: float) -> tuple[list[TimingPoint], dict]:
    """Split section ``index`` in two where a tempo changes inside it (editor).

    The new red line goes on the beat of the section's own grid nearest
    ``at_ms``, so the bars before it stay where they were; it must be a beat
    or more after the section's line and before the next. Both halves are
    then refitted to their attacks (``_refit_section``): the section keeps
    its offset, the new line its place, each gets the BPM its attacks keep
    or keeps the old one with the reason. Returns the new points and a
    report of both halves.
    """
    if not 0 <= index < len(points):
        raise ValueError("No timing point at that index.")
    point, start = points[index], _shown_offset(points, index)
    stop = _shown_offset(points, index + 1) if index + 1 < len(points) else float(end_ms)
    beat_ms = 60000.0 / point.bpm
    k = int(round((float(at_ms) - start) / beat_ms))
    split_ms = start + k * beat_ms
    if k < 1 or split_ms > stop - 0.5 * beat_ms:
        raise ValueError("Split inside the section: a beat or more after its red line, "
                         "before the next one.")
    times = np.asarray(attack_times, dtype=np.float64)
    weights = np.asarray(attack_weights, dtype=np.float64)
    first = _refit_section(times, weights, start, point.bpm, split_ms)
    second = _refit_section(times, weights, split_ms, point.bpm, stop)
    merged = list(points)
    merged[index] = data_model.TimingPoint(start, first["bpm"], point.confidence,
                                point.beat_index, point.meter, point.meter_known, manual=True)
    # A split on a beat need not be on a bar: the new line's meter is a guess.
    merged.append(data_model.TimingPoint(split_ms, second["bpm"], 1.0, _nearest_beat_index(beats, split_ms),
                              point.meter, False, manual=True))
    merged.sort(key=lambda p: p.offset_ms)
    return merged, {"split_ms": split_ms, "sections": [first, second]}


def merge_sections(points: list[TimingPoint], beats: np.ndarray, index: int,
                   attack_times, attack_weights, end_ms: float) -> tuple[list[TimingPoint], dict]:
    """Merge section ``index`` with the next one: the next red line goes and
    the whole span is refitted from ``index``'s line (``_refit_section``),
    which keeps its offset. Returns the new points and a report."""
    if not 0 <= index < len(points) - 1:
        raise ValueError("There is no next section to merge with.")
    point, start = points[index], _shown_offset(points, index)
    stop = _shown_offset(points, index + 2) if index + 2 < len(points) else float(end_ms)
    row = _refit_section(np.asarray(attack_times, dtype=np.float64),
                         np.asarray(attack_weights, dtype=np.float64),
                         start, point.bpm, stop)
    merged = [p for n, p in enumerate(points) if n != index + 1]
    merged[index] = data_model.TimingPoint(start, row["bpm"], point.confidence, point.beat_index,
                                point.meter, point.meter_known, manual=True)
    return merged, {"removed_ms": _shown_offset(points, index + 1), "sections": [row]}


# ---------------------------------------------------------------------------
# Per-section pulse suggestions
# ---------------------------------------------------------------------------

def suggest_section_pulse(analysis: Analysis,
                          low_bpm: float = 120.0,
                          min_ratio: float = 0.55) -> list[tuple[int, int, float]]:
    """Flag sections that look like half-time tracker locks.

    Returns [(point_index, suggested_factor, support_ratio)]. Only *suggests*:
    a 112 BPM half-time *feel* section with busy hats is musically correct at
    112, so doubling stays a one-click manual decision (GUI "2× §"), never
    automatic. Sections already in map range are never flagged.
    """
    suggestions: list[tuple[int, int, float]] = []
    if analysis.base_frames is None or len(analysis.onset) < 8:
        return suggestions
    snapped = exports.snap_timing_points(analysis.points)
    frame_rate = analysis.sample_rate / analysis.hop_length
    section_frames = np.rint(np.asarray(analysis.base_frames, dtype=float))
    section_frames = section_frames[(section_frames >= 0) & (section_frames < len(analysis.onset))]
    # The envelope is read where the fallback tracker put each beat, on its
    # peaks, not where the beat was moved to (Analysis.beat_shift_s).
    shift = float(getattr(analysis, "beat_shift_s", 0.0))
    for idx, point in enumerate(snapped):
        if point.bpm >= low_bpm:
            continue
        doubled = point.bpm * 2
        if not 120 <= doubled <= 400:
            continue
        start_s = point.offset_ms / 1000.0
        end_s = snapped[idx + 1].offset_ms / 1000.0 if idx + 1 < len(snapped) else analysis.duration
        mask = (analysis.beats >= start_s) & (analysis.beats < end_s)
        grid = np.rint((analysis.beats[mask] - shift) * frame_rate).astype(int)
        grid = grid[(grid >= 0) & (grid < len(analysis.onset))]
        if len(grid) < 4:
            continue
        base_support = max(tempo_helpers._subdivision_support(analysis.onset, grid, 1), 1e-9)
        ratio = tempo_helpers._subdivision_support(analysis.onset, grid, 2) / base_support
        if ratio >= min_ratio:
            suggestions.append((idx, 2, float(ratio)))
    return suggestions
