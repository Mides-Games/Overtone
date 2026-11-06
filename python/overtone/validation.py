"""Validation findings and the mod report."""
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

from . import exports, map_objects, octave_choice, params, reference_timing


# ---------------------------------------------------------------------------
# Validation findings (Phase 7, first row)
# ---------------------------------------------------------------------------


def validate_timing_points(analysis: Analysis) -> list[dict]:
    """Findings a mapper should review by ear before trusting the red lines.

    Pure Phase 7, first row: duplicate points, very short sections, impossible
    changes, suspicious offsets, octave mistakes. Operates on the *snapped*
    points — what the exporters write — so a finding names the line the mapper
    actually sees. Each finding is ``{"level", "key", "index", "values"}`` with
    plain JSON types; ``index`` is the governing point, -1 for song-level.
    Levels: ``error`` (the map is wrong), ``warn`` (check it), ``info`` (a
    judgement call, stated as one). An empty map has no findings, and findings
    never raise: validation must not break on the input it is checking.
    """
    try:
        points = exports.snap_timing_points(list(getattr(analysis, "points", None) or []))
    except Exception:
        return []
    if not points:
        return []
    try:
        duration = float(getattr(analysis, "duration", 0.0) or 0.0)
        beats = np.asarray(getattr(analysis, "beats", []), dtype=np.float64)
        first_beat = float(beats[0]) if beats.size else 0.0
    except (TypeError, ValueError):
        duration, first_beat = 0.0, 0.0

    findings: list[dict] = []

    def err(key: str, index: int, values: dict | None = None) -> None:
        findings.append({"level": "error", "key": key, "index": index,
                         "values": values or {}})

    def warn(key: str, index: int, values: dict | None = None) -> None:
        findings.append({"level": "warn", "key": key, "index": index,
                         "values": values or {}})

    def info(key: str, index: int, values: dict | None = None) -> None:
        findings.append({"level": "info", "key": key, "index": index,
                         "values": values or {}})

    for n, point in enumerate(points):
        offset = getattr(point, "offset_ms", float("nan"))
        bpm = getattr(point, "bpm", float("nan"))
        try:
            bad = not (np.isfinite(offset) and np.isfinite(bpm))
        except TypeError:
            bad = True
        if bad or bpm <= 0:
            err("bad_number", n)
            continue
        if offset < 0:
            err("negative_offset", n, {"ms": f"{offset:.1f}"})
        elif duration > 0 and offset / 1000.0 > duration + 0.001:
            warn("past_end", n, {"ms": f"{offset:.1f}"})
        if n == 0 and first_beat > 0 and offset / 1000.0 - first_beat > params.LATE_FIRST_LINE_S:
            warn("late_first", n, {"line": f"{offset / 1000.0:.1f}",
                                   "beat": f"{first_beat:.1f}"})

    for n in range(1, len(points)):
        prev, point = points[n - 1], points[n]
        if prev.bpm <= 0 or not np.isfinite(prev.bpm) or not np.isfinite(point.bpm):
            continue
        gap_ms = point.offset_ms - prev.offset_ms
        beat_ms = 60000.0 / prev.bpm
        if gap_ms < params.DUPLICATE_BEATS * beat_ms:
            err("dup_points", n, {"gap": f"{gap_ms:.1f}"})
            continue
        if gap_ms < params.MIN_BEATS_PER_SECTION * beat_ms:
            warn("short_section", n - 1, {"beats": f"{gap_ms / beat_ms:.1f}"})
        ratio = point.bpm / prev.bpm
        if ratio >= params.IMPOSSIBLE_RATIO or ratio <= 1.0 / params.IMPOSSIBLE_RATIO:
            err("impossible_change", n,
                {"from": f"{prev.bpm:.2f}", "to": f"{point.bpm:.2f}"})
        elif min(abs(float(np.log2(ratio)) - 1.0),
                 abs(float(np.log2(ratio)) + 1.0)) <= params.OCTAVE_BAND_LOG:
            info("octave_check", n,
                 {"from": f"{prev.bpm:.2f}", "to": f"{point.bpm:.2f}"})

    # The last section runs to the end of the song: it can be short too.
    last = points[-1]
    if last.bpm > 0 and np.isfinite(last.bpm) and duration > 0:
        tail_beats = (duration - last.offset_ms / 1000.0) / (60.0 / last.bpm)
        if 0 <= tail_beats < params.MIN_BEATS_PER_SECTION:
            warn("short_section", len(points) - 1, {"beats": f"{tail_beats:.1f}"})
    return findings


def _finding_text(finding: dict) -> str:
    """One human line per validation finding (CLI --stats, GUI details)."""
    key, values = finding["key"], finding["values"]
    if key == "dup_points":
        return f"two red lines {values['gap']} ms apart — one is a duplicate"
    if key == "short_section":
        return f"section lasts {values['beats']} beats, less than a bar"
    if key == "impossible_change":
        return f"tempo {values['from']} → {values['to']} BPM is a detection error, not music"
    if key == "octave_check":
        return f"tempo {values['from']} → {values['to']} BPM: half-time or an octave mistake?"
    if key == "negative_offset":
        return f"offset {values['ms']} ms is before the audio starts"
    if key == "bad_number":
        return "no usable number — re-analyze or delete"
    if key == "late_first":
        return f"first red line at {values['line']} s, music starts at {values['beat']} s"
    if key == "past_end":
        return f"offset {values['ms']} ms is past the end of the audio"
    return f"{key} {values}"


# ---------------------------------------------------------------------------
# Mod report (proposal P2): every finding as an osu! editor timestamp
# ---------------------------------------------------------------------------


def mod_timestamp(time_ms: float, combo: list[int] | None = None) -> str:
    """``mm:ss:mmm (1,2)`` as modders write it; times before 0 clamp to 0."""
    whole = int(round(max(0.0, float(time_ms))))
    minutes, rest = divmod(whole, 60000)
    seconds, millis = divmod(rest, 1000)
    stamp = f"{minutes:02d}:{seconds:02d}:{millis:03d}"
    return f"{stamp} ({','.join(str(n) for n in combo)})" if combo else stamp


def mod_editor_link(stamp: str) -> str:
    """The ``osu://edit/`` link that opens the local editor at a timestamp.

    Only a well-formed timestamp becomes a link: it is handed to the shell.
    """
    if not params.MOD_STAMP.match(stamp or ""):
        raise ValueError(f"Not an osu! editor timestamp: {stamp!r}")
    return "osu://edit/" + stamp.replace(" ", "%20")


def _combo_numbers(objects: list[dict]) -> dict[float, int]:
    """Each object's number inside its combo, keyed by time, as the editor
    counts them: a new-combo object is 1, the next ones count up."""
    numbers: dict[float, int] = {}
    count = 0
    for obj in sorted((o for o in objects if "time" in o), key=lambda o: o["time"]):
        count = 1 if (obj.get("new_combo") or count == 0) else count + 1
        numbers.setdefault(float(obj["time"]), count)
    return numbers


def _mod_text(item: dict) -> str:
    """The English line a modder would post for one finding."""
    key, v = item["key"], item["values"]
    if key == "ref_offset":
        return (f"red line sits {v['ms']} ms from the rest of the map's offset "
                f"(±{v['se']} ms): check it by ear")
    if key == "ref_drift":
        return (f"by here the red line's grid is {v['ms']} ms off the music (±{v['se']} ms), "
                f"the attacks fit {v['bpm']} BPM")
    if key == "ref_weak":
        return f"the music does not follow this red line's grid ({v['share']}% of the attacks on it)"
    if key == "missing_line":
        return f"the tempo changes here to {v['bpm']} BPM and the map has no red line for it"
    if key == "unsnapped":
        return f"unsnapped: {v['ms']} ms off the nearest 1/{v['divisor']} tick"
    if key == "before_red":
        return "object before the first red line"
    if key == "past_audio":
        return "object after the audio ends"
    if key == "ref_split":
        return (f"the {v['n']} red lines do not agree on one offset and no majority says "
                "which are right: check them by ear")
    if key == "ref_shift":
        return (f"every red line sits {v['ms']} ms from the attacks; Overtone reads real songs "
                "about +26 ms here and why is not known, so check the offset by ear first")
    if key == "off_attack":
        # What is measured: quiet passages may hold sounds too soft to detect.
        return f"{v['ms']} ms from the nearest attack Overtone detects"
    return f"{key} {v}"


def mod_report(beatmap: dict, attack_times: np.ndarray, attack_weights: np.ndarray,
               duration_s: float | None = None, analysis: Analysis | None = None) -> dict:
    """Every finding about one difficulty, as the lines a modder would post.

    Gathers what the other checks already measure and nothing new:
    ``grade_reference_timing`` (red lines to check, with their error),
    ``suggest_missing_lines`` (tempo changes the map has no red line for;
    needs an analysis), ``snap_audit`` (objects off the map's own grid, before
    its first red line or past the audio) and ``alignment_report`` (objects
    away from any attack). Each item carries its time, an editor timestamp
    with the combo numbers of the objects it names, the number behind it, a
    level and the English line; ``text`` is the whole report, ready to paste.
    Plain JSON types. Nothing is changed.
    """
    objects = [o for o in beatmap.get("hitobjects", []) if "time" in o]
    combos = _combo_numbers(objects)
    items: list[dict] = []

    def add(source: str, level: str, key: str, time_ms: float | None, values: dict,
            on_object: bool = False) -> None:
        # No time: a finding about the whole map, posted under "General".
        if time_ms is None:
            items.append({"source": source, "level": level, "key": key, "time_ms": None,
                          "stamp": "General", "values": values})
            return
        combo = [combos[float(time_ms)]] if on_object and float(time_ms) in combos else None
        items.append({"source": source, "level": level, "key": key, "time_ms": float(time_ms),
                      "stamp": mod_timestamp(time_ms, combo), "values": values})

    times = np.asarray(attack_times, dtype=np.float64)
    weights = np.asarray(attack_weights, dtype=np.float64)
    graded = reference_timing.grade_reference_timing(beatmap, times, weights, duration_s)
    for finding in graded.get("findings", []):
        if finding["key"] in ("ref_split", "ref_shift"):
            add("reference", finding["level"], finding["key"], None, finding["values"])
    for line in graded.get("lines", []):
        if "offset" in line["issues"]:
            add("reference", "warn", "ref_offset", line["offset_ms"],
                {"ms": f"{line['relative_ms']:+.1f}", "se": f"{2 * line['offset_se_ms']:.1f}"})
        if "drift" in line["issues"]:
            add("reference", "warn", "ref_drift", line["end_ms"],
                {"ms": f"{line['drift_ms']:+.1f}", "se": f"{2 * line['drift_se_ms']:.1f}",
                 "bpm": f"{line['fitted_bpm']:.3f}"})
        if line["verdict"] == "weak":
            add("reference", "warn", "ref_weak", line["offset_ms"],
                {"share": f"{100 * line['share']:.0f}"})

    if analysis is not None:
        for suggestion in octave_choice.suggest_missing_lines(analysis, beatmap):
            add("suggestion", "info", "missing_line", suggestion["offset_ms"],
                {"bpm": f"{suggestion['bpm']:.3f}"})

    audit = map_objects.snap_audit(beatmap, duration_s=duration_s)
    if audit.get("ok"):
        for obj in audit["unsnapped"]:
            add("snap", "warn", "unsnapped", obj["time_ms"],
                {"ms": f"{obj['off_ms']:+.1f}", "divisor": obj["nearest_divisor"]}, True)
        for time_ms in audit["before_first_red"]:
            add("snap", "warn", "before_red", time_ms, {}, True)
        for time_ms in audit["past_audio"] or []:
            add("snap", "warn", "past_audio", time_ms, {}, True)

    if times.size:
        from types import SimpleNamespace
        aligned = map_objects.alignment_report(SimpleNamespace(attack_times=times, attack_weights=weights),
                                   beatmap)
        for obj in aligned["offenders"]:
            add("alignment", "info", "off_attack", obj["time"], {"ms": f"{obj['ms']:.1f}"}, True)

    items.sort(key=lambda item: (item["time_ms"] is not None, item["time_ms"] or 0.0,
                                 params.MOD_SOURCES.index(item["source"])))
    for item in items:
        item["text"] = _mod_text(item)
    counts = {source: sum(1 for item in items if item["source"] == source)
              for source in params.MOD_SOURCES}
    return {"items": items, "counts": counts,
            "text": "\n".join(f"{item['stamp']} - {item['text']}" for item in items)}
