"""Overtone — tempo map analyser for osu! beatmapping (v3 engine).

The v2 engine read tempo from the *gaps between detected beats*. Differencing
amplifies the few milliseconds of jitter every onset detector carries, so its
BPM wandered by a couple of tenths and its offsets sat about 8 ms late.

v3 never differences anything. It fits an explicit model

    t(k) = offset + k · beat_length          (k = integer beat index)

to the detected attack times by iteratively re-weighted least squares. Hundreds
of inlier attacks average the jitter down by sqrt(N), which is what turns
"±0.2 BPM" into "±0.001 BPM" and puts offsets inside a millisecond of the true
attack. On the synthetic benchmark (24 tracks: odd tempos, noise, jitter, swing,
drops, sparse bars, 2-4 tempo changes) every section lands within 0.05 BPM and
5 ms of ground truth, most of them within 0.001 BPM and 0.3 ms.

Pipeline
--------
1. Load mono audio at 44.1 kHz (SoundFile fast-path, librosa fallback).
2. Detect attacks on a 2.9 ms onset envelope, then **re-time each one on the
   raw waveform at sample resolution** — a spectral-flux peak lags the physical
   attack by about a window, and an offset 8 ms late is audible in the editor.
3. Find the *atomic* pulse with a weighted circular-coherence sweep,
   R(f) = |Σ w·e^{2πi f t}| / Σ w, ranked by how much attack energy each grid
   explains times how many of its own slots are filled.
4. Lock that grid onto the track with expanding-window least squares.
5. Decide how many atoms make a beat from the accent pattern (attacks grouped
   by index modulo m) plus tempogram hints — the octave is chosen from
   evidence, never by blind multiplication.
6. Grow constant-tempo sections forward while attacks keep landing on the grid;
   each new section re-seeds its own coherence scan, so an abrupt change cannot
   poison it. Boundaries settle on the beat where the two grids cross, and each
   section is refitted on its own attacks alone.
7. Fall back to the v2 hybrid beat tracker when no grid fits at all (rubato,
   free time, no percussion). Its beats sit on the onset envelope's peaks, so
   they are moved by the envelope's lag behind the attacks, read on the
   waveform for each song.

Defaults (1.5 BPM / 12 beats / 75 %) target songs whose BPM changes often;
the Steady preset (2.0 / 20 / 85 %) suits constant-tempo tracks.

Everything is local: no uploads, no accounts.
"""
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

# The engine is split by pipeline stage. Modules reach each other's names as
# ``module.NAME`` at call time, never by value, so a name set on ``overtone``
# (a test's mock.patch.object, an experiment flag from overtone_runs.py,
# bench/golden.py's stage wrappers) is seen by every caller, as it was when the
# engine was one file. The package forwards reads and writes to the module that
# defines each name.
import types as _types

from . import (params, data_model, onsets, hybrid_tracker, tempo_helpers,  # noqa: E402
               precision_grid, audio_io, pipeline, red_lines, beat_this, drum_signal,
               octave_choice, phrases, exports, validation, editing, osu_write, osu_read,
               map_objects, reference_timing, sounds, structure, cli)

_MODULES = (params, data_model, onsets, hybrid_tracker, tempo_helpers, precision_grid,
            audio_io, pipeline, red_lines, beat_this, drum_signal, octave_choice, phrases,
            exports, validation, editing, osu_write, osu_read, map_objects, reference_timing,
            sounds, structure, cli)
#: Names every module imports (``np``, ``os``, ``Path``...): a write reaches all.
_SHARED = frozenset(n for n in vars() if not n.startswith("__") and n not in
                    {m.__name__.rpartition(".")[2] for m in _MODULES} | {"_types"})
#: Every name the engine defines, and the module that defines it.
_OWNER: dict[str, _types.ModuleType] = {}
for _module in _MODULES:
    for _name in vars(_module):
        if _name.startswith("__") or _name in _SHARED \
                or isinstance(vars(_module)[_name], _types.ModuleType):
            continue
        if _name in _OWNER:
            raise ImportError(f"{_name} is defined in {_OWNER[_name].__name__} "
                              f"and {_module.__name__}")
        _OWNER[_name] = _module
del _module, _name


class _Engine(_types.ModuleType):
    """``overtone``: one namespace over the stage modules."""

    def __getattr__(self, name):
        owner = _OWNER.get(name)
        if owner is None:
            raise AttributeError(f"module 'overtone' has no attribute {name!r}")
        return getattr(owner, name)

    def __setattr__(self, name, value):
        owner = _OWNER.get(name)
        if owner is not None:
            setattr(owner, name, value)
            return
        if name in _SHARED:
            for module in _MODULES:
                if name in vars(module):
                    setattr(module, name, value)
        super().__setattr__(name, value)

    def __delattr__(self, name):
        # mock.patch restores a name it did not find in the module's own
        # __dict__ by deleting it and setting the original back.
        owner = _OWNER.get(name)
        if owner is not None:
            delattr(owner, name)
            return
        if name in _SHARED:
            for module in _MODULES:
                if name in vars(module):
                    delattr(module, name)
        super().__delattr__(name)

    def __dir__(self):
        return sorted(set(super().__dir__()) | set(_OWNER))


sys.modules[__name__].__class__ = _Engine
