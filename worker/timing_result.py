"""The site worker's analysis: one audio file in, one ``timing-result v1`` out.

This is the part of the worker that touches the engine, kept apart from the
HTTP loop in ``main.py`` so the tests can run it without a server.

It calls ``python/overtone.py`` directly. It does not import the desktop shell
(``overtone_web``), which is being removed, and it never reads anybody's saved
settings: a site analysis runs with the defaults a fresh desktop install had,
written out in ``default_params`` below.

Standard library plus the engine only: the worker adds no dependency, so the
lock, SBOM and notices gates do not move.
"""
from __future__ import annotations

import hashlib
import math
import sys
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))

import overtone as ta  # noqa: E402

FORMAT = "timing-result"
VERSION = 1

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


def engine_hash(vote: bool | None = None) -> str:
    """The code a result came from, keyed as ``bench/corpus_b.py`` and the
    library key their caches: a SHA-1 over the engine source, plus this
    file (it shapes the result), plus whether the Beat This! vote ran (it
    moves red lines). Any edit to either file stales every cached result."""
    if vote is None:
        vote = beat_vote_available()
    digest = hashlib.sha1(f"{FORMAT} {VERSION} {ENGINE} vote={bool(vote)}".encode())
    for path in (Path(ta.__file__), Path(__file__)):
        digest.update(hashlib.sha1(path.read_bytes()).digest())
    return digest.hexdigest()[:16]


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
                         "coverage": round(float(grid.coverage), 4) if grid is not None else None})

    return {
        "format": FORMAT, "version": VERSION,
        "engine": ENGINE, "engine_mode": str(analysis.engine), "engine_hash": hash_,
        "app_version": ta.APP_VERSION, "beat_vote": bool(vote),
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
    }


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
    if "pulse" in text or "beats" in text or "tempo" in text:
        return "no_pulse"
    return "refused"


def refused_result(message: str, *, vote: bool, hash_: str, duration_s: float | None = None) -> dict:
    """The engine found nothing it would stand behind: no BPM, no red lines,
    the reason. White noise ends here (CLAUDE.md rule 2)."""
    return {
        "format": FORMAT, "version": VERSION,
        "engine": ENGINE, "engine_mode": None, "engine_hash": hash_,
        "app_version": ta.APP_VERSION, "beat_vote": bool(vote),
        "params": default_params(),
        "duration_s": round(duration_s, 3) if duration_s is not None else None,
        "refused": True, "refusal": {"code": refusal_code(message), "message": message},
        "global_bpm": None, "offset_ms": None, "meter": None, "stability": None,
        "residual_ms": None, "red_lines": [], "sections": [], "findings": [],
        "osu_timing": "",
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


def analyse(path: str | Path, *, vote: bool, hash_: str,
            max_seconds: float | None = None,
            progress: Callable[[str, float], None] | None = None) -> dict:
    """Run the engine on one file and return its ``timing-result v1``.

    A ``ValueError`` from the engine is a refusal (no pulse, too short, too
    long), returned as a result. Anything else is a failure, raised as
    ``AnalysisFailed`` with the engine's message.
    """
    heavy = header_refusal(path, max_seconds)
    if heavy:
        return refused_result(heavy, vote=vote, hash_=hash_)
    seconds = audio_seconds(path)
    if max_seconds and seconds is not None and seconds > max_seconds:
        return refused_result(f"Audio is longer than {max_seconds / 60:g} minutes.",
                              vote=vote, hash_=hash_, duration_s=seconds)

    def say(message: str) -> None:
        found = stage_of(message)
        if found and progress is not None:
            progress(*found)

    params = default_params()
    try:
        analysis = ta.analyze_audio(
            str(path), params["min_delta"], params["persistence"], params["prefer_map_bpm"],
            params["min_confidence"], say, params["force_subdivision"], params["refine_beats"],
            beat_vote=vote)
    except ValueError as exc:
        return refused_result(str(exc), vote=vote, hash_=hash_, duration_s=seconds)
    except Exception as exc:  # noqa: BLE001 -- the job records why, the worker keeps going
        raise AnalysisFailed(str(exc) or type(exc).__name__) from exc
    if max_seconds and analysis.duration > max_seconds:
        return refused_result(f"Audio is longer than {max_seconds / 60:g} minutes.",
                              vote=vote, hash_=hash_, duration_s=float(analysis.duration))
    if progress is not None:
        progress("result", 0.95)
    return build_result(analysis, vote=vote, hash_=hash_)
