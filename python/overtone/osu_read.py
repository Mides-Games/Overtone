""".osu reading: red lines, the full file, and map-vs-detected comparison."""
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

from . import exports, osu_write, params, reference_timing, sounds


# ---------------------------------------------------------------------------
# .osu red-line reading and map-vs-detected comparison (Phase 5)
# ---------------------------------------------------------------------------

def _load_osu_text(osu_path: str | os.PathLike[str]) -> tuple[str, bool]:
    """The whole .osu as text plus whether it carried a BOM.

    Size and encoding guards in one place; the writer needs the BOM flag so an
    untouched file comes back byte-identical.
    """
    path = Path(osu_path)
    if not path.is_file():
        raise ValueError(f"{path} is not a file.")
    size = path.stat().st_size
    if size > params.MAX_OSU_BYTES:
        raise ValueError(f"{path.name} is {size / 1e6:.1f} MB — that is not a beatmap.")
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8-sig"), raw.startswith(b"\xef\xbb\xbf")
    except UnicodeDecodeError as exc:
        raise ValueError(f"Could not decode {path.name} as UTF-8.") from exc


def _osu_lines(text: str, keepends: bool = False) -> list[str]:
    """The lines of .osu text as osu! reads them: broken at \\r\\n, \\r and \\n
    only. ``str.splitlines`` also breaks at \\v, \\f, \\x1c-\\x1e, \\x85,
    \\u2028 and \\u2029, which osu! keeps inside a line: a title holding one
    was two lines here and one in the game, and a writer counting lines one
    way while the reader counted the other could edit the wrong line."""
    lines = params._OSU_LINE.findall(text)
    return lines if keepends else [line.rstrip("\r\n") for line in lines]


def _timing_section_lines(osu_path: str | os.PathLike[str]) -> list[str]:
    """Raw body lines of the .osu [TimingPoints] section."""
    text, _bom = _load_osu_text(osu_path)
    lines = _osu_lines(text)
    header_idx = next((n for n, line in enumerate(lines)
                       if line.strip() == "[TimingPoints]"), None)
    if header_idx is None:
        raise ValueError("No [TimingPoints] section found in this .osu file.")
    end_idx = len(lines)
    for n in range(header_idx + 1, len(lines)):
        stripped = lines[n].strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            end_idx = n
            break
    return [line for line in lines[header_idx + 1:end_idx] if line.strip()]


def _parse_red_line(line: str) -> tuple[float, float] | None:
    """One red line as ``(offset_ms, bpm)``, or None when it has no numbers."""
    if not osu_write._is_red_line(line.strip()):
        return None
    fields = line.strip().split(",")
    try:
        offset = float(fields[0])
        beat_length = float(fields[1])
    except (ValueError, IndexError):
        return None
    if not (np.isfinite(offset) and np.isfinite(beat_length)) or beat_length <= 0:
        return None
    return (offset, 60000.0 / beat_length)


def read_osu_red_lines(osu_path: str | os.PathLike[str]) -> list[tuple[float, float]]:
    """Every uninherited (red) timing line as ``(offset_ms, bpm)``.

    The first half of Phase 5's map-vs-detected compare, and the reader the
    full .osu work will grow into. Green (inherited) lines are timing-neutral
    by definition — negative slider-velocity multipliers, not tempo — so they
    are skipped, not parsed. Legacy v3-v4 two-field lines count when their
    beat length is positive; decimal offsets (osu!lazer) survive as floats.
    Lines with no usable numbers are skipped rather than fatal: one hand-broken
    line must not hide the rest of the map.
    """
    return [red for line in _timing_section_lines(osu_path)
            if (red := _parse_red_line(line)) is not None]


def compare_map_timing(osu_path: str | os.PathLike[str],
                       analysis: Analysis) -> dict:
    """Per-section map-vs-detected diff table (Phase 5, second row).

    For every detected section, the governing map line — the last red line at
    or before the section start, with half a beat of slack, exactly as the
    benchmark scores ground truth — and two questions: is its BPM right (up
    to an octave), and does its grid pass through the detected beats. Returns
    ``{"sections": [...], "findings": [...]}`` with plain JSON types; findings
    reuse the validation vocabulary (``map_octave`` is info, because the
    octave is a judgement call; the rest are warns, never errors — the map is
    someone's work, and disagreement is review material, not a verdict).
    """
    detected = exports.snap_timing_points(list(getattr(analysis, "points", None) or []))
    if not detected:
        return {"sections": [], "findings": [
            {"level": "error", "key": "no_detected", "index": -1, "values": {}}]}
    try:
        reds = read_osu_red_lines(osu_path)
    except (ValueError, OSError) as exc:
        return {"sections": [], "findings": [
            {"level": "error", "key": "map_unreadable", "index": -1,
             "values": {"detail": str(exc)}}]}
    if not reds:
        return {"sections": [], "findings": [
            {"level": "error", "key": "map_no_reds", "index": -1, "values": {}}]}

    sections: list[dict] = []
    findings: list[dict] = []
    for n, point in enumerate(detected):
        start_s = point.offset_ms / 1000.0
        step = 60.0 / point.bpm if point.bpm > 0 else 0.0
        governing = reds[0]
        for offset_ms, _bpm in reds:
            if offset_ms / 1000.0 <= start_s + 0.5 * step:
                governing = (offset_ms, _bpm)
        map_offset, map_bpm = governing
        ratio = point.bpm / map_bpm if map_bpm > 0 else 1.0
        octave = 2.0 ** round(float(np.log2(ratio))) if ratio > 0 else 1.0
        bpm_error = abs(point.bpm / octave - map_bpm)
        beats = (map_offset / 1000.0 - start_s) / step if step > 0 else 0.0
        offset_error = abs(beats - round(beats)) * step * 1000.0
        sections.append({
            "index": n, "det_offset_ms": point.offset_ms, "det_bpm": point.bpm,
            "map_offset_ms": map_offset, "map_bpm": map_bpm,
            "bpm_error": bpm_error, "offset_error_ms": offset_error,
            "octave": octave,
        })
        if octave != 1:
            findings.append({"level": "info", "key": "map_octave", "index": n,
                             "values": {"map": f"{map_bpm:.2f}",
                                        "det": f"{point.bpm:.2f}",
                                        "octave": f"x{octave:g}"}})
        elif bpm_error > params.MAP_BPM_TOLERANCE:
            findings.append({"level": "warn", "key": "map_bpm", "index": n,
                             "values": {"map": f"{map_bpm:.2f}",
                                        "det": f"{point.bpm:.2f}",
                                        "err": f"{bpm_error:.2f}"}})
        if offset_error > params.MAP_OFFSET_TOLERANCE_MS:
            findings.append({"level": "warn", "key": "map_offset", "index": n,
                             "values": {"ms": f"{offset_error:.1f}"}})
    if len(reds) != len(detected):
        findings.append({"level": "info", "key": "map_count", "index": -1,
                         "values": {"map": len(reds), "det": len(detected)}})
    return {"sections": sections, "findings": findings}


def scan_beatmap_folder(folder: str | os.PathLike[str]) -> dict:
    """Beatmap folder import, first half (Phase 5): audio plus difficulties.

    An osu! song folder holds one audio file and one .osu per difficulty.
    Returns ``{"folder", "audio" (path or None), "beatmaps" (sorted paths),
    "audio_from" (the beatmap that named the audio, or None)}`` with plain
    types. Audio choice: the first beatmap's AudioFilename when that file
    exists — the mapper's own word beats guessing; else the single audio file
    when there is exactly one; else None. Several candidates with no map to
    arbitrate is ambiguity, and guessing an audio file is worse than asking.
    Flat listing on purpose: osu! song folders are flat.
    """
    root = Path(folder)
    if not root.is_dir():
        raise ValueError(f"{root} is not a folder.")
    try:
        entries = sorted(p for p in root.iterdir() if p.is_file())
    except OSError as exc:
        raise ValueError(f"Could not list {root}: {exc}") from exc
    beatmaps = [str(p) for p in entries if p.suffix.lower() == ".osu"]
    audios = [p for p in entries if p.suffix.lower() in params.AUDIO_EXTENSIONS]
    audio: Path | None = None
    audio_from: str | None = None
    for beatmap in beatmaps:
        try:
            text = Path(beatmap).read_bytes().decode("utf-8-sig")
        except (OSError, ValueError):
            continue
        named = next((line.split(":", 1)[1].strip() for line in _osu_lines(text)
                      if line.startswith("AudioFilename:")), "")
        if named and (root / named).is_file():
            audio, audio_from = root / named, beatmap
            break
    if audio is None and len(audios) == 1:
        audio = audios[0]
    return {"folder": str(root), "audio": str(audio) if audio else None,
            "beatmaps": beatmaps, "audio_from": audio_from}


# ---------------------------------------------------------------------------
# Full .osu reading (Phase 5, first row)
# ---------------------------------------------------------------------------

def _split_osu_sections(text: str) -> tuple[int, list[str], list[str], list[dict]]:
    """Format version, pre-section head lines and their endings, and every
    section in file order.

    Unknown sections ride along verbatim in ``sections`` — the span-preserving
    writer's contract is that a field nobody asked to change comes out
    byte-identical, and that starts with the reader losing nothing, including
    the exact head lines before the first section and each line's own ending:
    a CRLF file can hold a bare LF line, and ``endings`` (beside ``lines``)
    and ``header_ending`` keep it one.
    """
    version = 0
    head: list[str] = []
    head_endings: list[str] = []
    sections: list[dict] = []
    current: dict | None = None
    for raw in _osu_lines(text, keepends=True):
        line = raw.rstrip("\r\n")
        ending = raw[len(line):]
        stripped = line.strip()
        if version == 0 and stripped.startswith("osu file format v"):
            try:
                version = int(stripped.rsplit("v", 1)[1])
            except ValueError:
                pass
        if stripped.startswith("[") and stripped.endswith("]") and len(stripped) > 2:
            # ``header`` keeps the line as written (a stray space or tab around
            # the brackets included), so the writer gives it back unchanged.
            current = {"name": stripped[1:-1], "lines": [], "endings": [],
                       "header": line, "header_ending": ending}
            sections.append(current)
            continue
        if current is None:
            head.append(line)
            head_endings.append(ending)
        else:
            current["lines"].append(line)
            current["endings"].append(ending)
    return version, head, head_endings, sections


def _osu_key_values(lines: list[str]) -> dict:
    """``Key: value`` pairs; comments and blanks skipped, last key wins."""
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("//") or ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
        values[key.strip()] = value.strip()
    return values


def _parse_hit_sample(text: str) -> dict:
    """``normal:addition:index:volume:file`` — short forms pad with silence."""
    parts = (text or "").split(":")
    while len(parts) < 5:
        parts.append("")
    out: dict = {"raw": text}
    for key, part in zip(("normal_set", "addition_set", "index", "volume"), parts[:4]):
        try:
            out[key] = int(part)
        except ValueError:
            out[key] = 0
    out["file"] = parts[4]
    return out


def _parse_slider_curve(data: str) -> dict:
    """``B|123:456|789:12`` — curve kind plus integer anchor points."""
    kind, _, rest = data.partition("|")
    points: list[tuple[int, int]] = []
    for token in rest.split("|"):
        if ":" not in token:
            continue
        try:
            px, py = token.split(":")
            points.append((int(px), int(py)))
        except ValueError:
            continue
    return {"curve_type": kind, "points": points}


def _parse_hit_object(line: str) -> dict:
    """One [HitObjects] line as plain types, always keeping the raw line.

    Circles, sliders (curve, slides, length, edges), spinners and mania holds;
    anything else — including a hand-broken line — comes back as ``unparsed``
    with its raw text, so one bad object never hides the rest of the map.
    """
    obj: dict = {"raw": line, "kind": "unparsed"}
    fields = line.split(",")
    if len(fields) < 5:
        return obj
    try:
        x, y = int(fields[0]), int(fields[1])
        time = float(fields[2])
        type_bits, hit_sound = int(fields[3]), int(fields[4])
    except ValueError:
        return obj
    if not np.isfinite(time):
        return obj
    obj.update({"x": x, "y": y, "time": time, "type": type_bits,
                "hit_sound": hit_sound, "new_combo": bool(type_bits & 4),
                "combo_skip": (type_bits >> 4) & 7})
    rest = fields[5:]
    if type_bits & 128:  # mania hold: endTime, then the sample
        try:
            end, _, sample = rest[0].partition(":")
            obj.update({"kind": "hold", "end_time": int(end),
                        "hit_sample": _parse_hit_sample(sample)})
        except (ValueError, IndexError):
            pass
    elif type_bits & 8:  # spinner: endTime, then the sample
        try:
            obj.update({"kind": "spinner", "end_time": int(rest[0]),
                        "hit_sample": _parse_hit_sample(rest[1] if len(rest) > 1 else "")})
        except (ValueError, IndexError):
            pass
    elif type_bits & 2:  # slider: curve, slides, length, then edges and sample
        try:
            curve = _parse_slider_curve(rest[0])
            obj.update({"kind": "slider", "curve": curve,
                        "slides": int(rest[1]), "length": float(rest[2])})
        except (ValueError, IndexError):
            return obj
        if len(rest) > 3:
            obj["edge_sounds"] = rest[3]
        if len(rest) > 4:
            obj["edge_sets"] = rest[4]
        if len(rest) > 5:
            obj["hit_sample"] = _parse_hit_sample(rest[5])
    elif type_bits & 1:
        obj.update({"kind": "circle",
                    "hit_sample": _parse_hit_sample(rest[0] if rest else "")})
    return obj


def read_osu_beatmap(osu_path: str | os.PathLike[str]) -> dict:
    """The whole beatmap as plain types (Phase 5, first row).

    ``sections`` carries every section in file order with raw lines, so
    unknown sections and keys survive even though only the known ones get
    parsed views (``general``/``editor``/``metadata``/``difficulty``,
    ``timing`` reds plus green raws, ``hitobjects``). Hit sounds parse into
    ``normal_set``/``addition_set``/``index``/``volume``/``file``. ``head``,
    ``head_endings``, each section's ``endings`` and ``header_ending``,
    ``newline`` and ``bom`` exist for one reason: the writer rebuilds from
    them, so an untouched file comes back byte-identical, mixed line endings
    included. ``newline`` is only for lines added since the read.
    """
    text, bom = _load_osu_text(osu_path)
    version, head, head_endings, sections = _split_osu_sections(text)
    by_name: dict[str, dict] = {}
    for section in sections:
        by_name.setdefault(section["name"], section)

    def body(name: str) -> list[str]:
        return by_name.get(name, {}).get("lines", [])

    timing = [line for line in body("TimingPoints") if line.strip()
              and not line.strip().startswith("//")]
    objects = [line for line in body("HitObjects") if line.strip()
               and not line.strip().startswith("//")]
    return {
        "format": version,
        "head": head,
        "head_endings": head_endings,
        "newline": "\r\n" if "\r\n" in text else "\n",
        "trailing_newline": text.endswith(("\n", "\r")),
        "bom": bom,
        "sections": sections,
        "general": _osu_key_values(body("General")),
        "editor": _osu_key_values(body("Editor")),
        "metadata": _osu_key_values(body("Metadata")),
        "difficulty": _osu_key_values(body("Difficulty")),
        "timing": {
            "reds": [red for line in timing if (red := _parse_red_line(line)) is not None],
            "greens": [line for line in timing if not osu_write._is_red_line(line.strip())],
        },
        "hitobjects": [_parse_hit_object(line) for line in objects],
    }


def set_beatmap_reds(beatmap: dict, new_reds: list[str]) -> int:
    """Replace the red raws in place; greens, comments and blanks stay put.

    New reds take the position of the first old red (same rule as inject, but
    on the parsed structure instead of the file); with no old reds they append
    at the end of the section. Every other line keeps its own ending; the
    k-th new red takes the k-th old red's, and reds beyond the old count take
    none, so the writer gives them the file's ``newline``. The ``timing`` view
    is refreshed, and the replaced red count returns.
    """
    section = next((s for s in beatmap["sections"] if s["name"] == "TimingPoints"), None)
    if section is None:
        raise ValueError("No [TimingPoints] section in this beatmap.")
    endings = _aligned_endings(section["lines"], section.get("endings"))
    is_red = [bool(line.strip()) and osu_write._is_red_line(line.strip()) for line in section["lines"]]
    red_endings = [ending for ending, red in zip(endings, is_red) if red]
    new_endings = [red_endings[k] if k < len(red_endings) else None
                   for k in range(len(new_reds))]
    replaced = len(red_endings)
    out: list[str] = []
    out_endings: list[str | None] = []
    done = False
    for line, ending, red in zip(section["lines"], endings, is_red):
        if red:
            if not done:
                out.extend(new_reds)
                out_endings.extend(new_endings)
                done = True
        else:
            out.append(line)
            out_endings.append(ending)
    if not done:
        out.extend(new_reds)
        out_endings.extend(new_endings)
    section["lines"] = out
    section["endings"] = out_endings
    timing = [line for line in out if line.strip() and not line.strip().startswith("//")]
    beatmap["timing"] = {
        "reds": [red for line in timing if (red := _parse_red_line(line)) is not None],
        "greens": [line for line in timing if not osu_write._is_red_line(line.strip())],
    }
    return replaced


def _green_fields(line: str) -> list[str]:
    """A green line's eight fields, the missing ones at osu!'s defaults: an
    empty field would not read back (osu! reads a character from it)."""
    fields = [f.strip() for f in line.split(",")]
    while len(fields) < 8:
        fields.append(params._GREEN_FIELD_DEFAULTS[len(fields)])
    return fields


def _point_time_text(section: dict, time_ms: float) -> str | None:
    """The time field of a timing line at ``time_ms``, exactly as the map
    wrote it. A green inserted at a red line's time must carry the same
    number: rounded, 17837.0114440535 became 17837.011 and landed before the
    red line it was meant to follow, which then undid it."""
    for line in section.get("lines", []):
        text = line.strip()
        if text and not text.startswith("//") and (point := osu_write._timing_point_fields(text)) is not None \
                and abs(point["time"] - time_ms) <= 0.01:
            return text.split(",", 1)[0].strip()
    return None


def _first_red_time(beatmap: dict) -> float | None:
    """The map's first red line: nothing is written before it, since osu!
    reads the first line's settings back to the song's start, and a green
    placed there would become what the whole intro reads."""
    rows = [o for o, b, _m in reference_timing._beatmap_red_rows(beatmap) if np.isfinite(o) and np.isfinite(b)]
    return min(rows) if rows else None


def _insert_timing_line(section: dict, row: str) -> None:
    """``row`` into [TimingPoints] before the first point later than it,
    every other line keeping its own ending; the new one takes the file's."""
    time_ms = float(row.split(",", 1)[0])
    at = next((n for n, line in enumerate(section["lines"])
               if line.strip() and not line.strip().startswith("//")
               and (point := osu_write._timing_point_fields(line)) is not None
               and point["time"] > time_ms + 1e-6), len(section["lines"]))
    endings = section.get("endings")
    if endings is not None and len(endings) == len(section["lines"]):
        endings.insert(at, None)
    section["lines"].insert(at, row)


def set_chorus_kiai(beatmap: dict, spans: list[tuple[float, float]]) -> dict:
    """Kiai on chorus spans, written as green lines (Phase 21, Kiai).

    Choruses that touch or overlap light as one run: a chorus ending where
    the next one begins must not switch kiai off at the seam. Inside a run
    every point reads kiai, because a point carries its own kiai bit and the
    map's own greens (SV, volume) would switch it off a beat in: a green
    where kiai reads off gets its bit set, and a time with no green to set
    (the run's start, or a red line inside, which carries its own effects)
    gets a new green carrying the audible state in force there (SV, sets,
    index, volume), so nothing plays differently — kiai is light, not sound.
    At the run's end, kiai goes back to what the map itself had there. A
    boundary already reading right is kept, so a second run changes nothing.
    Raw lines move, the ``timing`` view is refreshed, and comments and
    blanks stay put. In place, like the P-2 field edits. Returns added
    (greens), flipped (kiai bits) and kept (boundaries already right).
    """
    section = next((s for s in beatmap.get("sections", []) if s["name"] == "TimingPoints"), None)
    if section is None:
        raise ValueError("No [TimingPoints] section in this beatmap.")
    cursor = sounds._TimingCursor(beatmap)      # the map as read: audible state and its own kiai
    import bisect

    def meter_at(time_ms: float) -> int:
        rows = reference_timing._beatmap_red_rows(beatmap)
        i = bisect.bisect_right([o for o, _b, _m in rows], time_ms + 1e-6) - 1
        return rows[max(i, 0)][2] if rows else 4

    def stamp(time_ms: float) -> str:
        whole = round(time_ms)
        return str(int(whole)) if abs(time_ms - whole) < 1e-6 else f"{time_ms:.3f}"

    # The kiai each point time reads once every point there is applied, in
    # osu!'s order, and the green read last there: the one a flip goes to.
    rows = []
    for order, line in enumerate(section["lines"]):
        text = line.strip()
        if text and not text.startswith("//") and (point := osu_write._timing_point_fields(text)) is not None:
            point["order"] = order
            rows.append(point)
    kiai_at: dict[float, bool] = {}
    last_green: dict[float, int] = {}
    for row in osu_write._ordered(rows):
        kiai_at[row["time"]] = bool(row["effects"] & 1)
        if not row["red"]:
            last_green[row["time"]] = row["order"]
    times = sorted(kiai_at)
    flips: dict[int, bool] = {}
    inserts: list[tuple[float, bool]] = []

    def point_time(time_ms: float) -> float | None:
        i = bisect.bisect_left(times, time_ms - 0.01)
        return times[i] if i < len(times) and times[i] <= time_ms + 0.01 else None

    def kiai_now(time_ms: float) -> bool:
        # Before the first point, the first point's settings apply, as in osu!.
        i = bisect.bisect_right(times, time_ms + 1e-6) - 1
        return kiai_at[times[max(i, 0)]] if times else False

    def decide(time_ms: float, on: bool) -> str:
        at = point_time(time_ms)
        if at is None:
            at = time_ms
            bisect.insort(times, at)
        kiai_at[at] = on
        if at in last_green:
            flips[last_green[at]] = on
            return "flipped"
        inserts.append((at, on))            # no green there, or only a red line
        return "added"

    first_red = _first_red_time(beatmap)
    runs: list[list[float]] = []
    for start_ms, end_ms in sorted((float(a), float(b)) for a, b in spans):
        if first_red is not None:
            start_ms = max(start_ms, first_red)
        if not end_ms > start_ms:
            continue
        if runs and start_ms <= runs[-1][1] + 0.01:
            runs[-1][1] = max(runs[-1][1], end_ms)
        else:
            runs.append([start_ms, end_ms])
    counts = {"added": 0, "flipped": 0, "kept": 0}
    for start_ms, end_ms in runs:
        # What follows the run is the map's own kiai there, read before any edit.
        _beat, after = cursor.at(end_ms)
        restore = bool(after is not None and after.kiai)
        if kiai_now(start_ms):
            counts["kept"] += 1
        else:
            counts[decide(start_ms, True)] += 1
        for time_ms in [t for t in times if start_ms + 0.01 < t < end_ms - 0.01]:
            if not kiai_now(time_ms):
                counts[decide(time_ms, True)] += 1
        if kiai_now(end_ms) == restore:
            counts["kept"] += 1
        else:
            counts[decide(end_ms, restore)] += 1
    for index, on in flips.items():
        fields = _green_fields(section["lines"][index])
        effects = int(float(fields[7])) if fields[7] else 0
        fields[7] = str((effects | 1) if on else (effects & ~1))
        section["lines"][index] = ",".join(fields)
    for time_ms, on in inserts:
        _beat, state = cursor.at(time_ms)
        sv, sample_set, sample_index, volume = ((state.sv, state.sample_set, state.sample_index,
                                                 state.volume) if state is not None else (1.0, 0, 0, 100))
        when = _point_time_text(section, time_ms) or stamp(time_ms)
        _insert_timing_line(section, f"{when},{-100.0 / sv:.12g},{meter_at(time_ms)},"
                                     f"{sample_set},{sample_index},{volume},0,{1 if on else 0}")
    timing = [line for line in section["lines"]
              if line.strip() and not line.strip().startswith("//")]
    beatmap["timing"] = {
        "reds": [red for line in timing if (red := _parse_red_line(line)) is not None],
        "greens": [line for line in timing if not osu_write._is_red_line(line.strip())],
    }
    return counts


def set_section_volumes(beatmap: dict, sections: list[dict]) -> dict:
    """Hitsound volume from section energy, as greens (Phase 21, Volume).

    Each section plays at the loudest section's volume scaled by their level
    distance in dB — amplitude math, not taste — so a chorus hits harder than
    its verse by exactly how much louder it is. The scale's anchor is the
    volume the loudest section plays longest, which the tool never changes: a
    second run reads its own greens as right instead of turning them down
    again, and a short mute at that section's start (5 % on a real map) does
    not become the scale.

    The mapper's own volumes are kept. A section where the map changes the
    volume, at its start or anywhere inside, is left as it is and counted as
    the mapper's. A section the map plays at one volume from start to end is
    set to its target all the way through: its start, the volume of every
    green inside, and a new green at each red line inside, since a red line
    carries a volume of its own. New greens carry the audible state in force
    there, so SV, sets, index and kiai never move with the volume. A section
    already at its target throughout is kept. One case reads wrong on a second
    run: a mapper's section whose one volume equals the target this tool
    wrote into the section before it reads as inherited and is set. Sections
    run to their stated end, else to the next start. In place, like the P-2
    field edits. Returns sections set, kept (at their target already) and
    mapper (left to the map's own volumes), and the green lines added and
    flipped (volume rewritten) to set them.
    """
    section = next((s for s in beatmap.get("sections", []) if s["name"] == "TimingPoints"), None)
    if section is None:
        raise ValueError("No [TimingPoints] section in this beatmap.")
    counts = {"added": 0, "flipped": 0, "kept": 0, "mapper": 0, "set": 0}
    entries = []
    for entry in sections or []:
        try:
            start = float(entry["start_s"]) * 1000.0
            level = float(entry.get("level_db", float("nan")))
            end = float(entry.get("end_s", float("nan"))) * 1000.0
        except (TypeError, ValueError, KeyError):
            continue
        if np.isfinite(start) and np.isfinite(level):
            entries.append((start, level, end))
    if not entries:
        return counts
    # One boundary per start: contiguous sections never share one, but a
    # hand-built list might, and two greens on the same millisecond are junk.
    unique: list[tuple[float, float, float]] = []
    for start, level, end in sorted(entries):
        if not unique or abs(start - unique[-1][0]) > 0.01:
            unique.append((start, level, end))
    cursor = sounds._TimingCursor(beatmap)      # the map as read, before any edit here
    import bisect

    def meter_at(time_ms: float) -> int:
        rows = reference_timing._beatmap_red_rows(beatmap)
        i = bisect.bisect_right([o for o, _b, _m in rows], time_ms + 1e-6) - 1
        return rows[max(i, 0)][2] if rows else 4

    def stamp(time_ms: float) -> str:
        whole = round(time_ms)
        return str(int(whole)) if abs(time_ms - whole) < 1e-6 else f"{time_ms:.3f}"

    def volume_at(time_ms: float) -> int:
        _beat, state = cursor.at(time_ms)
        return state.volume if state is not None else 100

    points = []
    for order, line in enumerate(section["lines"]):
        text = line.strip()
        if text and not text.startswith("//") and (point := osu_write._timing_point_fields(text)) is not None:
            point["order"] = order
            points.append(point)
    points = osu_write._ordered(points)
    ends = [float(o.get("end_time") or o.get("time") or 0.0)
            for o in beatmap.get("hitobjects", []) if "time" in o]
    last = max([p["time"] for p in points] + ends + [unique[-1][0]]) + 1.0
    spans = []
    for n, (start, level, end) in enumerate(unique):
        following = unique[n + 1][0] if n + 1 < len(unique) else None
        stop = end if np.isfinite(end) and end > start else (following if following is not None else last)
        if following is not None:
            stop = min(stop, following)
        spans.append((start, max(stop, start), level, following is not None))
    # Nothing is written before the first red line (osu! would read it back
    # to the song's start), and the scale comes from what is left.
    first_red = _first_red_time(beatmap)
    if first_red is not None:
        spans = [(max(s, first_red), e, lv, more) for s, e, lv, more in spans if e > first_red + 0.01]
    if not spans:
        return counts
    loudest = max(lv for _s, _e, lv, _m in spans)

    def longest_volume(start: float, stop: float) -> int:
        cuts = sorted({start, stop} | {p["time"] for p in points if start < p["time"] < stop})
        held: dict[int, float] = {}
        for a, b in zip(cuts, cuts[1:]):
            held[volume_at(a)] = held.get(volume_at(a), 0.0) + (b - a)
        return max(held, key=lambda v: (held[v], v)) if held else volume_at(start)

    anchor = min(spans, key=lambda s: (-s[2], s[0]))
    reference = longest_volume(anchor[0], anchor[1])
    flips: dict[int, int] = {}
    # New greens by time: a set section's closing green and the next
    # section's own start land on the same millisecond, and the start wins.
    inserts: dict[float, tuple[float, int]] = {}
    for start, stop, level, more in spans:
        # Never under osu!'s own floor: a fade 47 dB down came out at 0.
        target = max(params.MIN_SAMPLE_VOLUME, min(100, int(round(reference * 10.0 ** ((level - loudest) / 20.0)))))
        inside = [p for p in points if start - 0.01 <= p["time"] < stop - 0.01]
        times = sorted({start} | {p["time"] for p in inside})
        if all(volume_at(t) == target for t in times):
            counts["kept"] += 1
            continue
        before = volume_at(start - 0.01)
        if any(p["volume"] != before for p in inside):
            counts["mapper"] += 1
            continue
        counts["set"] += 1
        for time_ms in times:
            greens = [p for p in inside if not p["red"] and abs(p["time"] - time_ms) <= 0.01]
            for green in greens:
                flips[green["order"]] = target
            if greens:
                inserts.pop(round(time_ms, 2), None)
            else:
                inserts[round(time_ms, 2)] = (time_ms, target)
        # The target must not run on past the section: where the next one
        # starts with no line of its own, a green gives back what the map
        # played there (the next section's own start may still replace it).
        opens_own = any(abs(p["time"] - stop) <= 0.01 for p in points)
        if (more or stop < last - 1.0) and not opens_own and volume_at(stop) != target:
            inserts[round(stop, 2)] = (stop, volume_at(stop))
    counts["flipped"] = len(flips)
    counts["added"] = len(inserts)
    for order, volume in flips.items():
        fields = _green_fields(section["lines"][order])
        fields[5] = str(volume)
        section["lines"][order] = ",".join(fields)
    for time_ms, volume in inserts.values():
        _beat, state = cursor.at(time_ms)
        sv, sample_set, sample_index, kiai = ((state.sv if state.sv > 0 else 1.0, state.sample_set,
                                               state.sample_index, state.kiai)
                                              if state is not None else (1.0, 0, 0, False))
        when = _point_time_text(section, time_ms) or stamp(time_ms)
        _insert_timing_line(section, f"{when},{-100.0 / sv:.12g},{meter_at(time_ms)},"
                                     f"{sample_set},{sample_index},{volume},0,{1 if kiai else 0}")
    timing = [line for line in section["lines"]
              if line.strip() and not line.strip().startswith("//")]
    beatmap["timing"] = {
        "reds": [red for line in timing if (red := _parse_red_line(line)) is not None],
        "greens": [line for line in timing if not osu_write._is_red_line(line.strip())],
    }
    return counts


def suggest_breaks(beatmap: dict, sections: list[dict], min_length_s: float = 5.0,
                 quiet_db: float = 6.0) -> list[dict]:
    """Quiet spans long enough for a break (Phase 21, Breaks).

    A break lives where the song goes quiet *and* the map goes silent: each
    section at least ``quiet_db`` under the loudest one's level is covered,
    adjacent quiet sections merged, and every gap between the map's own sound
    events (see :func:`sound_events`) meeting that cover for at least
    ``min_length_s`` becomes a span. Both bars are the tool's own, adjustable —
    the preview shows each span's length and depth so the mapper judges, never
    a claim about the client's. Read only, plain JSON types: ``start_ms``,
    ``end_ms``, the section ``kind`` holding the span's start, ``under_db``
    and the ``gap_s`` it was cut from.
    """
    usable = []
    for section in sections or []:
        try:
            start = float(section["start_s"]) * 1000.0
            end = float(section["end_s"]) * 1000.0
            level = float(section.get("level_db", float("nan")))
        except (TypeError, ValueError, KeyError):
            continue
        if not np.isfinite(level) or end <= start:
            continue
        usable.append((start, end, str(section.get("kind", "")), level))
    if not usable:
        return []
    loudest = max(level for _s, _e, _k, level in usable)
    quiet = sorted([(s, e, k, loudest - level)
                    for s, e, k, level in usable if loudest - level >= quiet_db])
    if not quiet:
        return []
    # One cover: adjacent quiet sections read as one silence.
    cover: list[list] = []
    for start, end, kind, under in quiet:
        if cover and start <= cover[-1][1] + 1e-6:
            cover[-1][1] = max(cover[-1][1], end)
        else:
            cover.append([start, end, kind, under])
    times = sorted({float(e["time"]) for e in sounds.sound_events(beatmap)})
    if len(times) < 2:
        return []
    minimum = float(min_length_s) * 1000.0
    spans = []
    for start, end, kind, under in cover:
        for before, after in zip(times, times[1:]):
            low, high = max(before, start), min(after, end)
            if high - low >= minimum - 1e-6:
                spans.append({
                    "start_ms": int(round(low)), "end_ms": int(round(high)),
                    "kind": kind, "under_db": round(under, 1),
                    "gap_s": round((after - before) / 1000.0, 2),
                })
    return sorted(spans, key=lambda s: (s["start_ms"], s["end_ms"]))


def set_map_breaks(beatmap: dict, spans: list[tuple[float, float]]) -> dict:
    """Break spans as ``2,start,end`` lines in [Events] (Phase 21, Breaks).

    A span already covered by a break line is kept, the rest are added after
    the ``//Break Periods`` comment when the map has one, else at the
    section's end — line order inside [Events] means nothing to the client,
    every line is typed. Whole milliseconds; a span ending at or before its
    start refuses the map, and a missing [Events] refuses it too, rather than
    inventing file structure. Comments and blanks stay put. In place, like the
    P-2 field edits. Returns added and kept.
    """
    section = next((s for s in beatmap.get("sections", []) if s["name"] == "Events"), None)
    if section is None:
        raise ValueError("No [Events] section in this beatmap.")
    have: list[tuple[int, int]] = []
    for line in section["lines"]:
        stripped = line.strip()
        if not stripped or stripped.startswith("//"):
            continue
        fields = stripped.split(",")
        if len(fields) >= 3 and fields[0].strip() == "2":
            try:
                have.append((int(float(fields[1])), int(float(fields[2]))))
            except ValueError:
                continue
    added = kept = 0
    fresh: list[str] = []
    for start_ms, end_ms in spans:
        start, end = int(round(float(start_ms))), int(round(float(end_ms)))
        if end <= start:
            raise ValueError(f"Break ends at or before its start: {start_ms} -> {end_ms}.")
        if any(begin <= start + 1 and finish >= end - 1 for begin, finish in have):
            kept += 1
            continue
        have.append((start, end))
        fresh.append(f"2,{start},{end}")
        added += 1
    if fresh:
        at = next((n + 1 for n, line in enumerate(section["lines"])
                   if line.strip() == "//Break Periods"), len(section["lines"]))
        section["lines"][at:at] = fresh
    return {"added": added, "kept": kept}


class ScrollMovesSliders(ValueError):
    """Normalising would move slider ends: in osu! a slider lasts by the SV
    it starts under, so scaling that SV moves its tail and repeats off the
    beats they were snapped to. On 225 local maps with BPM changes, the
    first version of the tool moved slider ends in 194."""

    def __init__(self, count: int, first_ms: float) -> None:
        super().__init__(f"{count} sliders start where the scroll would be rescaled (the first at "
                         f"{first_ms:.0f} ms): a slider lasts by its SV, so each end would leave "
                         "its beat. Refusing the map.")
        self.count = count
        self.first_ms = first_ms


def scroll_profile(beatmap: dict) -> str:
    """A fingerprint of what the map scrolls at: every change of BPM or SV
    multiplier, in osu!'s order, rounded to 1e-6. Writes that leave scroll
    alone keep it — a kiai or volume green carries the SV in force — while a
    restore, an inject, a hand edit of SV or another copy of the map change
    it. Constant scroll records it in History, so a map it normalised is not
    normalised twice in any session, and a map that changed since is free."""
    import hashlib
    section = next((s for s in beatmap.get("sections", []) if s["name"] == "TimingPoints"), None)
    points = []
    for order, line in enumerate((section or {}).get("lines", [])):
        text = line.strip()
        if text and not text.startswith("//") and (point := osu_write._timing_point_fields(text)) is not None:
            point["order"] = order
            points.append(point)
    bpm, sv, changes = None, 1.0, []
    for point in osu_write._ordered(points):
        if point["red"] and point["beat_length"] > 0:
            bpm, sv = 60000.0 / point["beat_length"], 1.0
        elif not point["red"] and point["beat_length"] < 0:
            sv = -100.0 / point["beat_length"]
        now = (None if bpm is None else round(bpm, 6), round(sv, 6))
        if not changes or changes[-1][1:] != now:
            changes.append((round(point["time"], 3), *now))
    return hashlib.sha1(repr(changes).encode("utf-8")).hexdigest()


def set_constant_scroll(beatmap: dict) -> dict:
    """Greens that cancel BPM changes, so scroll and slider speed stay
    constant (Phase 21, SV normaliser).

    The first red line's BPM is the reference. Under every later red with a
    different BPM, each green's multiplier is scaled by reference over that
    BPM, so the mapper's own SV changes keep their shape at the reference's
    speed instead of the new tempo's; a red with no green at its own time
    gets one carrying reference over its BPM (red before green, as osu!
    orders them), with the audible state in force there — SV is scroll, not
    sound — and the red's own effects, so kiai and barlines read as before.

    A span already reading constant is kept whole: when the scroll right
    after its red line is the reference's (``SCROLL_TOLERANCE``), it was
    normalised, by hand or by a first run, and is not scaled twice. osu!
    resets SV to 1.0 at every red line, so "right after" is what the map sets
    there, not what played before it. One case reads wrong: a span whose own
    green at the red line held another multiplier than 1.0 reads as not yet
    normalised on a second run and is scaled again — History restores it.
    A multiplier scaled out of ``SV_RANGE`` refuses the map, naming its time.
    So does a slider starting in a span that would be rescaled
    (:class:`ScrollMovesSliders`): a slider lasts by its SV, and scaling it
    would move every tail and repeat off its beat, so only maps with nothing
    but circles, spinners and holds there (osu!mania's, for one) are written.
    Reds at the reference BPM are not this tool's business and never count.
    In place, like the P-2 field edits. Returns added (greens at red lines),
    flipped (greens rescaled) and kept (spans already constant).
    """
    section = next((s for s in beatmap.get("sections", []) if s["name"] == "TimingPoints"), None)
    if section is None:
        raise ValueError("No [TimingPoints] section in this beatmap.")
    rows = [(o, b, m) for o, b, m in reference_timing._beatmap_red_rows(beatmap)
            if np.isfinite(o) and np.isfinite(b) and b > 0]
    if not rows:
        raise ValueError("No usable red lines in this beatmap.")
    reference = rows[0][1]
    cursor = sounds._TimingCursor(beatmap)
    import bisect

    def stamp(time_ms: float) -> str:
        whole = round(time_ms)
        return str(int(whole)) if abs(time_ms - whole) < 1e-6 else f"{time_ms:.3f}"

    def red_effects(time_ms: float) -> int:
        for line in section["lines"]:
            point = osu_write._timing_point_fields(line.strip()) if line.strip() else None
            if point is not None and point["red"] and abs(point["time"] - time_ms) < 1e-6:
                return point["effects"]
        return 0

    # Every green, in osu!'s order, under the red line it plays at.
    points = []
    for order, line in enumerate(section["lines"]):
        text = line.strip()
        if text and not text.startswith("//") and (point := osu_write._timing_point_fields(text)) is not None:
            point["order"] = order
            points.append(point)
    greens = [p for p in osu_write._ordered(points) if not p["red"] and p["beat_length"] < 0]
    red_times = [o for o, _b, _m in rows]
    by_span: dict[int, list[dict]] = {}
    for green in greens:
        span = bisect.bisect_right(red_times, green["time"] + 1e-6) - 1
        if span >= 0:
            by_span.setdefault(span, []).append(green)

    added = flipped = kept = 0
    rescaled: dict[int, float] = {}
    inserts: list[tuple[float, float, int]] = []
    slider_starts = sorted(float(o["time"]) for o in beatmap.get("hitobjects", [])
                           if o.get("kind") == "slider" and "time" in o)
    moved: list[float] = []
    for span, (offset, bpm, meter) in enumerate(rows):
        need = reference / bpm
        if span == 0 or abs(need - 1.0) < 1e-9:
            continue
        own = by_span.get(span, [])
        at_red = [g for g in own if abs(g["time"] - offset) <= 0.01]
        after = -100.0 / at_red[-1]["beat_length"] if at_red else 1.0
        if abs(bpm * after / reference - 1.0) <= params.SCROLL_TOLERANCE:
            kept += 1
            continue
        until = rows[span + 1][0] if span + 1 < len(rows) else float("inf")
        moved += [t for t in slider_starts if offset - 1e-6 <= t < until - 1e-6]
        for green in own:
            value = -100.0 / green["beat_length"] * need
            if not params.SV_RANGE[0] - 1e-9 <= value <= params.SV_RANGE[1] + 1e-9:
                raise ValueError(f"Scaling the green at {stamp(green['time'])} ms gives "
                                 f"{value:.3f}x, outside osu!'s {params.SV_RANGE[0]:g}x-{params.SV_RANGE[1]:g}x: "
                                 "refusing the map.")
            rescaled[green["order"]] = value
        flipped += len(own)
        if not at_red:
            inserts.append((offset, need, meter))
            added += 1
    if moved:
        raise ScrollMovesSliders(len(moved), min(moved))
    for order, value in rescaled.items():
        fields = _green_fields(section["lines"][order])
        fields[1] = f"{-100.0 / value:.12g}"
        section["lines"][order] = ",".join(fields)
    for offset, need, meter in inserts:
        _beat, state = cursor.at(offset)
        sample_set, sample_index, volume = ((state.sample_set, state.sample_index, state.volume)
                                            if state is not None else (0, 0, 100))
        when = _point_time_text(section, offset) or stamp(offset)
        _insert_timing_line(section, f"{when},{-100.0 / need:.12g},{meter},"
                                     f"{sample_set},{sample_index},{volume},0,{red_effects(offset)}")
    timing = [line for line in section["lines"]
              if line.strip() and not line.strip().startswith("//")]
    beatmap["timing"] = {
        "reds": [red for line in timing if (red := _parse_red_line(line)) is not None],
        "greens": [line for line in timing if not osu_write._is_red_line(line.strip())],
    }
    return {"added": added, "flipped": flipped, "kept": kept}

def _aligned_endings(lines: list[str], endings: list | None) -> list[str | None]:
    """``endings`` when they still pair one to one with ``lines``; otherwise
    None for every line, since pairing by position would misplace them."""
    if endings is None or len(endings) != len(lines):
        return [None] * len(lines)
    return list(endings)


def beatmap_text(beatmap: dict) -> str:
    """Head plus sections in order, raw lines untouched, each with its own ending.

    A line keeps the ending it was read with, so a CRLF file holding one bare
    LF comes back as it was. A line with no ending on record (added since the
    read, or in a section whose ``lines`` changed length without its
    ``endings``) takes ``newline``, as does a line that was last and no
    longer is. The file ends with a line break exactly when it did.
    """
    newline = beatmap.get("newline", "\n")
    head = beatmap.get("head", [])
    rows = list(zip(head, _aligned_endings(head, beatmap.get("head_endings"))))
    for section in beatmap["sections"]:
        rows.append((section.get("header") or f"[{section['name']}]", section.get("header_ending")))
        rows.extend(zip(section["lines"],
                        _aligned_endings(section["lines"], section.get("endings"))))
    trailing = beatmap.get("trailing_newline", True)
    out: list[str] = []
    for n, (line, ending) in enumerate(rows):
        if n == len(rows) - 1:
            ending = (ending or newline) if trailing else ""
        elif not ending:
            ending = newline
        out.append(line + ending)
    return "".join(out)


def write_osu_beatmap(osu_path: str | os.PathLike[str], beatmap: dict,
                      backup: bool = True, op: str = "write", summary: dict | None = None) -> dict:
    """Write a parsed beatmap back (Phase 5, writer row).

    Untouched lines come out byte-identical — same text, same line ending
    (each its own, mixed or not), same BOM — because the reader kept them
    all. Atomic temp-plus-rename, and backups follow inject's rules
    (_backup_before_write): written first, never overwritten, skipped when
    there is no original to protect. ``backup`` in the result is the path
    holding the replaced bytes, or None. ``op`` names the write in the
    history log (kiai, breaks...), so History says which tool wrote it, and
    ``summary`` adds to what the log keeps of it.
    """
    path = Path(osu_path)
    original = path.read_bytes() if path.is_file() else None
    payload = beatmap_text(beatmap).encode("utf-8-sig" if beatmap.get("bom") else "utf-8")
    spare = None
    if backup and original is not None:
        try:
            spare = osu_write._backup_before_write(path, original)
        except OSError as exc:
            raise ValueError(f"Could not back up {path.name}: {exc}") from exc
    try:
        osu_write._atomic_write_bytes(path, payload)
    except (OSError, ValueError) as exc:
        raise ValueError(f"Could not write {path.name}: {exc}") from exc
    osu_write.log_write(path, op, str(spare) if spare else None, {"bytes": len(payload), **(summary or {})})
    return {"bytes": len(payload), "backup": str(spare) if spare else None}
