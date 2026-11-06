"""bpm-snapshot (audit F-07): the absolute BPM of every fixture, pinned."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from gate_modes.common import BPM_EPS, SNAPSHOT, _analyse, _reading


def bpm_snapshot(names: list[str], audio_dir: Path, engine: str, update: bool) -> int:
    baseline = {}
    if SNAPSHOT.exists():
        baseline = json.loads(SNAPSHOT.read_text(encoding="utf-8")).get("cases", {})
    if not baseline and not update:
        print(f"No baseline at {SNAPSHOT.name}. Create it with --update, then commit it.")
        return 1

    current, failures = {}, []
    print(f"{'case':<18} {'global BPM':>11} {'sections':>9}  verdict")
    print("-" * 62)
    for name in names:
        reading = _reading(_analyse(name, audio_dir, engine))
        current[name] = reading
        want = baseline.get(name)
        if want is None:
            verdict = "new" if update else "NO BASELINE"
            if not update:
                failures.append(f"{name}: no baseline entry")
        else:
            problems = []
            if abs(reading["global_bpm"] - want["global_bpm"]) > BPM_EPS:
                ratio = reading["global_bpm"] / max(want["global_bpm"], 1e-9)
                octave = ""
                if abs(ratio - 2.0) < 0.02 or abs(ratio - 0.5) < 0.01:
                    octave = "  <-- OCTAVE FLIP"
                problems.append(
                    f"global BPM {want['global_bpm']} -> {reading['global_bpm']}{octave}")
            if reading["point_bpms"] != want["point_bpms"]:
                if len(reading["point_bpms"]) != len(want["point_bpms"]):
                    problems.append(
                        f"{len(want['point_bpms'])} red lines -> {len(reading['point_bpms'])}")
                else:
                    for got, expected in zip(reading["point_bpms"], want["point_bpms"]):
                        if abs(got - expected) > BPM_EPS:
                            problems.append(f"red line {expected} -> {got}")
            if reading["engine"] != want["engine"]:
                problems.append(f"engine {want['engine']} -> {reading['engine']}")
            if problems:
                failures.append(f"{name}: " + "; ".join(problems))
                verdict = "CHANGED: " + "; ".join(problems)
            else:
                verdict = "ok"
        print(f"{name:<18} {reading['global_bpm']:11.4f} "
              f"{len(reading['section_bpms']):9d}  {verdict}")

    if update:
        SNAPSHOT.write_text(
            json.dumps({
                "_comment": "Absolute reported BPMs, no octave normalization. "
                            "Regenerate with: python bench/gates.py bpm-snapshot --update",
                "engine": engine,
                "bpm_eps": BPM_EPS,
                "cases": current,
            }, indent=2) + "\n",
            encoding="utf-8")
        print(f"\nWrote {SNAPSHOT.name} ({len(current)} cases). Commit it.")
        return 0

    if failures:
        print(f"\n{len(failures)} case(s) changed their reading:")
        for line in failures:
            print(f"  {line}")
        print("\nIf a change is intended, say why in docs/timeline.md and re-run with --update.")
        return 1
    print(f"\n{len(names)}/{len(names)} readings unchanged.")
    return 0
