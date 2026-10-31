"""The site worker's analysis: one audio file in, one ``timing-result v1.1`` out.

This is the part of the worker that touches the engine, kept apart from the
HTTP loop in ``main.py`` so the tests can run it without a server.

It calls ``python/overtone.py`` directly. It does not import the desktop shell
(``overtone_web``), which left the repository with the desktop app, and it never reads anybody's saved
settings: a site analysis runs with the defaults a fresh desktop install had,
written out in ``default_params`` below.

Standard library plus the engine only: the worker adds no dependency, so the
lock, SBOM and notices gates do not move.
"""
from __future__ import annotations

import contextlib
import functools
import hashlib
import math
import os
import sys
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))

import numpy as np  # noqa: E402 -- the engine's own dependency, nothing new
import overtone as ta  # noqa: E402

FORMAT = "timing-result"
VERSION = 1
#: ``timing-result v1.2``: ``version`` stays 1 so every v1 reader (the API's
#: check, the exports) reads it unchanged; ``minor`` 1 added the read-only
#: evidence the result page draws (``beats``, ``downbeats_ms``, ``onsets``,
#: ``onset_envelope``, per-section drift, ``swing``, ``pulse_hints``); ``minor``
#: 2 adds how the analysis was asked for (W11.1, W3.21, W12.19): ``mode``,
#: ``options``, ``hint_checks`` and ``stretch``. Nothing in a v1 field changes.
MINOR = 2

#: The engine generation the site's ``analyses.engine`` column records.
ENGINE = "v3"

#: How sure a section has to be for each of the three levels the site shows
#: (the legend on the home page: high confidence, medium, check by ear).
#: ``MEDIUM`` is the engine's own default ``min_confidence``: below it the
#: engine itself would not have kept the change. ``HIGH`` is not a measured
#: threshold; it is where a section stops needing a second look on the
#: synthetic corpus, where every section scores 0.99+. Real music sits lower
#: (Corpus B is still research), which is why every level says "check by ear"
#: somewhere on the page.
HIGH = 0.90
MEDIUM = 0.75
#: A grid residual past this is worth saying out loud: the desktop shell's
#: LOOSE_RESIDUAL_MS, measured on Corpus B on 2026-09-28 (30 ms fires on one
#: ranked track of 15, the one a mapper would reject). Copied, not imported.
LOOSE_RESIDUAL_MS = 30.0


def default_params() -> dict:
    """The analysis parameters a site analysis runs with.

    These are what the desktop app ran with for someone who never opened its
    settings: ``TimingAnalyzerApp.PRESETS["variable"]`` (delta 1.5,
    persistence 12, confidence 75 %), pulse Auto, prefer the map's BPM, refine
    beats, the v3 Python engine. ``analyze_audio``'s own defaults then add the
    osu! conventions, drift following and the Beat This! vote. They are
    written here rather than read from the desktop shell because that shell is
    leaving the repository, and because a server must not pick up whatever a
    developer last set in their own window.
    """
    return {"min_delta": 1.5, "persistence": 12, "min_confidence": 0.75,
            "prefer_map_bpm": True, "refine_beats": True, "force_subdivision": 0.0}


# ── Modes and the person's hints (W11.1, W3.21, W12.19) ─────────────────────

#: How long the person is willing to wait, not which engine runs (W11.1).
#: ``normal`` is the analysis every result had before modes existed, exactly.
MODES = ("fast", "normal", "strict")
DEFAULT_MODE = "normal"

#: What each mode changes, and nothing else:
#:
#: - ``vote``: whether Beat This! votes on the red lines (it still needs the
#:   model to be there; a worker without it votes in no mode);
#: - ``judges``: whether Beat This! is asked about the octave at all (the
#:   local, section and song octave judges). Off, every judge gets "no
#:   answer", which each one already reads as "leave the engine's octave";
#: - ``flags``: engine switches set for the job and restored after it.
#:
#: ``fast`` is the engine without the network: about a tenth of the time on
#: a quiet machine (docs/deploy.md, W2.4). ``strict`` is ``normal`` until a
#: switch is measured to help on real music. The engine's switches that are
#: off (PIECEWISE_GRID, CONSTANT_GRID, SONG_OCTAVE_BEAT_THIS) are the
#: candidates, each "off until measured on the server" in python/overtone.py;
#: none has a held-out measurement yet (docs/timeline.md, 2026-10-27), so none
#: is switched on here. W11.4, the phase polish, is what is meant to fill it.
MODE_SETTINGS = {
    "fast": {"vote": False, "judges": False, "flags": {}},
    "normal": {"vote": True, "judges": True, "flags": {}},
    "strict": {"vote": True, "judges": True, "flags": {}},
}

#: Hints a person can give before analysing (W3.21), and their bounds. The
#: API checks the same bounds; the worker checks again, since what it is
#: handed decides what the engine is asked.
HINT_BPM = (30.0, 400.0)
HINT_METER = (1, 16)
TEMPO_HINTS = ("constant", "changes")
#: The shortest stretch worth analysing: the engine wants two seconds, and a
#: tempo needs a few bars.
MIN_STRETCH_S = 10.0
#: How far an approximate BPM may be from the reading before the result says
#: so: a person's "about 170" is a guess, not a measurement.
APPROX_SLACK = 0.10


def clean_options(raw) -> dict:
    """The hints that are well formed, as plain numbers and words; anything
    else is dropped (the API refuses it before it gets here)."""
    if not isinstance(raw, dict):
        return {}
    out = {}

    def number(key, low, high):
        value = raw.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        value = float(value)
        return value if math.isfinite(value) and low <= value <= high else None

    if raw.get("tempo") in TEMPO_HINTS:
        out["tempo"] = raw["tempo"]
    bpm = number("bpm", *HINT_BPM)
    low, high = number("bpm_min", *HINT_BPM), number("bpm_max", *HINT_BPM)
    if bpm is not None:
        out["bpm"] = bpm
    elif low is not None and high is not None and low < high:
        out["bpm_min"], out["bpm_max"] = low, high
    meter = raw.get("meter")
    if isinstance(meter, int) and not isinstance(meter, bool) and HINT_METER[0] <= meter <= HINT_METER[1]:
        out["meter"] = meter
    start, end = number("start_s", 0.0, 4 * 3600.0), number("end_s", 0.0, 4 * 3600.0)
    if start is not None and end is not None and end - start >= MIN_STRETCH_S:
        out["start_s"], out["end_s"] = start, end
    if raw.get("band") is True:
        out["band"] = True
    return out


#: The separator's share of a job's time: the job ends at 3x the audio's length
#: (worker/isolate.py), so the separator stops at 1.5x and leaves the engine the
#: rest, reading the mix if it has to. Measured on the VPS (2026-10-31, 6 cores):
#: 0.47x the length with the glibc build, 0.63x with the static one.
STEMS_TIME_SHARE = 1.5
STEMS_MIN_TIMEOUT_S = 60.0


def stems_timeout(seconds: float | None) -> float | None:
    """How long the separator may run on audio this long; None when unknown."""
    return max(STEMS_MIN_TIMEOUT_S, STEMS_TIME_SHARE * seconds) if seconds else None


def stems_available() -> bool:
    """Whether the drums separator a live band's hint asks for is installed:
    the stemsplit binary and its weights (python/overtone.py, STEMS_DRUMS)."""
    import shutil
    binary = shutil.which(ta.STEMSPLIT_CLI) or os.path.isfile(ta.STEMSPLIT_CLI)
    model = ta.STEMSPLIT_MODEL or os.fspath(ta.ROOT / "assets" / "models" / ta.STEMSPLIT_WEIGHTS)
    return bool(binary) and os.path.isfile(model)


def octave_window(options: dict) -> tuple[float, float] | None:
    """The octave the engine reads the song at when the person named a tempo:
    the engine's own MAP_OCTAVE_RANGE (one octave, 120-240 by default) moved
    to sit around their BPM or the middle of their range. None without a
    tempo hint, and None when the hint already lies inside the default
    window: the engine reads that octave anyway, so it runs untouched."""
    lo, hi = ta.MAP_OCTAVE_RANGE
    if "bpm" in options:
        centre = options["bpm"]
        if lo <= centre <= hi:
            return None
    elif "bpm_min" in options:
        if lo <= options["bpm_min"] and options["bpm_max"] <= hi:
            return None
        centre = math.sqrt(options["bpm_min"] * options["bpm_max"])
    else:
        return None
    return (round(centre / math.sqrt(2.0), 3), round(centre * math.sqrt(2.0), 3))


@contextlib.contextmanager
def engine_settings(mode: str, window: tuple[float, float] | None, stems: bool = False,
                    stems_timeout_s: float | None = None):
    """The engine switched as ``mode``, the octave window and a live band's
    drums (``stems``) ask, for one job, and put back as it was after it,
    whatever happens. The worker's analysis process runs one job at a time,
    so nothing else sees the switches."""
    settings = MODE_SETTINGS[mode]
    flags = {**settings["flags"], **({"STEMS_DRUMS": True} if stems else {})}
    if stems and stems_timeout_s:
        flags["STEMSPLIT_TIMEOUT_S"] = float(stems_timeout_s)
    saved = {name: getattr(ta, name) for name in flags}
    saved["MAP_OCTAVE_RANGE"] = ta.MAP_OCTAVE_RANGE
    saved["_beat_this_judge_beats"] = ta._beat_this_judge_beats
    try:
        for name, value in flags.items():
            setattr(ta, name, value)
        if window is not None:
            ta.MAP_OCTAVE_RANGE = window
        if not settings["judges"]:
            ta._beat_this_judge_beats = lambda _y, _sr: None
        yield
    finally:
        for name, value in saved.items():
            setattr(ta, name, value)


_ARENA: list = []


def _shared_arena(onnxruntime) -> None:
    """One CPU arena for every Beat This! session, grown by what a run asks
    for (kSameAsRequested) instead of doubling. Each session's own arena kept
    the doubled overshoot of the largest chunk: a 543 s song peaked at 2369 MB
    committed with them and 1864 MB with this (2026-10-28, 4 threads, the vote
    on, same beats, same wall time). Turning the arena off reached 1739 MB but
    took 83 s instead of 60."""
    if _ARENA:
        return
    info = onnxruntime.OrtMemoryInfo("Cpu", onnxruntime.OrtAllocatorType.ORT_ARENA_ALLOCATOR, 0,
                                     onnxruntime.OrtMemType.DEFAULT)
    onnxruntime.create_and_register_allocator(info, onnxruntime.OrtArenaCfg(0, 1, -1, -1))
    _ARENA.append(True)


def limit_onnx_threads(threads: int) -> None:
    """Make every Beat This! session the engine opens use ``threads`` intra-op
    threads. ONNX Runtime sizes its pool from the machine's cores, not from a
    container's CPU limit, so on a shared node an unlimited session spawns
    dozens of threads fighting over four cores of quota (docs/deploy.md,
    WORKER_THREADS). Call it before the first session loads; the engine's own
    loader is wrapped, not edited, so the desktop path is untouched."""
    original = ta._load_beat_this

    def load():
        try:
            import onnxruntime
        except ImportError:
            return original()
        path = ta.ROOT / "assets" / "models" / ta.BEAT_THIS_MODEL
        if not path.is_file():
            return None
        options = onnxruntime.SessionOptions()
        options.log_severity_level = 3
        options.intra_op_num_threads = int(threads)
        options.inter_op_num_threads = 1
        # As the engine's own loader: the pattern only adds to the peak
        # (python/overtone.py, _load_beat_this). Without this line the worker
        # that caps its threads, which is every deployed one, kept the old peak.
        options.enable_mem_pattern = False
        # The arena every session shares (_shared_arena): what kept the too_heavy
        # failures at 1800 MB on songs of nine minutes.
        _shared_arena(onnxruntime)
        options.add_session_config_entry("session.use_env_allocators", "1")
        try:
            return onnxruntime.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
        except Exception:  # noqa: BLE001 -- as the engine's loader: no session, no vote
            return None

    ta._load_beat_this = load


def beat_vote_available() -> bool:
    """Whether the Beat This! vote will run: its runtime and model are there.
    Loads the model the first time (a few seconds), as the first analysis
    would anyway."""
    return ta._beat_this_session() is not None


@functools.lru_cache(maxsize=1)
def model_info() -> dict | None:
    """The Beat This! model a vote runs on: its file name and the first 12
    hex of its SHA-1, so a result says which model it came from even when a
    new model keeps the old name. ``None`` when the file is not there."""
    path = ta.ROOT / "assets" / "models" / ta.BEAT_THIS_MODEL
    if not path.is_file():
        return None
    return {"name": ta.BEAT_THIS_MODEL, "sha1": hashlib.sha1(path.read_bytes()).hexdigest()[:12]}


def result_model(vote: bool) -> dict | None:
    """The model a result names: only when the vote ran, since without it no model touched the reading."""
    return model_info() if vote else None


def engine_hash(vote: bool | None = None, mode: str = DEFAULT_MODE) -> str:
    """The code a result came from, keyed as ``bench/corpus_b.py`` and the
    library key their caches: a SHA-1 over the engine source, plus this
    file (it shapes the result), plus whether the Beat This! vote ran (it
    moves red lines) and the model it ran on, plus the mode when it is not
    ``normal``. Any edit to
    either file stales every cached result."""
    if vote is None:
        vote = beat_vote_available()
    vote = bool(vote) and MODE_SETTINGS[mode]["vote"]
    label = f"{FORMAT} {VERSION}.{MINOR} {ENGINE} vote={vote}"
    # The model moves red lines as the code does: another model, another hash.
    if vote and model_info():
        label += f" model={model_info()['sha1']}"
    if mode != DEFAULT_MODE:
        label += f" mode={mode}"
    digest = hashlib.sha1(label.encode())
    for path in (Path(ta.__file__), Path(__file__)):
        digest.update(hashlib.sha1(path.read_bytes()).digest())
    return digest.hexdigest()[:16]


def engine_hashes(vote: bool | None = None) -> dict:
    """Each mode's engine hash: what the API keys a cached result of that
    mode by (the same audio in another mode is another result)."""
    if vote is None:
        vote = beat_vote_available()
    return {mode: engine_hash(vote, mode) for mode in MODES}


#: The engine's progress messages, as stages the site can name in either
#: language, and roughly how far along each one is. Wall time is dominated by
#: the attacks and the vote; these fractions only have to move forward.
STAGES = (
    ("Loading", "load", 0.05),
    ("Detecting attacks", "attacks", 0.20),
    ("Scanning pulse", "coherence", 0.40),
    ("No fittable grid", "fallback", 0.45),
    ("Extracting transients", "tracker", 0.55),
    ("Resolving", "octave", 0.55),
    ("Tracking beats", "tracker", 0.60),
    ("Computing local tempo", "sections", 0.65),
    ("Fitting tempo", "sections", 0.65),
    ("Checking the beats", "vote", 0.75),
)


def stage_of(message: str) -> tuple[str, float] | None:
    """The stage a progress message belongs to, or None for one not known."""
    for prefix, key, fraction in STAGES:
        if message.startswith(prefix):
            return key, fraction
    return None


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


def analyse(path: str | Path, *, vote: bool, hash_: str,
            max_seconds: float | None = None,
            progress: Callable[[str, float], None] | None = None,
            mode: str = DEFAULT_MODE, options: dict | None = None) -> dict:
    """Run the engine on one file and return its ``timing-result v1``.

    ``vote`` says whether the Beat This! vote is available; ``mode`` says
    whether this job uses it (W11.1). ``options`` are the person's hints
    (W3.21): an expected tempo moves the octave window the engine reads the
    song at, a meter fills the bars the engine could not prove, a stretch
    (W12.19) is cut out of the decoded audio and analysed alone, its times
    put back in the song's timeline. The rest only flag the result
    (``hint_checks``). With no options and the default mode this is the
    analysis it always was.

    A ``ValueError`` from the engine is a refusal (no pulse, too short, too
    long), returned as a result. Anything else is a failure, raised as
    ``AnalysisFailed`` with the engine's message.
    """
    mode = mode if mode in MODES else DEFAULT_MODE
    options = clean_options(options)
    vote = bool(vote) and MODE_SETTINGS[mode]["vote"]
    window = octave_window(options)
    # A live band's drums, separated, for the grid: the biggest measured gain on
    # live-drummed songs (bands-variable dev, beats within 10 ms 69.4 -> 78.8 %,
    # docs/timeline.md 2026-10-31). Without the separator the mix is analysed and
    # the result says so.
    stems = bool(options.get("band")) and stems_available()

    def refuse(message: str, duration_s: float | None = None) -> dict:
        return {**refused_result(message, vote=vote, hash_=hash_, duration_s=duration_s),
                **asked(mode, options)}

    heavy = header_refusal(path, max_seconds)
    if heavy:
        return refuse(heavy)
    seconds = audio_seconds(path)
    if max_seconds and seconds is not None and seconds > max_seconds:
        return refuse(f"Audio is longer than {max_seconds / 60:g} minutes.", seconds)

    def say(message: str) -> None:
        found = stage_of(message)
        if found and progress is not None:
            progress(*found)

    params = default_params()
    stretch = None
    separator_failed = False
    with contextlib.ExitStack() as stack:
        source = Path(path)
        try:
            if "start_s" in options:
                # The whole song decoded once, as the engine decodes it, and the
                # stretch written out losslessly: the engine then reads exactly
                # those samples, and the offset back is a whole number of them.
                y, sr = ta._load_audio(str(path), say)
                full = len(y) / sr
                if max_seconds and full > max_seconds:
                    return refuse(f"Audio is longer than {max_seconds / 60:g} minutes.", full)
                first = int(round(options["start_s"] * sr))
                last = int(round(min(options["end_s"], full) * sr))
                if last - first < MIN_STRETCH_S * sr:
                    return refuse(f"The stretch to analyse holds less than {MIN_STRETCH_S:g} seconds of the audio.", full)
                folder = stack.enter_context(tempfile.TemporaryDirectory(prefix="overtone-stretch-"))
                source = Path(folder) / "stretch.wav"
                ta.sf.write(str(source), y[first:last], sr, subtype="FLOAT")
                del y
                stretch = {"start_ms": round(first / sr * 1000.0, 3), "end_ms": round(last / sr * 1000.0, 3),
                           "duration_s": round(full, 3)}
            def run(drums: bool):
                with engine_settings(mode, window, drums, stems_timeout(seconds)):
                    return ta.analyze_audio(
                        str(source), params["min_delta"], params["persistence"], params["prefer_map_bpm"],
                        params["min_confidence"], say, params["force_subdivision"], params["refine_beats"],
                        beat_vote=vote)

            try:
                analysis = run(stems)
            except ta.SeparatorFailed as exc:
                # out of memory, out of time, or broken on this host: the mix, said so
                print(f"[worker] drums separator failed, reading the mix: {exc}", file=sys.stderr)
                stems, separator_failed = False, True
                analysis = run(False)
        except ValueError as exc:
            return refuse(str(exc), seconds)
        except Exception as exc:  # noqa: BLE001 -- the job records why, the worker keeps going
            raise AnalysisFailed(str(exc) or type(exc).__name__) from exc
    if max_seconds and analysis.duration > max_seconds:
        return refuse(f"Audio is longer than {max_seconds / 60:g} minutes.", float(analysis.duration))
    if progress is not None:
        progress("result", 0.95)

    # A meter the person named fills the bars the engine could not prove: the
    # engine's own fallback for such a line is the analysis's meter, which was
    # a guess there. A bar it proved stays, and a different one is flagged.
    applied = 0
    if "meter" in options:
        applied = sum(1 for p in analysis.points if not p.meter_known)
        if applied:
            below = str(analysis.meter).split("/")[1] if "/" in str(analysis.meter) else "4"
            analysis = replace(analysis, meter=f"{options['meter']}/{below}")

    result = {**build_result(analysis, vote=vote, hash_=hash_), **asked(mode, options)}
    if stretch is not None:
        result = shift_result(result, stretch["start_ms"])
        result["osu_timing"] = ta.osu_timing_text(_shifted(analysis, stretch["start_ms"]))
        result["duration_s"] = stretch.pop("duration_s")
        result["stretch"] = stretch
    result["hint_checks"] = hint_checks(result, options, window, applied)
    if options.get("band"):
        key = "band_drums" if stems else "band_separator_failed" if separator_failed else "band_no_separator"
        result["hint_checks"].append({"level": "info" if stems else "warn", "key": key, "values": {}})
    return result
