"""Each analysis in a child process the worker can stop.

A song is untrusted input. A few kilobytes of header can claim hours of
eight-channel audio, and a damaged file can send a decoder into a loop; in the
worker's own process either one takes the server down with it. So the engine
runs in one child process, started once and kept warm between jobs, and the
worker only waits on it:

    - a wall-clock limit per job: ``max(WORKER_TIMEOUT_MIN_S, WORKER_TIMEOUT_FACTOR
      x the audio's length)``, 120 s and 3x by default. Past it the child is
      killed and the job fails with ``timeout``.
    - on Linux, a limit on the child's resident memory of ``WORKER_MEMORY_MB``,
      1800 by default (0 turns it off). The worker reads the child's RSS from
      /proc every half second and stops it past the limit; a child the kernel
      kills first (the container's OOM killer) is noticed by its pipe closing.
      Either way the job fails with ``too_heavy``. Windows has no /proc: there
      the limit is skipped and said so.

      Not an address-space limit (``RLIMIT_AS``), which this was until
      2026-10-28: ONNX Runtime, numba and the thread pools reserve far more
      address space than they ever touch, so a 1800 MB cap on it failed long
      songs whose real use was well under that (a Softmax allocation inside
      Beat This!), while the RSS of a 10-minute song with the vote peaks at
      about 1.2 GB (docs/timeline.md, W2.4).
    - whatever happens to the child, the worker keeps serving: the next job
      starts a fresh child.

The cost is the warm-up. The engine's imports and the Beat This! model load in
the child, not in the worker, and a killed child's successor pays them again
before it takes the next job (docs/deploy.md has the measured numbers). A job
that ends normally keeps the same child, so a healthy queue pays them once.
``spawn`` rather than ``fork``, on every platform: ONNX Runtime and the OpenMP
pools are not fork-safe once they have threads, and the worker process itself
never imports the engine, so there is nothing warm to inherit anyway.

Standard library only; the child imports ``timing_result`` (and the engine).
"""
from __future__ import annotations

import multiprocessing
import os
import signal
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent

#: How long a child may take to import the engine, load the model and run its
#: self-test before the worker gives up on it.
READY_TIMEOUT_S = 900.0
#: How often a job that reports no new stage still tells the API it is alive,
#: so the API's JOB_TIMEOUT_S sweep never takes a running job for a dead one;
#: the limit here is the one that bounds it.
HEARTBEAT_S = 60.0
#: Messages that mean an allocation failed, from the libraries that do not
#: raise Python's MemoryError (ONNX Runtime's std::bad_alloc, numpy's own).
OUT_OF_MEMORY = ("bad_alloc", "unable to allocate", "failed to allocate", "out of memory", "cannot allocate memory")


@dataclass(frozen=True)
class Limits:
    memory_mb: int = 1800
    timeout_min_s: float = 120.0
    timeout_factor: float = 3.0


def limits_from_env(env=None) -> Limits:
    """``WORKER_MEMORY_MB``, ``WORKER_TIMEOUT_MIN_S`` and ``WORKER_TIMEOUT_FACTOR``,
    each falling back to its default when unset or not a number."""
    env = os.environ if env is None else env
    defaults = Limits()

    def number(name, default, minimum):
        raw = str(env.get(name, "")).strip()
        try:
            value = float(raw) if raw else default
        except ValueError:
            print(f"[worker] {name}={raw!r} is not a number; using {default:g}", file=sys.stderr)
            return default
        return max(minimum, value)

    return Limits(memory_mb=int(number("WORKER_MEMORY_MB", defaults.memory_mb, 0)),
                  timeout_min_s=number("WORKER_TIMEOUT_MIN_S", defaults.timeout_min_s, 10.0),
                  timeout_factor=number("WORKER_TIMEOUT_FACTOR", defaults.timeout_factor, 1.0))


def timeout_for(seconds: float | None, max_seconds: float | None, limits: Limits) -> float:
    """The wall-clock limit of one job. The audio's length is read from its
    header when it has one; without it, the longest audio the API accepts."""
    length = seconds if seconds is not None and seconds > 0 else (max_seconds or 600.0)
    return max(limits.timeout_min_s, limits.timeout_factor * float(length))


class JobFailed(Exception):
    """One job could not be analysed. ``code`` is ``too_heavy``, ``timeout`` or
    ``failed`` (the engine's own error, as before the child existed)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def __str__(self) -> str:
        return self.message if self.code == "failed" else f"{self.code}: {self.message}"


class WorkerBroken(Exception):
    """The child could not get ready at all: the worker cannot serve."""


# ── The child ───────────────────────────────────────────────────────────────


#: How often the worker reads the child's resident memory during a job.
MEMORY_POLL_S = 0.5


def _status_mb(pid, field: str) -> int | None:
    """One ``kB`` field of /proc/<pid>/status, in MB; None without /proc."""
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith(field + ":"):
                return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        pass
    return None


def resident_mb(pid) -> int | None:
    """A process's resident memory now (Linux), in MB."""
    return _status_mb(pid, "VmRSS")


def resident_peak_mb() -> int | None:
    """This process's peak resident memory (Linux), for the start-up log."""
    return _status_mb("self", "VmHWM")


def can_watch_memory(memory_mb: int) -> bool:
    """Whether the memory limit applies here: on, and /proc readable."""
    return bool(memory_mb and memory_mb > 0 and resident_mb("self") is not None)


def kind_of(exc: BaseException) -> str:
    """``too_heavy`` for an allocation that failed, anywhere in the chain."""
    seen = 0
    while exc is not None and seen < 8:
        if isinstance(exc, MemoryError):
            return "too_heavy"
        if any(text in str(exc).lower() for text in OUT_OF_MEMORY):
            return "too_heavy"
        exc = exc.__cause__ or exc.__context__
        seen += 1
    return "failed"


def _self_test(tr, vote: bool, hash_: str) -> None:
    """Eight seconds of clicks through the whole engine, vote included: proves
    the memory limit leaves room for an analysis at all, and compiles numba's
    kernels before the first real job instead of during it."""
    import tempfile

    import numpy as np
    import soundfile as sf

    sr = 22050
    audio = np.zeros(sr * 8, dtype=np.float32)
    for beat in range(16):
        start = int((0.25 + beat * 0.5) * sr)
        audio[start:start + 400] += np.hanning(800)[400:].astype(np.float32) * 0.8
    with tempfile.TemporaryDirectory(prefix="overtone-selftest-") as folder:
        path = Path(folder) / "clicks.wav"
        sf.write(str(path), audio, sr)
        tr.analyse(path, vote=vote, hash_=hash_, max_seconds=60)


def run_child(conn, threads: int | None, memory_mb: int, vote_wanted: bool | None, self_test: bool) -> None:
    """The child's whole life: warm up, then analyse on request. Its memory
    is watched from outside (Runner), not limited from inside.

    Messages to the worker: ``("ready", vote, hash, limited, peak_mb, hashes)``
    (``hash`` is the normal mode's, ``hashes`` every mode's) or
    ``("broken", kind, text)`` once; then per job, asked as ``("analyse",
    path, max_seconds, mode, options)``, ``("length", seconds)``,
    any number of ``("progress", stage, fraction)``, and one ``("result",
    dict)`` or ``("failed", kind, text)``. After a ``too_heavy`` the child
    leaves, so the next job gets a fresh heap.
    """
    # The panel's first ^C is for the worker: it lets the job in hand finish.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    limited = can_watch_memory(memory_mb)
    try:
        sys.path.insert(0, str(HERE))
        import timing_result as tr

        if threads:
            tr.limit_onnx_threads(threads)
        vote = tr.beat_vote_available() if vote_wanted is not False else False
        hashes = tr.engine_hashes(vote)
        hash_ = hashes[tr.DEFAULT_MODE]
        if self_test:
            _self_test(tr, vote, hash_)
    except BaseException as exc:  # noqa: BLE001 -- told to the worker, which decides
        conn.send(("broken", kind_of(exc), f"{type(exc).__name__}: {exc}"))
        return
    conn.send(("ready", vote, hash_, limited, resident_peak_mb(), hashes))

    while True:
        try:
            request = conn.recv()
        except (EOFError, OSError):
            return
        if request[0] != "analyse":
            return
        path, max_seconds = request[1], request[2]
        mode = request[3] if len(request) > 3 and request[3] in tr.MODES else tr.DEFAULT_MODE
        options = request[4] if len(request) > 4 else None
        conn.send(("length", tr.audio_seconds(path)))
        try:
            result = tr.analyse(path, vote=vote, hash_=hashes[mode], max_seconds=max_seconds,
                                mode=mode, options=options,
                                progress=lambda stage, fraction: conn.send(("progress", stage, fraction)))
        except BaseException as exc:  # noqa: BLE001
            kind = kind_of(exc)
            conn.send(("failed", kind, str(exc) or type(exc).__name__))
            if kind == "too_heavy":
                return
            continue
        conn.send(("result", result))


# ── The worker's side ───────────────────────────────────────────────────────


class Runner:
    """The warm child and the limits it runs under."""

    def __init__(self, threads: int | None = None, limits: Limits | None = None, *,
                 vote: bool | None = None, self_test: bool = True,
                 child: Callable = run_child, ready_timeout_s: float = READY_TIMEOUT_S,
                 heartbeat_s: float = HEARTBEAT_S):
        self.threads = threads
        self.limits = limits or Limits()
        self.vote_wanted = vote
        self.self_test = self_test
        self.child = child
        self.ready_timeout_s = ready_timeout_s
        self.heartbeat_s = heartbeat_s
        self.vote = False
        self.hash = None
        self.hashes = {}
        self.limited = False
        self.peak_mb = None
        self.job_peak_mb = None
        self.warmups = 0
        self._process = None
        self._conn = None
        self._context = multiprocessing.get_context("spawn")

    def alive(self) -> bool:
        return self._process is not None and self._process.is_alive()

    def memory_report(self) -> dict | None:
        """What the API's staff panel shows of this worker's memory (W13.19):
        the analysis process's resident MB now, the last job's peak and the
        limit, in whole MB. None where /proc cannot be read (Windows), so the
        panel says nothing rather than a guess."""
        rss = resident_mb(self._process.pid) if self.alive() else None
        if rss is None and self.job_peak_mb is None:
            return None
        limit = self.limits.memory_mb if self.limited and self.limits.memory_mb > 0 else None
        return {"rss_mb": rss, "peak_mb": self.job_peak_mb, "limit_mb": limit}

    def start(self) -> None:
        """A ready child, starting one if there is none. Raises WorkerBroken."""
        if self.alive():
            return
        self._drop()
        # glibc gives each thread its own 64 MB heap reservation, and freed
        # arenas are slow to go back: two keep the resident size near what is
        # in use. They cost nothing measurable here.
        os.environ.setdefault("MALLOC_ARENA_MAX", "2")
        ours, theirs = self._context.Pipe()
        self._process = self._context.Process(
            target=self.child, name="overtone-analysis", daemon=True,
            args=(theirs, self.threads, self.limits.memory_mb, self.vote_wanted, self.self_test))
        self._process.start()
        theirs.close()
        self._conn = ours
        self.warmups += 1
        message = self._receive(time.monotonic() + self.ready_timeout_s)
        if message is None or message[0] != "ready":
            reason = message[2] if message and message[0] == "broken" else "it did not answer"
            if message and message[1] == "too_heavy":
                reason += (f" (the engine ran out of memory while warming up; WORKER_MEMORY_MB is"
                           f" {self.limits.memory_mb}, and the container's own limit may be lower)")
            self._drop(kill=True)
            raise WorkerBroken(f"the analysis process could not start: {reason}")
        _, self.vote, self.hash, self.limited, self.peak_mb, *rest = message
        # A child from before modes announced only the normal mode's hash.
        self.hashes = dict(rest[0]) if rest and isinstance(rest[0], dict) else {"normal": self.hash}

    def analyse(self, path, *, max_seconds: float | None = None,
                progress: Callable[[str, float], None] | None = None,
                mode: str = "normal", options: dict | None = None) -> dict:
        """One job's ``timing-result v1``, in ``mode`` with the person's
        ``options`` (worker/timing_result.py). Raises JobFailed."""
        self.start()
        started = time.monotonic()
        limit = timeout_for(None, max_seconds, self.limits)
        self._conn.send(("analyse", str(path), max_seconds, mode, options or {}))
        last = ("load", 0.0)
        beat = started + self.heartbeat_s
        watch = self.limited and self.limits.memory_mb > 0
        peak = 0
        while True:
            now = time.monotonic()
            deadline = started + limit
            if now >= deadline:
                self._drop(kill=True)
                raise JobFailed("timeout", f"The analysis ran past its {limit:.0f} s limit and was stopped.")
            if watch:
                used = resident_mb(self._process.pid)
                if used is not None:
                    peak = max(peak, used)
                    if used > self.limits.memory_mb:
                        self._drop(kill=True)
                        raise JobFailed("too_heavy", f"The analysis used {used} MB of memory, past the worker's "
                                                     f"{self.limits.memory_mb} MB limit, and was stopped.")
            wait = min(deadline, beat if progress else deadline) - now
            if watch:
                wait = min(wait, MEMORY_POLL_S)
            if not self._conn.poll(max(0.05, wait)):
                if not self._process.is_alive():
                    raise self._died()
                if progress and time.monotonic() >= beat:
                    progress(*last)
                    beat = time.monotonic() + self.heartbeat_s
                continue
            try:
                message = self._conn.recv()
            except (EOFError, OSError):
                raise self._died() from None
            if message[0] == "length":
                limit = timeout_for(message[1], max_seconds, self.limits)
            elif message[0] == "progress":
                last = (message[1], message[2])
                beat = time.monotonic() + self.heartbeat_s
                if progress:
                    progress(*last)
            elif message[0] == "result":
                self.job_peak_mb = peak or None
                return message[1]
            elif message[0] == "failed":
                if message[1] == "too_heavy":
                    self._drop(kill=True)
                    raise JobFailed("too_heavy", "The analysis needed more memory than the worker allows "
                                                 f"({message[2][:200]}).")
                raise JobFailed("failed", message[2])

    def close(self) -> None:
        if self.alive():
            try:
                self._conn.send(("stop",))
            except (OSError, ValueError):
                pass
            self._process.join(5)
        self._drop(kill=True)

    def _receive(self, deadline: float):
        while time.monotonic() < deadline:
            if self._conn.poll(min(1.0, max(0.05, deadline - time.monotonic()))):
                try:
                    return self._conn.recv()
                except (EOFError, OSError):
                    return None
            if not self._process.is_alive():
                return None
        return None

    def _died(self) -> JobFailed:
        self._process.join(5)
        code = self._process.exitcode
        self._drop(kill=True)
        return JobFailed("too_heavy", f"The analysis process was stopped (exit {code}), most likely for "
                                      "running out of memory.")

    def _drop(self, kill: bool = False) -> None:
        if self._process is not None and kill and self._process.is_alive():
            self._process.terminate()
            self._process.join(5)
            if self._process.is_alive():
                self._process.kill()
                self._process.join(5)
        if self._conn is not None:
            try:
                self._conn.close()
            except OSError:
                pass
        self._process = None
        self._conn = None
