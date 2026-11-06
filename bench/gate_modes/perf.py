"""perf: every stage inside its time budget."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import benchmark as bm  # noqa: E402
import overtone as ta  # noqa: E402

from gate_modes.common import HERE, PERF_SNAPSHOT  # noqa: E402


# ---------------------------------------------------------------------------
# Per-stage cost, against a pinned baseline
# ---------------------------------------------------------------------------

#: The cases the perf gate times, one per path the engine takes: the common
#: grid analysis, the long track where the heavy stages actually cost
#: something (its attacks and sections are most of the run), and a ramp, which
#: no grid fits, so the fallback tracker's stages are timed too.
PERF_CASES = ("edm-174", "long-6min", "_ramp")
#: Analyses per case. The fastest counts: noise on this machine only ever adds
#: (another process taking the core, a page fault, numba compiling on the
#: first analysis of the process), so the minimum is the closest thing to the
#: engine's own cost that can be measured from here. Two runs would do; three
#: costs little and makes the warm-up impossible to mistake for the cost.
PERF_RUNS = 3
#: The measurement runs **single-threaded, in a process of its own**. numpy's
#: and numba's pools are sized when they are imported, so this cannot be set
#: after gates.py has loaded them. It matters: with the pools free, attack
#: detection on edm-174 cost 1.72, 2.94 and 3.11 CPU seconds for identical
#: work as the pool grew and shrank (CPU over wall ran 2.06-3.60). Pinned,
#: CPU time is wall time and the same stage lands within 4 % run to run, which
#: is what makes a budget mean anything. It is the engine's cost that is being
#: held, not the machine's parallelism.
PERF_ENV = {"OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1",
            "NUMBA_NUM_THREADS": "1", "NUMEXPR_NUM_THREADS": "1"}
#: Set in the child, so it measures instead of spawning another child.
PERF_PINNED = "OVERTONE_PERF_PINNED"
#: Bumped when the snapshot's shape changes, so an old one is named rather
#: than read as the new one and compared against nonsense.
PERF_FORMAT = 1
#: A stage fails when its CPU time passes **both** bars: this many times the
#: baseline, and this many seconds over it. The factor alone would flag a
#: 20 ms stage that drifted to 50; the margin alone would let a 0.2 s stage
#: become 0.6. Both together catch what this gate is for -- a stage that grew
#: by an order, an accidental O(n^2), a lost early exit -- and leave the
#: machine's own third-of-a-run spread well inside.
PERF_FACTOR = 2.0
PERF_MARGIN_S = 0.30
#: Wall time is held too, and loosely. CPU time answers "is the engine doing
#: more work"; it says nothing about a stage that *waits* -- a lock, a poll, a
#: file read -- and the engine now checkpoints inside its loops, which is
#: exactly where a wait could appear. A sleep of one second inside a stage
#: passed the CPU bars untouched while this one catches it. It is wide because
#: wall time is the machine's: another process can take a third of a run.
PERF_WALL_FACTOR = 3.0
PERF_WALL_MARGIN_S = 1.00


def _perf_slower(was: dict[str, float], now: dict[str, float]) -> list[str]:
    """Which clocks say this stage got slower, worded for the report.

    A clock has to pass **both** its bars before it counts, so neither the
    clock's own step (Windows counts process CPU in 15.6 ms) nor the
    machine's ordinary spread can fail a stage by itself: on this machine a
    stage that did not change lands within about 1.1x of its baseline.
    """
    reasons = []
    if now["cpu"] > was["cpu"] * PERF_FACTOR and now["cpu"] > was["cpu"] + PERF_MARGIN_S:
        reasons.append(f"CPU {was['cpu']:.3f} -> {now['cpu']:.3f} s")
    if (now["wall"] > was["wall"] * PERF_WALL_FACTOR
            and now["wall"] > was["wall"] + PERF_WALL_MARGIN_S):
        reasons.append(f"wall {was['wall']:.3f} -> {now['wall']:.3f} s")
    return reasons


def _stage_times(path: Path, runs: int) -> tuple[str, dict[str, dict[str, float]]]:
    """The engine taken, and what each announced stage cost in CPU and in wall
    seconds, each the fastest of ``runs`` analyses.

    Stage boundaries are the engine's own progress messages, so this measures
    what the user is told is happening; a message no stage is named for is
    left out, which shows up as a stage gone rather than as time hidden. The
    first mark is the call itself, so ``total`` covers the decode and the
    stages together. Each clock takes its own minimum: they answer different
    questions and a run can be the fastest on one and not the other.
    """
    best: dict[str, dict[str, float]] = {}
    engine = ""
    for _ in range(runs):
        marks: list[tuple[str, float, float]] = [("", time.process_time(), time.perf_counter())]
        analysis = ta.analyze_audio(
            str(path),
            progress=lambda m: marks.append((m, time.process_time(), time.perf_counter())))
        marks.append(("", time.process_time(), time.perf_counter()))
        engine = str(analysis.engine)
        run: dict[str, dict[str, float]] = {}
        for (message, cpu0, wall0), (_next, cpu1, wall1) in zip(marks[1:], marks[2:]):
            name = ta.stage_id(message)
            if name is None:
                continue
            into = run.setdefault(name, {"cpu": 0.0, "wall": 0.0})
            into["cpu"] += cpu1 - cpu0
            into["wall"] += wall1 - wall0
        run["total"] = {"cpu": marks[-1][1] - marks[0][1],
                        "wall": marks[-1][2] - marks[0][2]}
        for name, clocks in run.items():
            kept = best.setdefault(name, dict(clocks))
            for clock, seconds in clocks.items():
                kept[clock] = min(kept[clock], seconds)
    return engine, best


def perf(names: list[str], audio_dir: Path, runs: int, update: bool) -> int:
    """Hold every stage of an analysis to the cost it had when pinned.

    The accuracy gates would all stay green if a stage became ten times
    slower; nothing else here would notice until someone waited. Times are the
    machine's, so the baseline is this machine's and the bars are wide: this
    catches a stage that grew by an order, not a percent.

    The timing itself happens in a single-threaded child process (see
    ``PERF_ENV``); this is still one command, which is what the repo asks of
    a gate.
    """
    if os.environ.get(PERF_PINNED) != "1":
        argv = [sys.executable, str(HERE / "gates.py"), "perf",
                "--runs", str(runs), "--dir", str(audio_dir)]
        if update:
            argv.append("--update")
        if names != list(PERF_CASES):
            argv += ["--only", *names]
        return subprocess.call(argv, env={**os.environ, **PERF_ENV, PERF_PINNED: "1"})

    baseline = {}
    if PERF_SNAPSHOT.exists():
        pinned = json.loads(PERF_SNAPSHOT.read_text(encoding="utf-8"))
        if pinned.get("format") != PERF_FORMAT:
            if not update:
                print(f"{PERF_SNAPSHOT.name} was written in an older shape "
                      f"(format {pinned.get('format')}, this reads {PERF_FORMAT}). "
                      "Pin it again with --update and say so in timeline.md.")
                return 1
        else:
            baseline = pinned.get("cases", {})
    if not baseline and not update:
        print(f"No baseline at {PERF_SNAPSHOT.name}. Create it with --update, then commit it.")
        return 1

    current, failures = {}, []
    print(f"seconds per stage, fastest of {runs} run(s), single-threaded; a stage fails past "
          f"{PERF_FACTOR:g}x and +{PERF_MARGIN_S:g} s of CPU,\nor {PERF_WALL_FACTOR:g}x "
          f"and +{PERF_WALL_MARGIN_S:g} s of wall")
    print(f"\n{'case / stage':<26} {'CPU was':>8} {'now':>8} {'wall was':>9} {'now':>8}  verdict")
    print("-" * 72)
    for name in names:
        path = audio_dir / f"{name}.wav"
        if not path.exists():
            if name == "_ramp":
                bm.build_ramp(path, 120.0, 160.0, 60.0)
            else:
                bm.build_track(path, seed=zlib.crc32(name.encode()), **bm.CASES[name])
        engine, measured = _stage_times(path, runs)
        current[name] = {"engine": engine,
                         "stages": {stage: {c: round(s, 3) for c, s in clocks.items()}
                                    for stage, clocks in measured.items()}}
        want = baseline.get(name)
        print(f"{name} ({engine})")
        if want is None:
            for stage, clocks in measured.items():
                print(f"  {stage:<24} {'-':>8} {clocks['cpu']:>8.3f} {'-':>9} "
                      f"{clocks['wall']:>8.3f}  {'new' if update else 'NO BASELINE'}")
            if not update:
                failures.append(f"{name}: no baseline entry")
            continue
        if want["engine"] != engine:
            failures.append(f"{name}: engine {want['engine']} -> {engine}")
            print(f"  {'':<24} {'':>8} {'':>8} {'':>9} {'':>8}  "
                  f"ENGINE {want['engine']} -> {engine}")
        for stage, clocks in measured.items():
            was = want["stages"].get(stage)
            if was is None:
                print(f"  {stage:<24} {'-':>8} {clocks['cpu']:>8.3f} {'-':>9} "
                      f"{clocks['wall']:>8.3f}  new stage")
                continue
            slow = _perf_slower(was, clocks)
            for line in slow:
                failures.append(f"{name}/{stage}: {line}")
            print(f"  {stage:<24} {was['cpu']:>8.3f} {clocks['cpu']:>8.3f} "
                  f"{was['wall']:>9.3f} {clocks['wall']:>8.3f}  "
                  f"{'SLOWER' if slow else 'ok'}")
        for stage, was in want["stages"].items():
            if stage not in measured:
                failures.append(f"{name}/{stage}: stage gone")
                print(f"  {stage:<24} {was['cpu']:>8.3f} {'-':>8} {was['wall']:>9.3f} "
                      f"{'-':>8}  GONE")

    if update:
        PERF_SNAPSHOT.write_text(
            json.dumps({"_comment": "CPU and wall seconds per stage on the machine that "
                                    "pinned it, single-threaded; bench/gates.py perf "
                                    "--update rewrites it",
                        "format": PERF_FORMAT, "runs": runs, "cases": current}, indent=1) + "\n",
            encoding="utf-8")
        print(f"\nWrote {PERF_SNAPSHOT.name} for {len(current)} case(s). "
              "Say in timeline.md why the cost changed.")
        return 0
    if failures:
        print("\nperf FAILED:")
        for line in failures:
            print(f"  {line}")
        return 1
    print(f"\nperf: {len(names)} case(s), every stage inside its budget")
    return 0
