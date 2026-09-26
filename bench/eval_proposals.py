"""H4e real-audio gate: the decision engine against the mapper, per addition.

Runs ``overtone-cli hitsound`` over index-selected local maps and scores
each proposal against the mapper's own sounds, event by event: the mapper's
label is whether the sound event carries the addition, the proposal's is
whether its additions name it, joined on (object, part, edge). Bodies ride
neither side — H4 proposes nothing for them. Medians over maps where the
mapper uses the addition enough, exactly like P-6, because this gate exists
to answer one question: better than a rule, or it does not ship. The rules
to beat are P-6's (clap F1 0.59, finish F1 0.42).

    python bench/eval_proposals.py [--db PATH] [--limit N] [--cli PATH]

Read-only like P-6, but slow: every song pays decode, attacks, tempo,
structure, evidence and decide inside the CLI. The maps are never
committed; this script and its numbers are.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from eval_hitsounds import MIN_CLAPS, MIN_FINISHES, open_index_readonly, quartiles, select_maps
import overtone as ov
from overtone_library import read_osu_header

TIMEOUT_S = 300


def default_cli() -> str:
    name = "overtone-cli.exe" if sys.platform == "win32" else "overtone-cli"
    override = __import__("os").environ.get("OVERTONE_CLI")
    if override:
        return override
    root = HERE.parent
    for candidate in (root / name, root / "target" / "release" / name):
        if candidate.is_file():
            return str(candidate)
    return name


def run_proposals(cli: str, audio: str, osu: str) -> dict:
    """The CLI's proposal document. Raises on failure, like the sidecar."""
    done = subprocess.run([cli, "hitsound", audio, osu], capture_output=True,
                          timeout=TIMEOUT_S,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        report = json.loads(done.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        report = None
    if done.returncode != 0 or report is None or "units" not in report:
        detail = (done.stderr.decode("utf-8", "replace").strip()[-300:]
                  if done.stdout is not None else "")
        raise RuntimeError(f"hitsound failed on {osu} (exit {done.returncode}): {detail}")
    return report


def score_proposals(events: list[dict], units: list[dict]) -> dict:
    """Mapper-vs-proposal tallies per addition, joined on (object, part, edge).

    A proposal the mapper's event does not cover, or an event with no
    proposal, counts apart: the join is the measurement, and silent drops
    on either side would flatter it.
    """
    by_unit = {(u["object"], u["part"], u.get("edge")): u for u in units}
    out: dict[str, dict] = {}
    for addition in ("clap", "finish", "whistle"):
        tp = fp = fn = uncovered = 0
        mapper = 0
        for event in events:
            if event["part"] == "body":
                continue
            has = addition in event["sounds"]
            mapper += has
            unit = by_unit.get((event["object"], event["part"], event.get("edge")))
            if unit is None:
                uncovered += 1
                continue
            proposed = addition in unit["proposal"]["additions"]
            if has and proposed:
                tp += 1
            elif proposed:
                fp += 1
            elif has:
                fn += 1
        precision = tp / (tp + fp) if tp + fp else None
        recall = tp / (tp + fn) if tp + fn else None
        if precision is None or recall is None or precision + recall == 0:
            f1 = None
        else:
            f1 = 2 * precision * recall / (precision + recall)
        out[addition] = {"tp": tp, "fp": fp, "fn": fn, "uncovered": uncovered,
                         "mapper": mapper, "precision": precision,
                         "recall": recall, "f1": f1}
    return out


def summarize(results: list[dict]) -> dict:
    """Corpus medians over maps where the mapper uses the addition enough."""
    summary = {"maps": len(results)}
    for addition, minimum in (("clap", MIN_CLAPS), ("finish", MIN_FINISHES)):
        f1 = [r[addition]["f1"] for r in results
              if r[addition]["mapper"] >= minimum and r[addition]["f1"] is not None]
        recall = [r[addition]["recall"] for r in results
                  if r[addition]["mapper"] >= minimum and r[addition]["recall"] is not None]
        summary[addition] = {"f1": quartiles(f1), "recall": quartiles(recall)}
    whistle = [r["whistle"]["f1"] for r in results if r["whistle"]["f1"] is not None]
    summary["whistle"] = {"f1": quartiles(whistle)}
    summary["uncovered"] = sum(r[a]["uncovered"] for r in results for a in ("clap", "finish"))
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", default=None, help="library index to read (read-only)")
    parser.add_argument("--limit", type=int, default=12, help="maps to propose, oldest first")
    parser.add_argument("--offset", type=int, default=0, help="maps to skip first")
    parser.add_argument("--cli", default=None, help="overtone-cli binary")
    parser.add_argument("--min-objects", type=int, default=200)
    args = parser.parse_args(argv)

    from overtone_library import default_path
    db = open_index_readonly(args.db or str(default_path()))
    try:
        paths = select_maps(db, args.min_objects, (args.offset + args.limit) * 8)
    finally:
        db.close()
    cli = args.cli or default_cli()

    # One map per audio file: the same song proposed twice measures nothing.
    # The offset skips songs, not map rows — a set holds many difficulties
    # of one audio, so slicing happens after the per-audio dedup.
    seen_audio: set[str] = set()
    songs: list[tuple[str, str]] = []
    for path in paths:
        try:
            audio = str(Path(path).parent / read_osu_header(path).get("audio_file", ""))
        except (ValueError, OSError):
            continue
        if Path(audio).is_file() and audio not in seen_audio:
            seen_audio.add(audio)
            songs.append((audio, path))
    pairs = songs[args.offset:args.offset + args.limit]
    if not pairs:
        print("eval: no maps selected; is the index scanned?")
        return 1

    started = time.perf_counter()
    results: list[dict] = []
    errors = 0
    for audio, osu in pairs:
        try:
            beatmap = ov.read_osu_beatmap(osu)
            events = [e for e in ov.sound_events(beatmap)]
            report = run_proposals(cli, audio, osu)
            results.append(score_proposals(events, report["units"]))
            print(f"eval: {Path(osu).name[:50]}", flush=True)
        except (ValueError, OSError, RuntimeError) as exc:
            errors += 1
            print(f"eval: skip {Path(osu).name[:50]}: {str(exc)[:100]}", flush=True)
    elapsed = time.perf_counter() - started

    summary = summarize(results)
    summary["errors"] = errors
    summary["seconds"] = round(elapsed, 1)
    print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
