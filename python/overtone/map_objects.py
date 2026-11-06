"""Objects against attacks: alignment, density, snap."""
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

from . import exports, octave_choice, params


# ---------------------------------------------------------------------------
# Objects against attacks: alignment, density, snap
# ---------------------------------------------------------------------------


def _object_step(obj: dict, other: dict | None) -> float | None:
    """Playfield distance in pixels, None when either end lacks a position."""
    if other is None:
        return None
    try:
        return float(np.hypot(obj["x"] - other["x"], obj["y"] - other["y"]))
    except (TypeError, KeyError):
        return None


def _pattern_class(gap_prev: float | None, step_prev: float | None,
                   gap_next: float | None, step_next: float | None
                   ) -> tuple[str, float | None]:
    """Coarse pattern class plus the deciding step (nearest neighbour first),
    as the density report counts streams and jumps. No neighbour with a
    position: single.
    """
    gaps = [(g, s) for g, s in ((gap_prev, step_prev), (gap_next, step_next))
            if g is not None and s is not None]
    if not gaps:
        return "single", None
    gap, step = min(gaps, key=lambda gs: gs[0])
    if gap < params.STREAM_GAP_MS and step < params.STREAM_STEP_PX:
        return "stream", step
    if step >= params.JUMP_STEP_PX and gap < params.JUMP_GAP_MS:
        return "jump", step
    return "single", step


def alignment_report(analysis: Analysis, beatmap: dict,
                     tolerance_ms: float = params.OBJECT_WINDOW_MS) -> dict:
    """Objects not on attacks; strong attacks with no object (Phase 7, row 3).

    Objects match their nearest attack start, slider ends excluded — an end
    is a release, not a hit to land. Only attacks at half the
    strongest weight or above can leave an object uncovered: ghost notes stay
    unmapped on purpose, and flagging them would be noise, not signal. Attack
    times arrive in seconds (engine convention) and are reported in
    milliseconds (map convention). Findings
    stay summarized (counts plus worst case) rather than one banner per object
    because a real map holds hundreds. Legacy analyses carry no attacks, so
    they report that instead of inventing alignment. All plain JSON types.
    """
    times = np.asarray(getattr(analysis, "attack_times", []), dtype=np.float64) * 1000.0
    weights = np.asarray(getattr(analysis, "attack_weights", []), dtype=np.float64)
    try:
        objects = [(float(o["time"]), o.get("kind")) for o in beatmap.get("hitobjects", [])
                   if isinstance(o, dict) and np.isfinite(o.get("time", float("nan")))]
    except (TypeError, ValueError):
        objects = []
    objects.sort()
    otimes = np.array([t for t, _kind in objects])
    if times.size == 0:
        return {"objects": len(objects), "matched": 0, "attacks": 0, "covered": 0,
                "offenders": [], "uncovered": [],
                "findings": [{"level": "info", "key": "no_attacks",
                              "index": -1, "values": {}}]}

    offenders: list[dict] = []
    for time, kind in objects:
        near = octave_choice._nearest_sorted(times, time)
        ms = abs(time - near)
        if ms > tolerance_ms:
            offenders.append({"time": time, "kind": kind, "ms": round(ms, 1)})

    peak = float(weights.max()) if weights.size else 0.0
    strong = times if peak <= 0 else times[np.asarray(weights) >= 0.5 * peak]
    uncovered: list[float] = []
    for attack in strong:
        if otimes.size == 0 or abs(float(attack) - octave_choice._nearest_sorted(otimes, float(attack))) > tolerance_ms:
            uncovered.append(round(float(attack), 1))

    findings: list[dict] = []
    if offenders:
        worst = max(o["ms"] for o in offenders)
        findings.append({"level": "warn", "key": "objects_off_grid", "index": -1,
                         "values": {"n": len(offenders), "worst": worst}})
    if uncovered:
        findings.append({"level": "warn", "key": "attacks_without_objects", "index": -1,
                         "values": {"n": len(uncovered)}})
    return {"objects": len(objects), "matched": len(objects) - len(offenders),
            "attacks": int(times.size), "covered": int(len(strong) - len(uncovered)),
            "offenders": offenders, "uncovered": uncovered, "findings": findings}


def density_report(beatmap: dict, bucket_s: float = 5.0) -> dict:
    """Objects per second plus stream/jump/single breakdown over time (P7).

    Buckets cover the map from 0 to the last object; every bucket reports its
    count, rate and pattern split by ``_pattern_class``.
    Spinners and holds count once at their start — the report measures hit
    density, not held time. Empty maps report zeros, and everything stays
    plain JSON types.
    """
    if bucket_s <= 0:
        raise ValueError("Bucket length must be positive.")
    try:
        objects = [o for o in beatmap.get("hitobjects", [])
                   if isinstance(o, dict) and np.isfinite(o.get("time", float("nan")))]
    except (TypeError, ValueError):
        objects = []
    objects.sort(key=lambda o: o["time"])
    if not objects:
        return {"objects": 0, "buckets": [], "peak_per_second": 0.0,
                "mean_per_second": 0.0, "stream": 0, "jump": 0, "single": 0}
    kinds: list[str] = []
    for i, obj in enumerate(objects):
        prev = objects[i - 1] if i > 0 else None
        nxt = objects[i + 1] if i + 1 < len(objects) else None
        gap_prev = float(obj["time"] - prev["time"]) if prev else None
        gap_next = float(nxt["time"] - obj["time"]) if nxt else None
        pattern, _step = _pattern_class(gap_prev, _object_step(obj, prev),
                                        gap_next, _object_step(obj, nxt))
        kinds.append(pattern)
    last_ms = float(objects[-1]["time"])
    span_s = last_ms / 1000.0
    count = max(1, int(np.ceil(span_s / bucket_s)))
    buckets: list[dict] = []
    for b in range(count):
        t0, t1 = b * bucket_s, (b + 1) * bucket_s
        in_bucket = [k for o, k in zip(objects, kinds)
                     if t0 <= o["time"] / 1000.0 < t1 or (b == count - 1 and o["time"] / 1000.0 == t1)]
        buckets.append({"t0": round(t0, 2), "t1": round(t1, 2), "objects": len(in_bucket),
                        "per_second": round(len(in_bucket) / bucket_s, 2),
                        "stream": in_bucket.count("stream"),
                        "jump": in_bucket.count("jump"),
                        "single": in_bucket.count("single")})
    rates = [b["per_second"] for b in buckets]
    totals = {kind: kinds.count(kind) for kind in ("stream", "jump", "single")}
    return {"objects": len(objects), "buckets": buckets,
            "peak_per_second": max(rates), "mean_per_second": round(sum(rates) / len(rates), 2),
            **totals}


def _snap_of(time_ms: float, reds: list[tuple[float, float]]) -> dict:
    """Where one time sits on a red-line grid: the coarsest divisor it hits
    within OBJECT_SNAP_TOLERANCE_MS, or the nearest tick it misses."""
    governing = reds[0]
    for red in reds:
        if red[0] <= time_ms + 1e-9:
            governing = red
    offset, bpm = governing
    beat_ms = 60000.0 / bpm
    position = (time_ms - offset) / beat_ms
    best = None
    for divisor in params.SNAP_DIVISORS:
        tick = round(position * divisor) / divisor
        off = time_ms - (offset + tick * beat_ms)
        if abs(off) <= params.OBJECT_SNAP_TOLERANCE_MS:
            return {"divisor": divisor, "off_ms": off, "snapped": True}
        if best is None or abs(off) < abs(best["off_ms"]) - 1e-9:
            best = {"divisor": divisor, "off_ms": off, "snapped": False}
    return best


def snap_audit(beatmap: dict, analysis: Analysis | None = None,
               duration_s: float | None = None) -> dict:
    """Objects off the map's own grid, and what a new timing would unsnap
    (Phase 7, "Snap audit").

    Every object start is placed on the red line governing it at the snap
    divisors the editor offers (1/1 to 1/16). An object on none of them within
    OBJECT_SNAP_TOLERANCE_MS is listed with the nearest tick and how far it misses.
    Objects before the first red line and, given the audio length, past its
    end are listed too. With an analysis, the same audit runs against the red
    lines an inject would write, and the report says how many objects that
    would move off the grid and how many it would put back on — the question
    to ask before injecting. Starts only, like the alignment check: slider
    ends follow from length and slider velocity, and spinner and hold ends are
    not audited yet. Nothing is changed. All plain JSON types.
    """
    reds = sorted(beatmap.get("timing", {}).get("reds", []))
    objects = [o for o in beatmap.get("hitobjects", []) if "time" in o]
    unparsed = sum(1 for o in beatmap.get("hitobjects", []) if "time" not in o)
    if not reds:
        return {"ok": False, "reason": "no_red_lines", "objects": len(objects),
                "unparsed": unparsed}
    audited, histogram = [], {str(d): 0 for d in params.SNAP_DIVISORS}
    for obj in objects:
        snap = _snap_of(float(obj["time"]), reds)
        audited.append((obj, snap))
        if snap["snapped"]:
            histogram[str(snap["divisor"])] += 1
    unsnapped = [{"time_ms": float(obj["time"]), "kind": obj.get("kind", "unparsed"),
                  "nearest_divisor": snap["divisor"], "off_ms": round(snap["off_ms"], 3)}
                 for obj, snap in audited if not snap["snapped"]]
    report = {
        "ok": True,
        "objects": len(objects),
        "unparsed": unparsed,
        "red_lines": len(reds),
        "snapped": len(objects) - len(unsnapped),
        "by_divisor": histogram,
        "unsnapped": unsnapped,
        "before_first_red": [float(o["time"]) for o in objects if o["time"] < reds[0][0]],
        "past_audio": ([float(o["time"]) for o in objects if o["time"] > duration_s * 1000.0]
                       if duration_s is not None else None),
    }
    if analysis is not None:
        detected = [(p.offset_ms, p.bpm) for p in exports.snap_timing_points(analysis.points)
                    if np.isfinite(p.offset_ms) and p.bpm > 0]
        if detected:
            detected.sort()
            would_unsnap, would_snap = [], 0
            for obj, snap in audited:
                after = _snap_of(float(obj["time"]), detected)
                if snap["snapped"] and not after["snapped"]:
                    would_unsnap.append({"time_ms": float(obj["time"]),
                                         "nearest_divisor": after["divisor"],
                                         "off_ms": round(after["off_ms"], 3)})
                elif after["snapped"] and not snap["snapped"]:
                    would_snap += 1
            report["with_detected_timing"] = {"would_unsnap": would_unsnap,
                                              "would_snap": would_snap}
    return report


def snap_divisors(analysis: Analysis, tol_ms: float = params.DIVISOR_TOLERANCE_MS) -> dict:
    """Where the song needs 1/3, 1/4 or 1/6, per section (Phase 21).

    Every attack takes the coarsest of the 1/1-1/16 grids it sits on within
    ``tol_ms`` — the same divisors the editor offers — and each section
    counts how many need thirds (divisor 3), sixths (6 and nothing coarser),
    finer grids (8 and up, past this row's scope but reported), or none (far
    off-grid feel such as heavy shuffle lives here; the swing lane is its own
    row). The verdict follows the weight, not the count: a section reads 1/6
    past the count and weight bars, else 1/3, else 1/4 — a soft triplet still
    counts, but the prominent rhythm decides. Read only, plain JSON types.
    """
    if tol_ms <= 0:
        raise ValueError("Tolerance must be positive.")
    points = [p for p in list(getattr(analysis, "points", None) or [])
              if np.isfinite(getattr(p, "offset_ms", float("nan")))
              and np.isfinite(getattr(p, "bpm", float("nan"))) and p.bpm > 0]
    times = np.asarray(getattr(analysis, "attack_times", []), dtype=np.float64) * 1000.0
    weights = np.asarray(getattr(analysis, "attack_weights", []), dtype=np.float64)
    finite = np.isfinite(times)
    times = times[finite]
    weights = weights[finite] if weights.shape == finite.shape else np.ones_like(times)
    weights = np.where(np.isfinite(weights) & (weights > 0), weights, 0.0)
    duration_ms = float(getattr(analysis, "duration", 0.0) or 0.0) * 1000.0
    out = []
    for i, point in enumerate(points):
        offset, bpm = float(point.offset_ms), float(point.bpm)
        end = float(points[i + 1].offset_ms) if i + 1 < len(points) else duration_ms
        beat_ms = 60000.0 / bpm
        in_span = (times >= offset - 1e-6) & (times < end - 1e-6)
        span, span_w = times[in_span], weights[in_span]
        thirds = sixths = finer = other = 0
        thirds_w = sixths_w = 0.0
        for attack, weight in zip(span, span_w):
            position = (float(attack) - offset) / beat_ms
            hit = None
            for divisor in params.SNAP_DIVISORS:
                tick = round(position * divisor) / divisor
                if abs(position - tick) * beat_ms <= float(tol_ms) + 1e-9:
                    hit = divisor
                    break
            if hit is None:
                other += 1
            elif hit == 3:
                thirds += 1
                thirds_w += float(weight)
            elif hit == 6:
                sixths += 1
                sixths_w += float(weight)
            elif hit in (8, 12, 16):
                finer += 1
        total = len(span)
        weight_total = float(span_w.sum())
        sixth_share = sixths_w / weight_total if weight_total > 0 else 0.0
        third_share = thirds_w / weight_total if weight_total > 0 else 0.0
        if sixths >= params.DIVISOR_MIN_COUNT and sixth_share >= params.DIVISOR_MIN_WSHARE:
            divisor = "1/6"
        elif thirds >= params.DIVISOR_MIN_COUNT and third_share >= params.DIVISOR_MIN_WSHARE:
            divisor = "1/3"
        else:
            divisor = "1/4"
        out.append({"offset_ms": round(offset, 3), "bpm": round(bpm, 3),
                    "attacks": int(total), "quarters": total - thirds - sixths - finer - other,
                    "thirds": thirds, "sixths": sixths, "finer": finer, "other": other,
                    "third_share": round(third_share, 3),
                    "sixth_share": round(sixth_share, 3),
                    "divisor": divisor})
    return {"sections": out}


def _swing_peak(x: np.ndarray, w: np.ndarray, lo: float, hi: float, tol: float,
                beat_ms: float) -> tuple[float | None, np.ndarray]:
    """The weighted median of the values within ``tol`` of the densest place
    between ``lo`` and ``hi`` (a 6 ms kernel, 1 ms steps), and which values
    those are. None when nothing with weight lies there."""
    zone = (x >= lo) & (x <= hi)
    if hi <= lo or not zone.any() or float(w[zone].sum()) <= 0:
        return None, np.zeros_like(zone)
    grid = np.linspace(lo, hi, max(int((hi - lo) * beat_ms), 8))
    sigma = max(6.0 / beat_ms, 1e-3)
    density = (w[zone][None, :]
               * np.exp(-0.5 * ((grid[:, None] - x[zone][None, :]) / sigma) ** 2)).sum(axis=1)
    peak = float(grid[int(np.argmax(density))])
    near = zone & (np.abs(x - peak) <= tol)
    order = np.argsort(x[near])
    cumulative = np.cumsum(w[near][order])
    middle = min(int(np.searchsorted(cumulative, cumulative[-1] / 2.0)), len(order) - 1)
    return float(x[near][order][middle]), near


def _swing_window(phases: np.ndarray, weights: np.ndarray, beat_of: np.ndarray,
                  beats: int, beat_ms: float, tol_ms: float) -> dict:
    """One window's feel from its attacks' places within their beats."""
    tol = tol_ms / beat_ms
    need = (beats + 1) // 2

    def on_beats(mask: np.ndarray) -> int:
        return len(set(beat_of[mask].tolist()))

    out = {"feel": "none", "at": None, "on_ms": None}
    wrapped = np.where(phases > 1.0 - params.SWING_ON_SPAN, phases - 1.0, phases)
    on_at, on = _swing_peak(wrapped, weights, -params.SWING_ON_SPAN, params.SWING_ON_SPAN, tol, beat_ms)
    if on_at is None or on_beats(on) < need:
        return out  # no beat of its own to measure the eighth from
    out["on_ms"] = round(on_at * beat_ms, 1)
    rel = phases - on_at
    rel = np.where(rel < -params.SWING_ON_SPAN, rel + 1.0, rel)
    straight = np.abs(rel - 0.5) <= tol
    at, late = _swing_peak(rel, weights, 0.5 + 2.0 * tol, params.SWING_LATE_MAX, tol, beat_ms)
    late_w = float(weights[late].sum()) if at is not None else 0.0
    if (at is not None and at - 0.5 >= 2.0 * tol and on_beats(late) >= need
            and float(weights[straight].sum()) <= params.SWING_MAX_STRAIGHT * late_w
            and late_w >= params.SWING_MIN_SHARE * float(weights.sum())):
        thirds = float(weights[np.abs(rel - 1.0 / 3.0) <= tol].sum())
        triplet = abs(at - 2.0 / 3.0) * beat_ms <= tol_ms and thirds >= 0.5 * late_w
        out.update(feel="triplets" if triplet else "swing", at=at)
    elif on_beats(straight) >= need:
        out.update(feel="straight", at=0.5)
    return out


def _swung(at: float, beat_ms: float, tol_ms: float) -> dict:
    """A swung eighth's numbers: where (a share of the beat), the ratio of the
    pair, how late in ms, and the coarsest editor snap within ``tol_ms``."""
    out = {"at": round(at, 3), "ratio": round(at / (1.0 - at), 2),
           "late_ms": round((at - 0.5) * beat_ms, 1),
           "snap": None, "divisor": None, "snap_off_ms": None}
    for divisor in params.SNAP_DIVISORS[1:]:
        tick = round(at * divisor)
        if abs(at - tick / divisor) * beat_ms <= float(tol_ms) + 1e-9:
            common = int(np.gcd(tick, divisor))
            out.update(snap=f"{tick // common}/{divisor // common}", divisor=divisor,
                       snap_off_ms=round((at - tick / divisor) * beat_ms, 1))
            break
    return out


def swing_lane(points: list, attack_times: np.ndarray, attack_weights: np.ndarray,
               duration_s: float, tol_ms: float = params.DIVISOR_TOLERANCE_MS,
               window_beats: int = params.SWING_WINDOW_BEATS) -> dict:
    """Where the music swings, eight beats at a time (Phase 21).

    Within each beat of the red lines' grid, where does the off-beat eighth
    fall: halfway (straight), later (swing: 0.58 light, 0.67 the triplet
    swing, 0.75 a hard shuffle), or on the thirds as well (triplets)? Measured
    from the window's own beat -- the densest place its attacks sit around the
    beats -- so a grid a few ms off moves nothing, and that beat's distance from
    the grid comes back as ``on_ms``. A window swings when its late eighth sits
    two tolerances past the straight one (the two never overlap), on at least
    half its beats, with a tenth of the window's attack weight, and the
    straight eighth is nearly empty; one that neither swings nor keeps a
    straight eighth on half its beats says ``none``. For a swung window: the
    coarsest editor snap within ``tol_ms`` of the eighth, and how far off.
    Windows restart at each red line; a remainder under half a window joins
    the one before. Consecutive swung windows of one feel and tempo make a
    span, its eighth the median of theirs. Read only, plain JSON types.
    """
    if tol_ms <= 0:
        raise ValueError("Tolerance must be positive.")
    if window_beats < 2:
        raise ValueError("A window needs at least two beats.")
    points = [p for p in list(points or [])
              if np.isfinite(getattr(p, "offset_ms", float("nan")))
              and np.isfinite(getattr(p, "bpm", float("nan"))) and p.bpm > 0]
    times = np.asarray(attack_times, dtype=np.float64) * 1000.0
    weights = np.asarray(attack_weights, dtype=np.float64)
    if weights.shape != times.shape:
        weights = np.ones_like(times)
    keep = np.isfinite(times) & np.isfinite(weights) & (weights > 0)
    order = np.argsort(times[keep])
    times, weights = times[keep][order], weights[keep][order]
    duration_ms = float(duration_s or 0.0) * 1000.0
    windows = []
    for i, point in enumerate(points):
        offset, bpm = float(point.offset_ms), float(point.bpm)
        end = float(points[i + 1].offset_ms) if i + 1 < len(points) else duration_ms
        beat_ms = 60000.0 / bpm
        count = int(np.floor((end - offset) / beat_ms + 1e-9))
        if count < 1:
            continue
        cuts = list(range(0, count, window_beats))
        if len(cuts) > 1 and count - cuts[-1] < (window_beats + 1) // 2:
            cuts.pop()
        for k, first in enumerate(cuts):
            last = cuts[k + 1] if k + 1 < len(cuts) else count
            starts = offset + np.arange(first, last) * beat_ms
            a, b = np.searchsorted(times, [starts[0], starts[-1] + beat_ms])
            beat_of = np.searchsorted(starts, times[a:b], side="right") - 1
            phases = (times[a:b] - starts[beat_of]) / beat_ms
            feel = _swing_window(phases, weights[a:b], beat_of, last - first, beat_ms, tol_ms)
            row = {"start_ms": round(float(starts[0]), 3),
                   "end_ms": round(float(starts[-1] + beat_ms), 3),
                   "bpm": round(bpm, 3), "beats": int(last - first),
                   "feel": feel["feel"], "at": None, "ratio": None, "late_ms": None,
                   "snap": None, "divisor": None, "snap_off_ms": None,
                   "on_ms": feel["on_ms"]}
            if feel["feel"] == "straight":
                row["at"] = 0.5
            elif feel["at"] is not None:
                row.update(_swung(feel["at"], beat_ms, tol_ms))
            windows.append(row)
    spans = []
    for row in windows:
        if row["feel"] not in ("swing", "triplets"):
            continue
        last = spans[-1] if spans else None
        # the next window starts where the last one ended (a dropped partial
        # beat at a red line aside): a window of another feel between breaks it
        if (last is not None and row["start_ms"] - last["end_ms"] < 30000.0 / row["bpm"]
                and last["feel"] == row["feel"] and last["bpm"] == row["bpm"]):
            last["_at"].append(row["at"])
            last["end_ms"] = row["end_ms"]
            last["windows"] += 1
        else:
            spans.append({"start_ms": row["start_ms"], "end_ms": row["end_ms"], "bpm": row["bpm"],
                          "feel": row["feel"], "windows": 1, "_at": [row["at"]]})
    for span in spans:
        at = float(np.median(span.pop("_at")))
        span.update(_swung(at, 60000.0 / span["bpm"], tol_ms))
    return {"windows": windows, "spans": spans,
            "swung": sum(r["feel"] in ("swing", "triplets") for r in windows),
            "measured": sum(r["feel"] != "none" for r in windows),
            "window_beats": int(window_beats), "tol_ms": float(tol_ms)}
