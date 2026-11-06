"""Before and after the engine: the audio header, a shifted start, and the hints checked."""
from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import overtone as ta  # noqa: E402

from timing.settings import APPROX_SLACK  # noqa: E402


def audio_seconds(path: str | Path) -> float | None:
    """The file's length from its header when libsndfile can read one
    (WAV, FLAC, OGG), else None: the engine then decodes and decides."""
    try:
        info = ta.sf.info(str(path))
    except Exception:  # noqa: BLE001 -- no header to read: not this function's call
        return None
    return info.frames / info.samplerate if info.samplerate > 0 else None


#: What a header may claim before a byte of it is decoded. A few kilobytes can
#: announce hours of eight-plus channels at any rate, and the decoder would
#: allocate all of it (worker/isolate.py bounds what slips past this).
MAX_SAMPLERATE = 192_000
MAX_CHANNELS = 8


def header_refusal(path: str | Path, max_seconds: float | None) -> str | None:
    """Why the file's header is refused before decoding, or None. A file with
    no header libsndfile reads is not this function's call."""
    try:
        info = ta.sf.info(str(path))
    except Exception:  # noqa: BLE001
        return None
    frames_cap = (max_seconds or 3600) * MAX_SAMPLERATE
    if not 0 < info.samplerate <= MAX_SAMPLERATE:
        return f"Audio is too heavy to analyse: its header says {info.samplerate} Hz (at most {MAX_SAMPLERATE})."
    if info.channels > MAX_CHANNELS:
        return f"Audio is too heavy to analyse: its header says {info.channels} channels (at most {MAX_CHANNELS})."
    if info.frames > frames_cap:
        return f"Audio is too heavy to analyse: its header says {info.frames} frames."
    return None


class AnalysisFailed(Exception):
    """The file could not be analysed at all (not audio, damaged, a codec
    missing): a failed job, not a refusal."""


def _shift_ms(value, shift: float, whole: bool = False):
    if value is None:
        return None
    moved = float(value) + shift
    return int(round(moved)) if whole else round(moved, 3)


def shift_result(result: dict, shift: float) -> dict:
    """Every time of ``result`` moved ``shift`` ms later: an analysis of a
    stretch read back in the whole song's timeline (W12.19). ``osu_timing``
    is not text this can move; the caller writes it again from the points."""
    out = dict(result)
    out["offset_ms"] = _shift_ms(result.get("offset_ms"), shift)
    out["red_lines"] = [{**line, "time_ms": _shift_ms(line["time_ms"], shift)} for line in result.get("red_lines", [])]
    out["sections"] = [{**s, "start_ms": _shift_ms(s["start_ms"], shift), "end_ms": _shift_ms(s["end_ms"], shift)}
                       for s in result.get("sections", [])]
    if isinstance(result.get("beats"), dict):
        out["beats"] = {**result["beats"], "t_ms": [_shift_ms(t, shift, True) for t in result["beats"]["t_ms"]]}
    if isinstance(result.get("onsets"), dict):
        out["onsets"] = {**result["onsets"], "t_ms": [_shift_ms(t, shift, True) for t in result["onsets"]["t_ms"]]}
    if "downbeats_ms" in result:
        out["downbeats_ms"] = [_shift_ms(t, shift, True) for t in result["downbeats_ms"]]
    if isinstance(result.get("onset_envelope"), dict):
        # The envelope covers the stretch only: where it starts says where to draw it.
        out["onset_envelope"] = {**result["onset_envelope"], "start_ms": _shift_ms(0, shift, True)}
    if isinstance(result.get("swing"), dict):
        out["swing"] = {**result["swing"], "spans": [
            {**s, "start_ms": _shift_ms(s["start_ms"], shift, True), "end_ms": _shift_ms(s["end_ms"], shift, True)}
            for s in result["swing"].get("spans", [])]}
    if "pulse_hints" in result:
        out["pulse_hints"] = [{**h, **{k: _shift_ms(h[k], shift, True) for k in ("from_ms", "to_ms", "boundary_ms")}}
                              for h in result["pulse_hints"]]
    return out


def _shifted(analysis, shift: float):
    """The analysis with its red lines ``shift`` ms later, for ``osu_timing``."""
    return replace(analysis, points=[replace(p, offset_ms=p.offset_ms + shift) for p in analysis.points])


def _fold(bpm: float, window: tuple[float, float]) -> float:
    """``bpm`` doubled or halved into ``window``, as the engine's fold reads it."""
    lo, hi = window
    while bpm < lo - 0.01:
        bpm *= 2.0
    while bpm > hi + 0.01:
        bpm /= 2.0
    return bpm


def hint_checks(result: dict, options: dict, window: tuple[float, float] | None,
                applied_meter: int = 0) -> list[dict]:
    """What the result says about each hint the person gave (W3.21): ``warn``
    where the audio contradicts it, ``info`` where the hint decided something.
    A hint never turns into an answer the engine did not find; when they
    disagree, this is how the page says so."""
    checks = []
    lines = result.get("red_lines") or []
    if not lines:
        return checks
    bpm = float(result["global_bpm"])
    tempos = sorted({round(float(line["bpm"]), 2) for line in lines})
    if options.get("tempo") == "constant" and len(tempos) > 1:
        checks.append({"level": "warn", "key": "tempo_not_constant", "values": {"count": len(tempos)}})
    if options.get("tempo") == "changes" and len(tempos) == 1:
        checks.append({"level": "warn", "key": "tempo_constant", "values": {"bpm": tempos[0]}})

    def octave_away(expected_low: float, expected_high: float):
        for factor in (2.0, 0.5):
            if expected_low <= bpm * factor <= expected_high:
                return factor
        return None

    if "bpm" in options:
        expected = options["bpm"]
        if abs(bpm - expected) > APPROX_SLACK * expected:
            checks.append({"level": "warn", "key": "bpm_far", "values": {
                "bpm": round(bpm, 2), "expected": round(expected, 2),
                "factor": octave_away(expected * (1 - APPROX_SLACK), expected * (1 + APPROX_SLACK))}})
    if "bpm_min" in options:
        low, high = options["bpm_min"], options["bpm_max"]
        outside = sum(1 for line in lines if not low - 0.01 <= float(line["bpm"]) <= high + 0.01)
        if outside:
            checks.append({"level": "warn", "key": "bpm_outside", "values": {
                "bpm": round(bpm, 2), "min": round(low, 2), "max": round(high, 2), "count": outside,
                "factor": octave_away(low, high)}})
    if window is not None:
        default = _fold(bpm, ta.MAP_OCTAVE_RANGE)
        checks.append({"level": "info", "key": "octave_window", "values": {
            "low": round(window[0], 1), "high": round(window[1], 1),
            "default_bpm": round(default, 2) if abs(default - bpm) > 0.01 else None}})
    if "meter" in options:
        found = sorted({int(line["meter"]) for line in lines if line.get("meter_known")} - {options["meter"]})
        if found:
            checks.append({"level": "warn", "key": "meter_differs", "values": {"meter": options["meter"], "found": found}})
        if applied_meter:
            checks.append({"level": "info", "key": "meter_applied", "values": {"meter": options["meter"], "count": applied_meter}})
    return checks
