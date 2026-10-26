"""Measurement runs on the server: the bench's timing stages over the Songs folder it holds.

The engine is measured against mappers' red lines by ``bench/stages.py``
(the folder in stages, each song in a dev or a held-out part) and
``bench/single_bpm.py`` (every one-red-line map). On a PC those take hours
and gigabytes; a server that holds the Songs folder runs them instead, one
at a time, and keeps each run: what was asked, which code answered (its git
commit and engine fingerprint), the log, and the tool's own JSON report.

A run is a separate process (``python overtone_runs.py worker ...``) that
calls the tool's ``main`` after two adjustments the tools do not offer:

- the Beat This! vote can be turned off (``beat_vote`` False): about 100 MB
  and 2 s a song on the Rust path instead of 1.5 GB and 50 s;
- the caches live under the run store, one tree per vote setting, because
  the tools' cache keys name the engine's code but not the vote, and a
  reading with the vote must never be served for one without it.

Parallel analyses fork from that adjusted process, so they inherit both.
Nothing in the engine or the bench is changed: what runs here is what the
gates and the user's own runs measure.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
ROOT = _HERE.parent
BENCH = ROOT / "bench"
#: The tools a run may start, and the options each takes.
TOOLS = ("stages", "single_bpm", "gates", "suite")
#: The Python gates of CLAUDE.md, in its order, as a server runs them. The
#: Rust ones need cargo, which the service does not have, and so do the
#: release build's two (sbom.py checks the Windows build venv against its
#: lock, notices.py reads the crates through cargo): those run where the
#: installer is built. ``perf`` measures the stage budgets on whatever
#: machine runs it: on a server, its own.
GATES = {
    "benchmark": ["bench/benchmark.py"],
    "bpm-snapshot": ["bench/gates.py", "bpm-snapshot"],
    "golden": ["bench/golden.py", "check"],
    "coverage": ["bench/gates.py", "coverage"],
    "measures": ["bench/gates.py", "measures"],
    "signatures": ["bench/gates.py", "signatures"],
    "robustness": ["bench/gates.py", "robustness"],
    "reference": ["bench/gates.py", "reference"],
    "assisted": ["bench/gates.py", "assisted"],
    "combine": ["bench/gates.py", "combine"],
    "real-audio": ["bench/gates.py", "real-audio"],
    "perf": ["bench/gates.py", "perf"],
    "fixtures": ["bench/fixtures.py"],
    "parity": ["bench/parity.py"],
    "fit-kits": ["bench/fit_kits.py", "--verify"],
    "facts": ["bench/facts.py"],
    "fuzz-reader": ["bench/fuzz_reader.py"],
}
#: The Python suite, whole or one module of it, each test named in the log:
#: a run cut short (the memory cap, 2026-10-26) shows which test it was in.
SUITES = {"all": ["-m", "unittest", "discover", "-v", "-s", "tests"],
          "engine": ["-m", "unittest", "-v", "tests.test_overtone"],
          "web": ["-m", "unittest", "-v", "tests.test_overtone_web"]}
#: "app" runs what the app runs: Rust, and v3 where Rust refuses or fails.
ENGINES = ("rust", "app", "python")
#: The most analyses one run holds at once.
MAX_JOBS = 8
#: The log lines a run's summary carries.
LOG_TAIL = 60
_RUN_ID = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{6}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def stage_ids() -> list[dict]:
    """The stages bench/stages.json lists, in their order."""
    manifest = json.loads((BENCH / "stages.json").read_text(encoding="utf-8"))
    return [{"id": s["id"], "title": s["title"], "order": s["order"]}
            for s in sorted(manifest["stages"], key=lambda s: s["order"])]


def git_commit(root: Path = ROOT) -> str | None:
    """The checked-out commit, read from .git without running git (the
    service may not own the checkout, and git refuses such repositories)."""
    git = root / ".git"
    try:
        if git.is_file():   # a worktree: "gitdir: <path>"
            git = Path(git.read_text(encoding="utf-8").split(":", 1)[1].strip())
        head = (git / "HEAD").read_text(encoding="utf-8").strip()
        if not head.startswith("ref: "):
            return head
        ref = head[5:]
        common = git
        if (git / "commondir").is_file():
            common = (git / (git / "commondir").read_text(encoding="utf-8").strip()).resolve()
        for base in (git, common):
            if (base / ref).is_file():
                return (base / ref).read_text(encoding="utf-8").strip()
        packed = common / "packed-refs"
        if packed.is_file():
            for line in packed.read_text(encoding="utf-8").splitlines():
                if line.endswith(" " + ref):
                    return line.split(" ", 1)[0]
    except (OSError, IndexError):
        return None
    return None


def build_args(request: dict, db_path: str | os.PathLike[str],
               songs: str | os.PathLike[str] = "",
               osu_db: str | os.PathLike[str] = "") -> tuple[str, list[str], dict]:
    """A run request as the tool's own command line, or ValueError.

    stages: ``{"tool": "stages", "stage": "anime-single", "engine": "rust",
    "split": "dev" | "holdout" | "", "jobs": 2, "max_songs": 0,
    "beat_vote": false, "baseline": "save" | "compare" | "", "ranked": bool}``;
    ``ranked`` (default: whether the server has an osu!.db) scores only the
    maps it lists as ranked, approved or loved.
    single_bpm: ``{"tool": "single_bpm", "engine", "jobs", "beat_vote",
    "max_songs", "sample": n, "tv": bool}``. Anything else is refused, so a
    request never names a file, a path or a flag of its own.
    """
    if not isinstance(request, dict):
        raise ValueError("A run is a JSON object.")
    tool = request.get("tool", "stages")
    if tool not in TOOLS:
        raise ValueError(f"No tool {tool!r}; one of {', '.join(TOOLS)}.")
    if tool == "gates":
        only = request.get("only") or []
        if (not isinstance(only, list) or not all(isinstance(g, str) for g in only)
                or any(g not in GATES for g in only)):
            raise ValueError(f"only is a list of gates: {', '.join(GATES)}.")
        names = [g for g in GATES if g in only] or list(GATES)
        return tool, names, {"tool": tool, "gates": "all" if not only else names}
    if tool == "suite":
        which = request.get("suite") or "all"
        if which not in SUITES:
            raise ValueError(f"suite is one of {', '.join(SUITES)}.")
        return tool, [which], {"tool": tool, "suite": which}
    engine = request.get("engine", "rust")
    if engine not in ENGINES:
        raise ValueError(f"No engine {engine!r}; one of {', '.join(ENGINES)}.")
    jobs = _count(request, "jobs", 1)
    if not 1 <= jobs <= MAX_JOBS:
        raise ValueError(f"jobs must be between 1 and {MAX_JOBS}.")
    beat_vote = _flag(request, "beat_vote")
    argv = ["--engine", engine, "--jobs", str(jobs), "--db", os.fspath(db_path)]
    settings = {"tool": tool, "engine": engine, "jobs": jobs, "beat_vote": beat_vote}
    if tool == "stages":
        stage = request.get("stage")
        if stage not in {s["id"] for s in stage_ids()}:
            raise ValueError(f"No stage {stage!r}.")
        argv = [stage] + argv
        settings["stage"] = stage
        split = request.get("split") or ""
        if split not in ("", "dev", "holdout"):
            raise ValueError("split is dev, holdout or empty (both).")
        if split:
            argv += ["--split", split]
            settings["split"] = split
        baseline = request.get("baseline") or ""
        if baseline not in ("", "save", "compare"):
            raise ValueError("baseline is save, compare or empty.")
        if baseline:
            argv.append("--save-baseline" if baseline == "save" else "--compare")
            settings["baseline"] = baseline
        ranked = request.get("ranked")
        if ranked is None:
            ranked = bool(osu_db) and Path(osu_db).is_file()
        elif not isinstance(ranked, bool):
            raise ValueError("ranked must be true or false.")
        if ranked:
            if not (osu_db and Path(osu_db).is_file()):
                raise ValueError("This server has no osu!.db to tell ranked maps apart; "
                                 "upload it beside the Songs folder.")
            argv += ["--ranked-db", os.fspath(osu_db)]
        settings["ranked"] = ranked
    else:
        if songs:
            argv += ["--songs", os.fspath(songs)]
        sample = _count(request, "sample", 0)
        if sample:
            argv += ["--sample", str(sample)]
            settings["sample"] = sample
        if _flag(request, "tv"):
            argv.append("--tv")
            settings["tv"] = True
    max_songs = _count(request, "max_songs", 0)
    if max_songs:
        argv += ["--max-songs", str(max_songs)]
        settings["max_songs"] = max_songs
    return tool, argv, settings


def _count(request: dict, key: str, default: int) -> int:
    value = request.get(key, default)
    if value in (None, ""):
        return default
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError(f"{key} must be a whole number.")
    try:
        number = int(value)
    except ValueError:
        raise ValueError(f"{key} must be a whole number.") from None
    if number < 0:
        raise ValueError(f"{key} must not be negative.")
    return number


def _flag(request: dict, key: str) -> bool:
    value = request.get(key, False)
    if not isinstance(value, bool):
        raise ValueError(f"{key} must be true or false.")
    return value


class RunStore:
    """Runs on disk, one folder each: meta.json, log.txt and, once the tool
    wrote it, result.json. Plain files, so a run outlives the server."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.cache = self.root / "cache"

    def folder(self, run_id: str) -> Path:
        if not _RUN_ID.match(str(run_id or "")):
            raise LookupError(f"No run {run_id!r}.")
        folder = self.root / run_id
        if not (folder / "meta.json").is_file():
            raise LookupError(f"No run {run_id!r}.")
        return folder

    def create(self, settings: dict, argv: list[str]) -> dict:
        run_id = time.strftime("%Y%m%d-%H%M%S", time.gmtime()) + "-" + secrets.token_hex(3)
        folder = self.root / run_id
        folder.mkdir()
        meta = {"id": run_id, "state": "queued", "created_at": _now(), "settings": settings,
                "argv": argv, "commit": git_commit(), "started_at": None,
                "finished_at": None, "exit_code": None, "seconds": None, "summary": None}
        self.write(meta)
        return meta

    def write(self, meta: dict) -> None:
        target = self.root / meta["id"] / "meta.json"
        partial = target.with_suffix(".part")
        partial.write_text(json.dumps(meta, indent=1), encoding="utf-8")
        os.replace(partial, target)

    def meta(self, run_id: str) -> dict:
        return json.loads((self.folder(run_id) / "meta.json").read_text(encoding="utf-8"))

    def runs(self) -> list[dict]:
        found = []
        for folder in sorted(self.root.iterdir(), reverse=True):
            if _RUN_ID.match(folder.name) and (folder / "meta.json").is_file():
                try:
                    found.append(json.loads((folder / "meta.json").read_text(encoding="utf-8")))
                except (OSError, ValueError):
                    continue
        return found

    def log_tail(self, run_id: str, lines: int = LOG_TAIL) -> list[str]:
        path = self.folder(run_id) / "log.txt"
        if not path.is_file():
            return []
        with open(path, encoding="utf-8", errors="replace") as handle:
            return [line.rstrip("\n") for line in deque(handle, maxlen=lines)]

    def log(self, run_id: str) -> str:
        """The run's whole log, as its tools wrote it."""
        path = self.folder(run_id) / "log.txt"
        return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""

    def result(self, run_id: str) -> dict:
        path = self.folder(run_id) / "result.json"
        if not path.is_file():
            raise LookupError(f"Run {run_id} has no report (yet).")
        return json.loads(path.read_text(encoding="utf-8"))


class RunQueue:
    """Runs one at a time, in the order asked, each in its own process."""

    def __init__(self, store: RunStore, db_path: str | os.PathLike[str],
                 songs: str | os.PathLike[str] = "", python: str = sys.executable,
                 env: dict | None = None, osu_db: str | os.PathLike[str] = "") -> None:
        self.store = store
        self.db_path = os.fspath(db_path)
        self.songs = os.fspath(songs)
        self.osu_db = os.fspath(osu_db)
        self.python = python
        self.env = env
        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        self._queue: deque[str] = deque()
        self._process: subprocess.Popen | None = None
        self._running: str | None = None
        self._stopping: set[str] = set()
        # A run the server was killed under can never finish now.
        for meta in store.runs():
            if meta["state"] in ("queued", "running"):
                meta.update(state="interrupted", finished_at=_now())
                store.write(meta)
        threading.Thread(target=self._loop, name="overtone-runs", daemon=True).start()

    def submit(self, request: dict) -> dict:
        tool, argv, settings = build_args(request, self.db_path, self.songs, self.osu_db)
        meta = self.store.create(settings, [tool, *argv])
        with self._wake:
            self._queue.append(meta["id"])
            self._wake.notify()
        return meta

    def stop(self, run_id: str) -> bool:
        """Cancel a queued run or end the running one; False when it is done."""
        self.store.folder(run_id)
        with self._lock:
            if run_id in self._queue:
                self._queue.remove(run_id)
                meta = self.store.meta(run_id)
                meta.update(state="cancelled", finished_at=_now())
                self.store.write(meta)
                return True
            if run_id != self._running or self._process is None:
                return False
            self._stopping.add(run_id)
            process = self._process
        _terminate(process)
        return True

    def state(self) -> dict:
        with self._lock:
            return {"running": self._running, "queued": list(self._queue)}

    def _loop(self) -> None:
        while True:
            with self._wake:
                self._wake.wait_for(lambda: self._queue)
                run_id = self._queue.popleft()
                self._running = run_id
            try:
                self._run(run_id)
            except Exception as exc:  # noqa: BLE001 -- recorded on the run, the queue goes on
                meta = self.store.meta(run_id)
                meta.update(state="failed", finished_at=_now(), error=f"{type(exc).__name__}: {exc}")
                self.store.write(meta)
            finally:
                with self._lock:
                    self._running = None
                    self._process = None
                    self._stopping.discard(run_id)

    def _run(self, run_id: str) -> None:
        meta = self.store.meta(run_id)
        folder = self.store.folder(run_id)
        settings = meta["settings"]
        cache = self.store.cache / ("vote" if settings.get("beat_vote", False) else "novote")
        command = [self.python, str(_HERE / "overtone_runs.py"), "worker",
                   "--cache", str(cache), "--result", str(folder / "result.json"),
                   *(["--beat-vote"] if settings.get("beat_vote", False) else []), "--", *meta["argv"]]
        env = dict(os.environ if self.env is None else self.env)
        if self.songs:
            env["OVERTONE_SONGS"] = self.songs     # the bench's Songs folder is the server's
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        meta.update(state="running", started_at=_now())
        self.store.write(meta)
        started = time.monotonic()
        with open(folder / "log.txt", "w", encoding="utf-8") as log:
            process = subprocess.Popen(command, cwd=str(ROOT), stdout=log,
                                       stderr=subprocess.STDOUT, env=env,
                                       start_new_session=(os.name != "nt"))
            with self._lock:
                self._process = process
            code = process.wait()
        with self._lock:
            stopped = run_id in self._stopping
        meta = self.store.meta(run_id)
        meta.update(state="stopped" if stopped else "done" if code == 0 else "failed",
                    exit_code=code, finished_at=_now(),
                    seconds=round(time.monotonic() - started, 1))
        try:
            meta["summary"] = self.store.result(run_id).get("summary")
        except (LookupError, ValueError, OSError):
            pass
        self.store.write(meta)


def _terminate(process: subprocess.Popen) -> None:
    """End a run and the analyses it forked."""
    try:
        if os.name != "nt":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
        process.wait(10)
    except (ProcessLookupError, subprocess.TimeoutExpired, OSError):
        try:
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except (ProcessLookupError, OSError):
            pass


# ---------------------------------------------------------------------------
# The run itself, in its own process
# ---------------------------------------------------------------------------

def worker(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="overtone_runs.py worker")
    parser.add_argument("--cache", required=True, help="cache root for this vote setting")
    parser.add_argument("--result", required=True, help="where the tool's JSON report goes")
    parser.add_argument("--beat-vote", action="store_true")
    parser.add_argument("tool", choices=TOOLS)
    parser.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    tool_args = args.args[1:] if args.args[:1] == ["--"] else args.args
    if args.tool in ("gates", "suite"):
        return _checks(args.tool, tool_args, Path(args.result))
    sys.path.insert(0, str(_HERE))
    sys.path.insert(0, str(BENCH))
    import multiprocessing
    if os.name != "nt":
        # Analyses in parallel fork from here, so they keep what is set below.
        multiprocessing.set_start_method("fork", force=True)
    elif not args.beat_vote and "--jobs" in tool_args:
        # Windows cannot fork: a parallel analysis would start afresh, with
        # the vote on. One at a time keeps the vote off as asked.
        at = tool_args.index("--jobs") + 1
        if at < len(tool_args) and tool_args[at] != "1":
            print("overtone run: one analysis at a time (Windows cannot fork; the vote stays off)")
            tool_args[at] = "1"
    import overtone as ta
    if not args.beat_vote:
        ta._BEAT_THIS_SESSION[:] = [None]
    import corpus_b
    import single_bpm
    cache = Path(args.cache)
    corpus_b.CACHE_DIR = cache / "corpus_b"
    single_bpm.CACHE_DIR = cache / "single_bpm"
    print(f"overtone run: {args.tool} {' '.join(tool_args)}  "
          f"(Beat This! vote {'on' if args.beat_vote else 'off'})", flush=True)
    if args.tool == "stages":
        import stages
        stages.OUT_DIR = cache / "stages"
        code = stages.main(tool_args)
        stage = tool_args[0] if tool_args else ""
        engine = tool_args[tool_args.index("--engine") + 1] if "--engine" in tool_args else "python"
        ranked = "-ranked" if "--ranked-db" in tool_args else ""
        report = stages.OUT_DIR / f"{stage}-{engine}{ranked}.json"
    else:
        report = Path(args.result).with_name("single_bpm.json")
        code = single_bpm.main([*tool_args, "--json", str(report)])
    if code == 0 and report.is_file():
        Path(args.result).write_bytes(report.read_bytes())
    return int(code or 0)


def _checks(tool: str, names: list[str], result: Path) -> int:
    """The gates or the suite, each its own process, as a person runs them
    from the repository root: nothing is adjusted, the Beat This! vote is as
    installed. Every line goes to the log; the report says what passed."""
    commands = ([(name, [sys.executable, *GATES[name]]) for name in names] if tool == "gates"
                else [(names[0], [sys.executable, *SUITES[names[0]]])])
    rows = []
    for name, command in commands:
        print(f"=== {name}: {' '.join(command[1:])}", flush=True)
        started = time.monotonic()
        process = subprocess.Popen(command, cwd=str(ROOT), stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                   errors="replace")
        tail: deque[str] = deque(maxlen=12)
        failing: list[str] = []
        ran = None
        for line in process.stdout:
            print(line, end="", flush=True)
            tail.append(line.rstrip())
            if line.startswith(("FAIL:", "ERROR:")):
                failing.append(line.split(":", 1)[1].strip())
            elif line.startswith("Ran ") and " test" in line:
                ran = int(line.split()[1])
        code = process.wait()
        rows.append({"name": name, "exit": code, "seconds": round(time.monotonic() - started, 1),
                     "tail": list(tail), **({"ran": ran, "failing": failing} if tool == "suite" else {})})
        print(f"--- {name}: {'pass' if code == 0 else f'FAIL (exit {code})'}", flush=True)
    failed = [r["name"] for r in rows if r["exit"] != 0]
    summary = {"checked": len(rows), "passed": len(rows) - len(failed), "failed": failed}
    if tool == "suite":
        summary.update(ran=rows[0]["ran"], failing=rows[0]["failing"][:50])
    result.write_text(json.dumps({"tool": tool, "summary": summary, "rows": rows}, indent=1),
                      encoding="utf-8")
    return 0 if not failed else 1


if __name__ == "__main__":
    if sys.argv[1:2] == ["worker"]:
        sys.exit(worker(sys.argv[2:]))
    sys.exit("usage: overtone_runs.py worker ...")
