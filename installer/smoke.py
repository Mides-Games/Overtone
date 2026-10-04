"""Smoke-test an unpacked Overtone without opening a window or playing a sound.

    .venv\\Scripts\\python.exe installer\\smoke.py [TREE]     (default: dist\\Overtone)

TREE is what a user runs: the build's output, or a copy of it unpacked from an
installer or an archive. Three runs, each timed:

1. ``overtone-py.exe AUDIO --json``: the Python engine, the app's default;
2. ``_internal\\overtone-cli.exe analyze AUDIO --json``: the Rust engine, run
   from where the app finds it;
3. ``Overtone.exe --self-check REPORT``: the window's own executable checks
   its page, icon, samples, library schema and window libraries, and runs
   both engines on clicks of its own, all without a window.

AUDIO is the benchmark's ``edm-174`` case, 174 BPM exactly, rendered by
``bench/benchmark.py``'s own code into ``bench/audio`` when it is missing. Both
engines must read it within the benchmark's 0.05 BPM.

Every run gets a scratch profile: USERPROFILE, LOCALAPPDATA, APPDATA, TEMP and
TMP point into a temporary folder and PATH holds only Windows' own folders, so
the frozen app can neither touch the user's config, cache or history nor lean
on a DLL that only a developer's PATH provides; what it writes there is
listed. The tree itself must come out as it went in: a program that writes
into its own folder leaves files an uninstall does not remove.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release  # noqa: E402

sys.path.insert(0, str(release.ROOT / "bench"))
from benchmark import AUDIO_DIR, BPM_TOLERANCE, CASES, build_track  # noqa: E402

CASE = "edm-174"
EXPECTED_BPM = CASES[CASE]["sections"][0][1]
TIMEOUT_S = 900


def fixture() -> Path:
    """The case's audio, rendered as the benchmark renders it when missing."""
    path = AUDIO_DIR / f"{CASE}.wav"
    if not path.is_file():
        AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        build_track(path, seed=zlib.crc32(CASE.encode()), **CASES[CASE])
    return path


def scratch_env(profile: Path) -> dict[str, str]:
    """The environment of a user who has never run Overtone."""
    local, roaming, temp = (profile / "AppData" / "Local", profile / "AppData" / "Roaming",
                            profile / "AppData" / "Local" / "Temp")
    for folder in (roaming, temp):
        folder.mkdir(parents=True, exist_ok=True)
    windows = os.environ.get("SystemRoot", r"C:\Windows")
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(("PYTHON", "OVERTONE_", "NUMBA_", "VIRTUAL_ENV"))}
    env.update(USERPROFILE=str(profile), LOCALAPPDATA=str(local), APPDATA=str(roaming),
               TEMP=str(temp), TMP=str(temp),
               PATH=os.pathsep.join([str(Path(windows) / "System32"), windows,
                                     str(Path(windows) / "System32" / "Wbem")]))
    return env


def snapshot(tree: Path) -> dict[str, tuple[int, int]]:
    return {str(path.relative_to(tree)): (path.stat().st_size, path.stat().st_mtime_ns)
            for path in tree.rglob("*") if path.is_file()}


def _run(argv: list[str], env: dict[str, str], cwd: Path) -> tuple[subprocess.CompletedProcess, float]:
    started = time.perf_counter()
    done = subprocess.run(argv, capture_output=True, env=env, cwd=cwd, timeout=TIMEOUT_S,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return done, time.perf_counter() - started


def _engine(name: str, argv: list[str], env: dict[str, str], cwd: Path) -> dict:
    done, seconds = _run(argv, env, cwd)
    result = {"name": name, "exe": Path(argv[0]).name, "exit": done.returncode,
              "seconds": round(seconds, 1), "bpm": None, "ok": False}
    try:
        result["bpm"] = float(json.loads(done.stdout.decode("utf-8"))["global_bpm"])
    except (ValueError, KeyError, TypeError):
        result["error"] = done.stderr.decode("utf-8", "replace").strip()[-800:]
        return result
    result["ok"] = done.returncode == 0 and abs(result["bpm"] - EXPECTED_BPM) <= BPM_TOLERANCE
    return result


def _self_check(tree: Path, env: dict[str, str], cwd: Path, report: Path) -> dict:
    done, seconds = _run([str(tree / release.APP_EXE), "--self-check", str(report)], env, cwd)
    result = {"name": "self-check", "exe": release.APP_EXE, "exit": done.returncode,
              "seconds": round(seconds, 1), "checks": [], "ok": False}
    try:
        verdict = json.loads(report.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        result["error"] = f"no report ({exc})"
        return result
    result["checks"] = verdict.get("checks", [])
    result["frozen"] = verdict.get("frozen")
    result["ok"] = done.returncode == 0 and bool(verdict.get("ok")) and bool(verdict.get("frozen"))
    return result


def _own_profile_write(name: str) -> bool:
    """Whether a file the run left in the scratch profile is Overtone's own state.

    The frozen engine's numba cache and the self-check's temporary audio are
    the platform's and the libraries' business and are expected there. What a
    portable build must never leave in a profile is Overtone's own folder or
    its settings file: those are the state a stick is meant to carry itself.
    """
    parts = Path(name).parts
    return (parts[:3] == ("AppData", "Local", "Overtone")
            or parts[:1] in ((".overtone.json",), (".timing_analyzer.json",)))


def smoke(tree: Path) -> dict:
    tree = tree.resolve()
    audio = fixture()
    portable = (tree / release.PORTABLE_MARKER).is_file()
    before = snapshot(tree)
    with tempfile.TemporaryDirectory(prefix="overtone-smoke-") as tmp:
        scratch = Path(tmp)
        profile = scratch / "profile"
        env = scratch_env(profile)
        work = scratch / "work"   # a working folder that is neither the tree nor the repo
        work.mkdir()
        runs = [
            _engine("python engine", [str(tree / release.CLI_EXE), str(audio), "--json"],
                    env, work),
            _engine("rust engine", [str(tree / release.CONTENTS / release.RUST_CLI),
                                    "analyze", str(audio), "--json"], env, work),
            _self_check(tree, env, work, scratch / "self-check.json"),
        ]
        written = sorted((str(path.relative_to(profile)), path.stat().st_size)
                         for path in profile.rglob("*") if path.is_file())
    after = snapshot(tree)
    changed = sorted(name for name in before.keys() | after.keys()
                     if before.get(name) != after.get(name))
    # A portable build writes into its own data folder and nowhere else: the
    # tree may change only there, and the profile must hold none of its state.
    own = [name for name, _size in written if _own_profile_write(name)]
    if portable:
        changed = [name for name in changed
                   if not name.startswith(release.PORTABLE_DATA + "/")]
    return {"tree": str(tree), "files": len(before),
            "bytes": sum(size for size, _mtime in before.values()),
            "audio": str(audio), "expected_bpm": EXPECTED_BPM, "runs": runs,
            "portable": portable, "tree_changed": changed, "profile_writes": written,
            "profile_own_writes": own,
            "ok": (all(run["ok"] for run in runs) and not changed
                   and not (portable and own))}


def report_lines(result: dict) -> list[str]:
    lines = [f"tree: {result['tree']} ({result['files']} files, "
             f"{result['bytes'] / 1e6:.1f} MB)",
             f"audio: {result['audio']} ({result['expected_bpm']:g} BPM)"]
    for run in result["runs"]:
        reading = (f"{run['bpm']:.4f} BPM" if run.get("bpm") is not None else
                   f"{sum(c['ok'] for c in run.get('checks', []))}/{len(run.get('checks', []))} checks"
                   if run["name"] == "self-check" else "no reading")
        lines.append(f"  {run['name']:<14} {run['exe']:<17} {reading:<16} "
                     f"{run['seconds']:6.1f} s  exit {run['exit']}  {'ok' if run['ok'] else 'FAILED'}")
        for check in run.get("checks", []):
            lines.append(f"      {'ok  ' if check['ok'] else 'FAIL'} {check['name']}: {check['detail']}")
        if run.get("error"):
            lines.append(f"      {run['error']}")
    lines.append("  tree unchanged" if not result["tree_changed"] else
                 f"  tree CHANGED: {', '.join(result['tree_changed'][:10])}")
    if result.get("portable"):
        lines.append("  portable: writes stayed in data\\, none in the profile" if not
                     result.get("profile_own_writes") else
                     "  portable: wrote Overtone's own state to the profile: "
                     + ", ".join(result["profile_own_writes"][:5]))
    folders: dict[str, list[int]] = {}
    for name, size in result["profile_writes"]:
        folder = str(Path(*Path(name).parts[:4]))
        folders.setdefault(folder, []).append(size)
    for folder, sizes in sorted(folders.items()):
        lines.append(f"  wrote to the scratch profile: {folder} ({len(sizes)} files, "
                     f"{sum(sizes) / 1e3:.0f} kB)")
    lines.append("smoke: ok" if result["ok"] else "smoke: FAILED")
    return lines


def main() -> int:
    tree = Path(sys.argv[1]) if len(sys.argv) > 1 else release.TREE
    if not (tree / release.APP_EXE).is_file():
        print(f"{tree} holds no {release.APP_EXE}; build it with installer\\build.py")
        return 2
    result = smoke(tree)
    print("\n".join(report_lines(result)))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
