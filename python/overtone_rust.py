"""The v4 Rust engine as a sidecar: run ``overtone-cli``, get v3's ``Analysis``.

Roadmap Phase 22, "Rust engine in the app": opt-in, with v3 as the fallback.
The CLI's ``--full`` report carries everything v3's precision engine stores on
an :class:`overtone.Analysis` (envelope, attacks, sections, beat grid, local
BPM curve, bar, red lines before export snapping), so the object built here
is the one every exporter, editor and card already reads. Nothing downstream
needs to know which engine ran.

What the Rust engine does not do, this module does not pretend it did:

- it has no beat-tracker fallback: where v3 would fall back, the sidecar
  refuses (:class:`SidecarRefused`, with the engine's reasons), and the caller
  decides whether to run v3 instead;
- it runs at the pulse the grid proves (``subdivision`` 1). A user who asked
  for another subdivision or for the legacy engine goes to v3.

Measured against v3 on edm-174, three-sections, swing-120, secs-4 and
long-6min: beat grid and local BPM curve identical to 1e-7 ms and 1e-5 BPM,
envelope frame counts equal, red lines within 0.019 ms (the settled section
boundaries' float noise). Exported, the whole-millisecond offsets are the same
and beat lengths agree to 1e-9 ms. The golden gate pins the rest stage by
stage.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Iterable

import numpy as np

import overtone as ta

#: Point this at a binary to use it instead of the one the search finds.
CLI_ENV = "OVERTONE_CLI"
#: A six-minute song takes about 0.2 s; an hour, tens of seconds. Past this,
#: something is wrong and v3 should take over.
TIMEOUT_S = 300
#: How often a running CLI is asked about, between reads of what it wrote:
#: the longest a stop waits for the process to be ended.
POLL_S = 0.05

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
_EXE = "overtone-cli.exe" if os.name == "nt" else "overtone-cli"


class SidecarUnavailable(RuntimeError):
    """No ``overtone-cli`` binary was found; build it or set OVERTONE_CLI."""


#: v3's own refusal messages, so the app says the same thing whichever engine
#: ran. Keys are the CLI's diagnostic kinds.
REFUSALS = {
    "too_few_attacks": "Not enough beats detected. Try a file with clearer percussion.",
    "no_coherent_pulse": "No rhythmic pulse found: this audio sounds like noise or has no "
                         "beat, so there is no BPM to report.",
    "large_grid_residual": "The music does not sit on a fixed grid.",
}


class SidecarRefused(ValueError):
    """The engine found no grid; ``diagnostics`` says why."""

    def __init__(self, message: str, diagnostics: list[dict]):
        super().__init__(message)
        self.diagnostics = diagnostics


def candidates() -> list[Path]:
    """Where a binary may live: the override, next to this file (a bundled
    app), then the workspace's release and debug builds."""
    found = [Path(os.environ[CLI_ENV])] if os.environ.get(CLI_ENV) else []
    return found + [_HERE / _EXE,
                    _ROOT / "target" / "release" / _EXE,
                    _ROOT / "target" / "debug" / _EXE]


def find_cli(search: Iterable[Path] | None = None) -> Path | None:
    for path in (candidates() if search is None else search):
        if path.is_file():
            return path
    return None


def _run(args: list[str], timeout: float) -> subprocess.CompletedProcess:
    """Run the CLI to its end and return what it wrote.

    It is ended, never left behind, when it overruns ``timeout``
    (``RuntimeError``) or when the analysis on this thread is stopped:
    between reads of its output, every POLL_S, ``overtone.checkpoint``
    asks, and raises AnalysisStopped once a stop was asked for. Either way
    the process is killed and reaped before the exception leaves. Raises
    :class:`SidecarUnavailable` when it cannot start.
    """
    try:
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError as exc:
        raise SidecarUnavailable(f"The Rust engine could not start: {exc}") from exc
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                # Retrying loses nothing: communicate keeps what it has read.
                stdout, stderr = process.communicate(timeout=POLL_S)
                break
            except subprocess.TimeoutExpired as exc:
                ta.checkpoint()
                if time.monotonic() >= deadline:
                    raise RuntimeError(
                        f"The Rust engine took over {timeout:.0f} s and was stopped.") from exc
    except BaseException:
        process.kill()
        process.communicate()
        raise
    return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)


def analysis_from_report(report: dict) -> ta.Analysis:
    """Build v3's :class:`Analysis` from an ``overtone-cli --full`` report."""
    evidence = report["evidence"]
    sr = int(evidence["sample_rate"])
    hop = int(evidence["hop"])
    beats = np.asarray(evidence["beats"], dtype=float)
    sections = [ta.GridSection(float(s["start_s"]), float(s["end_s"]), float(s["period_s"]),
                               float(s["phase_s"]), int(s["inliers"]),
                               float(s["residual_ms"]), float(s["coverage"]))
                for s in report["sections"]]
    # v3's precision points carry their section's index as beat_index.
    points = [ta.TimingPoint(float(p["offset_ms"]), float(p["bpm"]), float(p["confidence"]),
                             int(p["section"]), int(p["meter"]), bool(p["meter_known"]))
              for p in evidence["points"]]
    return ta.Analysis(
        str(report["source"]), float(report["duration"]), beats,
        np.asarray(evidence["local_bpms"], dtype=float), points, hop, sr, 1.0,
        float(report["global_bpm"]), float(report["stability"]), str(report["meter"]),
        np.asarray(evidence["onset"], dtype=np.float32),
        beats * sr / hop if beats.size else np.zeros(0),
        np.asarray(evidence["attack_times"], dtype=float),
        np.asarray(evidence["attack_weights"], dtype=float),
        sections, int(evidence["meter_beats"]), int(evidence["downbeat_class"]),
        float(report["residual_ms"]), "precision")


def analyze(path: str | os.PathLike[str], *, min_delta: float = 1.5, persistence: int = 12,
            min_confidence: float = 0.75, prefer_map_bpm: bool = True,
            cli: Path | None = None, timeout: float = TIMEOUT_S) -> ta.Analysis:
    """Analyse ``path`` with the Rust engine.

    Raises :class:`SidecarUnavailable` without a binary, :class:`SidecarRefused`
    when the audio has no grid, and ``RuntimeError`` with the loader's own
    message when the file cannot be read, as v3's loader does.
    """
    binary = cli or find_cli()
    if binary is None:
        raise SidecarUnavailable("The Rust engine (overtone-cli) is not built.")
    args = [str(binary), "analyze", os.fspath(path), "--full",
            "--min-delta", repr(float(min_delta)), "--persistence", str(int(persistence)),
            "--min-confidence", repr(float(min_confidence))]
    if not prefer_map_bpm:
        args.append("--no-map-bpm")
    done = _run(args, timeout)
    try:
        report = json.loads(done.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        report = None
    if done.returncode == 3 and report is not None:
        diagnostics = report.get("diagnostics", [])
        kind = diagnostics[0].get("kind") if diagnostics else None
        raise SidecarRefused(REFUSALS.get(kind, REFUSALS["no_coherent_pulse"]), diagnostics)
    if done.returncode == 1 and report is not None and "error" in report:
        raise RuntimeError(f"Cannot load {Path(os.fspath(path)).name}: {report['error']}")
    if done.returncode != 0 or report is None:
        detail = done.stderr.decode("utf-8", "replace").strip()[-300:]
        raise RuntimeError(f"The Rust engine failed (exit {done.returncode}): {detail}")
    return analysis_from_report(report)


def attacks(path: str | os.PathLike[str], *, cli: Path | None = None,
            timeout: float = TIMEOUT_S) -> tuple[np.ndarray, np.ndarray, float]:
    """The audio's attacks (times in s, weights) and its length in seconds,
    as ``grade_reference_timing`` takes them: what the library health check
    grades a map's own red lines against.

    From ``analyze --full``, whether or not the engine found a grid: attacks
    are detected before any grid is fitted, so a song refused one (exit 3)
    still has them. Raises :class:`SidecarUnavailable` without a binary and
    ``RuntimeError`` with the loader's message when the file cannot be read.
    """
    binary = cli or find_cli()
    if binary is None:
        raise SidecarUnavailable("The Rust engine (overtone-cli) is not built.")
    done = _run([str(binary), "analyze", os.fspath(path), "--full"], timeout)
    try:
        report = json.loads(done.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        report = None
    if done.returncode == 1 and report is not None and "error" in report:
        raise RuntimeError(f"Cannot load {Path(os.fspath(path)).name}: {report['error']}")
    if done.returncode not in (0, 3) or report is None or "evidence" not in report:
        detail = done.stderr.decode("utf-8", "replace").strip()[-300:]
        raise RuntimeError(f"The Rust engine failed (exit {done.returncode}): {detail}")
    evidence = report["evidence"]
    return (np.asarray(evidence["attack_times"], dtype=float),
            np.asarray(evidence["attack_weights"], dtype=float), float(report["duration"]))


def structure(path: str | os.PathLike[str], *, cli: Path | None = None,
              timeout: float = TIMEOUT_S) -> dict:
    """``overtone-cli structure``: phrase boundaries, labels with their
    evidence, and the energy lane, as the CLI's JSON (Phase 19, Structure).

    Raises :class:`SidecarUnavailable` without a binary, and ``RuntimeError``
    with the loader's message when the file cannot be read.
    """
    binary = cli or find_cli()
    if binary is None:
        raise SidecarUnavailable("The Rust engine (overtone-cli) is not built.")
    done = _run([str(binary), "structure", os.fspath(path)], timeout)
    try:
        report = json.loads(done.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        report = None
    if done.returncode == 1 and report is not None and "error" in report:
        raise RuntimeError(f"Cannot load {Path(os.fspath(path)).name}: {report['error']}")
    if done.returncode != 0 or report is None or "sections" not in report:
        detail = done.stderr.decode("utf-8", "replace").strip()[-300:]
        raise RuntimeError(f"The Rust engine failed (exit {done.returncode}): {detail}")
    return report


def _as_several(report: dict) -> dict:
    """A one-map report in the shape a list of maps gets: the song once, its
    one map under ``maps``, and that map's decision time with it."""
    timings = dict(report.get("timings_s", {}))
    decide = timings.pop("decide", None)
    song = {k: v for k, v in report.items() if k not in ("map", "units", "timings_s")}
    return {**song, "timings_s": timings,
            "maps": [{"map": report["map"], "units": report["units"],
                      "timings_s": {"decide": decide}}]}


def hitsound(audio: str | os.PathLike[str],
             osu: str | os.PathLike[str] | Iterable[str | os.PathLike[str]], *,
             profile: str | os.PathLike[str] | None = None,
             cli: Path | None = None, timeout: float = TIMEOUT_S) -> dict:
    """``overtone-cli hitsound``: the proposed sound of every decidable point.

    The audio and the map travel together because the decision reads both.
    ``osu`` is one map, or a list of maps of this audio: then the audio is
    analysed once for all of them, and the report's ``maps`` holds one entry
    per map in the order given, its ``map`` path with its ``units``, or with
    its own ``error`` when that map cannot be read (the others are still
    decided). ``profile`` is a profile file to decide with; without one the
    CLI's baked ``balanced`` decides. Raises :class:`SidecarUnavailable`
    without a binary, and ``RuntimeError`` with the loader's message when
    the audio or the profile cannot be read, or a map given alone.
    """
    binary = cli or find_cli()
    if binary is None:
        raise SidecarUnavailable("The Rust engine (overtone-cli) is not built.")
    several = not isinstance(osu, (str, os.PathLike))
    maps = [os.fspath(path) for path in osu] if several else [os.fspath(osu)]
    if not maps:
        raise ValueError("No map to propose for.")
    args = [str(binary), "hitsound", os.fspath(audio), *maps]
    if profile is not None:
        args += ["--profile", os.fspath(profile)]
    done = _run(args, timeout)
    try:
        report = json.loads(done.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        report = None
    if done.returncode == 1 and report is not None and "error" in report:
        raise RuntimeError(report["error"])
    if several and len(maps) == 1 and done.returncode == 0 and report is not None \
            and "units" in report:
        report = _as_several(report)
    # Several maps exit 1 when one could not be read; the report says which.
    expected = ((0, 1), "maps") if several else ((0,), "units")
    if done.returncode not in expected[0] or report is None or expected[1] not in report:
        detail = done.stderr.decode("utf-8", "replace").strip()[-300:]
        raise RuntimeError(f"The Rust engine failed (exit {done.returncode}): {detail}")
    return report


def ramps(audio: str | os.PathLike[str], drift_ms: float = 5.0,
          max_lines: int | None = None, decimals: int = 0,
          *, cli: Path | None = None, timeout: float = TIMEOUT_S) -> dict:
    """``overtone-cli ramps``: the elastic curve as the fewest red lines.

    Raises :class:`SidecarUnavailable` without a binary, ``RuntimeError``
    with the loader's message when the file cannot be read, and
    :class:`SidecarRefused` when too few attacks fit anything.
    """
    binary = cli or find_cli()
    if binary is None:
        raise SidecarUnavailable("The Rust engine (overtone-cli) is not built.")
    args = [str(binary), "ramps", os.fspath(audio), "--drift", repr(float(drift_ms)),
            "--decimals", str(int(decimals))]
    if max_lines is not None:
        args += ["--max-lines", str(int(max_lines))]
    done = _run(args, timeout)
    try:
        report = json.loads(done.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        report = None
    if done.returncode == 3 and report is not None:
        raise SidecarRefused("Too few attacks to fit a curve on.", [])
    if done.returncode == 1 and report is not None and "error" in report:
        raise RuntimeError(f"Cannot load {Path(os.fspath(audio)).name}: {report['error']}")
    if done.returncode != 0 or report is None or "lines" not in report:
        detail = done.stderr.decode("utf-8", "replace").strip()[-300:]
        raise RuntimeError(f"The Rust engine failed (exit {done.returncode}): {detail}")
    return report
