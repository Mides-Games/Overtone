"""The command line."""
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

from . import audio_io, exports, osu_read, osu_write, params, pipeline, precision_grid, validation


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------

def _file_stamp(path: str | os.PathLike[str]) -> tuple[int, int] | None:
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return stat.st_mtime_ns, stat.st_size


def watch_file(path: str | os.PathLike[str], run, note, poll: float = 0.5,
               sleep=time.sleep, stop=lambda: False) -> int:
    """Call ``run`` now and again each time ``path`` changes; returns how many runs.

    A change counts once the file holds still for one poll: a DAW rendering
    the file writes it over several seconds, and analysing it half written
    reads a different song. A file that disappears is waited for instead of
    ending the watch -- some editors save by deleting and renaming.
    """
    runs = 0
    seen = _file_stamp(path)
    if seen is not None:
        run()
        runs += 1
    note(f"Watching {path} for changes (Ctrl+C stops)")
    while not stop():
        sleep(poll)
        current = _file_stamp(path)
        if current is None or current == seen:
            continue
        sleep(poll)
        if _file_stamp(path) != current:    # still being written
            continue
        seen = current
        note(f"{path} changed; analysing again")
        run()
        runs += 1
    return runs


def main() -> None:
    # Redirected (`> timing.txt`, a pipe), Windows hands Python its ANSI code
    # page, and a Japanese file name in a batch row or an error ended the run
    # in a traceback. UTF-8 holds every name; a console is left as it is.
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure") and not stream.isatty():
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Overtone — BPM and offset detector for osu! mapping")
    parser.add_argument("audio", help="Audio file to analyze (a folder analyses every audio file in it)")
    parser.add_argument("--delta", type=float, default=1.5, help="Minimum BPM change (default 1.5)")
    parser.add_argument("--persistence", type=int, default=12, help="Beats required to confirm a change (default 12; 20+ for steady songs)")
    parser.add_argument("--min-confidence", type=float, default=75, help="Minimum confidence of exported points (0-100; default 75)")
    parser.add_argument("--csv", help="Output CSV path")
    parser.add_argument("--click", help="Output click-track WAV path (metronome aligned to red lines)")
    parser.add_argument("--stats", action="store_true", help="Print a human-readable summary table")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON instead of the human report")
    parser.add_argument("--subdivision", choices=("auto", "0.25", "0.5", "1", "2", "4"), default="auto",
                        help="Multiply the detected beat rate: 2 doubles (fixes a half-time read), 0.5 halves. Default: auto.")
    parser.add_argument("--engine", choices=("auto", "precision", "legacy"), default="auto",
                        help="auto (default) fits the grid and falls back to the v2 tracker; "
                             "precision refuses to fall back; legacy forces the v2 tracker.")
    parser.add_argument("--decimal-offsets", type=int, default=0, metavar="N",
                        help="Write N decimals on offsets (default 0 — whole ms, what osu!stable expects)")
    parser.add_argument("--no-refine", action="store_true", help="Skip sample-resolution attack re-timing (diagnostic)")
    parser.add_argument("--osz", metavar="OUT.OSZ", help="Write a complete beatmap archive: the audio plus an .osu carrying this timing")
    parser.add_argument("--artist", help="Artist for --osz metadata (default: unknown)")
    parser.add_argument("--title", help="Title for --osz metadata (default: the audio filename)")
    parser.add_argument("--creator", help="Creator for --osz metadata (default: Overtone)")
    parser.add_argument("--inject", metavar="MAP.OSU", help="Inject red lines into an .osu [TimingPoints] (backup .bak, greens kept)")
    parser.add_argument("--no-backup", action="store_true", help="Skip the .bak backup when injecting")
    parser.add_argument("--no-map-preference", action="store_true", help="Do not prefer 120-300 mapping BPM when resolving the octave")
    parser.add_argument("--check", metavar="MAP.OSU",
                        help="Check a map against this audio and print the modder's report instead of "
                             "red lines (red lines to check, changes the map lacks, snapping, objects "
                             "away from the music); exits 3 when it finds something, 0 when clean")
    parser.add_argument("--watch", action="store_true",
                        help="Re-run the analysis, with every other option given, each time the "
                             "audio file changes; Ctrl+C stops")
    args = parser.parse_args()
    if args.watch:
        # Each run is its own process: main() ends in SystemExit on every
        # path, and a fresh process starts from the file as it is now.
        if Path(args.audio).is_dir():
            parser.error("--watch needs a single audio file")
        command = [sys.executable, sys.argv[0]]
        command += [arg for arg in sys.argv[1:] if arg != "--watch"]
        import subprocess
        try:
            watch_file(args.audio, lambda: subprocess.run(command, check=False).returncode,
                       lambda message: print(message, file=sys.stderr))
        except KeyboardInterrupt:
            pass
        return

    def note(message: str) -> None:
        """Progress, status and errors go to stderr: stdout carries only the
        red lines (or the JSON), so `> timing.txt` holds nothing else."""
        print(message, file=sys.stderr)

    # A flag that cannot act is refused, never dropped: --title without --osz
    # wrote nothing anywhere, without a word.
    given = sorted("--" + name.replace("_", "-") for name, value in vars(args).items()
                   if name != "audio" and value != parser.get_default(name))
    metadata = [flag for flag in ("--artist", "--title", "--creator") if flag in given]
    if metadata and not args.osz:
        parser.error(f"{', '.join(metadata)} only {'names' if len(metadata) == 1 else 'name'} "
                     "what --osz writes; add --osz OUT.osz")
    if args.no_backup and not args.inject:
        parser.error("--no-backup only applies to --inject; nothing else makes a backup")
    if not 0 <= args.decimal_offsets <= 6:
        note("Error: --decimal-offsets must be between 0 and 6")
        raise SystemExit(2)
    force = 0.0 if args.subdivision == "auto" else float(args.subdivision)
    if Path(args.audio).is_dir():
        single = [flag for flag in ("--click", "--osz", "--inject", "--stats", "--decimal-offsets",
                                    "--check") if flag in given]
        if single:
            note(f"Error: {'/'.join(single)} need a single audio file, not a folder")
            raise SystemExit(2)
        try:
            rows = pipeline.analyze_batch(args.audio, args.delta, args.persistence, not args.no_map_preference,
                                 args.min_confidence / 100, force, refine_beats=not args.no_refine,
                                 engine=args.engine)
        except ValueError as exc:
            note(f"Error: {exc}")
            raise SystemExit(1)
        failures = sum(not row["ok"] for row in rows)
        if args.json:
            print(json.dumps(rows, indent=2))
        else:
            print(f"{'file':<32} {'bpm':>10} {'points':>7} {'seconds':>8}  status")
            for row in rows:
                status = "ok" if row["ok"] else f"FAILED: {row['error']}"
                print(f"{row['file']:<32} {row['global_bpm']:>10.2f} {row['points']:>7d} "
                      f"{row['duration']:>8.1f}  {status}")
        if args.csv:
            try:
                with open(args.csv, "w", newline="", encoding="utf-8") as handle:
                    writer = csv.writer(handle)
                    writer.writerow(["file", "ok", "global_bpm", "points", "duration", "error"])
                    writer.writerows([[row["file"], row["ok"], row["global_bpm"],
                                       row["points"], row["duration"], row["error"]] for row in rows])
            except OSError as exc:
                note(f"Error writing output: {exc}")
                raise SystemExit(1)
        raise SystemExit(1 if failures else 0)
    try:
        analysis = pipeline.analyze_audio(args.audio, args.delta, args.persistence, not args.no_map_preference,
                                 args.min_confidence / 100, note, force,
                                 refine_beats=not args.no_refine, engine=args.engine)
    except (ValueError, RuntimeError, OSError) as exc:
        note(f"Error: {exc}")
        raise SystemExit(1)
    check = None
    if args.check:
        # The mod report the app's Report section posts, for one map: read
        # only, and scriptable, since a finding changes the exit code.
        try:
            beatmap = osu_read.read_osu_beatmap(args.check)
            times = np.asarray(analysis.attack_times, dtype=np.float64)
            weights = np.asarray(analysis.attack_weights, dtype=np.float64)
            if times.size == 0:     # the fallback tracker keeps none: found here, once
                y, sr = audio_io._load_audio(args.audio, lambda _message: None)
                times, weights, _envelope = precision_grid._detect_attacks(y, sr, params.FIT_HOP)
            check = validation.mod_report(beatmap, times, weights, float(analysis.duration), analysis)
        except (ValueError, OSError, RuntimeError) as exc:
            note(f"Error checking {args.check}: {exc}")
            raise SystemExit(1)
    if args.json:
        report = exports.analysis_report(analysis)
        print(json.dumps(report if check is None else {"analysis": report, "check": check},
                         indent=2))
    elif check is not None:
        if args.stats:
            print(exports.analysis_summary(analysis))
            print()
        print(check["text"] or "No findings.")
    else:
        if args.stats:
            print(exports.analysis_summary(analysis))
            print()
        print(exports.osu_timing_text(analysis, args.decimal_offsets))
    try:
        if args.csv:
            exports.export_csv(analysis, args.csv)
        if args.click:
            exports.export_click_track(analysis, args.click)
        if args.osz:
            written = osu_write.export_osz(
                analysis, args.osz, args.audio,
                {"artist": args.artist, "title": args.title, "creator": args.creator},
                args.decimal_offsets)
            note(f"Wrote {args.osz}: {written['osu']} "
                 f"({written['points']} red line(s), {written['bytes'] / 1e6:.1f} MB)")
    except (OSError, ValueError, RuntimeError) as exc:  # soundfile's errors are RuntimeErrors
        note(f"Error writing output: {exc}")
        raise SystemExit(1)
    if args.inject:
        try:
            summary = osu_write.inject_osu_timing_points(args.inject, analysis, backup=not args.no_backup,
                                               decimals=args.decimal_offsets)
        except (ValueError, OSError) as exc:
            note(f"Error injecting into {args.inject}: {exc}")
            raise SystemExit(1)
        note(f"Injected {summary['reds_added']} red lines "
             f"({summary['reds_replaced']} replaced, {summary['greens_kept']} greens kept, "
             f"{summary['greens_added']} greens added to keep SV and hitsounds)"
             + (" [audio mismatch!]" if summary["audio_mismatch"] else ""))
        if summary["backup"]:
            note(f"Backup: {summary['backup']}")
    # A check that found something says so to a script, as a linter does.
    if check is not None and check["items"]:
        raise SystemExit(3)
