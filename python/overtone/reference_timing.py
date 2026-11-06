"""The mapset check and reference timing."""
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

from . import data_model, editing, map_objects, osu_read, osu_write, params, pipeline, precision_grid


# ---------------------------------------------------------------------------
# Mapset check (proposal P1): what every difficulty of one set must share
# ---------------------------------------------------------------------------


def _mapset_difficulty_name(path: Path, beatmap: dict | None) -> str:
    """The difficulty name: ``Version`` when the map has one, else the file's."""
    version = str(((beatmap or {}).get("metadata") or {}).get("Version", "")).strip()
    if version:
        return version
    bracket = re.search(r"\[([^\]]+)\]\s*$", path.stem)
    return bracket.group(1) if bracket else path.stem


def _mapset_timing_lines(beatmap: dict) -> list[dict]:
    """Every timing line with usable numbers, red or green, in file order.

    The parsed ``timing`` view keeps reds as ``(offset, bpm)`` only; this
    check needs the beat length as written, the meter and the kiai bit, so it
    reads the raw section. Lines without numbers are skipped, never fatal.
    """
    section = next((s for s in beatmap.get("sections", [])
                    if s.get("name") == "TimingPoints"), None)
    lines: list[dict] = []
    for raw in (section or {}).get("lines", []):
        text = str(raw).strip()
        if not text or text.startswith("//"):
            continue
        fields = text.split(",")
        try:
            time_ms = float(fields[0])
            beat_length = float(fields[1])
        except (ValueError, IndexError):
            continue
        if not (np.isfinite(time_ms) and np.isfinite(beat_length)):
            continue
        meter: int | str = 4
        if len(fields) > 2 and fields[2].strip():
            try:
                meter = int(fields[2])
            except ValueError:
                meter = fields[2].strip()  # compared as written, not guessed
        try:
            effects = int(fields[7]) if len(fields) > 7 and fields[7].strip() else 0
        except ValueError:
            effects = 0
        lines.append({"time": time_ms, "beat_length": beat_length, "meter": meter,
                      "red": osu_write._is_red_line(text) and beat_length > 0,
                      "kiai": bool(effects & 1)})
    return lines


def _mapset_kiai_spans(lines: list[dict]) -> list[dict]:
    """Kiai on/off spans; ``end_ms`` None means kiai runs to the end of the map."""
    spans: list[dict] = []
    active, start = False, 0.0
    for line in sorted(lines, key=lambda item: item["time"]):  # stable: file order at ties
        if line["kiai"] == active:
            continue
        if line["kiai"]:
            start = line["time"]
        elif line["time"] > start:
            spans.append({"start_ms": start, "end_ms": line["time"]})
        active = line["kiai"]
    if active:
        spans.append({"start_ms": start, "end_ms": None})
    return spans


def _mapset_red_differences(reference: list[dict], other: list[dict]) -> list[dict]:
    """How ``other``'s red lines differ from ``reference``'s, one entry each.

    Lines pair on an identical offset first; a leftover within half a
    reference beat of a leftover is the same line moved (``offset``). Paired
    lines then compare beat length (within ``MAPSET_BEAT_TOLERANCE_MS``) and
    meter. Whatever stays unpaired is ``missing`` from, or ``extra`` in,
    ``other``. Sorted by offset.
    """
    ref_left, other_left = list(reference), list(other)
    pairs: list[tuple[dict, dict]] = []
    diffs: list[dict] = []
    for red in reference:
        match = next((o for o in other_left if o["time"] == red["time"]), None)
        if match is not None:
            other_left.remove(match)
            ref_left.remove(red)
            pairs.append((red, match))
    for red in sorted(ref_left, key=lambda item: item["time"]):
        near = min(other_left, key=lambda o: abs(o["time"] - red["time"]), default=None)
        if near is None or abs(near["time"] - red["time"]) > 0.5 * red["beat_length"]:
            continue
        other_left.remove(near)
        ref_left.remove(red)
        pairs.append((red, near))
        diffs.append({"offset_ms": red["time"], "kind": "offset",
                      "expected": red["time"], "found": near["time"]})
    for red, found in pairs:
        if abs(red["beat_length"] - found["beat_length"]) > params.MAPSET_BEAT_TOLERANCE_MS:
            diffs.append({"offset_ms": red["time"], "kind": "beat_length",
                          "expected": red["beat_length"], "found": found["beat_length"]})
        if red["meter"] != found["meter"]:
            diffs.append({"offset_ms": red["time"], "kind": "meter",
                          "expected": red["meter"], "found": found["meter"]})
    diffs += [{"offset_ms": red["time"], "kind": "missing", "expected": red["time"],
               "found": None} for red in ref_left]
    diffs += [{"offset_ms": extra["time"], "kind": "extra", "expected": None,
               "found": extra["time"]} for extra in other_left]
    return sorted(diffs, key=lambda d: d["offset_ms"])


def _mapset_field_key(field_name: str, value: str | None):
    """What two values of one field must share to count as the same setting."""
    if field_name in params._MAPSET_GENERAL_DEFAULTS:
        if value is None or not value.strip():
            return params._MAPSET_GENERAL_DEFAULTS[field_name]
        try:
            number = float(value)
        except ValueError:
            return value
        return number if np.isfinite(number) else value
    if field_name == "Tags" and value is not None:
        return frozenset(value.split())  # order and spacing carry no meaning
    return value


def mapset_report(folder: str | os.PathLike[str]) -> dict:
    """Every difficulty of one beatmap folder, checked for what must match.

    Read only: differences are listed, never fixed. Compared across
    difficulties: red lines (offset exactly as written, beat length within
    ``MAPSET_BEAT_TOLERANCE_MS``, meter), ``AudioFilename``/``PreviewTime``/
    ``AudioLeadIn`` (osu!'s defaults stand in for a missing number) and the
    metadata in ``MAPSET_METADATA_FIELDS`` (tags as a set of words). Reported
    per difficulty for information: kiai spans, and object density from
    ``density_report`` -- objects per second, not a star rating.

    Red lines are compared against one reference difficulty: the one the
    most others match exactly (first in file order on a tie), so a single
    odd difficulty is the one that shows up, not everything compared to it.
    Fields use the value most difficulties share. A file that cannot be read
    is reported with the reason and left out of the comparison; it never
    stops the rest. Raises ``ValueError`` only when ``folder`` is not a
    folder. Plain JSON types throughout.
    """
    scan = osu_read.scan_beatmap_folder(folder)
    difficulties: list[dict] = []
    parsed: list[tuple[dict, dict, list[dict]]] = []
    for name in scan["beatmaps"]:
        path = Path(name)
        entry: dict = {"file": path.name}
        try:
            beatmap = osu_read.read_osu_beatmap(path)
            lines = _mapset_timing_lines(beatmap)
            density = map_objects.density_report(beatmap)
        except (ValueError, OSError, TypeError, KeyError) as exc:
            entry.update({"difficulty": _mapset_difficulty_name(path, None),
                          "readable": False, "detail": str(exc)})
            difficulties.append(entry)
            continue
        reds = [line for line in lines if line["red"]]
        entry.update({
            "difficulty": _mapset_difficulty_name(path, beatmap), "readable": True,
            "reference": False, "red_lines": len(reds),
            "kiai": _mapset_kiai_spans(lines),
            "density": {"objects": density["objects"],
                        "mean_per_second": density["mean_per_second"],
                        "peak_per_second": density["peak_per_second"]},
            "checks": {"red_lines": 0, "audio": [], "metadata": []},
        })
        difficulties.append(entry)
        parsed.append((entry, beatmap, reds))

    reference = None
    red_differences: list[dict] = []
    if parsed:
        def agreeing(candidate: list[dict]) -> int:
            return sum(1 for _e, _b, reds in parsed
                       if not _mapset_red_differences(candidate, reds))
        ref_index = max(range(len(parsed)), key=lambda n: (agreeing(parsed[n][2]), -n))
        ref_entry, _ref_map, ref_reds = parsed[ref_index]
        reference = ref_entry["file"]
        ref_entry["reference"] = True
        for entry, _beatmap, reds in parsed:
            if entry is ref_entry:
                continue
            found = _mapset_red_differences(ref_reds, reds)
            entry["checks"]["red_lines"] = len(found)
            red_differences += [{"file": entry["file"], "difficulty": entry["difficulty"],
                                 **diff} for diff in found]
        # The reference's value breaks ties, so it goes first.
        parsed = [parsed[ref_index]] + parsed[:ref_index] + parsed[ref_index + 1:]

    fields: list[dict] = []
    for section, names, check in (("General", params.MAPSET_AUDIO_FIELDS, "audio"),
                                  ("Metadata", params.MAPSET_METADATA_FIELDS, "metadata")):
        for field_name in names:
            values = [(entry, (beatmap.get(section.lower()) or {}).get(field_name))
                      for entry, beatmap, _reds in parsed]
            keys = [_mapset_field_key(field_name, value) for _entry, value in values]
            common = max(dict.fromkeys(keys), key=keys.count) if keys else None
            shown = next((value for (_entry, value), key in zip(values, keys)
                          if key == common), None)
            odd = []
            for (entry, value), key in zip(values, keys):
                if key != common:
                    entry["checks"][check].append(field_name)
                    odd.append({"file": entry["file"], "difficulty": entry["difficulty"],
                                "value": value})
            fields.append({"section": section, "field": field_name,
                           "identical": not odd, "value": shown, "differences": odd})

    unreadable = sum(1 for entry in difficulties if not entry["readable"])
    field_differences = sum(len(f["differences"]) for f in fields)
    return {"folder": scan["folder"], "reference": reference,
            "difficulties": difficulties, "red_lines": red_differences,
            "fields": fields, "unreadable": unreadable,
            "differences": len(red_differences) + field_differences,
            "consistent": not red_differences and not field_differences and not unreadable}


# ---------------------------------------------------------------------------
# Reference timing (proposal P1): any map's red lines, graded by the attacks
# ---------------------------------------------------------------------------


def _red_line_meter(line: str) -> int:
    """The meter field of one red line; 4 when it is missing or unreadable."""
    fields = line.strip().split(",")
    try:
        meter = int(fields[2])
    except (ValueError, IndexError):
        return 4
    return meter if 0 < meter <= params.MAX_METER else 4


def _beatmap_red_rows(beatmap: dict) -> list[tuple[float, float, int]]:
    """Every red line as ``(offset_ms, bpm, meter)``, sorted by offset."""
    lines = next((s.get("lines", []) for s in beatmap.get("sections", [])
                  if s.get("name") == "TimingPoints"), None)
    if lines is None:
        # A beatmap built by hand (tests, callers) may carry only the view.
        return sorted((float(o), float(b), 4) for o, b in beatmap.get("timing", {}).get("reds", []))
    rows = []
    for line in lines:
        red = osu_read._parse_red_line(line)
        if red is not None:
            rows.append((red[0], red[1], _red_line_meter(line)))
    return sorted(rows)


def _forward_fit(times: np.ndarray, weights: np.ndarray, period: float,
                 phase: float, start: float, stop: float, lock: float) -> tuple[float, float]:
    """Lock the phase on the span's first window, then refit on windows that
    double forward from the start, so beat indices never slip."""
    lo, hi = (period * r for r in params.REFERENCE_PERIOD_BAND)
    span = lock
    first = (times >= start) & (times <= start + span)
    phase = precision_grid._recentre_phase(times[first], weights[first], period, phase)
    while True:
        window = (times >= start) & (times <= min(stop, start + span))
        if int(window.sum()) >= 8:
            fitted, moved, _ = precision_grid._refine_grid(times[window], weights[window], period, phase)
            if not lo <= fitted <= hi:
                return period, phase
            period, phase = fitted, moved
        if start + span >= stop:
            return period, phase
        span *= 2.0


def _grade_span(times: np.ndarray, weights: np.ndarray, offset_s: float,
                beat_s: float, end_s: float) -> dict:
    """Fit one red line's span at each divisor and keep the coarsest that
    explains the attacks; errors are measured against the map's own grid."""
    fits = []
    for divisor in params.REFERENCE_DIVISORS:
        atom = beat_s / divisor
        period, phase = _forward_fit(times, weights, atom, offset_s, offset_s, end_s,
                                     params.REFERENCE_LOCK_BEATS * beat_s)
        share, _coverage, rms = precision_grid._grid_quality(times, weights, period, phase)
        fits.append((divisor, atom, period, phase, share, rms))
    top = max(fit[4] for fit in fits)
    divisor, atom, period, phase, share, rms = next(
        fit for fit in fits if fit[4] >= params.REFERENCE_DIVISOR_SLACK * top)
    # The fitted tick nearest the red line, as an error in the map's frame:
    # E(k) = E0 + k * (period - atom) along the span.
    tick = phase + np.round((offset_s - phase) / period) * period
    atoms = (end_s - offset_s) / atom
    # Standard errors of a straight line through the inliers, sampled at the
    # red line and across the span: few attacks, or loose ones, cannot
    # vouch for a 5 ms error, and saying so is the point.
    k = np.round((times - phase) / period)
    inlier = np.abs(times - (phase + k * period)) <= max(0.12 * period, 0.006)
    x = times[inlier] - offset_s
    n = int(x.size)
    sxx = float(np.sum((x - x.mean()) ** 2)) if n else 0.0
    # Infinity is not JSON: an error with no spread to measure reads as null.
    offset_se = drift_se = None
    if n >= 3 and sxx > 0:
        sigma = rms / 1000.0
        offset_se = float(sigma * np.sqrt(1.0 / n + x.mean() ** 2 / sxx)) * 1000.0
        drift_se = float(sigma * (end_s - offset_s) / np.sqrt(sxx)) * 1000.0
    return {"divisor": divisor, "share": share, "residual_ms": rms, "inliers": n,
            "offset_error_ms": float(tick - offset_s) * 1000.0,
            "drift_ms": atoms * (period - atom) * 1000.0,
            "offset_se_ms": offset_se, "drift_se_ms": drift_se,
            "fitted_bpm": 60.0 / (period * divisor)}


def grade_reference_timing(beatmap: dict, attack_times: np.ndarray,
                           attack_weights: np.ndarray,
                           duration_s: float | None = None) -> dict:
    """Grade each red line of any .osu against the audio's attacks (P19).

    Every red line governs its span, up to the next red line (the last one up
    to its last attack). The attacks in a span are fitted with the engine's
    own tools, started from the map's grid: the phase goes to the densest
    cluster of attacks (``_recentre_phase``), then least squares
    (``_refine_grid``) follows the tempo the attacks keep, on windows that
    double forward from the red line. That is read at 1/1, 1/2, 1/3 and 1/4
    of the map's beat, and the coarsest subdivision that explains nearly as
    much weight as the best is kept.

    Per line: ``share`` of attack weight on the fitted grid, ``residual_ms``
    around it, ``offset_error_ms`` (positive: the attacks sit after the line,
    measured modulo one subdivision), ``drift_ms`` (how far the map's grid has
    walked from the attacks by the span's end) and ``fitted_bpm``. The map's
    common shift is the median offset, weighted by attacks; it is reported
    once (``ref_shift``) rather than on every line. A line whose offset leaves
    it (``relative_ms``), or whose drift grows, by more than 5 ms and more than
    two of its own standard errors is ``check``, with ``issues`` saying which. Lines with too few attacks, or a grid that
    explains too little, are ``too_few`` or ``weak`` instead of guessed.
    Nothing is changed and everything is plain JSON types.
    """
    rows = _beatmap_red_rows(beatmap)
    times = np.asarray(attack_times, dtype=np.float64)
    weights = np.asarray(attack_weights, dtype=np.float64)
    if not rows:
        return {"ok": False, "reason": "no_red_lines"}
    if times.size == 0:
        return {"ok": False, "reason": "no_attacks"}
    order = np.argsort(times)
    times, weights = times[order], weights[order]

    lines: list[dict] = []
    for n, (offset_ms, bpm, meter) in enumerate(rows):
        start_s = offset_ms / 1000.0
        beat_s = 60.0 / bpm
        # An attack up to half the finest subdivision early still belongs to
        # the line it opens, not to the one before.
        slack = 0.5 * beat_s / max(params.REFERENCE_DIVISORS)
        last = n + 1 == len(rows)
        lo = start_s - slack
        hi = np.inf if last else rows[n + 1][0] / 1000.0 - slack
        inside = (times >= lo) & (times < hi)
        span_t, span_w = times[inside], weights[inside]
        end_s = rows[n + 1][0] / 1000.0 if not last else (
            float(span_t[-1]) if span_t.size else start_s)
        if duration_s is not None and last:
            end_s = min(end_s, float(duration_s))
        line = {"index": n, "offset_ms": offset_ms, "bpm": bpm, "meter": meter,
                "end_ms": end_s * 1000.0, "attacks": int(span_t.size),
                "verdict": "too_few", "issues": []}
        if span_t.size >= params.REFERENCE_MIN_ATTACKS and end_s > start_s:
            line.update(_grade_span(span_t, span_w, start_s, beat_s, end_s))
            line["verdict"] = "weak" if line["share"] < params.REFERENCE_MIN_SHARE else "ok"
        lines.append(line)

    # Offsets are judged against the map's own common shift, not against
    # zero: on real songs every line of a ranked map reads 12-46 ms before
    # the attacks, MP3 and OGG alike, and that is not explained yet (roadmap,
    # Phase 22). The shift is reported once; a line that leaves it is flagged.
    graded = [line for line in lines if line["verdict"] == "ok"]
    common = (pipeline._weighted_median(np.array([line["offset_error_ms"] for line in graded]),
                               np.array([float(line["attacks"]) for line in graded]))
              if graded else None)

    def beyond(error: float, se: float | None) -> bool:
        # Past 5 ms and past twice its own standard error: a real error, not
        # the spread of a few loose attacks. No spread measured, no verdict.
        return se is not None and abs(error) > max(params.REFERENCE_TOLERANCE_MS,
                                                   params.REFERENCE_SIGMAS * se)

    for line in graded:
        line["relative_ms"] = line["offset_error_ms"] - common
        if beyond(line["relative_ms"], line["offset_se_ms"]):
            line["issues"].append("offset")
        if beyond(line["drift_ms"], line["drift_se_ms"]):
            line["issues"].append("drift")
        if line["issues"]:
            line["verdict"] = "check"
    findings: list[dict] = []
    if common is not None and abs(common) > params.REFERENCE_TOLERANCE_MS:
        findings.append({"level": "info", "key": "ref_shift", "index": -1,
                         "values": {"ms": f"{common:+.1f}"}})
    # Two lines 10 ms apart have no majority: the median takes one side and
    # flags the other, which may be the right one. Say that no side won.
    # Lines vote, not attacks: each is one decision of the mapper's.
    agree = sum(1 for line in graded if "offset" not in line["issues"])
    if len(graded) > 1 and 2 * agree <= len(graded):
        findings.append({"level": "warn", "key": "ref_split", "index": -1,
                         "values": {"n": len(graded)}})
    first_s, first_beat = rows[0][0] / 1000.0, 60.0 / rows[0][1]
    early = int(np.sum(times < first_s - 0.5 * first_beat / max(params.REFERENCE_DIVISORS)))
    if early:
        findings.append({"level": "info", "key": "ref_before", "index": -1,
                         "values": {"n": early}})
    counts = {verdict: sum(1 for line in lines if line["verdict"] == verdict)
              for verdict in ("ok", "check", "weak", "too_few")}
    return {"ok": True, "lines": lines, "common_offset_ms": common,
            "counts": counts, "findings": findings}


def reference_points(beatmap: dict, beats: np.ndarray | None = None) -> list[TimingPoint]:
    """A map's red lines as the working timing: the mapper vouches for them.

    Each becomes a hand-placed point (confidence 1.0, ``manual`` so export
    snapping never moves it) carrying the line's own meter as a known bar.
    Raises ``ValueError`` when the map has no red lines to load.
    """
    rows = _beatmap_red_rows(beatmap)
    if not rows:
        raise ValueError("This map has no red lines to load.")
    beats = np.zeros(0) if beats is None else np.asarray(beats, dtype=np.float64)
    return [data_model.TimingPoint(offset, bpm, 1.0, editing._nearest_beat_index(beats, offset),
                        meter, True, manual=True) for offset, bpm, meter in rows]


def _file_digest(path: Path) -> str:
    import hashlib
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def same_audio(osu_path: str | os.PathLike[str], beatmap: dict,
               audio_path: str | os.PathLike[str]) -> bool | None:
    """Whether a map's AudioFilename holds the same bytes as ``audio_path``.

    None when either file is missing: a name alone proves nothing, since two
    encodes of one song share names and offsets do not transfer between them.
    """
    named = str((beatmap.get("general") or {}).get("AudioFilename", "")).strip()
    mine, theirs = Path(audio_path), Path(osu_path).parent / named
    if not named or not mine.is_file() or not theirs.is_file():
        return None
    try:
        if mine.stat().st_size != theirs.stat().st_size:
            return False
        return _file_digest(mine) == _file_digest(theirs)
    except OSError:
        return None


def find_same_audio_maps(audio_path: str | os.PathLike[str],
                         root: str | os.PathLike[str]) -> dict:
    """Every beatmap under ``root`` whose audio is byte for byte this file.

    Walks ``root`` and one level of folders below it, the shape of an osu!
    Songs folder. Only audio files of the same size are hashed, so a whole
    Songs folder costs a directory listing plus a hash or two. Each match
    lists the .osu files in its folder that name that audio. Plain types.
    """
    audio = Path(audio_path)
    base = Path(root)
    if not audio.is_file():
        raise ValueError(f"{audio} is not a file.")
    if not base.is_dir():
        raise ValueError(f"{base} is not a folder.")
    size = audio.stat().st_size
    want: str | None = None
    # os.scandir, not Path.iterdir: on Windows each entry carries its size, so
    # a 4,800-set Songs folder (59,000 audio files with the hitsound samples)
    # costs a listing, not a stat per file. iterdir took 9-21 s on one.
    try:
        with os.scandir(base) as entries:
            folders = [base] + sorted(Path(e.path) for e in entries if e.is_dir())
    except OSError as exc:
        raise ValueError(f"Could not list {base}: {exc}") from exc
    scanned = same_size = 0
    matches: list[dict] = []
    for folder in folders:
        try:
            with os.scandir(folder) as entries:
                files = sorted((e for e in entries if e.is_file()), key=lambda e: e.name)
        except OSError:
            continue
        for entry in files:
            if os.path.splitext(entry.name)[1].lower() not in params.AUDIO_EXTENSIONS:
                continue
            scanned += 1
            try:
                if entry.stat().st_size != size:
                    continue
                same_size += 1
                want = want or _file_digest(audio)
                if _file_digest(Path(entry.path)) != want:
                    continue
            except OSError:
                continue
            candidate = Path(entry.path)
            beatmaps = []
            for osu in (Path(e.path) for e in files if e.name.lower().endswith(".osu")):
                try:
                    beatmap = osu_read.read_osu_beatmap(osu)
                except (ValueError, OSError):
                    continue
                named = str(beatmap["general"].get("AudioFilename", "")).strip()
                if named.lower() == candidate.name.lower():
                    beatmaps.append({"path": str(osu),
                                     "difficulty": _mapset_difficulty_name(osu, beatmap)})
            matches.append({"folder": str(folder), "audio": str(candidate),
                            "beatmaps": beatmaps})
    return {"root": str(base), "scanned": scanned, "same_size": same_size,
            "matches": matches}
