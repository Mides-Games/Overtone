"""The site worker's cost: seconds per minute of audio and peak memory (W2.4).

    python bench/worker_perf.py                # 1, 6 and 10 minutes, vote on and off
    python bench/worker_perf.py --threads 2    # as the staging worker runs
    python bench/worker_perf.py --only edm-174 --runs 3

Each measurement is one fresh process doing what a worker does with one job:
load the engine (and the Beat This! model when the vote is on), then
``timing_result.analyse`` one file. The process is fresh so its peak memory
is one job's, model included, which is what the container's RAM limit has to
hold. Threads are capped the way ``deploy/eggs/start.sh`` caps them from
``WORKER_THREADS`` (the math libraries' pools and ONNX Runtime's), 4 by
default, as the production worker runs.

The gate holds the two numbers the deployment is sized by (docs/deploy.md):

- **Peak memory** inside the worker container: 2048 MB with the vote (its
  RAM in docs/deploy.md), 768 MB without. The deploy notes said 512 MB would
  do without the vote; that was never measured, and the first run of this
  gate (2026-10-27) read 565 MB for a 10-minute track.
- **Time**: the longest track the API accepts (``MAX_AUDIO_SECONDS``, 600 s)
  must finish inside ``JOB_TIMEOUT_S`` (900 s) with half of it to spare, so
  every case has to cost under 45 s per minute of audio. Past that, a busy
  host turns a long upload into a job handed out twice and failed.

The load time (engine import and model) is reported apart: a worker pays it
once at start, not per job. Timings on a shared machine move by a third
between runs (CLAUDE.md), so compare numbers taken minutes apart.

The fixtures are the benchmark's own (same seeds) plus one at the API's
maximum length, rendered on first use into ``bench/audio/``.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import time
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

#: The API's limits the worker is sized against (site/api, docs/deploy.md).
MAX_AUDIO_SECONDS = 600
JOB_TIMEOUT_S = 900
#: Seconds of analysis per minute of audio, at most: the longest accepted
#: track in half the job timeout.
BUDGET_S_PER_MIN = 0.5 * JOB_TIMEOUT_S / (MAX_AUDIO_SECONDS / 60)
#: The worker container's RAM with the vote (docs/deploy.md), and what one
#: without it needs: 565 MB measured at 10 minutes, rounded up to 768.
BUDGET_MB = {True: 2048, False: 768}

#: name -> (benchmark case it is rendered from, duration override or None).
CASES = {
    "edm-174": ("edm-174", None),
    "long-6min": ("long-6min", None),
    "max-10min": ("long-6min", float(MAX_AUDIO_SECONDS)),
}


def _fixture(name: str, audio_dir: Path) -> Path:
    sys.path.insert(0, str(ROOT / "python"))
    sys.path.insert(0, str(HERE))
    import benchmark as bm

    path = audio_dir / (f"{name}.wav" if name in bm.CASES else f"_worker-{name}.wav")
    if not path.exists():
        case, duration = CASES[name]
        spec = dict(bm.CASES[case])
        if duration is not None:
            spec["duration"] = duration
        bm.build_track(path, seed=zlib.crc32(name.encode()), **spec)
    return path


def _peak_mb() -> float:
    """This process's peak resident memory, in MB."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t),
                        ("PeakPagefileUsage", ctypes.c_size_t)]

        # The handle is pointer-sized: left to ctypes' default int, the
        # pseudo-handle is cut to 32 bits and the call fails, reading 0 MB.
        kernel32, psapi = ctypes.windll.kernel32, ctypes.windll.psapi
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        if not psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters),
                                          counters.cb):
            raise OSError("GetProcessMemoryInfo failed")
        return counters.PeakWorkingSetSize / 2**20
    import resource
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / 2**20 if sys.platform == "darwin" else peak / 1024


def child(path: str, vote: bool, threads: int) -> None:
    """One job in this process; prints its numbers as one JSON line."""
    started = time.perf_counter()
    sys.path.insert(0, str(ROOT / "worker"))
    import timing_result as tr

    tr.limit_onnx_threads(threads)
    if vote and not tr.beat_vote_available():
        print(json.dumps({"error": "the Beat This! vote is not available (onnxruntime or "
                                   "assets/models/ missing; a Git LFS pointer is not the model)"}))
        return
    load_s = time.perf_counter() - started
    started = time.perf_counter()
    result = tr.analyse(path, vote=vote, hash_="perf")
    analyse_s = time.perf_counter() - started
    print(json.dumps({"load_s": load_s, "analyse_s": analyse_s, "peak_mb": _peak_mb(),
                      "duration_s": result["duration_s"], "refused": result["refused"],
                      "bpm": result["global_bpm"]}))


def measure(path: Path, vote: bool, threads: int) -> dict:
    env = {**os.environ, "OMP_NUM_THREADS": str(threads), "OPENBLAS_NUM_THREADS": str(threads),
           "MKL_NUM_THREADS": str(threads), "NUMBA_NUM_THREADS": str(threads)}
    done = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--child", str(path),
                           "--vote" if vote else "--no-vote", "--threads", str(threads)],
                          env=env, capture_output=True, text=True, check=False)
    lines = [line for line in done.stdout.splitlines() if line.startswith("{")]
    if done.returncode != 0 or not lines:
        return {"error": (done.stderr.strip().splitlines() or ["no output"])[-1]}
    return json.loads(lines[-1])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*", metavar="CASE", help=f"of {', '.join(CASES)}")
    parser.add_argument("--threads", type=int, default=4, help="WORKER_THREADS (default 4, prod)")
    parser.add_argument("--runs", type=int, default=1, help="jobs per case and mode, the fastest counting")
    parser.add_argument("--dir", default=str(HERE / "audio"), help="where the fixtures live")
    parser.add_argument("--child", help=argparse.SUPPRESS)
    parser.add_argument("--vote", dest="vote", action="store_true", default=True, help=argparse.SUPPRESS)
    parser.add_argument("--no-vote", dest="vote", action="store_false", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.child:
        child(args.child, args.vote, args.threads)
        return 0

    names = args.only or list(CASES)
    unknown = [n for n in names if n not in CASES]
    if unknown or args.threads < 1 or args.runs < 1:
        print(f"Cases: {', '.join(CASES)}; --threads and --runs at least 1.")
        return 2
    audio_dir = Path(args.dir)
    audio_dir.mkdir(parents=True, exist_ok=True)

    print(f"{platform.system()} {platform.machine()}, {os.cpu_count()} cores, "
          f"Python {platform.python_version()}, {args.threads} threads, best of {args.runs}")
    print(f"budget: {BUDGET_S_PER_MIN:.0f} s per audio minute; peak "
          f"{BUDGET_MB[True]} MB with the vote, {BUDGET_MB[False]} MB without")
    print(f"{'case':<10} {'audio':>6} {'vote':>4} {'load s':>7} {'job s':>7} "
          f"{'s/min':>6} {'peak MB':>8}  verdict", flush=True)
    print("-" * 66)
    failures, rows = [], []
    for name in names:
        path = _fixture(name, audio_dir)
        for vote in (True, False):
            runs = [measure(path, vote, args.threads) for _ in range(args.runs)]
            errors = [r["error"] for r in runs if "error" in r]
            if errors:
                failures.append(f"{name} vote={'on' if vote else 'off'}: {errors[0]}")
                print(f"{name:<10} {'':>6} {'on' if vote else 'off':>4}  ERROR: {errors[0]}")
                continue
            best = min(runs, key=lambda r: r["analyse_s"])
            per_min = best["analyse_s"] / (best["duration_s"] / 60)
            peak = max(r["peak_mb"] for r in runs)
            problems = []
            if best["refused"]:
                problems.append("refused")
            if per_min > BUDGET_S_PER_MIN:
                problems.append(f"{per_min:.1f} s/min > {BUDGET_S_PER_MIN:.0f}")
            if peak > BUDGET_MB[vote]:
                problems.append(f"peak {peak:.0f} MB > {BUDGET_MB[vote]}")
            if problems:
                failures.append(f"{name} vote={'on' if vote else 'off'}: " + "; ".join(problems))
            rows.append(name)
            print(f"{name:<10} {best['duration_s']:5.0f}s {'on' if vote else 'off':>4} "
                  f"{best['load_s']:7.1f} {best['analyse_s']:7.1f} {per_min:6.1f} {peak:8.0f}  "
                  f"{'over: ' + '; '.join(problems) if problems else 'ok'}", flush=True)

    print()
    if failures:
        print(f"FAIL: {len(failures)} over budget or broken:")
        for line in failures:
            print(f"  {line}")
        return 1
    print(f"PASS: {len(rows)} jobs inside {BUDGET_S_PER_MIN:.0f} s per audio minute and "
          "their container's memory.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
