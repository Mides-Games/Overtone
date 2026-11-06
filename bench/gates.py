"""Regression gates the accuracy benchmark cannot see.

``benchmark.py`` measures **precision** — given that a song has a pulse, how
close are the reported BPM and offset. It deliberately normalizes the octave,
and that leaves two blind spots wide enough to drive a rewrite through:

F-07  Nothing checks which octave was chosen. The tempogram-hint path
      (``_tempo_hints`` -> ``_hint_score`` -> ``_beat_from_atoms``) decides
      whether a track reads 112 or 225, and a change there could halve or
      double every track while all 24 benchmark rows stayed green.

F-11  Nothing checks whether a *density* change inside a reported section was
      noticed. ``_grow_sections`` computes coverage and throws it away
      (``share, _cov, rms = _grid_quality(...)``), so a region where the note
      rate halves is absorbed into its neighbour in silence.

So this file holds two gates:

    python bench/gates.py bpm-snapshot        # F-07: pin the absolute BPMs
    python bench/gates.py bpm-snapshot --update
    python bench/gates.py coverage            # F-11: find density changes
    python bench/gates.py measures            # per-section bars and downbeats
    python bench/gates.py signatures          # time-signature regions over one bar
    python bench/gates.py robustness          # the audit's edge-case probes
    python bench/gates.py reference           # hand-timed maps graded by the attacks
    python bench/gates.py assisted            # two marked downbeats seed the grid
    python bench/gates.py real-audio          # local songs keep analysing, readings pinned
    python bench/gates.py real-audio --update

Both exit non-zero on failure. Neither renders new audio for the main corpus —
they reuse ``bench/audio/`` — but ``coverage`` has two fixtures of its own,
kept *out* of ``benchmark.CASES`` on purpose so the headline "24/24" stays
exactly comparable to the numbers already published.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import soundfile as sf  # noqa: E402

import benchmark as bm  # noqa: E402
import local_data  # noqa: E402  -- the private library measurements, gitignored
import overtone as ta  # noqa: E402

from gate_modes.common import (  # noqa: E402,F401
    BPM_EPS,
    COVERAGE_DROP,
    HERE,
    PERF_SNAPSHOT,
    REAL_AUDIO,
    REAL_SNAPSHOT,
    SNAPSHOT,
    _analyse,
    _reading)
from gate_modes.octave import (  # noqa: E402,F401
    bpm_snapshot)
from gate_modes.density import (  # noqa: E402,F401
    COVERAGE_CASES,
    SUBDIVISIONS,
    coverage,
    coverage_profile)
from gate_modes.bars import (  # noqa: E402,F401
    MEASURE_CASES,
    SIGNATURE_BAR,
    SIGNATURE_BARS,
    SIGNATURE_FIRST,
    SIGNATURE_REGIONS,
    build_measures,
    build_signatures,
    measures,
    signatures)
from gate_modes.robustness import (  # noqa: E402,F401
    CLEAN_ERRORS,
    _clicks,
    _write_wav,
    robustness)
from gate_modes.maps import (  # noqa: E402,F401
    ASSISTED_MARK_ERRORS_MS,
    ASSISTED_OVERSHOOT_BEATS,
    ASSISTED_PART_TOLERANCE,
    REFERENCE_SHIFT_MS,
    REFERENCE_TEMPO_ERROR,
    assisted,
    reference)
from gate_modes.real_audio import (  # noqa: E402,F401
    real_audio)
from gate_modes.perf import (  # noqa: E402,F401
    PERF_CASES,
    PERF_ENV,
    PERF_FACTOR,
    PERF_FORMAT,
    PERF_MARGIN_S,
    PERF_PINNED,
    PERF_RUNS,
    PERF_WALL_FACTOR,
    PERF_WALL_MARGIN_S,
    _perf_slower,
    _stage_times,
    perf)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("gate",
                        choices=("bpm-snapshot", "coverage", "measures", "signatures",
                                 "robustness", "reference", "assisted", "real-audio",
                                 "perf"))
    parser.add_argument("--only", nargs="*", metavar="CASE",
                        help="bpm-snapshot / real-audio / perf: run just these cases")
    parser.add_argument("--update", action="store_true",
                        help="bpm-snapshot / real-audio / perf: rewrite the baseline")
    parser.add_argument("--runs", type=int, default=PERF_RUNS,
                        help=f"perf: analyses per case, the fastest counting (default {PERF_RUNS})")
    parser.add_argument("--regen", action="store_true", help="re-render fixtures")
    parser.add_argument("--engine", choices=("auto", "precision", "legacy"),
                        default="auto")
    parser.add_argument("--dir", default=str(bm.AUDIO_DIR))
    args = parser.parse_args()

    if args.gate == "robustness":
        raise SystemExit(robustness())
    if args.gate == "reference":
        raise SystemExit(reference())
    if args.gate == "assisted":
        raise SystemExit(assisted())
    if args.gate == "real-audio":
        names = args.only or list(REAL_AUDIO)
        unknown = [n for n in names if n not in REAL_AUDIO]
        if unknown:
            print(f"Unknown track(s): {', '.join(unknown)}")
            raise SystemExit(2)
        raise SystemExit(real_audio(names, args.update))
    audio_dir = Path(args.dir)
    audio_dir.mkdir(parents=True, exist_ok=True)
    if args.gate == "perf":
        names = args.only or list(PERF_CASES)
        unknown = [n for n in names if n not in PERF_CASES]
        if unknown:
            print(f"Unknown case(s): {', '.join(unknown)}\nAvailable: {', '.join(PERF_CASES)}")
            raise SystemExit(2)
        if args.runs < 1:
            print("--runs must be at least 1")
            raise SystemExit(2)
        raise SystemExit(perf(names, audio_dir, args.runs, args.update))
    if args.gate == "bpm-snapshot":
        names = args.only or list(bm.CASES)
        unknown = [n for n in names if n not in bm.CASES]
        if unknown:
            print(f"Unknown case(s): {', '.join(unknown)}")
            raise SystemExit(2)
        raise SystemExit(bpm_snapshot(names, audio_dir, args.engine, args.update))
    if args.gate == "measures":
        raise SystemExit(measures(audio_dir, args.engine, args.regen))
    if args.gate == "signatures":
        raise SystemExit(signatures(audio_dir, args.engine, args.regen))
    raise SystemExit(coverage(audio_dir, args.engine, args.regen))


if __name__ == "__main__":
    main()
