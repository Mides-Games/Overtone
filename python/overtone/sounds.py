"""Sound events: every object as the sounds osu! plays for it."""
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

from . import osu_write, params


# ---------------------------------------------------------------------------
# Sound events: every object as the sounds osu! plays for it (read by the
# structure tools: breaks, kiai and section volumes)
# ---------------------------------------------------------------------------

#: hitSound bits. The normal sound always plays; these three are additions.
HIT_WHISTLE, HIT_FINISH, HIT_CLAP = 2, 4, 8


def _addition_names(bits: int) -> list[str]:
    return [name for bit, name in ((HIT_WHISTLE, "whistle"), (HIT_FINISH, "finish"),
                                   (HIT_CLAP, "clap")) if bits & bit]


def _sample_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class _TimingCursor:
    """What the timing points say at any time, in any query order: the red
    line's beat length, slider velocity, sample set, index and volume.
    Before the first point, the first point's settings apply, as in osu!."""

    def __init__(self, beatmap: dict) -> None:
        import bisect
        self._bisect = bisect.bisect_right
        section = next((s for s in beatmap.get("sections", [])
                        if s.get("name") == "TimingPoints"), None)
        rows = []
        for order, raw in enumerate((section or {}).get("lines", [])):
            text = str(raw).strip()
            if not text or text.startswith("//"):
                continue
            fields = osu_write._timing_point_fields(text)
            if fields is None or not (np.isfinite(fields["time"])
                                      and np.isfinite(fields["beat_length"])):
                continue
            fields["order"] = order
            rows.append(fields)
        rows = osu_write._ordered(rows)
        self.times = [r["time"] for r in rows]
        self.states: list[tuple[float | None, _PlayState]] = []
        beat, state = None, None
        for r in rows:
            if r["red"] and r["beat_length"] > 0:
                beat = r["beat_length"]
            state = osu_write._apply_point(state, r)
            self.states.append((beat, state))
        first_beat = next((r["beat_length"] for r in rows if r["red"] and r["beat_length"] > 0),
                          None)
        # A green line before the first red one still needs a beat length.
        self.states = [(b if b is not None else first_beat, s) for b, s in self.states]

    def at(self, time_ms: float) -> tuple[float | None, "_PlayState | None"]:
        if not self.states:
            return None, None
        i = self._bisect(self.times, time_ms + 1e-6) - 1
        return self.states[max(i, 0)]


def _event_sample(state: "_PlayState | None", default_set: int, normal_raw: int,
                  addition_raw: int, index_raw: int, volume_raw: int, file: str) -> dict:
    """One sound's sample, resolved the way osu! resolves it: the object's own
    value where it set one, else the timing point's, else the map's default.
    The additions' set follows the normal sound's set when it is 0."""
    point_set = state.sample_set if state is not None and state.sample_set in params.SAMPLE_SET_NAMES \
        else default_set
    normal = normal_raw if normal_raw in params.SAMPLE_SET_NAMES else point_set
    addition = addition_raw if addition_raw in params.SAMPLE_SET_NAMES else normal
    return {"normal_set": params.SAMPLE_SET_NAMES[normal], "addition_set": params.SAMPLE_SET_NAMES[addition],
            "index": index_raw if index_raw > 0 else (state.sample_index if state else 0),
            "volume": volume_raw if volume_raw > 0 else (state.volume if state else 100),
            "file": file,
            "raw": {"normal_set": normal_raw, "addition_set": addition_raw,
                    "index": index_raw, "volume": volume_raw, "file": file}}


def sound_events(beatmap: dict) -> list[dict]:
    """Every sound a map's objects make, resolved to what osu! plays (P-1).

    A circle and a mania hold sound at their start; a spinner at its end. A
    slider sounds at each edge (head, every repeat, tail), each with its own
    ``edgeSounds`` bits and ``edgeSets`` sets where the map gives them, the
    slider's own otherwise, and its body carries the slide (plus the whistle
    slide when the slider's whistle bit is set). Slider ticks are not events:
    they take no hitsound of their own in the format.

    Resolution follows osu!lazer's legacy decoder: each sound reads the
    timing point in force ``SAMPLE_LENIENCY_MS`` after it (a body reads the
    slider's end); an object's set of 0 inherits the timing point's, and a
    timing point's 0 the map's ``SampleSet``; an addition set of 0 follows
    the normal set; index and volume of 0 inherit. A custom ``filename``
    plays alone, in place of the named samples. Every event keeps the raw
    values beside the resolved ones, so a copy or an edit writes what the
    map wrote, not what it resolved to. Plain JSON types, in object order.
    """
    cursor = _TimingCursor(beatmap)
    general = beatmap.get("general") or {}
    default_set = {"normal": 1, "soft": 2, "drum": 3}.get(
        str(general.get("SampleSet", "Normal")).strip().lower(), 1)
    try:
        multiplier = float((beatmap.get("difficulty") or {}).get("SliderMultiplier", 1.4))
    except (TypeError, ValueError):
        multiplier = 1.4
    if not np.isfinite(multiplier) or multiplier <= 0:
        multiplier = 1.4

    events: list[dict] = []

    def emit(obj_index: int, part: str, edge, time_ms: float, bits: int, normal_raw: int,
             addition_raw: int, sample: dict, resolve_at: float, end_ms=None) -> None:
        _beat, state = cursor.at(resolve_at + params.SAMPLE_LENIENCY_MS)
        resolved = _event_sample(state, default_set, normal_raw, addition_raw,
                                 _sample_int(sample.get("index")),
                                 _sample_int(sample.get("volume")), str(sample.get("file") or ""))
        if part == "body":
            names = ["slide"] + (["whistle"] if bits & HIT_WHISTLE else [])
        else:
            names = ["normal"] + _addition_names(bits)
        events.append({"object": obj_index, "part": part, "edge": edge,
                       "time": round(float(time_ms), 3),
                       "end": None if end_ms is None else round(float(end_ms), 3),
                       "bits": int(bits), "sounds": names, **resolved})

    for n, obj in enumerate(beatmap.get("hitobjects", [])):
        kind = obj.get("kind")
        if kind not in ("circle", "slider", "spinner", "hold") or "time" not in obj:
            continue
        sample = obj.get("hit_sample") or {}
        bits = _sample_int(obj.get("hit_sound"))
        normal_raw = _sample_int(sample.get("normal_set"))
        addition_raw = _sample_int(sample.get("addition_set"))
        start = float(obj["time"])
        if kind in ("circle", "hold"):
            emit(n, kind, None, start, bits, normal_raw, addition_raw, sample, start)
        elif kind == "spinner":
            end = float(obj.get("end_time", start))
            emit(n, "spinner_end", None, end, bits, normal_raw, addition_raw, sample, end)
        else:
            beat, state = cursor.at(start)
            sv = state.sv if state is not None else 1.0
            slides = max(1, _sample_int(obj.get("slides"), 1))
            length = float(obj.get("length", 0.0) or 0.0)
            span = (length / (multiplier * 100.0 * sv) * beat
                    if beat and sv > 0 and length > 0 and np.isfinite(length) else None)
            edge_bits = [_sample_int(b) for b in str(obj.get("edge_sounds") or "").split("|")
                         if b.strip()]
            edge_sets = []
            for pair in str(obj.get("edge_sets") or "").split("|"):
                if pair.strip():
                    normal, _, addition = pair.partition(":")
                    edge_sets.append((_sample_int(normal), _sample_int(addition)))
            for k in range(slides + 1):
                if span is None and k > 0:
                    break                       # no timing to place the edges on
                at = start + k * (span or 0.0)
                part = "head" if k == 0 else "tail" if k == slides else "repeat"
                e_normal, e_addition = edge_sets[k] if k < len(edge_sets) else (normal_raw,
                                                                                  addition_raw)
                emit(n, part, k, at, edge_bits[k] if k < len(edge_bits) else bits,
                     e_normal, e_addition, sample, at)
            if span is not None:
                end = start + slides * span
                emit(n, "body", None, start, bits, normal_raw, addition_raw, sample, end, end)
    return events
