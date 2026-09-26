"""Build Overtone's frozen tree in one line, from a checkout, and smoke-test it.

    .venv\\Scripts\\python.exe installer\\build.py [--clean]

Each step is timed, and its output goes to ``build\\logs``:

1. the Rust engine: ``cargo build --release -p overtone-cli``;
2. PyInstaller (``installer/overtone.spec``): ``dist\\Overtone``, the tree an
   installer carries;
3. the smoke test on that tree (``installer/smoke.py``);
4. sizes and timings, printed and written to ``dist``.

Nothing here reaches the network. A missing tool stops the build before it
starts, named, and so does a venv whose wheels differ from
``requirements.lock`` or ``requirements-build.lock``: the bundle carries what
the venv holds, and the lock is what was measured.

``--clean`` rebuilds PyInstaller's cache.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from importlib import metadata
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import release  # noqa: E402

LOGS = release.BUILD / "logs"


def _canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _pins(lock: Path) -> dict[str, str]:
    pins = {}
    for line in lock.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if "==" in line:
            name, version = line.split("==", 1)
            pins[_canonical(name)] = version.strip()
    return pins


def wheel_problems() -> list[str]:
    """Every pinned wheel, installed at its pinned version, in this venv."""
    installed = {_canonical(dist.metadata["Name"]): dist.version
                 for dist in metadata.distributions()}
    problems = []
    for lock in (release.ROOT / "requirements.lock", HERE / "requirements-build.lock"):
        for name, version in _pins(lock).items():
            if installed.get(name) != version:
                problems.append(f"{name} {installed.get(name, 'missing')}, "
                                f"{lock.name} pins {version}")
    return problems


class Steps:
    """Runs and times the build's steps; a failed one ends the build."""

    def __init__(self) -> None:
        self.timings: list[tuple[str, float]] = []
        LOGS.mkdir(parents=True, exist_ok=True)

    def run(self, name: str, argv: list[str] | str, cwd: Path,
            env: dict[str, str] | None = None) -> None:
        log = LOGS / (re.sub(r"\W+", "-", name.split(" (")[0].lower()).strip("-") + ".log")
        started = time.perf_counter()
        with open(log, "wb") as handle:
            done = subprocess.run(argv, cwd=cwd, env=env, stdout=handle,
                                  stderr=subprocess.STDOUT)
        self.done(name, started, ok=done.returncode == 0,
                  why=f"exit {done.returncode}, see {log}")
        if done.returncode:
            tail = log.read_text(encoding="utf-8", errors="replace").splitlines()[-25:]
            print("\n".join("    " + line for line in tail))
            raise SystemExit(1)

    def done(self, name: str, started: float, ok: bool = True, why: str = "") -> float:
        seconds = time.perf_counter() - started
        self.timings.append((name, seconds))
        print(f"  {name}: {seconds:.1f} s" + ("" if ok else f"  FAILED ({why})"), flush=True)
        return seconds


def git_head() -> str:
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=release.ROOT,
                          capture_output=True, text=True).stdout.strip() or "unknown"
    dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"],
                           cwd=release.ROOT, capture_output=True, text=True).stdout.strip()
    return head + (" (with uncommitted changes)" if dirty else "")


def tool_line() -> str:
    rustc = subprocess.run(["rustc", "--version"], capture_output=True, text=True).stdout.split()
    return " · ".join([f"Python {sys.version.split()[0]}",
                       f"PyInstaller {metadata.version('pyinstaller')} "
                       f"(hooks {metadata.version('pyinstaller-hooks-contrib')})",
                       f"rustc {rustc[1] if len(rustc) > 1 else '?'}"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--clean", action="store_true", help="rebuild PyInstaller's cache")
    args = parser.parse_args()

    version = release.version()
    missing = [f"wheels: {problem}" for problem in wheel_problems()]
    if shutil.which("cargo") is None:
        missing.append("cargo (the Rust toolchain) is not on PATH")
    if missing:
        print("Cannot build yet (docs/11-msi-distribution.md, \"Building it\"):")
        print("\n".join("  - " + line for line in missing))
        return 2

    print(f"Overtone {version}, commit {git_head()}", flush=True)
    steps = Steps()
    total = time.perf_counter()
    steps.run("Rust engine (cargo)", ["cargo", "build", "--release", "-p", "overtone-cli"],
              release.ROOT)
    steps.run("PyInstaller", [sys.executable, "-m", "PyInstaller", str(HERE / "overtone.spec"),
                              "--distpath", str(release.DIST), "--workpath",
                              str(release.BUILD / "pyinstaller"), "--noconfirm"]
              + (["--clean"] if args.clean else []), release.ROOT)

    import smoke  # imports the benchmark's renderer, and with it the engine
    started = time.perf_counter()
    tree_smoke = smoke.smoke(release.TREE)
    steps.done("smoke test, dist\\Overtone", started, ok=tree_smoke["ok"], why="see below")
    print("\n".join("    " + line for line in smoke.report_lines(tree_smoke)), flush=True)

    runs = ", ".join(
        f"{run['name']} " + (f"{run['bpm']:.4f} BPM" if run.get("bpm") is not None else
                             f"{sum(c['ok'] for c in run.get('checks', []))}/"
                             f"{len(run.get('checks', []))} checks")
        + f" in {run['seconds']:.1f} s" for run in tree_smoke["runs"])
    lines = [f"Overtone {version}, built {datetime.now():%Y-%m-%d %H:%M} from commit {git_head()}",
             f"toolchain: {tool_line()}",
             f"tree: {tree_smoke['files']} files, {tree_smoke['bytes'] / 1e6:.1f} MB",
             "steps: " + " · ".join(f"{name} {seconds:.1f} s" for name, seconds in steps.timings),
             f"total: {time.perf_counter() - total:.1f} s",
             f"dist\\Overtone: {'ok' if tree_smoke['ok'] else 'FAILED'}; {runs}",
             "build: ok" if tree_smoke["ok"] else "build: FAILED"]
    summary = release.DIST / f"Overtone-{version}-build.txt"
    summary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n" + "\n".join(lines))
    return 0 if tree_smoke["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
