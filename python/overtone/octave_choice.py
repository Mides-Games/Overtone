"""Octave choice: rules, smoothing and the half/double-time hints (audit F-11)."""
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

from . import beat_this, exports, map_objects, osu_read, osu_write, params, phrases, precision_grid, red_lines, sounds


def _smooth_octaves(analysis: Analysis) -> Analysis:
    """Red lines whose octave steps against their neighbours read at the
    octave of the song around them (OCTAVE_SMOOTH)."""
    points = list(getattr(analysis, "points", None) or [])
    if (not params.OCTAVE_SMOOTH or len(points) < 2
            or any(getattr(p, "manual", False) for p in points)):
        return analysis
    end_ms = float(analysis.duration) * 1000.0
    spans = np.array([max(1.0, (points[n + 1].offset_ms if n + 1 < len(points) else end_ms)
                          - p.offset_ms) for n, p in enumerate(points)])
    share = spans / spans.sum()
    factors = (0.5, 1.0, 2.0)
    keep = [[0.0 if f == 1.0 else params.OCTAVE_SMOOTH_KEEP + params.OCTAVE_SMOOTH_SPAN * w for f in factors]
            for w in share]
    for n, p in enumerate(points):
        for k, f in enumerate(factors):
            if f != 1.0 and not 60.0 <= p.bpm * f <= 320.0:
                keep[n][k] = np.inf

    def step(a: float, b: float) -> float:
        return 1.0 if abs(np.log2(b / a)) > 0.75 else 0.0

    cost = list(keep[0])
    back = []
    for n in range(1, len(points)):
        row, ptr = [], []
        for k, f in enumerate(factors):
            options = [cost[j] + step(points[n - 1].bpm * factors[j], points[n].bpm * f)
                       for j in range(3)]
            j = int(np.argmin(options))
            row.append(options[j] + keep[n][k])
            ptr.append(j)
        cost = row
        back.append(ptr)
    k = int(np.argmin(cost))
    path = [k]
    for ptr in reversed(back):
        k = ptr[k]
        path.append(k)
    path.reverse()
    if all(factors[k] == 1.0 for k in path):
        return analysis
    lines = [(p.offset_ms, p.bpm * factors[k]) for p, k in zip(points, path)]
    return phrases._with_lines(analysis, lines, beats=red_lines._beats_of(lines, float(analysis.duration)))


def _offbeat_ratio(analysis: Analysis) -> float | None:
    """Attack weight on the half beats over the weight on the beats, on the
    first red line's grid (bench/corpus_b.py reports the same number)."""
    times = np.asarray(analysis.attack_times, dtype=float)
    weights = np.asarray(analysis.attack_weights, dtype=float)
    if times.size < 16 or not analysis.points:
        return None
    period = 60.0 / float(analysis.points[0].bpm)
    phase = np.mod((times - analysis.points[0].offset_ms / 1000.0) / period, 1.0)
    on = float(weights[(phase < 0.1) | (phase > 0.9)].sum())
    half = float(weights[np.abs(phase - 0.5) < 0.1].sum())
    return half / on if on > 0 else None


def _octave_rule(analysis: Analysis) -> Analysis:
    """Every red line at twice or half its tempo where OCTAVE_RULE says the
    song was read an octave out; a halved song keeps the beats that carry
    more of the attacks."""
    points = list(getattr(analysis, "points", None) or [])
    if (not params.OCTAVE_RULE or not points or analysis.engine != "precision"
            or any(getattr(p, "manual", False) for p in points)):
        return analysis
    ratio = _offbeat_ratio(analysis)
    bpm = float(analysis.global_bpm) or float(points[0].bpm)
    if ratio is None:
        return analysis
    if bpm < params.OCTAVE_RULE_DOUBLE[0] and ratio >= params.OCTAVE_RULE_DOUBLE[1] and bpm * 2.0 <= 300.0:
        lines = [(p.offset_ms, p.bpm * 2.0) for p in points]
    elif bpm > params.OCTAVE_RULE_HALVE[0] and params.OCTAVE_RULE_HALVE_FLOOR <= ratio < params.OCTAVE_RULE_HALVE[1]:
        lines = _halved_lines(analysis, points)
    else:
        return analysis
    return phrases._with_lines(analysis, lines, beats=red_lines._beats_of(lines, float(analysis.duration)))


def _halved_lines(analysis: Analysis, points: list) -> list[tuple[float, float]]:
    """Each line at half its tempo, on whichever of its beats carries more of
    the attacks."""
    times = np.asarray(analysis.attack_times, dtype=float) * 1000.0
    weights = np.asarray(analysis.attack_weights, dtype=float)
    lines = []
    for n, p in enumerate(points):
        end = points[n + 1].offset_ms if n + 1 < len(points) else float(analysis.duration) * 1000.0
        period = 120000.0 / p.bpm
        inside = (times >= p.offset_ms) & (times < end)

        def weight(start: float) -> float:
            phase = np.mod((times[inside] - start) / period, 1.0)
            return float(weights[inside][(phase < 0.05) | (phase > 0.95)].sum())

        start = max((p.offset_ms, p.offset_ms + period / 2.0), key=weight)
        lines.append((start, p.bpm / 2.0))
    return lines


def _lines_on_downbeats(analysis: Analysis) -> Analysis:
    """Every red line after the first moved onto a bar line (LINES_ON_DOWNBEATS)."""
    points = list(getattr(analysis, "points", None) or [])
    if (not params.LINES_ON_DOWNBEATS or len(points) < 2
            or any(getattr(p, "manual", False) for p in points)):
        return analysis
    times = np.asarray(analysis.attack_times, dtype=float)
    weights = np.asarray(analysis.attack_weights, dtype=float)
    duration = float(analysis.duration)
    end_ms = duration * 1000.0
    lines = [(float(p.offset_ms), float(p.bpm)) for p in points]
    meter = max(1, int(getattr(points[0], "meter", 4) or 4))
    first_period = 60.0 / lines[0][1]
    span = times < (lines[1][0] / 1000.0)
    _, cls, bar = precision_grid._meter_from_grid(times[span], weights[span], first_period, lines[0][0] / 1000.0)
    meter = bar if bar > 1 else meter
    origin = lines[0][0] + cls * first_period * 1000.0     # a downbeat of the first line

    def fit(ls):
        return beat_this._grid_fit_score(red_lines._beats_of(ls, duration), times, weights, 10.0)

    score = fit(lines)
    moved = False
    for n in range(1, len(lines)):
        prev_offset, prev_bpm = lines[n - 1]
        offset, bpm = lines[n]
        step, prev_bar = 60000.0 / bpm, meter * 60000.0 / prev_bpm
        stop = lines[n + 1][0] if n + 1 < len(lines) else end_ms
        best = None
        for j in range(-(meter - 1), meter):
            at = offset + j * step
            if not (prev_offset + step < at < stop - step):
                continue
            off_bar = (at - origin) % prev_bar
            d = min(off_bar, prev_bar - off_bar)
            if best is None or d < best[0]:
                best = (d, at)
        if best is not None and best[1] != offset and best[0] <= params.LINES_ON_DOWNBEATS_TOL * step:
            trial = lines[:n] + [(best[1], bpm)] + lines[n + 1:]
            trial_score = fit(trial)
            if trial_score >= score - params.LINES_ON_DOWNBEATS_LOSS:
                lines, score, offset, moved = trial, trial_score, best[1], True
        origin = offset                                      # this line starts a bar
    if not moved:
        return analysis
    return phrases._with_lines(analysis, lines, beats=red_lines._beats_of(lines, duration))


# ---------------------------------------------------------------------------
# Half- and double-time inside one reported section — audit F-11
# ---------------------------------------------------------------------------


def density_window(times: np.ndarray, weights: np.ndarray, period: float,
                   phase: float, tol_ratio: float = params.DENSITY_TOL_RATIO) -> tuple[float, float, int]:
    """One window's (coverage, parity at m=2, inlier count) on a subdivided grid."""
    times = np.asarray(times, dtype=np.float64)
    if times.size == 0 or period <= 0:
        return 0.0, 0.0, 0
    k = np.round((times - phase) / period)
    inlier = np.abs(times - (phase + k * period)) <= max(tol_ratio * period, 0.006)
    n = int(inlier.sum())
    if n < 4:
        return 0.0, 0.0, n
    ki = k[inlier].astype(np.int64)
    slots = float(np.ptp(ki)) + 1.0
    coverage = min(1.0, len(np.unique(ki)) / max(slots, 1.0))
    # Weighted by attack strength, so a ghost note cannot carry the parity.
    totals = np.bincount(np.mod(ki, 2),
                         weights=np.asarray(weights, dtype=np.float64)[inlier], minlength=2)
    return coverage, float(np.max(totals) / max(np.sum(totals), 1e-9)), n


def _density_runs(thin: list[bool]) -> list[tuple[int, int]]:
    """The runs of thinned windows long enough to be a region, as [a, b)."""
    runs, start = [], None
    for i, flag in enumerate(thin):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(thin)))
    return [(a, b) for a, b in runs if b - a >= params.DENSITY_MIN_RUN]


def _density_section(index: int, section: "GridSection", times: np.ndarray,
                     weights: np.ndarray, window_beats: int) -> dict | None:
    """The best-scoring pulse change inside one section, or None."""
    span = window_beats * section.period
    if span <= 0 or section.end_s - section.start_s < (2 * params.DENSITY_MIN_RUN + 1) * span:
        return None
    best = None
    for sub in params.DENSITY_SUBDIVISIONS:
        period = section.period / sub
        rows, edge = [], section.start_s
        while edge + span <= section.end_s + 1e-9:
            inside = (times >= edge) & (times < edge + span)
            coverage, parity, count = density_window(times[inside], weights[inside],
                                                     period, section.phase)
            rows.append({"at": edge, "coverage": coverage, "parity": parity, "n": count})
            edge += span
        if len(rows) < 2 * params.DENSITY_MIN_RUN + 1:
            continue
        thin = [r["coverage"] <= params.DENSITY_COVERAGE_MAX and r["parity"] >= params.DENSITY_PARITY_MIN
                and r["n"] >= 4 for r in rows]
        runs = _density_runs(thin)
        # A run covering the whole section means the subdivision guess is
        # simply too fine for this music, not that the pulse changes in it.
        if not runs or all(b - a >= len(thin) - 1 for a, b in runs):
            continue
        a, b = max(runs, key=lambda r: r[1] - r[0])   # the first of equal lengths
        covs = np.array([r["coverage"] for r in rows])
        outside = np.r_[covs[:a], covs[b:]]
        if outside.size == 0 or float(outside.mean()) - float(covs[a:b].mean()) < params.DENSITY_COVERAGE_DROP:
            continue
        from_s, to_s = float(rows[a]["at"]), float(rows[b - 1]["at"] + span)
        # The change sits at whichever edge of the run is not a section edge: a
        # half-time drop thins the tail, so it is where the run starts; a
        # double-time chorus thins the head, so it is where the run ends.
        # Reporting the start either way put the double-time case 25.6 s off.
        at_head, at_tail = a == 0, b >= len(rows)
        hint = {
            "section": int(index), "subdivision": int(sub),
            "from_s": round(from_s, 3), "to_s": round(to_s, 3),
            "boundary_s": round(to_s if (at_head and not at_tail) else from_s, 3),
            "thin_side": "head" if at_head else ("tail" if at_tail else "mid"),
            "factor": 0.5,          # the thinned region reads half the reported rate
            "coverage_in": round(float(covs[a:b].mean()), 3),
            "coverage_out": round(float(outside.mean()), 3),
            "parity_in": round(float(np.mean([r["parity"] for r in rows[a:b]])), 3),
            "parity_out": round(float(np.mean([r["parity"] for r in rows[:a] + rows[b:]])), 3),
            "windows": len(rows), "thinned": int(b - a),
        }
        # Rounded first, then multiplied and rounded again: two subdivisions
        # within rounding of each other must pick the same one every run.
        hint["score"] = round((hint["coverage_out"] - hint["coverage_in"]) * hint["parity_in"], 3)
        if best is None or hint["score"] > best["score"]:
            best = hint
    return best


def density_hints(analysis: "Analysis", window_beats: int = params.DENSITY_WINDOW_BEATS) -> list[dict]:
    """Where one reported section holds a half- or double-time region (F-11).

    Eight beats at a time, on the reported beat halved and quartered: a run of
    windows that is both empty enough and regular enough is a pulse change,
    not a drop. Each hint says which section, where the change sits, which end
    thinned out, the coverage and parity in and out, and a score to rank it
    by. Read only, plain JSON types: nothing here changes a BPM or a red line.
    """
    if window_beats < 1:
        raise ValueError("A window needs at least one beat.")
    times = np.asarray(getattr(analysis, "attack_times", []), dtype=np.float64)
    weights = np.asarray(getattr(analysis, "attack_weights", []), dtype=np.float64)
    sections = list(getattr(analysis, "sections", None) or [])
    if times.size == 0 or weights.shape != times.shape or not sections:
        return []
    order = np.argsort(times)
    times, weights = times[order], weights[order]
    hints = [_density_section(n, s, times, weights, window_beats)
             for n, s in enumerate(sections)]
    return [h for h in hints if h is not None]


def resnap_objects(beatmap: dict, pairs: list[dict]) -> dict:
    """Move hit objects onto the new grid after a timing change (Phase 21).

    ``pairs`` are :func:`inject_diff`'s: each old red beside its new value.
    An object start that sat on the old grid — snapped before, snapped still,
    by the snap audit's own 2 ms — moves by that span's drift, so it lands on
    the same beat of the new timing; slider heads move and their tails follow
    from the slider's own length under the new BPM, while spinner and hold
    ends move by the drift at their own time. Anything else stays exactly
    where the mapper put it and is listed, with its nearest divisor and miss:
    swing, drags and deliberate offsets are not "fixed". Times are rewritten
    whole-millisecond over the file's own object lines; every other byte of
    each line survives. A move landing before zero is skipped, never written
    negative. In place. Returns moved, left and skipped.
    """
    old_reds = [(float(p["old"]["offset_ms"]), float(p["old"]["bpm"])) for p in pairs]
    new_reds = [(float(p["new"]["offset_ms"]), float(p["new"]["bpm"])) for p in pairs]
    if not old_reds:
        raise ValueError("No red-line pairs to resnap onto.")

    def drift(time_ms: float) -> float:
        index = 0
        for i, red in enumerate(old_reds):
            if red[0] <= time_ms + 1e-9:
                index = i
        old_off, old_bpm = old_reds[index]
        new_off, new_bpm = new_reds[index]
        return new_off + (time_ms - old_off) * ((60000.0 / new_bpm) / (60000.0 / old_bpm))

    def shift(time_ms: float) -> int | None:
        moved = int(round(drift(time_ms)))
        return moved if moved >= 0 else None

    section = next((s for s in beatmap.get("sections", []) if s["name"] == "HitObjects"), None)
    if section is None:
        raise ValueError("No [HitObjects] section in this beatmap.")
    moved = skipped = 0
    left: list[dict] = []
    out: list[str] = []
    for line in section["lines"]:
        stripped = line.strip()
        obj = osu_read._parse_hit_object(line) if stripped else None
        if obj is None or obj.get("kind") == "unparsed" or "time" not in obj:
            if stripped and not stripped.startswith("//"):
                skipped += 1
            out.append(line)
            continue
        snap = map_objects._snap_of(float(obj["time"]), old_reds)
        if not snap["snapped"]:
            left.append({"time_ms": float(obj["time"]), "kind": obj.get("kind", "unparsed"),
                         "nearest_divisor": snap["divisor"], "off_ms": round(snap["off_ms"], 3)})
            out.append(line)
            continue
        start = shift(float(obj["time"]))
        if start is None:
            skipped += 1
            out.append(line)
            continue
        fields = line.split(",")
        fields[2] = str(start)
        if obj.get("kind") in ("spinner", "hold") and "end_time" in obj:
            end = shift(float(obj["end_time"]))
            if end is None:
                skipped += 1
                out.append(line)
                continue
            if obj["kind"] == "spinner":
                fields[5] = str(end)
            else:
                _head, _, tail = fields[5].partition(":")
                fields[5] = f"{end}:{tail}" if tail else str(end)
        out.append(",".join(fields))
        moved += 1
    section["lines"] = out
    objects = [line for line in out if line.strip() and not line.strip().startswith("//")]
    beatmap["hitobjects"] = [osu_read._parse_hit_object(line) for line in objects]
    return {"moved": moved, "left": left, "skipped": skipped}


def suggest_missing_lines(analysis: Analysis, beatmap: dict,
                          tolerance_beats: float = 1.0) -> list[dict]:
    """Detected sections with no nearby map red (Phase 9: timing suggestions).

    For every detected point past the first, the nearest map red line; when
    none sits within ``tolerance_beats`` of the detected tempo, the detector
    hears a change the map does not have. Proposals, never auto-fixes — Phase 7
    consents first. Each is ``{"index", "offset_ms", "bpm", "nearest_ms"}``
    with plain JSON types; a map with no reds proposes every section past the
    first, which is exactly timing-from-scratch assistance. ``meter`` is the
    bar the detector proved for that section, or None when it proved none.

    ``map_bpm`` is the tempo of the map's red line in force there (its first
    before it begins; None without one), and ``octave`` the factor (2, 4, 1/2,
    1/4) the suggestion sits at from it, within the band the octave finding
    uses, or None. Such a suggestion is more often the same pulse counted
    differently than a change the map lacks: on Corpus B 6 of 23 are, and
    they hold all five that move the slider ends under them past 25 ms.
    """
    if tolerance_beats <= 0:
        raise ValueError("Tolerance must be positive.")
    detected = exports.snap_timing_points(list(getattr(analysis, "points", None) or []))
    try:
        rows = sorted((float(offset), float(bpm))
                      for offset, bpm in beatmap.get("timing", {}).get("reds", []))
    except (TypeError, ValueError):
        rows = []
    rows = [(offset, bpm) for offset, bpm in rows if np.isfinite(offset) and np.isfinite(bpm)]
    reds = [offset for offset, _bpm in rows]
    suggestions: list[dict] = []
    for n in range(1, len(detected)):
        point = detected[n]
        if not np.isfinite(point.bpm) or point.bpm <= 0 or not np.isfinite(point.offset_ms):
            continue
        beat_ms = 60000.0 / point.bpm
        nearest = min((abs(red - point.offset_ms) for red in reds), default=float("inf"))
        if nearest > tolerance_beats * beat_ms:
            in_force = ([bpm for offset, bpm in rows if offset <= point.offset_ms]
                        or [bpm for _offset, bpm in rows[:1]])
            map_bpm = in_force[-1] if in_force and in_force[-1] > 0 else None
            suggestions.append({"index": n, "offset_ms": point.offset_ms,
                                "bpm": point.bpm,
                                # Infinity is not JSON: no red line reads as null.
                                "nearest_ms": None if nearest == float("inf") else nearest,
                                "meter": int(point.meter) if point.meter_known else None,
                                "map_bpm": map_bpm,
                                "octave": _octave_apart(point.bpm, map_bpm)})
    return suggestions


def _octave_apart(bpm: float, reference: float | None) -> float | None:
    """The factor (2, 4, 1/2 or 1/4) ``bpm`` sits at from ``reference``, when
    within OCTAVE_BAND_LOG of it in log2, as the octave finding reads a jump
    between sections; None for anything else, the same tempo included."""
    if reference is None or not (bpm > 0 and reference > 0):
        return None
    apart = float(np.log2(bpm / reference))
    return next((float(2.0 ** k) for k in (1, 2, -1, -2) if abs(apart - k) <= params.OCTAVE_BAND_LOG),
                None)


def add_red_line(beatmap: dict, offset_ms: float, bpm: float, meter: int | None = None,
                 decimals: int = 0) -> dict:
    """One red line into [TimingPoints], in place (Phase 9: apply a suggestion).

    A suggestion adds a line; it does not rewrite the map's timing the way
    inject does, so every other line keeps its bytes and its place. The new
    line carries the sample set, index, volume and kiai the map plays at its
    time, and goes before any green at that time (the order osu! reads).
    A red line resets slider velocity, so where the map would then play
    differently — a velocity other than 1.0 in force there — a green at the
    same time restores what it played. The meter is the one the detector
    proved there, else the map's own at that time: a bar nobody measured is
    not invented. Offsets are whole milliseconds unless ``decimals`` says
    otherwise, as inject writes them.

    What it does change is the beat that objects follow from its time to the
    next red line, which is the point; sliders there keep their length in
    beats, so their ends move with the tempo, and the summary says by how
    much. ``map_bpm`` is the tempo of the map's own red line in force there:
    a suggestion at twice or four times it is more often the same pulse
    counted differently than a new tempo, and that is where slider ends move
    furthest (on Corpus B, every shift past 25 ms). Returns ``row``,
    ``offset_ms`` (as written), ``bpm``, ``meter``, ``map_bpm`` (None
    without a red line), ``greens_added``, ``objects`` (under the new line),
    ``sliders`` (of those), ``slider_ends_moved`` (by half a millisecond or
    more) and ``max_end_shift_ms`` (signed, None without sliders). Plain JSON
    types.
    """
    section = next((s for s in beatmap.get("sections", []) if s.get("name") == "TimingPoints"),
                   None)
    if section is None:
        raise ValueError("No [TimingPoints] section in this beatmap.")
    try:
        offset_ms, bpm = float(offset_ms), float(bpm)
    except (TypeError, ValueError) as exc:
        raise ValueError("A red line needs a time and a BPM.") from exc
    if not (np.isfinite(offset_ms) and np.isfinite(bpm)) or bpm <= 0:
        raise ValueError("A red line needs a finite time and a positive BPM.")
    if meter is not None and (isinstance(meter, bool) or int(meter) != meter
                              or int(meter) not in params.EDIT_METERS):
        raise ValueError(f"A bar holds {params.EDIT_METERS.start} to {params.EDIT_METERS.stop - 1} beats.")
    stamp = f"{offset_ms:.{int(decimals)}f}" if decimals > 0 else str(int(round(offset_ms)))
    time_ms = float(stamp)

    points: list[dict] = []
    for order, line in enumerate(section["lines"]):
        text = line.strip()
        if text and not text.startswith("//") and (point := osu_write._timing_point_fields(text)) is not None:
            point.update(order=order, line=order)
            points.append(point)
    reds = osu_write._ordered([q for q in points if q["red"]])
    clash = next((q for q in reds if abs(q["time"] - time_ms) < params.RED_LINE_CLASH_MS), None)
    if clash is not None:
        raise ValueError(f"A red line already sits at {clash['time']:g} ms.")
    # The map's own red line in force there (its first, before it begins).
    governing = [q for q in reds if q["time"] <= time_ms + 1e-6] or reds[:1]
    in_force = governing[-1] if governing else None
    if meter is None:
        meter = max(1, in_force["meter"]) if in_force is not None else 4
    state = osu_write._states_at_events(points, [time_ms])[0]
    sample_set, sample_index, volume, kiai = (
        (state.sample_set, state.sample_index, state.volume, state.kiai) if state is not None
        else (0, 0, 100, False))
    row = f"{stamp},{60000.0 / bpm:.12f},{int(meter)},{sample_set},{sample_index},{volume},1,{int(kiai)}"

    before = sounds._TimingCursor(beatmap)
    # Before the first point at or after its time; after the last point when
    # none is, so blank lines closing the section stay where they are.
    at = next((q["line"] for q in points if q["time"] >= time_ms - 1e-6),
              max((q["line"] for q in points), default=-1) + 1)
    red = osu_write._timing_point_fields(row)
    red.update(order=-1)
    endings = section.get("endings")
    aligned = endings is not None and len(endings) == len(section["lines"])
    section["lines"].insert(at, row)
    if aligned:
        endings.insert(at, None)

    # Wherever the map would now play differently, a green restores it.
    events = sorted({q["time"] for q in points} | {time_ms})
    wanted = osu_write._states_at_events(points, events)
    added: list[dict] = []
    for event, want in zip(events, wanted):
        if event < time_ms - 1e-6 or want is None:
            continue
        have = osu_write._states_at_events(points + [red] + added, [event])[0]
        if have is not None and have.same_as(want):
            continue
        governing = [q for q in osu_write._ordered(reds + [red]) if q["time"] <= event + 1e-6]
        text = (stamp if abs(event - time_ms) <= 1e-6
                else osu_read._point_time_text(section, event) or f"{event:g}")
        green = (f"{text},{-100.0 / want.sv:.12g},{governing[-1]['meter']},{want.sample_set},"
                 f"{want.sample_index},{want.volume},0,{int(want.kiai)}")
        point = osu_write._timing_point_fields(green)
        point.update(order=len(section["lines"]) + len(added))
        added.append(point)
        if abs(event - time_ms) <= 1e-6:
            section["lines"].insert(at + 1, green)
            if aligned:
                endings.insert(at + 1, None)
        else:
            osu_read._insert_timing_line(section, green)

    timing = [line for line in section["lines"]
              if line.strip() and not line.strip().startswith("//")]
    beatmap["timing"] = {
        "reds": [red for line in timing if (red := osu_read._parse_red_line(line)) is not None],
        "greens": [line for line in timing if not osu_write._is_red_line(line.strip())],
    }

    # The objects the new line times, up to the next red line, and how far
    # the ends of the sliders among them move at the new beat length.
    after = sounds._TimingCursor(beatmap)
    until = next((q["time"] for q in reds if q["time"] > time_ms + 1e-6), float("inf"))
    try:
        multiplier = float((beatmap.get("difficulty") or {}).get("SliderMultiplier", 1.4))
    except (TypeError, ValueError):
        multiplier = 1.4
    if not np.isfinite(multiplier) or multiplier <= 0:
        multiplier = 1.4

    def end_of(obj: dict, cursor: _TimingCursor) -> float | None:
        beat, play = cursor.at(float(obj["time"]))
        sv = play.sv if play is not None else 1.0
        length = float(obj.get("length", 0.0) or 0.0)
        if not beat or sv <= 0 or length <= 0 or not np.isfinite(length):
            return None
        slides = max(1, sounds._sample_int(obj.get("slides"), 1))
        return float(obj["time"]) + length / (multiplier * 100.0 * sv) * beat * slides

    under = []
    for obj in beatmap.get("hitobjects", []):
        try:
            start = float(obj["time"])
        except (KeyError, TypeError, ValueError):
            continue
        if np.isfinite(start) and time_ms - 1e-6 <= start < until - 1e-6:
            under.append(obj)
    shifts = []
    for obj in under:
        if obj.get("kind") == "slider":
            old, new = end_of(obj, before), end_of(obj, after)
            if old is not None and new is not None:
                shifts.append(new - old)
    worst = max(shifts, key=abs) if shifts else None
    map_bpm = (60000.0 / in_force["beat_length"]
               if in_force is not None and in_force["beat_length"] > 0 else None)
    return {"row": row, "offset_ms": time_ms, "bpm": bpm, "meter": int(meter), "map_bpm": map_bpm,
            "greens_added": len(added), "objects": len(under), "sliders": len(shifts),
            "slider_ends_moved": sum(1 for s in shifts if abs(s) >= 0.5),
            "max_end_shift_ms": None if worst is None else round(worst, 1)}


def _nearest_sorted(values: np.ndarray, target: float) -> float:
    """Nearest entry of a sorted array (binary search, edges included)."""
    idx = int(np.searchsorted(values, target))
    candidates = [v for v in (idx - 1, idx) if 0 <= v < values.size]
    if not candidates:
        return float("inf")
    return float(min((values[v] for v in candidates), key=lambda v: abs(v - target)))
