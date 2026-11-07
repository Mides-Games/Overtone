"""Audit timing agreement within a locked local accuracy cohort.

Compares difficulties sharing identical audio in both directions. This detects
conflicting annotations, not whether either annotation matches the sound.
Private pair-level output belongs under bench/.cache; stdout is aggregate only.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import itertools
import json
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "python"), str(ROOT / "bench")]
import accuracy_manifest as manifest_tools
import corpus_b as cb
import overtone as ta
from phase_residual import signed_nearest


def compare_grids(left: list, right: list, duration_s: float) -> dict:
    """Bidirectional grid agreement; half/double-time is not treated as equal."""
    a = np.asarray(cb.grid_beats(left, duration_s)) * 1000
    b = np.asarray(cb.grid_beats(right, duration_s)) * 1000
    if not a.size or not b.size:
        return {"status": "unscorable"}
    ab, ba = signed_nearest(a, b), signed_nearest(b, a)
    p95 = max(float(np.quantile(np.abs(ab), .95)), float(np.quantile(np.abs(ba), .95)))
    offset = float(np.median(ab))
    return {"status": "agree" if p95 <= 5 else "disagree",
            "p95_grid_error_ms": p95, "signed_offset_ms": offset,
            "p95_after_constant_offset_ms": max(
                float(np.quantile(np.abs(ab - offset), .95)),
                float(np.quantile(np.abs(ba + offset), .95)))}


def audit(manifest: dict) -> dict:
    groups, folders = defaultdict(list), defaultdict(set)
    for entry in manifest["entries"]:
        groups[entry["audio_sha1"]].append(entry)
        folders[entry["folder"]].add(entry["split"])
    pairs = []
    for audio, entries in sorted(groups.items()):
        grids = {e["osu_path"]: ta.read_osu_red_lines(e["osu_path"]) for e in entries}
        for left, right in itertools.combinations(entries, 2):
            durations = [e.get("duration_s") for e in (left, right)]
            result = (compare_grids(grids[left["osu_path"]], grids[right["osu_path"]],
                                    min(durations))
                      if all(d is not None and np.isfinite(d) and d > 0 for d in durations)
                      else {"status": "unscorable"})
            pairs.append({"audio_sha1": audio, "left": left["osu_path"],
                          "right": right["osu_path"], **result})
    crossings = sorted(folder for folder, splits in folders.items() if len(splits) > 1)
    return {"maps": len(manifest["entries"]), "audios": len(groups),
            "pairs": len(pairs), "agree": sum(p["status"] == "agree" for p in pairs),
            "disagree": sum(p["status"] == "disagree" for p in pairs),
            "unscorable": sum(p["status"] == "unscorable" for p in pairs),
            "sets_crossing_splits": len(crossings), "crossing_folders": crossings,
            "pair_results": pairs,
            "limitation": "Agreement cannot certify audio alignment or an untouched confirmation split."}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--json", type=Path, help="private pair-level output")
    args = parser.parse_args(argv)
    if manifest_tools.verify(args.manifest):
        return 1
    result = audit(json.loads(args.manifest.read_text(encoding="utf-8")))
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in result.items()
                      if k not in ("pair_results", "crossing_folders")}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
