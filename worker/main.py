"""overtone-worker: takes analysis jobs from the site's API, one at a time.

    python worker/main.py            # with OVERTONE_API and WORKER_TOKEN set

The API owns every piece of state (docs/16-web-platform.md, ADR-W5): the
queue, the spooled audio and the results. The worker is an HTTP client of its
internal routes and holds nothing between jobs:

    claim -> download the audio to a temp file -> analyse -> post the result
          -> delete the temp file

and the API deletes its own spooled copy when the result or the failure
arrives (ADR-W4: the audio is never kept). A worker that dies mid-job leaves
the job running; the API hands it out again after JOB_TIMEOUT_S, at most
twice, and every call the worker makes carries the attempt it was given, so a
late answer from a stale attempt is refused rather than overwriting a newer one.

Configuration (environment):

    OVERTONE_API   the API's origin, default http://127.0.0.1:3001
    WORKER_TOKEN   the bearer the API's internal routes demand (required)
    WORKER_POLL_S  seconds between claims while the queue is empty, default 2
    WORKER_THREADS Beat This!'s ONNX Runtime threads (deploy/eggs/start.sh
                   sets the math libraries' own from it), default: all cores
    WORKER_MEMORY_MB       the analysis process's address-space cap (Linux),
                           default 1800; 0 turns it off
    WORKER_TIMEOUT_MIN_S   the shortest wall-clock limit of a job, default 120
    WORKER_TIMEOUT_FACTOR  the limit in multiples of the audio's length, default 3

Each analysis runs in a child process under those limits (worker/isolate.py):
a job that runs out of memory or time fails on its own, as ``too_heavy`` or
``timeout``, and the worker goes on to the next one.

The API, not the proxy in front of it, is what the worker talks to: the
internal routes are never forwarded by overtone-web (deploy/web/serve.mjs).

Standard library plus the engine: no new dependency.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import isolate  # noqa: E402

#: Extensions the API accepts; anything else is never written to disk here.
EXTENSIONS = {".mp3", ".ogg", ".wav", ".flac", ".m4a", ".opus"}


class Api:
    """The API's internal routes, with the worker's bearer token."""

    def __init__(self, base: str, token: str, timeout: float = 30.0):
        self.base = base.rstrip("/") + "/api/internal"
        self.token = token
        self.timeout = timeout

    def _request(self, method: str, path: str, body: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        return urllib.request.urlopen(request, timeout=self.timeout)

    def call(self, method: str, path: str, body: dict | None = None) -> dict | None:
        with self._request(method, path, body) as response:
            raw = response.read()
            return json.loads(raw) if raw else None

    def claim(self, engine_hash: str, engine_hashes: dict | None = None) -> dict | None:
        """The next queued job, or None when the queue is empty (204).
        ``engine_hash`` is the normal mode's; ``engine_hashes`` names every
        mode's, which the API keys each mode's cached results by."""
        body = {"engine_hash": engine_hash}
        if engine_hashes:
            body["engine_hashes"] = engine_hashes
        return self.call("POST", "/jobs/claim", body)

    def download(self, job_id: str, attempt: int, target: Path) -> None:
        with self._request("GET", f"/jobs/{job_id}/audio?attempt={int(attempt)}") as response, \
                open(target, "wb") as out:
            shutil.copyfileobj(response, out, 1 << 20)


def run_job(api: Api, job: dict, runner: isolate.Runner) -> str:
    """One job, start to end. Returns the state it ended in."""
    job_id, attempt = job["id"], job["attempt"]
    suffix = Path(str(job.get("filename", ""))).suffix.lower()
    if suffix not in EXTENSIONS:
        suffix = ".audio"
    folder = Path(tempfile.mkdtemp(prefix="overtone-job-"))
    try:
        audio = folder / f"input{suffix}"
        api.download(job_id, attempt, audio)

        last = [0.0]

        def progress(stage: str, fraction: float) -> None:
            # Forward only: an engine message that maps backwards (the
            # fallback after a failed fit) does not move the bar back.
            fraction = max(fraction, last[0])
            last[0] = fraction
            try:
                api.call("POST", f"/jobs/{job_id}/progress",
                         {"attempt": attempt, "stage": stage, "progress": round(fraction, 3)})
            except (urllib.error.URLError, OSError):
                pass  # progress is a courtesy; the result is what matters

        try:
            # The mode and the hints the person chose (W11.1, W3.21); a job
            # from an API without them is a normal one with none.
            result = runner.analyse(audio, max_seconds=job.get("max_seconds"), progress=progress,
                                    mode=job.get("mode") or "normal", options=job.get("options") or {})
        except isolate.JobFailed as exc:
            api.call("POST", f"/jobs/{job_id}/fail", {"attempt": attempt, "error": str(exc)[:500]})
            return "failed" if exc.code == "failed" else f"failed ({exc.code})"
        api.call("POST", f"/jobs/{job_id}/result", {"attempt": attempt, "result": result})
        return "refused" if result["refused"] else "done"
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def exit_with_parent(pid: int) -> None:
    """Leave when the process that started the worker is gone. ``pnpm dev``
    passes its own pid; node --watch restarts it without running exit
    handlers on Windows, so the worker checks on it rather than waiting to be
    told. (It used to read stdin until the pipe closed, but on Windows a
    thread blocked reading a pipe stalls the start of the analysis child.)"""
    import threading
    import time

    def alive() -> bool:
        if os.name == "nt":
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
            if not handle:
                return False
            try:
                return kernel32.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT
            finally:
                kernel32.CloseHandle(handle)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def watch() -> None:
        while alive():
            time.sleep(2.0)
        os._exit(0)

    threading.Thread(target=watch, daemon=True, name="parent-watch").start()


def main() -> int:
    base = os.environ.get("OVERTONE_API", "http://127.0.0.1:3001")
    token = os.environ.get("WORKER_TOKEN", "").strip()
    if not token:
        print("[worker] WORKER_TOKEN is not set: the API's internal routes refuse a worker without it.",
              file=sys.stderr)
        return 2
    try:
        poll = max(0.2, float(os.environ.get("WORKER_POLL_S", "2")))
    except ValueError:
        poll = 2.0

    parent = os.environ.get("WORKER_PARENT_PID", "").strip()
    if parent.isdigit():
        exit_with_parent(int(parent))
    threads = os.environ.get("WORKER_THREADS", "").strip()
    limits = isolate.limits_from_env()
    runner = isolate.Runner(int(threads) if threads.isdigit() and int(threads) > 0 else None, limits)

    # The panel's stop is ^C, and Wings waits up to ten minutes before it
    # kills: the first one lets the job in hand finish and post its result,
    # and no new job is claimed; a second one leaves at once (the API hands
    # that job out again after JOB_TIMEOUT_S).
    stop = threading.Event()

    def on_stop(signum, _frame):
        if stop.is_set():
            raise KeyboardInterrupt
        stop.set()
        print("[worker] stopping: no new jobs; the one in hand finishes first (^C again to leave now)",
              flush=True)

    signal.signal(signal.SIGINT, on_stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, on_stop)

    api = Api(base, token)
    print("[worker] loading the engine in the analysis process…", flush=True)
    started = time.perf_counter()
    try:
        runner.start()
    except isolate.WorkerBroken as exc:
        print(f"[worker] {exc}", file=sys.stderr, flush=True)
        return 4
    hash_ = runner.hash
    if runner.limited:
        memory = f"{limits.memory_mb} MB address space"
    else:
        memory = "no memory cap (" + ("off" if limits.memory_mb <= 0 else "no rlimit on this platform") + ")"
    peak = f", {runner.peak_mb} MB used after warm-up" if runner.peak_mb else ""
    print(f"[worker] analysis process warm in {time.perf_counter() - started:.1f} s: {memory}{peak}; "
          f"a job stops after max({limits.timeout_min_s:g} s, {limits.timeout_factor:g} x the audio)", flush=True)
    # The egg's "done" line (deploy/eggs/egg.py): the panel shows the server
    # as running from here.
    print(f"overtone-worker: ready -- engine v3 {hash_}, Beat This! vote "
          f"{'on' if runner.vote else 'OFF (model or runtime missing)'}; polling {base} every {poll:g} s",
          flush=True)

    unreachable = False
    while not stop.is_set():
        if not runner.alive():
            # The last job's process was stopped: warm a new one before claiming.
            started = time.perf_counter()
            try:
                runner.start()
            except isolate.WorkerBroken as exc:
                print(f"[worker] {exc}", file=sys.stderr, flush=True)
                return 4
            print(f"[worker] a new analysis process is warm in {time.perf_counter() - started:.1f} s", flush=True)
        try:
            job = api.claim(hash_, runner.hashes)
            if unreachable:
                print("[worker] the API answers again", flush=True)
                unreachable = False
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                print("[worker] the API refused the token (WORKER_TOKEN differs).", file=sys.stderr)
                return 3
            print(f"[worker] claim failed: HTTP {exc.code}", file=sys.stderr)
            stop.wait(poll)
            continue
        except (urllib.error.URLError, OSError):
            if not unreachable:
                print(f"[worker] {base} does not answer yet; retrying", file=sys.stderr, flush=True)
                unreachable = True
            stop.wait(poll)
            continue
        if not job:
            stop.wait(poll)
            continue
        started = time.perf_counter()
        print(f"[worker] job {job['id'][:8]}… attempt {job['attempt']}", flush=True)
        try:
            state = run_job(api, job, runner)
        except Exception:  # noqa: BLE001 -- one job never stops the worker
            traceback.print_exc()
            try:
                api.call("POST", f"/jobs/{job['id']}/fail",
                         {"attempt": job["attempt"], "error": "The worker hit an internal error."})
            except Exception:  # noqa: BLE001
                pass
            state = "failed"
        print(f"[worker] job {job['id'][:8]}… {state} in {time.perf_counter() - started:.1f} s", flush=True)
    runner.close()
    print("[worker] stopped", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
