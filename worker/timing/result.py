"""One analysis as a timing-result: confidence levels, the evidence, refusals."""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import numpy as np  # noqa: E402
import overtone as ta  # noqa: E402

from timing.engine_info import result_model  # noqa: E402
from timing.settings import (
    DEFAULT_MODE,
    ENGINE,
    FORMAT,
    HIGH,
    LOOSE_RESIDUAL_MS,
    MEDIUM,
    MINOR,
    VERSION,
    default_params)  # noqa: E402


def _level(confidence: float, residual_ms: float | None, flagged: bool, engine: str) -> str:
    if flagged or confidence < MEDIUM:
        return "check"
    if residual_ms is not None and residual_ms > LOOSE_RESIDUAL_MS:
        return "check"
    # The beat tracker's fallback never earns "high": it has no grid fit to
    # stand on.
    if confidence >= HIGH and engine == "precision":
        return "high"
    return "medium"


def _plain(value):
    """A finding's values as JSON types (the engine may hand numpy scalars)."""
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, (bool, int, str)) or value is None:
        return value
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    return number if math.isfinite(number) else None


def _section_grid(analysis, start_s: float, end_s: float):
    """The fitted grid section under the middle of a red-line section, if any."""
    middle = 0.5 * (start_s + end_s)
    for section in getattr(analysis, "sections", None) or []:
        if section.start_s - 1e-6 <= middle <= section.end_s + 1e-6:
            return section
    return None


#: The onset envelope is max-pooled to at most this many values: enough for a
#: column a pixel wide across a wide screen, small enough for a 10-minute song.
ENVELOPE_BINS = 4000
#: The grid divisors drift is measured against, as the desktop app's drift
#: lane measured it: each attack's distance from the nearest 1/1, 1/2, 1/3 or
#: 1/4 tick of the red line that governs it.
DRIFT_DIVISORS = (1, 2, 3, 4)
#: Fewer attacks than this under a red line and its drift is not reported.
DRIFT_MIN_ATTACKS = 4


def _ms(values) -> list[int]:
    """Seconds as whole milliseconds: what the page draws needs no finer."""
    array = np.asarray(values, dtype=np.float64)
    array = array[np.isfinite(array)]
    return np.rint(array * 1000.0).astype(np.int64).tolist()


def _weighted_quantile(values: np.ndarray, weights: np.ndarray, q: float) -> float:
    order = np.argsort(values)
    cumulative = np.cumsum(weights[order])
    at = min(int(np.searchsorted(cumulative, q * cumulative[-1])), len(order) - 1)
    return float(values[order][at])


def _drift(times_s: np.ndarray, weights: np.ndarray, start_s: float, end_s: float,
           beat_s: float) -> dict:
    """How far the attacks under one red line sit from its grid, in ms: the
    weighted median of the distance (``drift_ms``), its 90th percentile, and
    the weighted median of the signed distance (``drift_bias_ms``, positive:
    the music lands after the grid). Read from the attacks the engine kept;
    None for a line with too few of them, or none (the fallback tracker)."""
    empty = {"drift_ms": None, "drift_p90_ms": None, "drift_bias_ms": None, "onsets": 0}
    inside = (times_s >= start_s) & (times_s < end_s) & (weights > 0)
    count = int(inside.sum())
    if count < DRIFT_MIN_ATTACKS or not beat_s > 0:
        return {**empty, "onsets": count}
    t, w = times_s[inside], weights[inside]
    position = (t - start_s) / beat_s
    best = np.full(t.shape, np.inf)
    for divisor in DRIFT_DIVISORS:
        off = (t - (start_s + np.round(position * divisor) / divisor * beat_s)) * 1000.0
        best = np.where(np.abs(off) < np.abs(best), off, best)
    size = np.abs(best)
    return {"drift_ms": round(_weighted_quantile(size, w, 0.5), 2),
            "drift_p90_ms": round(_weighted_quantile(size, w, 0.9), 2),
            "drift_bias_ms": round(_weighted_quantile(best, w, 0.5), 2),
            "onsets": count}


def _evidence(analysis, points, duration: float) -> dict:
    """The read-only evidence of ``timing-result v1.1``: what the engine
    already computed, rounded for the page. Never a new estimate: the beats
    and local tempo are the analysis's own, the bars are the click track's
    (``click_schedule``), the onsets are the attacks the grid was fitted to,
    swing and the half/double hints are the engine's read-only reports."""
    beats = np.asarray(getattr(analysis, "beats", []), dtype=np.float64)
    local = np.asarray(getattr(analysis, "local_bpms", []), dtype=np.float64)
    keep = np.isfinite(beats)
    if local.shape == beats.shape:
        keep &= np.isfinite(local) & (local > 0)
        bpm = np.round(local[keep], 2).tolist()
    else:
        bpm = []
    out = {"beats": {"t_ms": _ms(beats[keep]), "bpm": bpm}}

    try:
        schedule = ta.click_schedule(analysis)
    except (ValueError, TypeError, AttributeError):
        schedule = []
    out["downbeats_ms"] = _ms([t for t, level in schedule if level == ta.CLICK_BAR])

    times = np.asarray(getattr(analysis, "attack_times", []), dtype=np.float64)
    weights = np.asarray(getattr(analysis, "attack_weights", []), dtype=np.float64)
    if weights.shape != times.shape:
        weights = np.ones_like(times)
    good = np.isfinite(times) & np.isfinite(weights)
    order = np.argsort(times[good])
    times, weights = times[good][order], weights[good][order]
    peak = float(weights.max()) if weights.size else 0.0
    out["onsets"] = {"t_ms": _ms(times),
                     "w": (np.rint(weights / peak * 100).astype(np.int64).tolist()
                           if peak > 0 else [0] * int(times.size))}

    onset = np.asarray(getattr(analysis, "onset", []), dtype=np.float64)
    onset = np.where(np.isfinite(onset), onset, 0.0)
    frame_s = analysis.hop_length / float(analysis.sample_rate) if analysis.sample_rate else 0.0
    if onset.size and frame_s > 0:
        if onset.size > ENVELOPE_BINS:
            edges = np.linspace(0, onset.size, ENVELOPE_BINS + 1).astype(np.int64)
            onset = np.maximum.reduceat(onset, edges[:-1])
        top = float(onset.max())
        out["onset_envelope"] = {
            "span_ms": int(round(np.asarray(analysis.onset).size * frame_s * 1000.0)),
            "v": np.rint(onset / top * 100).astype(np.int64).tolist() if top > 0 else []}
    else:
        out["onset_envelope"] = {"span_ms": 0, "v": []}

    out["drift"] = []
    for i, p in enumerate(points):
        start = p.offset_ms / 1000.0
        end = points[i + 1].offset_ms / 1000.0 if i + 1 < len(points) else duration
        out["drift"].append(_drift(times, weights, start, max(end, start), 60.0 / float(p.bpm)))

    try:
        lane = ta.swing_lane(points, times, weights, duration)
        out["swing"] = {
            "measured": int(lane["measured"]), "swung": int(lane["swung"]),
            "spans": [{"start_ms": round(s["start_ms"]), "end_ms": round(s["end_ms"]),
                       "bpm": s["bpm"], "feel": s["feel"], "ratio": s["ratio"],
                       "late_ms": s["late_ms"], "snap": s["snap"]} for s in lane["spans"]]}
    except (ValueError, TypeError, KeyError):
        out["swing"] = None

    try:
        hints = ta.density_hints(analysis)
    except (ValueError, TypeError, AttributeError):
        hints = []
    out["pulse_hints"] = [{"section": int(h["section"]),
                           "from_ms": round(h["from_s"] * 1000), "to_ms": round(h["to_s"] * 1000),
                           "boundary_ms": round(h["boundary_s"] * 1000),
                           "thin_side": h["thin_side"], "factor": h["factor"], "score": h["score"]}
                          for h in hints]
    return out


def build_result(analysis, *, vote: bool, hash_: str) -> dict:
    """An analysis as ``timing-result v1``. Points are snapped exactly as the
    exporters snap them, so the table the site shows is what
    ``osu_timing`` writes."""
    points = [p for p in ta.snap_timing_points(list(analysis.points))
              if math.isfinite(p.bpm) and p.bpm > 0 and math.isfinite(p.offset_ms)]
    duration = float(analysis.duration)
    findings = [{"level": f["level"], "key": f["key"], "index": int(f["index"]),
                 "values": _plain(f.get("values", {}))}
                for f in ta.validate_timing_points(analysis)]
    flagged = {f["index"] for f in findings if f["level"] in ("warn", "error")}
    try:
        fallback_meter = max(1, min(16, int(str(analysis.meter).split("/")[0])))
    except (ValueError, TypeError):
        fallback_meter = 4

    evidence = _evidence(analysis, points, duration)
    drift = evidence.pop("drift")
    red_lines, sections = [], []
    for i, p in enumerate(points):
        meter = max(1, min(16, int(p.meter))) if p.meter_known else fallback_meter
        start_s = p.offset_ms / 1000.0
        end_s = points[i + 1].offset_ms / 1000.0 if i + 1 < len(points) else duration
        grid = _section_grid(analysis, start_s, end_s)
        residual = float(grid.residual_ms) if grid is not None else None
        confidence = float(p.confidence)
        level = _level(confidence, residual, i in flagged, analysis.engine)
        red_lines.append({"time_ms": round(float(p.offset_ms), 3), "bpm": round(float(p.bpm), 6),
                          "beat_length_ms": round(60000.0 / float(p.bpm), 6),
                          "meter": meter, "meter_known": bool(p.meter_known)})
        sections.append({"index": i, "start_ms": round(start_s * 1000.0, 3),
                         "end_ms": round(max(end_s, start_s) * 1000.0, 3),
                         "bpm": round(float(p.bpm), 6), "confidence": round(confidence, 4),
                         "level": level,
                         "residual_ms": round(residual, 3) if residual is not None else None,
                         "coverage": round(float(grid.coverage), 4) if grid is not None else None,
                         **drift[i]})

    return {
        "format": FORMAT, "version": VERSION, "minor": MINOR,
        "engine": ENGINE, "engine_mode": str(analysis.engine), "engine_hash": hash_,
        "app_version": ta.APP_VERSION, "beat_vote": bool(vote), "model": result_model(bool(vote)),
        "params": default_params(),
        "duration_s": round(duration, 3),
        "refused": False, "refusal": None,
        "global_bpm": round(float(analysis.global_bpm), 6),
        "offset_ms": red_lines[0]["time_ms"] if red_lines else None,
        "meter": str(analysis.meter),
        "stability": round(float(analysis.stability), 4),
        "residual_ms": round(float(analysis.fit_residual_ms), 3) if analysis.engine == "precision" else None,
        "red_lines": red_lines,
        "sections": sections,
        "findings": findings,
        "osu_timing": ta.osu_timing_text(analysis),
        **evidence,
        **asked(),
    }


def asked(mode: str = DEFAULT_MODE, options: dict | None = None) -> dict:
    """How the analysis was asked for (v1.2): the mode, the hints as they
    were applied, what the result says about each hint, and the stretch."""
    return {"mode": mode, "options": dict(options or {}), "hint_checks": [], "stretch": None}


def refusal_code(message: str) -> str:
    """A stable name for the engine's reason, so the site can say it in
    either language; the engine's own sentence travels beside it."""
    text = message.lower()
    if "too heavy" in text:
        return "too_heavy"
    if "longer than" in text:
        return "too_long"
    if "at least two seconds" in text:
        return "too_short"
    if "stretch" in text:
        return "bad_stretch"
    if "pulse" in text or "beats" in text or "tempo" in text:
        return "no_pulse"
    return "refused"


def refused_result(message: str, *, vote: bool, hash_: str, duration_s: float | None = None) -> dict:
    """The engine found nothing it would stand behind: no BPM, no red lines,
    the reason. White noise ends here (CLAUDE.md rule 2)."""
    return {
        "format": FORMAT, "version": VERSION, "minor": MINOR,
        "engine": ENGINE, "engine_mode": None, "engine_hash": hash_,
        "app_version": ta.APP_VERSION, "beat_vote": bool(vote), "model": result_model(bool(vote)),
        "params": default_params(),
        "duration_s": round(duration_s, 3) if duration_s is not None else None,
        "refused": True, "refusal": {"code": refusal_code(message), "message": message},
        "global_bpm": None, "offset_ms": None, "meter": None, "stability": None,
        "residual_ms": None, "red_lines": [], "sections": [], "findings": [],
        "osu_timing": "",
        **asked(),
    }
