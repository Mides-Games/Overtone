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
from pathlib import Path
from typing import Iterable

import numpy as np

import overtone as ta

#: Point this at a binary to use it instead of the one the search finds.
CLI_ENV = "OVERTONE_CLI"
#: A six-minute song takes about 0.2 s; an hour, tens of seconds. Past this,
#: something is wrong and v3 should take over.
TIMEOUT_S = 300

_HERE = Path(__file__).resolve().parent
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
                    _HERE / "target" / "release" / _EXE,
                    _HERE / "target" / "debug" / _EXE]


def find_cli(search: Iterable[Path] | None = None) -> Path | None:
    for path in (candidates() if search is None else search):
        if path.is_file():
            return path
    return None


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
    try:
        done = subprocess.run(args, capture_output=True, timeout=timeout,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"The Rust engine took over {timeout:.0f} s and was stopped.") from exc
    except OSError as exc:
        raise SidecarUnavailable(f"The Rust engine could not start: {exc}") from exc
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
    try:
        done = subprocess.run([str(binary), "structure", os.fspath(path)],
                              capture_output=True, timeout=timeout,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"The Rust engine took over {timeout:.0f} s and was stopped.") from exc
    except OSError as exc:
        raise SidecarUnavailable(f"The Rust engine could not start: {exc}") from exc
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
