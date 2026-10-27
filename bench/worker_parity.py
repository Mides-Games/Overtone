"""The site worker's readings against the pinned BPMs (W2.3).

    python bench/worker_parity.py              # 24 cases through worker/timing_result.py
    python bench/worker_parity.py --only edm-174

``bench/gates.py bpm-snapshot`` pins the engine's absolute BPMs on the machine
that recorded ``bench/bpm_snapshot.json`` (Windows). The worker runs on Linux,
behind a different numpy/scipy/libsndfile build, and goes through its own
wrapper (``worker/timing_result.py``): parameters written out instead of read
from the desktop shell, points snapped and filtered, values rounded into JSON.
This gate runs the 24 benchmark cases the way a job runs them --
``timing_result.analyse`` with the Beat This! vote -- and checks every
``timing-result v1`` against the same snapshot, with the same tolerance:

- ``global_bpm`` and every red line's BPM within ``bpm_eps`` (an octave flip
  is a factor of two, named as one);
- the same number of red lines, the same meter and the same engine path.

Run on Linux, it is the proof that the worker reads what Windows reads. It
imports neither ``bench/gates.py`` nor the desktop shell (``overtone_web``),
which a worker host does not install. It refuses to run without the vote:
the snapshot was taken with it, and a host without the model would differ for
that reason alone, which would say nothing about Linux.

The fixtures are rendered on first use into ``bench/audio/`` exactly as the
benchmark renders them (same seeds), so a fresh clone needs nothing copied.
"""
from __future__ import annotations

import argparse
import json
import platform
import sys
import time
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "worker"))
sys.path.insert(0, str(HERE))

import benchmark as bm  # noqa: E402
import timing_result as tr  # noqa: E402

SNAPSHOT = HERE / "bpm_snapshot.json"


def _fixture(name: str, audio_dir: Path) -> Path:
    path = audio_dir / f"{name}.wav"
    if not path.exists():
        bm.build_track(path, seed=zlib.crc32(name.encode()), **bm.CASES[name])
    return path


def compare(result: dict, want: dict, eps: float) -> list[str]:
    """What differs between one ``timing-result v1`` and its snapshot entry."""
    if result["refused"]:
        return [f"refused ({result['refusal']['code']}): {result['refusal']['message']}"]
    problems = []
    got = result["global_bpm"]
    if abs(got - want["global_bpm"]) > eps:
        ratio = got / max(want["global_bpm"], 1e-9)
        flip = "  <-- OCTAVE FLIP" if abs(ratio - 2.0) < 0.02 or abs(ratio - 0.5) < 0.01 else ""
        problems.append(f"global BPM {want['global_bpm']} -> {got:.4f}{flip}")
    lines = [line["bpm"] for line in result["red_lines"]]
    if len(lines) != len(want["point_bpms"]):
        problems.append(f"{len(want['point_bpms'])} red lines -> {len(lines)}")
    else:
        for got_bpm, expected in zip(lines, want["point_bpms"]):
            if abs(got_bpm - expected) > eps:
                problems.append(f"red line {expected} -> {got_bpm:.4f}")
    if result["meter"] != want["meter"]:
        problems.append(f"meter {want['meter']} -> {result['meter']}")
    if result["engine_mode"] != want["engine"]:
        problems.append(f"engine {want['engine']} -> {result['engine_mode']}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*", metavar="CASE", help="run just these cases")
    parser.add_argument("--dir", default=str(bm.AUDIO_DIR), help="where the fixtures live")
    args = parser.parse_args(argv)

    snapshot = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    baseline, eps = snapshot["cases"], float(snapshot["bpm_eps"])
    names = args.only or list(bm.CASES)
    unknown = [n for n in names if n not in baseline]
    if unknown:
        print(f"Not in {SNAPSHOT.name}: {', '.join(unknown)}")
        return 2
    if not tr.beat_vote_available():
        print("The Beat This! vote is not available (onnxruntime or assets/models/ missing; "
              "a Git LFS pointer is not the model). The snapshot was taken with it, so a "
              "comparison without it measures nothing. Run `git lfs pull` and retry.")
        return 2
    audio_dir = Path(args.dir)
    audio_dir.mkdir(parents=True, exist_ok=True)
    hash_ = tr.engine_hash(True)

    import numpy
    import scipy
    import soundfile
    print(f"{platform.system()} {platform.machine()}, Python {platform.python_version()}, "
          f"numpy {numpy.__version__}, scipy {scipy.__version__}, "
          f"libsndfile {soundfile.__libsndfile_version__}; worker engine {hash_}")
    print(f"{'case':<18} {'global BPM':>11} {'lines':>6} {'s':>6}  verdict")
    print("-" * 62)
    failures = []
    for name in names:
        started = time.perf_counter()
        result = tr.analyse(_fixture(name, audio_dir), vote=True, hash_=hash_)
        seconds = time.perf_counter() - started
        problems = compare(result, baseline[name], eps)
        if problems:
            failures.append(f"{name}: " + "; ".join(problems))
        bpm = f"{result['global_bpm']:11.4f}" if result["global_bpm"] is not None else f"{'-':>11}"
        print(f"{name:<18} {bpm} {len(result['red_lines']):6d} {seconds:6.1f}  "
              f"{'CHANGED: ' + '; '.join(problems) if problems else 'ok'}")

    print()
    if failures:
        print(f"FAIL: {len(failures)} of {len(names)} worker readings differ from {SNAPSHOT.name}:")
        for line in failures:
            print(f"  {line}")
        return 1
    print(f"PASS: {len(names)}/{len(names)} worker readings match {SNAPSHOT.name} "
          f"within {eps} BPM.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
