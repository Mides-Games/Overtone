"""Section labels against mappers' kiai (roadmap T6).

The structure stage finds *where* phrases change and `classify` names them;
the Kiai card lights kiai on the chorus spans. This measures whether that is
worth doing: for a deterministic sample of Songs, the proposed chorus seconds
under the mapper's own kiai spans, against the chance of landing there without
looking. Either the labels earn the card or they do not.

Usage (reads the local Songs folder, writes nothing into it)::

    .venv/Scripts/python.exe bench/labels.py --songs "C:\\osu!\\Songs"

The sample splits in two before anything is measured: the first half tunes,
the second half confirms. The bar is set here, not after the listening: mean
chorus-under-kiai clears mean chance by **15 points** on both halves. One
adjustment at most on a miss, confirmed on the half it never saw.

Ground truth, stated plainly: a mapper's kiai, not a ranked map's. Ranked
status lives in `osu!.db`, which has no reader yet (10.0b); mapper kiai is
noisier, which cuts against the engine, not for it. The map per folder is the
first alphabetically holding kiai spans — deterministic, no cherry-picking.
"""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import overtone as ta  # noqa: E402

HERE = Path(__file__).resolve().parent
CLI = HERE.parent / "target" / "release" / "overtone-cli.exe"

#: Whose folders, whose half. Both in the output: a sample nobody can
#: re-derive is an anecdote, not a measurement.
FOLDER_SEED = 60
TUNE = 100
HELDOUT = 100

#: The bar, set before measuring: chorus time under kiai clears the chance of
#: landing there — kiai seconds over song seconds — by this many points, on
#: both halves.
BAR_POINTS = 15.0


def _audio_of(folder: Path, beatmap: dict) -> Path | None:
    named = str(beatmap.get("general", {}).get("AudioFilename") or "").strip().strip('"')
    if not named:
        return None
    files = {entry.name.lower(): entry for entry in folder.iterdir() if entry.is_file()}
    found = files.get(named.lower())
    return found if found and found.suffix.lower() in (
        ".mp3", ".ogg", ".wav", ".m4a", ".flac", ".opus", ".mp4") else None


def kiai_spans(path: Path) -> list[tuple[float, float]]:
    """Kiai spans in ms from a map's timing lines, red or green: the effects
    field's lowest bit opens the span, clearing it closes it."""
    try:
        beatmap = ta.read_osu_beatmap(path)
    except (OSError, ValueError):
        return []
    section = next((s for s in beatmap.get("sections", [])
                    if s.get("name") == "TimingPoints"), None)
    events: list[tuple[float, bool]] = []
    for raw in (section or {}).get("lines", []):
        fields = ta._timing_point_fields(str(raw).strip())
        if fields is None:
            continue
        effects = 0
        try:
            effects = int(str(raw).strip().split(",")[7])
        except (IndexError, ValueError):
            pass
        events.append((float(fields["time"]), bool(effects & 1)))
    spans: list[tuple[float, float]] = []
    opened: float | None = None
    for at, on in sorted(events):
        if on and opened is None:
            opened = at
        elif not on and opened is not None:
            if at > opened:
                spans.append((opened, at))
            opened = None
    if opened is not None:
        spans.append((opened, float("inf")))
    return spans


def _overlap(a: tuple[float, float], b: tuple[float, float]) -> float:
    return max(0.0, min(a[1], b[1]) - max(a[0], b[0]))


def structure_chorus(audio: Path) -> tuple[list[tuple[float, float]], float]:
    """Proposed chorus spans in ms, plus the audio length in ms, from the
    sidecar both the app and the Kiai card read."""
    proc = subprocess.run([str(CLI), "structure", str(audio)],
                          capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(f"structure refused {audio.name}: {proc.stderr.strip()[:200]}")
    try:
        payload = json.loads(proc.stdout)
    except ValueError:
        payload = json.loads(proc.stdout[:proc.stdout.rfind("}") + 1])
    rules = payload.get("rules", {})
    return ([(s["start_s"] * 1000.0, s["end_s"] * 1000.0)
             for s in payload.get("sections", []) if s.get("kind") == "chorus"],
            float(payload.get("duration", 0.0)) * 1000.0,
            rules.get("split_power_ratio"))


def measure(folder: Path) -> dict:
    """One folder as one row: chorus seconds, kiai seconds, and their overlap."""
    row: dict = {"folder": folder.name, "usable": False}
    maps = sorted(folder.glob("*.osu"))
    picked, spans = None, []
    for path in maps:
        spans = kiai_spans(path)
        if spans:
            picked = path
            break
    if picked is None:
        row["why"] = "no kiai in any difficulty"
        return row
    try:
        beatmap = ta.read_osu_beatmap(picked)
    except (OSError, ValueError) as exc:
        row["why"] = f"unreadable: {exc}"
        return row
    audio = _audio_of(folder, beatmap)
    if audio is None:
        row["why"] = "no audio for the picked map"
        return row
    try:
        chorus, duration, ratio = structure_chorus(audio)
    except (RuntimeError, ValueError, OSError) as exc:
        row["why"] = str(exc)
        return row
    row["split_power_ratio"] = ratio
    if duration <= 0:
        row["why"] = "zero-length audio"
        return row
    finite = [(s, e if e != float("inf") else duration) for s, e in spans]
    under = sum(_overlap((s * 1.0, e * 1.0), (c, d))
                for s, e in finite for c, d in chorus)
    chorus_s = sum(d - c for c, d in chorus)
    kiai_s = sum(e - s for s, e in finite)
    row.update({"usable": True, "file": picked.name,
                "chorus_s": round(chorus_s / 1000.0, 1),
                "kiai_s": round(kiai_s / 1000.0, 1),
                "under_s": round(under / 1000.0, 1),
                "duration_s": round(duration / 1000.0, 1),
                "precision": round(under / max(chorus_s, 1e-9), 4) if chorus_s > 0 else None,
                "chance": round(kiai_s / duration, 4)})
    return row


def summarize(rows: list[dict]) -> dict:
    scored = [r for r in rows if r.get("usable") and (r["chorus_s"] or 0) > 0]
    if not scored:
        return {"n": 0}
    precision = sum(r["precision"] for r in scored) / len(scored)
    chance = sum(r["chance"] for r in scored) / len(scored)
    lit = sum(1 for r in rows if r.get("usable"))
    return {"n": len(scored), "folders": len(rows), "lit": lit,
            "precision": round(precision * 100, 1),
            "chance": round(chance * 100, 1),
            "lift": round((precision - chance) * 100, 1)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--songs", required=True)
    parser.add_argument("--tune", type=int, default=TUNE)
    parser.add_argument("--heldout", type=int, default=HELDOUT)
    args = parser.parse_args()
    if not CLI.is_file():
        print("No overtone-cli built: cargo build --release -p overtone-cli")
        return 2

    songs = Path(args.songs)
    names = sorted(path.name for path in songs.iterdir()
                   if path.is_dir() and any(path.glob("*.osu")))
    rng = random.Random(FOLDER_SEED)
    picked = rng.sample(names, min(args.tune + args.heldout, len(names)))
    halves = {"tune": picked[:args.tune], "heldout": picked[args.tune:]}
    print(f"{len(names)} folders, seed {FOLDER_SEED}: "
          f"{len(halves['tune'])} tune, {len(halves['heldout'])} held out; "
          f"bar: +{BAR_POINTS:g} points both halves")
    started = time.perf_counter()
    out = {"folder_seed": FOLDER_SEED, "bar_points": BAR_POINTS,
           "split_power_ratio": None, "halves": {}}
    for half, folders in halves.items():
        rows = []
        for n, name in enumerate(folders):
            row = measure(songs / name)
            rows.append(row)
            if not row.get("usable"):
                flag = row.get("why", "?")
            elif not row.get("chorus_s"):
                flag = "no chorus proposed"
            else:
                flag = f"{row['precision'] * 100:.0f}% under"
            print(f"  [{half} {n + 1}/{len(folders)}] {name[:60]:60s} {flag} "
                  f"({time.perf_counter() - started:.0f} s)")
        summary = summarize(rows)
        summary["pass"] = summary.get("lift", -1) >= BAR_POINTS
        print(f"  {half}: {summary.get('n', 0)} scored, "
              f"precision {summary.get('precision')}%, "
              f"chance {summary.get('chance')}%, "
              f"lift {summary.get('lift')} "
              f"({'PASS' if summary.get('pass') else 'MISS'})")
        out["halves"][half] = {"rows": rows, "summary": summary}
        ratios = {row["split_power_ratio"] for row in rows
                  if row.get("split_power_ratio") is not None}
        if len(ratios) == 1:
            out["split_power_ratio"] = next(iter(ratios))
    (HERE / "labels.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"({time.perf_counter() - started:.0f} s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
