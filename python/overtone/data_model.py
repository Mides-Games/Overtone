"""The data data_model (timing points, the analysis) and stopping an analysis."""
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

from . import params


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TimingPoint:
    offset_ms: float
    bpm: float
    confidence: float
    beat_index: int
    #: Beats per bar for this point, written into the .osu meter field and
    #: used to accent the click track. Defaults to 4 so every existing caller
    #: and every hand-made point keeps working unchanged.
    meter: int = 4
    #: True when the accents actually proved where the bar starts. When they
    #: did not, the offset is anchored to a beat rather than a downbeat —
    #: guessing a bar without evidence pushes the first red line up to three
    #: beats past the first sound.
    meter_known: bool = False
    #: True when the mapper placed or edited this point. Export snapping never
    #: moves it, and never pulls the next detected point onto its grid.
    manual: bool = False


@dataclass
class Analysis:
    source: str
    duration: float
    beats: np.ndarray
    local_bpms: np.ndarray
    points: list[TimingPoint]
    hop_length: int
    sample_rate: int
    subdivision: float
    # v2 enrichment (defaults keep old pickles/callers working)
    global_bpm: float = 0.0
    stability: float = 0.0
    meter: str = "4/4"
    onset: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    # Pre-subdivision beat grid (frames): lets the GUI/CLI re-resolve ×1/×2/×4
    # without re-tracking beats.
    base_frames: np.ndarray | None = None
    # v3 precision engine: the raw evidence and the fitted grids. Present only
    # when the grid engine ran; the legacy tracker leaves them empty and every
    # consumer falls back to the beat-array path.
    attack_times: np.ndarray = field(default_factory=lambda: np.zeros(0))
    attack_weights: np.ndarray = field(default_factory=lambda: np.zeros(0))
    sections: list["GridSection"] = field(default_factory=list)
    meter_beats: int = 4
    downbeat_class: int = 0
    fit_residual_ms: float = 0.0
    engine: str = "legacy"
    # The fallback tracker's beats and red lines were moved by this much (s,
    # negative: earlier) from the onset envelope's peaks it put them on: the
    # envelope's lag behind the sound, measured on the song (_tracker_lag).
    # base_frames stay where the tracker put them. 0 for the precision
    # engine, which re-times every attack on the waveform instead.
    beat_shift_s: float = 0.0
    #: True when the red lines came from the local-tempo tracker
    #: (_local_tempo_track): x2 / /2 then scale those lines, not the v2 grid.
    local_tempo: bool = False
    # The subdivision of base_frames the fallback tracker chose by itself
    # (pulse Auto), before any factor the user asked for. Away from it a beat
    # with no peak under it is held where the split put it, in the analysis
    # and in a ×2 / ÷2 rebuild alike (_tracker_result). 0 for the precision
    # engine; a result without it holds such beats above a subdivision of 1.
    auto_subdivision: float = 0.0
    # Whether the fallback tracker's beats were re-anchored to transients
    # (analyze_audio's refine_beats); a ×2 / ÷2 rebuild re-anchors its own
    # only then. The precision engine's rebuild reads its fitted grids and
    # re-anchors nothing, so it never reads this.
    refine_beats: bool = True


# ---------------------------------------------------------------------------
# Stopping an analysis
# ---------------------------------------------------------------------------

class AnalysisStopped(BaseException):
    """Raised through the engine when the analysis running on this thread
    was asked to stop (see ``checkpoint``). A BaseException, as asyncio's
    CancelledError is: the engine falls back to the beat tracker on any
    ``Exception`` from the precision fit, and passes over librosa's failures
    in places, and a stop is not a failure."""


#: Per thread on purpose: an analysis another thread runs meanwhile (a
#: reference grade, a library scan) never sees this one's stop.
_stop_requests = threading.local()


def checkpoint() -> None:
    """Where a long loop lets a stop land (roadmap 10.12).

    Raises AnalysisStopped when the analysis running on this thread was asked
    to stop; otherwise it costs a thread-local read. Nothing asks unless the
    caller ran the analysis inside ``stop_requests``, so the CLI and every
    other thread run to the end as they always did.
    """
    asked = getattr(_stop_requests, "asked", None)
    if asked is not None and asked():
        raise AnalysisStopped()


@contextmanager
def stop_requests(asked: Callable[[], bool]):
    """Let ``asked()`` stop what this thread analyses inside the block: every
    checkpoint calls it, and a true answer raises AnalysisStopped there."""
    previous = getattr(_stop_requests, "asked", None)
    _stop_requests.asked = asked
    try:
        yield
    finally:
        _stop_requests.asked = previous


def stage_id(message: str) -> str | None:
    """The stage a progress message announces, or None for one the table does
    not know. The fallback's message carries its reason after the fixed text."""
    return next((sid for text, sid in params.STAGES.items() if message.startswith(text)), None)
