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

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import overtone as ta  # noqa: E402,F401  -- the tests reach the engine as timing_result.ta

from timing import settings  # noqa: E402,F401  -- where stems_available is patched

from timing.settings import (  # noqa: E402,F401
    APPROX_SLACK,
    DEFAULT_MODE,
    ENGINE,
    FORMAT,
    HIGH,
    HINT_BPM,
    HINT_METER,
    LOOSE_RESIDUAL_MS,
    MEDIUM,
    MINOR,
    MIN_STRETCH_S,
    MODES,
    MODE_SETTINGS,
    STEMS_EVERY_SONG,
    STEMS_MIN_TIMEOUT_S,
    STEMS_TIME_SHARE,
    TEMPO_HINTS,
    VERSION,
    clean_options,
    default_params,
    engine_settings,
    octave_window,
    stems_available,
    stems_every_song,
    stems_timeout)
from timing.engine_info import (  # noqa: E402,F401
    STAGES,
    _ARENA,
    _shared_arena,
    beat_vote_available,
    engine_hash,
    engine_hashes,
    limit_onnx_threads,
    model_info,
    result_model,
    stage_of)
from timing.result import (  # noqa: E402,F401
    DRIFT_DIVISORS,
    DRIFT_MIN_ATTACKS,
    ENVELOPE_BINS,
    _drift,
    _evidence,
    _level,
    _ms,
    _plain,
    _section_grid,
    _weighted_quantile,
    asked,
    build_result,
    refusal_code,
    refused_result)
from timing.checks import (  # noqa: E402,F401
    AnalysisFailed,
    MAX_CHANNELS,
    MAX_SAMPLERATE,
    _fold,
    _shift_ms,
    _shifted,
    audio_seconds,
    header_refusal,
    hint_checks,
    shift_result)
from timing.run import (  # noqa: E402,F401
    analyse)
