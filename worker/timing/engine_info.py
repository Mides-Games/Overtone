"""What the worker's engine is: ONNX threads, the Beat This! vote and model, the engine hash, the stages."""
from __future__ import annotations

import functools
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import overtone as ta  # noqa: E402

from timing import settings  # noqa: E402  -- stems_available, read at call time
from timing.settings import (
    DEFAULT_MODE,
    ENGINE,
    FORMAT,
    MINOR,
    MODES,
    MODE_SETTINGS,
    VERSION,
    stems_every_song)  # noqa: E402


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
    library key their caches: a SHA-1 over every module of the engine, plus the
    worker's own code (it shapes the result), plus whether the Beat This! vote ran (it
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
    # A worker that separates the drums reads every song differently from one
    # that cannot: another hash, so neither serves the other's results.
    if MODE_SETTINGS[mode]["drums"] and stems_every_song() and settings.stems_available():
        label += " drums=separated"
    digest = hashlib.sha1(label.encode())
    # This package and the module that fronts it shape the result as the engine does.
    here = Path(__file__).resolve().parent
    engine = sorted(Path(ta.__file__).parent.glob("*.py"))
    for path in (*engine, here.parent / "timing_result.py", *sorted(here.glob("*.py"))):
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
