"""The structure view and assisted timing."""
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

from . import data_model, editing, exports, params, precision_grid, reference_timing


# ---------------------------------------------------------------------------
# Structure view (Phase 19): the Rust engine's phrases, on this song's bars
# ---------------------------------------------------------------------------


def downbeat_times(analysis: Analysis) -> list[tuple[float, bool]]:
    """Every bar line the red lines imply, as ``(seconds, proven)``.

    The bars ``click_schedule`` accents, by the same rules: each red line
    counts bars from its own offset, in its own meter when it proved one,
    else in the song's. ``proven`` is True where the line's bar was proved
    by the accents or set by the mapper; a bar counted on a guessed meter
    is a bar line, but not evidence for a phrase.
    """
    return [(t, proven) for t, proven, _bar in _bar_lines(analysis)]


def _bar_lines(analysis: Analysis) -> list[tuple[float, bool, float]]:
    """:func:`downbeat_times` with each line's own bar length in seconds:
    ``(seconds, proven, bar)``. A bar a later red line cuts short keeps its
    line's length here, so a level read over "one bar" is always a bar."""
    points = exports.snap_timing_points(list(getattr(analysis, "points", None) or []))
    duration = float(getattr(analysis, "duration", 0.0) or 0.0)
    try:
        song_bar = max(1, min(16, int(str(getattr(analysis, "meter", "4/4")).split("/")[0])))
    except (ValueError, TypeError):
        song_bar = 4
    out: list[tuple[float, bool, float]] = []
    for s, point in enumerate(points):
        if not np.isfinite(point.bpm) or point.bpm <= 0 or not np.isfinite(point.offset_ms):
            continue
        proven = bool(point.meter_known or point.manual)
        bar = max(1, int(point.meter or 4)) if point.meter_known else song_bar
        start = point.offset_ms / 1000.0
        end = duration if s + 1 == len(points) else points[s + 1].offset_ms / 1000.0
        step = bar * 60.0 / point.bpm
        for k in range(params.MAX_CLICKS_PER_LINE):
            t = start + k * step
            if t >= end - 1e-6 and not (s + 1 == len(points) and t <= end + 1e-6):
                break
            out.append((t, proven, step))
    return out


def _lane_power(energy: np.ndarray, hop: float, start: float, end: float) -> float | None:
    """Mean power of the RMS lane over ``[start, end)``, each window weighed by
    how much of it the span covers; the span is clipped to the lane first.
    None when nothing of it is on the lane."""
    start, end = max(start, 0.0), min(end, energy.size * hop)
    if hop <= 0 or end <= start:
        return None
    first, last = int(np.floor(start / hop)), min(int(np.ceil(end / hop)), energy.size)
    edges = np.arange(first, last) * hop
    cover = np.clip(np.minimum(edges + hop, end) - np.maximum(edges, start), 0.0, None)
    return float(np.sum(cover * energy[first:last] ** 2) / (end - start))


def _bar_change_db(energy: np.ndarray, hop: float, bar: float, before: float,
                   after: float) -> float:
    """The level of the bar from ``bar`` on over the bar before it, in dB.
    0.0 where either side is off the lane: no level, no evidence."""
    later = _lane_power(energy, hop, bar, bar + after)
    earlier = _lane_power(energy, hop, bar - before, bar)
    if later is None or earlier is None:
        return 0.0
    return float(10.0 * np.log10(max(later, 1e-12) / max(earlier, 1e-12)))


def _pooled_lane(values: list[float], hop: float, points: int) -> dict:
    """The energy lane at most ``points`` long: each point the loudest of the
    windows it covers, so a short hit survives the pooling."""
    energy = np.asarray(values, dtype=np.float64)
    if energy.size == 0:
        return {"values": [], "hop": hop}
    factor = max(1, int(np.ceil(energy.size / points)))
    usable = energy[: energy.size - energy.size % factor] if factor > 1 else energy
    pooled = usable.reshape(-1, factor).max(axis=1) if factor > 1 else usable
    if factor > 1 and energy.size % factor:
        pooled = np.append(pooled, energy[energy.size - energy.size % factor:].max())
    peak = float(pooled.max()) or 1.0
    return {"values": [round(float(v) / peak, 4) for v in pooled], "hop": hop * factor}


def structure_view(report: dict, analysis: Analysis) -> dict:
    """The Structure view of one song: phrases snapped to proven downbeats,
    each label beside the evidence it rests on. Plain types.

    ``report`` is ``overtone-cli structure``'s JSON. Each inner boundary
    moves to the nearest proven downbeat within ``STRUCTURE_SNAP_S``, or to
    the proven bar line either side of it when the level changes more there
    (``STRUCTURE_PHRASE_MARGIN_DB``), the way it goes from the section before
    to the one after: one bar after the line against one bar before, on the
    report's energy lane. Each says how far it moved, which of the two put
    it there and the change at its bar. One with no proven downbeat that
    close stays on the 0.5 s feature grid and says so. The song's start and
    end never move.

    Labels are the Rust rules' (repetition, then level); ``why`` names the
    rule that decided each one, with the numbers it read. Groups are letters
    by first appearance, so "A B A B" reads at a glance whatever the labels.
    """
    duration = float(report.get("duration") or getattr(analysis, "duration", 0.0) or 0.0)
    lines = _bar_lines(analysis)
    every = np.asarray([t for t, _known, _bar in lines], dtype=np.float64)
    known = np.asarray([k for _t, k, _bar in lines], dtype=bool)
    length = np.asarray([b for _t, _known, b in lines], dtype=np.float64)
    raw = list(report.get("sections") or [])
    energy = np.asarray(report.get("energy") or [], dtype=np.float64)
    hop = float(report.get("energy_hop") or 0.5)

    def snap(t: float, rising: bool) -> tuple[float, float | None, str | None, float | None]:
        """Where an edge lands, how far it moved, which rule put it there and
        the level change at its bar: ``(t, None, None, None)`` with no proven
        bar close enough."""
        if not known.any():
            return t, None, None, None
        n = int(np.argmin(np.where(known, np.abs(every - t), np.inf)))
        if abs(every[n] - t) > params.STRUCTURE_SNAP_S:
            return t, None, None, None
        sign = 1.0 if rising else -1.0
        # A bar against the one before it, each its own line's length.
        change = {i: _bar_change_db(energy, hop, float(every[i]),
                                    float(length[i - 1] if i > 0 else length[i]), float(length[i]))
                  for i in (n - 1, n, n + 1) if 0 <= i < every.size and known[i]}
        # Ties go to the nearest line, then to the earlier one.
        best = max(change, key=lambda i: (sign * change[i], -abs(i - n), -i))
        if sign * change[best] < sign * change[n] + params.STRUCTURE_PHRASE_MARGIN_DB:
            best = n
        to = float(every[best])
        return to, to - t, "nearest" if best == n else "level", round(change[best], 1)

    edges = [snap(float(raw[i]["start_s"]),
                  float(raw[i]["level_db"]) >= float(raw[i - 1]["level_db"]))
             for i in range(1, len(raw))]

    def bar_number(t: float) -> int | None:
        # 1 from the first red line's bar; None before it, where no bar is counted.
        count = int(np.searchsorted(every, t + 1e-6, side="right")) if every.size else 0
        return count or None

    def power(section: dict) -> float:
        return 10.0 ** (float(section["level_db"]) / 10.0)

    families: dict[int, list[dict]] = {}
    for section in raw:
        families.setdefault(int(section["group"]), []).append(section)
    family_db = {g: 10.0 * np.log10(max(np.mean([power(s) for s in members]), 1e-12))
                 for g, members in families.items()}
    repeated = sorted((g for g, members in families.items() if len(members) >= 2),
                      key=lambda g: family_db[g], reverse=True)

    sections: list[dict] = []
    for i, section in enumerate(raw):
        start, end = float(section["start_s"]), float(section["end_s"])
        start_to, start_moved, placed, change = (start, None, None, None) if i == 0 else edges[i - 1]
        # Sections are contiguous: an end is the next start, snapped once.
        end_to = end if i + 1 == len(raw) else edges[i][0]
        kind, group = str(section["kind"]), int(section["group"])
        repeats = int(section["repeats"])
        if kind == "chorus":
            louder = family_db[group] - family_db[repeated[1]] if len(repeated) > 1 else None
            why = {"rule": "chorus_loudest", "repeats": repeats,
                   "over_db": None if louder is None else round(float(louder), 1)}
        elif kind == "verse" and len(raw) == 1:
            why = {"rule": "verse_single"}
        elif kind == "verse" and len(repeated) >= 2:
            why = {"rule": "verse_quieter", "repeats": repeats,
                   "under_db": round(float(family_db[repeated[0]] - family_db[group]), 1)}
        elif kind == "verse":
            why = {"rule": "verse_one_family", "repeats": repeats}
        elif kind == "intro":
            why = {"rule": "intro_first", "length_s": round(end - start, 1),
                   "max_s": (report.get("rules") or {}).get("intro_max_s")}
        elif kind == "outro":
            why = {"rule": "outro_last"}
        else:
            why = {"rule": "bridge_once"}
        sections.append({
            "index": i, "kind": kind, "group": chr(ord("A") + group) if group < 26 else str(group),
            "repeats": repeats, "level_db": round(float(section["level_db"]), 1),
            "start_s": round(start_to, 4), "end_s": round(end_to, 4),
            "raw_start_s": start, "moved_ms": None if start_moved is None else round(start_moved * 1000, 1),
            "snapped": i == 0 or start_moved is not None, "bar": bar_number(start_to),
            "snap": placed, "change_db": change,
            "why": why,
        })
    one_family = len(families) == 1 and len(raw) > 1
    return {
        "duration": duration,
        "sections": sections,
        "families": len(families),
        "one_family": one_family,
        "proven_bars": int(known.sum()),
        "bars": int(every.size),
        "lane": _pooled_lane(report.get("energy") or [], float(report.get("energy_hop") or 0.5),
                             params.STRUCTURE_LANE_POINTS),
        "rules": report.get("rules") or {},
        "snap_s": params.STRUCTURE_SNAP_S,
        "phrase_margin_db": params.STRUCTURE_PHRASE_MARGIN_DB,
        "timings_s": report.get("timings_s") or {},
        "preview": suggest_preview_time(sections),
    }


def suggest_preview_time(sections: list[dict]) -> dict | None:
    """Where a song-select preview should start (Phase 21, Preview point).

    The loudest chorus's start; without a chorus, the loudest part that is
    neither intro nor outro; without anything, nothing. Starts are the
    snapped ones when they come from the view, so the point sits on a bar.
    A suggestion with its reason, never a write. Plain JSON types.
    """
    if not sections:
        return None

    def pick(pool: list[dict]) -> dict:
        return max(pool, key=lambda s: (float(s.get("level_db", 0.0)), -float(s.get("start_s", 0.0))))

    choruses = [s for s in sections if s.get("kind") == "chorus"]
    if choruses:
        chosen, why = pick(choruses), "chorus_loudest"
    else:
        parts = [s for s in sections if s.get("kind") not in ("intro", "outro")]
        if parts:
            chosen, why = pick(parts), "loudest_part"
        else:
            chosen, why = pick(list(sections)), "loudest_only"
    return {"time_s": float(chosen["start_s"]), "time_ms": int(round(float(chosen["start_s"]) * 1000)),
            "kind": chosen["kind"], "why": why}


def set_editor_bookmarks(beatmap: dict, times_ms: list[float]) -> dict:
    """Section starts as editor bookmarks (Phase 21, Bookmarks).

    Merges whole-millisecond times into the map's own bookmarks, sorted —
    the mapper's survive, nothing is ever deleted, negative times are
    dropped (bookmarks live at or past zero). A bookmarks line with
    unreadable entries refuses the map instead of silently dropping them.
    Only the bookmarks line moves (appended at the section's end when the
    map has none); every other byte waits for the writer. In place, like
    the P-2 field edits. Returns added and total.
    """
    section = next((s for s in beatmap.get("sections", []) if s["name"] == "Editor"), None)
    if section is None:
        raise ValueError("No [Editor] section in this beatmap.")
    kept: list[int] = []
    index = next((i for i, line in enumerate(section["lines"])
                  if line.strip().lower().startswith("bookmarks:")), None)
    if index is not None:
        for token in section["lines"][index].split(":", 1)[1].split(","):
            token = token.strip()
            if not token:
                continue
            try:
                kept.append(int(token))
            except ValueError:
                raise ValueError(f"Unusable bookmarks: {token!r}.")
    wanted = sorted({int(round(t)) for t in times_ms if t is not None} | set(kept))
    wanted = [t for t in wanted if t >= 0]
    # Commas alone, as osu! writes the line: the mapper's own marks read back
    # as they were, and the diff against the backup is the added numbers.
    listed = ",".join(str(t) for t in wanted)
    if index is None:
        section["lines"].append(f"Bookmarks: {listed}")
    else:
        head = section["lines"][index].split(":", 1)[0]
        section["lines"][index] = f"{head}: {listed}"
    editor = beatmap.setdefault("editor", {})
    if isinstance(editor, dict):
        editor["Bookmarks"] = listed
    return {"added": len(wanted) - len(kept), "total": len(wanted)}


# ---------------------------------------------------------------------------
# Assisted timing (proposal P1): two marked downbeats seed the grid
# ---------------------------------------------------------------------------


def _snap_mark(times: np.ndarray, weights: np.ndarray, mark: float, reach: float) -> float:
    """The strongest attack within ``reach`` of a mark, or the mark itself."""
    near = np.abs(times - mark) <= reach
    if not near.any():
        return mark
    candidates = np.flatnonzero(near)
    return float(times[candidates[int(np.argmax(weights[candidates]))]])


def _chunk_fits(times: np.ndarray, weights: np.ndarray, period: float, phase: float,
                a: float, b: float, min_share: float) -> bool | None:
    """Whether the attacks in (a, b] land on the grid; None when too few to say."""
    chunk = (times > a) & (times <= b)
    if int(chunk.sum()) < 3:
        return None
    share, _coverage, rms = precision_grid._grid_quality(times[chunk], weights[chunk], period, phase,
                                          tol_ratio=0.11)
    return share >= min_share and rms <= params.ASSISTED_GROW_RMS * period * 1000.0


def _another_grid(times: np.ndarray, weights: np.ndarray, period: float,
                  lo: float, hi: float) -> bool:
    """Whether a stretch the grid does not fit holds a grid of its own.

    The engine's seed search is run on it. A grid that explains the stretch as
    well as growth demands, at a tempo other than ours up to an octave, is a
    tempo change; anything less is a gap (a breakdown, a bar of vocals) that
    the same grid may resume after. Skipping gaps alone ran secs-3's first
    145 BPM line across its 152 BPM section into the 145 after it.
    """
    fresh = precision_grid._seed_grid(times, weights, lo, hi, prior_period=period, widths=(12.0, 7.0, 4.5))
    if fresh is None:
        return False
    other, other_phase = fresh
    window = (times >= lo) & (times <= hi)
    share, _coverage, _rms = precision_grid._grid_quality(times[window], weights[window], other, other_phase)
    if share < params.ASSISTED_GROW_SHARE:
        return False
    ratio = other / period
    ratio /= 2.0 ** round(float(np.log2(ratio)))
    return abs(ratio - 1.0) > params.ASSISTED_SAME_GRID


def _grow_assisted(times: np.ndarray, weights: np.ndarray, period: float, phase: float,
                   lo: float, hi: float, forward: bool,
                   min_share: float) -> tuple[float, float, float]:
    """Extend a seeded grid one way while fresh chunks keep landing on it,
    refitting on everything covered so far. Returns (period, phase, edge).

    A chunk that does not fit (a breakdown, a bar of vocals alone) ends the
    span only if the grid does not come back within ``ASSISTED_GAP_S``: on 30
    ranked maps, stopping at the first one covered a median 31 % of the line.
    """
    band = (period * params.REFERENCE_PERIOD_BAND[0], period * params.REFERENCE_PERIOD_BAND[1])
    finish = float(times[-1]) if forward else float(times[0])
    edge = hi if forward else lo
    while (edge < finish) if forward else (edge > finish):
        step = max(2.0, 4.0 * period)
        nxt = min(finish, edge + step) if forward else max(finish, edge - step)
        a, b = (edge, nxt) if forward else (nxt - 1e-9, edge - 1e-9)
        fits = _chunk_fits(times, weights, period, phase, a, b, min_share)
        if fits is False:
            # A stretch that holds another grid is a tempo change: stop there.
            window = ((edge, min(finish, edge + params.ASSISTED_CHANGE_WINDOW_S)) if forward
                      else (max(finish, edge - params.ASSISTED_CHANGE_WINDOW_S), edge))
            if _another_grid(times, weights, period, *window):
                break
            # One with no grid is a gap: resume where the same grid holds again.
            resume = None
            probe = nxt
            while resume is None and abs(probe - edge) <= params.ASSISTED_GAP_S and (
                    (probe < finish) if forward else (probe > finish)):
                after = min(finish, probe + step) if forward else max(finish, probe - step)
                pa, pb = (probe, after) if forward else (after - 1e-9, probe - 1e-9)
                if _chunk_fits(times, weights, period, phase, pa, pb, min_share):
                    resume = after
                probe = after
            if resume is None:
                break
            nxt, fits = resume, True
        if fits:
            if forward:
                whole = (times >= lo - 0.5 * period) & (times <= nxt)
            else:
                whole = (times >= nxt) & (times <= hi + 0.5 * period)
            fitted, moved, _ = precision_grid._refine_grid(times[whole], weights[whole], period, phase)
            if not band[0] <= fitted <= band[1]:
                break
            period, phase = fitted, moved
        edge = nxt
        if forward:
            hi = edge
        else:
            lo = edge
    return period, phase, _settle_edge(times, weights, period, phase, edge, forward)


def _settle_edge(times: np.ndarray, weights: np.ndarray, period: float, phase: float,
                 edge: float, forward: bool) -> float:
    """Where the grid really stops, inside the last chunk that passed.

    A chunk passes with most, not all, of its weight on the grid, so the last
    one can carry up to a step of the next tempo: at a 150 -> 120 BPM change at 31 s
    the span ran to 32.2 s, and adding the line would have dropped the real
    change. The attacks of the last two steps are scored +weight on the grid
    and -weight off it; the edge is the attack that closes the best-scoring
    run from the inside.
    """
    reach = 2.0 * max(2.0, 4.0 * period)
    if forward:
        region = (times > edge - reach) & (times <= edge)
    else:
        region = (times >= edge) & (times < edge + reach)
    t, w = times[region], weights[region]
    if t.size == 0:
        return edge
    k = np.round((t - phase) / period)
    on = np.abs(t - (phase + k * period)) <= max(0.11 * period, 0.006)
    signed = np.where(on, w, -w)
    if not forward:
        t, signed = t[::-1], signed[::-1]
    run = np.cumsum(signed)
    best = int(np.argmax(run))
    return float(t[best]) if run[best] > 0 else edge


def assisted_grid(attack_times: np.ndarray, attack_weights: np.ndarray,
                  first_ms: float, second_ms: float, bars: int = 1,
                  meter: int = 4) -> dict:
    """One red line from two downbeats the user marked (P19, assisted timing).

    Where the detector refuses or reads the wrong octave or bar, the user
    knows two things it does not: where a bar starts, and how many bars lie
    between two marks. That fixes the beat, ``(second - first) / (bars *
    meter)``, and the downbeat. Each mark first snaps to the strongest attack
    near it. The attacks then do the rest: the seed is fitted around the marks
    exactly as a reference line is (the coarsest of 1/1-1/4 that explains
    them), and grows backward and forward while fresh chunks keep landing on
    it, as the engine grows a section. It crosses a stretch with no grid (a
    breakdown) when the same grid comes back, and stops at one that holds a
    grid of its own (a tempo change). The red line goes on the first downbeat
    of the span; how far each mark moved is reported, and a grid that held
    fewer than 16 bars is answered but marked ``short``.

    Refuses instead of guessing: marks out of order, a tempo outside 40-400
    BPM, too few attacks around the marks, a grid that explains too little of
    them, or one chance explains as well. The number of bars between the marks
    is the user's: two marks one bar apart called two bars read at double
    tempo, consistently, and nothing in the attacks can say otherwise.
    Plain JSON types.
    """
    times = np.asarray(attack_times, dtype=np.float64)
    weights = np.asarray(attack_weights, dtype=np.float64)

    def refuse(reason: str, **values) -> dict:
        return {"ok": False, "reason": reason, "values": values}

    try:
        first_s, second_s = float(first_ms) / 1000.0, float(second_ms) / 1000.0
        bars, meter = int(bars), int(meter)
    except (TypeError, ValueError):
        return refuse("bad_marks")
    if not (np.isfinite(first_s) and np.isfinite(second_s)) or second_s <= first_s:
        return refuse("bad_marks")
    if bars < 1 or meter < 1:
        return refuse("bad_marks")
    if times.size == 0:
        return refuse("no_attacks")
    order = np.argsort(times)
    times, weights = times[order], weights[order]
    # Each mark goes to the strongest attack near it before the beat is taken
    # from them, as the editor snaps a click. At 300 BPM one bar is 0.8 s, and
    # marks 15 ms late and 20 ms early made the seed 4.6 % fast: enough to slip
    # an index over the seed window and refuse a clean track.
    reach = min(params.ASSISTED_SNAP_BEATS * (second_s - first_s) / (bars * meter), params.ASSISTED_SNAP_S)
    marked = (first_s, second_s)
    first_s, second_s = (_snap_mark(times, weights, mark, reach) for mark in marked)
    if second_s <= first_s:
        return refuse("bad_marks")
    beat_s = (second_s - first_s) / (bars * meter)
    seed_bpm = 60.0 / beat_s
    if not params.ASSISTED_BPM_RANGE[0] <= seed_bpm <= params.ASSISTED_BPM_RANGE[1]:
        return refuse("bpm_range", bpm=f"{seed_bpm:.1f}")

    slack = 0.5 * beat_s / max(params.REFERENCE_DIVISORS)
    seed_hi = max(second_s, first_s + params.ASSISTED_SEED_BEATS * beat_s)
    seed = (times >= first_s - slack) & (times <= seed_hi + slack)
    if int(seed.sum()) < params.REFERENCE_MIN_ATTACKS:
        return refuse("too_few", n=int(seed.sum()))
    grade = reference_timing._grade_span(times[seed], weights[seed], first_s, beat_s, seed_hi)
    if grade["share"] < params.REFERENCE_MIN_SHARE:
        return refuse("weak", share=f"{grade['share']:.2f}")
    divisor = grade["divisor"]
    period = 60.0 / (grade["fitted_bpm"] * divisor)
    phase = first_s + grade["offset_error_ms"] / 1000.0

    min_share = min(params.ASSISTED_GROW_SHARE,
                    max(params.REFERENCE_MIN_SHARE, params.ASSISTED_GROW_RATIO * grade["share"]))
    period, phase, lo = _grow_assisted(times, weights, period, phase,
                                       first_s, seed_hi, False, min_share)
    period, phase, hi = _grow_assisted(times, weights, period, phase,
                                       lo, seed_hi, True, min_share)
    span = (times >= lo - 0.5 * period) & (times <= hi + 0.5 * period)
    share, _coverage, rms = precision_grid._grid_quality(times[span], weights[span], period, phase)
    # The engine's own test: a grid that chance explains as well is no grid,
    # whoever seeded it. Marks on white noise found a 157 BPM "grid" at 0.41.
    chance = precision_grid._pulse_log10p(times[span], period, phase)
    if chance > params.ASSISTED_CHANCE_LOG10P:
        return refuse("chance", log10p=f"{chance:.1f}")

    beat = period * divisor
    bar = beat * meter
    downbeat = phase + np.round((first_s - phase) / period) * period
    # The red line opens the span on a downbeat: whole bars back from the mark,
    # never before the first attack the grid holds.
    offset = downbeat - np.floor((downbeat - (lo - 0.5 * period)) / bar) * bar
    second_tick = downbeat + bars * bar
    held = (hi - lo) / bar
    return {"ok": True, "offset_ms": float(offset) * 1000.0, "bpm": 60.0 / beat,
            "bars_held": float(held), "short": bool(held < params.ASSISTED_MIN_BARS),
            "meter": meter, "divisor": divisor, "seed_bpm": seed_bpm,
            "share": share, "residual_ms": rms,
            "start_ms": float(lo) * 1000.0, "end_ms": float(hi) * 1000.0,
            "first_shift_ms": float(downbeat - marked[0]) * 1000.0,
            "second_shift_ms": float(second_tick - marked[1]) * 1000.0}


def apply_assisted_grid(points: list[TimingPoint], fit: dict,
                        beats: np.ndarray | None = None) -> list[TimingPoint]:
    """The working timing with an assisted red line added.

    Points inside the span the grid holds are dropped: there the user's marks
    and the attacks agree on one tempo, so a detected line in between would
    only contradict it. Points outside stay, hand-placed ones included, and so
    do points in the span's last ``ASSISTED_EDGE_BEATS``: the end is known to a
    few beats (the grids of two close tempos agree that long), and a line
    there is most likely the change that ended it. On secs-3 the span ran
    0.4 s past the 152 -> 145 change and dropped its red line. The new line is
    hand-placed with its meter known.
    """
    if not fit.get("ok"):
        raise ValueError("That grid was refused; there is nothing to add.")
    start, end = float(fit["start_ms"]), float(fit["end_ms"])
    offset = float(fit["offset_ms"])
    edge = end - params.ASSISTED_EDGE_BEATS * 60000.0 / float(fit["bpm"])
    beats = np.zeros(0) if beats is None else np.asarray(beats, dtype=np.float64)
    kept = [p for p in points if not (min(start, offset) - 1.0 <= p.offset_ms < edge)]
    kept.append(data_model.TimingPoint(offset, float(fit["bpm"]), 1.0, editing._nearest_beat_index(beats, offset),
                            int(fit["meter"]), True, manual=True))
    kept.sort(key=lambda p: p.offset_ms)
    return kept
