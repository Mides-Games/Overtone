"""real-audio: local songs keep analysing, readings pinned."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import local_data  # noqa: E402
import overtone as ta  # noqa: E402

from gate_modes.common import BPM_EPS, REAL_SNAPSHOT, _reading  # noqa: E402


# ---------------------------------------------------------------------------
# Real audio — a handful of local songs must keep analysing, never refused
# ---------------------------------------------------------------------------

def real_audio(names: list[str], update: bool) -> int:
    """The synthetic corpus is clean drums; a change can keep it green and
    still refuse a real song, or move its reading. These tracks must analyse
    (no refusal), on the same engine path, to the readings pinned in
    ``real_audio_snapshot.local.json`` (BPMs within ``BPM_EPS``, the same red lines).
    A track this machine does not hold, or holds changed, is skipped and named:
    the audio is the user's and never committed. None held: nothing checked,
    said so, and not a failure. Neither the manifest nor the snapshot is
    committed (bench/local_data.py): without them, the same."""
    import corpus_b as cb
    held = [cb.MANIFEST] + ([] if update else [REAL_SNAPSHOT])
    if not all(path.is_file() for path in held):
        for path in held:
            if not path.is_file():
                print(local_data.missing(path))
        print("\nreal-audio: no local library here: nothing checked")
        return 0
    manifest = {t["id"]: t for t in json.loads(cb.MANIFEST.read_text(encoding="utf-8"))["tracks"]}
    baseline = {}
    if REAL_SNAPSHOT.exists():
        baseline = json.loads(REAL_SNAPSHOT.read_text(encoding="utf-8")).get("tracks", {})
    current, failures, skipped = {}, [], []
    print(f"{'track':<18} {'engine':<10} {'global BPM':>11} {'lines':>6}  verdict")
    print("-" * 66)
    for name in names:
        found = cb.locate(manifest[name], cb.SONGS)
        if not found["ok"]:
            skipped.append(f"{name}: {found['reason']}")
            print(f"{name:<18} {'-':<10} {'-':>11} {'-':>6}  skipped ({found['reason']})")
            continue
        try:
            analysis = ta.analyze_audio(str(found["folder"] / manifest[name]["audio"]))
        except (ValueError, RuntimeError) as exc:
            failures.append(f"{name}: refused ({exc})")
            print(f"{name:<18} {'refused':<10} {'-':>11} {'-':>6}  REFUSED: {exc}")
            continue
        reading = _reading(analysis)
        current[name] = reading
        want = baseline.get(name)
        problems = []
        if want is None:
            if not update:
                problems.append("no baseline entry")
        else:
            if reading["engine"] != want["engine"]:
                problems.append(f"engine {want['engine']} -> {reading['engine']}")
            if abs(reading["global_bpm"] - want["global_bpm"]) > BPM_EPS:
                problems.append(f"global BPM {want['global_bpm']} -> {reading['global_bpm']}")
            got, expected = reading["point_bpms"], want["point_bpms"]
            if len(got) != len(expected):
                problems.append(f"{len(expected)} red lines -> {len(got)}")
            elif any(abs(a - b) > BPM_EPS for a, b in zip(got, expected)):
                problems.append("a red line's BPM moved")
        if update:
            verdict = "new" if want is None else "updated: " + "; ".join(problems) if problems else "ok"
        elif problems:
            failures.append(f"{name}: " + "; ".join(problems))
            verdict = "CHANGED: " + "; ".join(problems)
        else:
            verdict = "ok"
        print(f"{name:<18} {reading['engine']:<10} {reading['global_bpm']:11.4f} "
              f"{len(reading['point_bpms']):6d}  {verdict}")

    if update:
        if not current:
            print("\nNo track held here: nothing to pin.")
            return 1
        REAL_SNAPSHOT.write_text(
            json.dumps({
                "_comment": "Real songs (bench/corpus_b.local.json tracks) that must keep analysing, "
                            "never refused. Regenerate with: python bench/gates.py real-audio --update",
                "bpm_eps": BPM_EPS,
                "tracks": current,
            }, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8")
        print(f"\nWrote {REAL_SNAPSHOT.name} ({len(current)} tracks). It stays local, never committed.")
        return 0
    if skipped:
        print(f"\n{len(skipped)} skipped, not held here as the manifest names them.")
    if failures:
        print(f"\n{len(failures)} track(s) failed:")
        for line in failures:
            print(f"  {line}")
        print("\nIf a change is intended, say why in timeline.md and re-run with --update.")
        return 1
    checked = len(current)
    print(f"\nreal-audio: {checked}/{len(names)} tracks analysed as pinned"
          + ("" if checked else " (none held here: nothing checked)"))
    return 0
