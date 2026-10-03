"""H7 agreement measurement: the audio-only proposal against H4's, per sound.

Runs ``overtone-cli hitsound`` twice over local mapped songs — once with a
map (H4), once on the audio alone (H7) — and joins the two proposals by
time: an H4 unit is covered when an audio-only unit lands within 50 ms (the
P-5 window), and agrees when both propose the same bank and additions. Also
reports the reverse: audio-only units with no H4 unit nearby (the song
suggests more sounds than the map holds).

    python bench/eval_audio_only.py [--songs DIR] [--limit N] [--cli PATH] [--json OUT]

A measurement, not a gate (like corpus_b.py): there is no threshold yet,
only the numbers H7 has to beat once it proposes for a reason. Read-only:
nothing is written beside the songs. Tails ride neither side — H4's tails
follow the object under them, and audio-only units never are tails.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "python"))
sys.path.insert(0, str(HERE.parent))

import overtone as ov

#: A timeout is for a run that hangs, not a slow one: on a loaded machine
#: one song's evidence took 546 s (2026-09-26).
TIMEOUT_S = 1800
#: The P-5 window: an audio-only unit covers the H4 unit it lands nearest
#: when they are this close.
JOIN_MS = 50.0


def default_songs() -> Path:
    """The local Songs folder: the usual installs, else --songs must name it."""
    home = Path(os.environ.get("LOCALAPPDATA", str(Path.home())))
    for candidate in (Path("C:/osu!/Songs"), home / "osu!" / "Songs"):
        if candidate.is_dir():
            return candidate
    raise SystemExit("no Songs folder found: pass --songs DIR")


def default_cli() -> str:
    name = "overtone-cli.exe" if sys.platform == "win32" else "overtone-cli"
    override = os.environ.get("OVERTONE_CLI")
    if override:
        return override
    root = HERE.parent
    for candidate in (root / name, root / "target" / "release" / name):
        if candidate.is_file():
            return str(candidate)
    return name


def run(cli: str, *argv: str) -> dict:
    done = subprocess.run(
        [cli, *argv], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=TIMEOUT_S)
    if done.returncode != 0:
        detail = done.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(f"exit {done.returncode}: {detail[-1] if detail else ''}")
    return json.loads(done.stdout.decode("utf-8"))


def pairs(songs: Path, limit: int) -> list[tuple[Path, Path]]:
    """(audio, map) pairs, two difficulties per set at most, in folder order."""
    found: list[tuple[Path, Path]] = []
    for folder in sorted(p for p in songs.iterdir() if p.is_dir()):
        audio = folder / "audio.mp3"
        if not audio.is_file():
            audios = sorted(folder.glob("*.mp3"))
            if not audios:
                continue
            audio = audios[0]
        for osu in sorted(folder.glob("*.osu"))[:2]:
            found.append((audio, osu))
            if len(found) >= limit:
                return found
    return found


def sound_of(unit: dict) -> tuple[str, tuple[str, ...]]:
    proposal = unit["proposal"]
    return proposal["bank"], tuple(proposal["additions"])


def score_mapper(events: list[dict], alone: list[dict]) -> dict:
    """The proposal against the mapper's own sounds, P-6 style per addition.

    Joined by time (±50 ms): a mapper event the proposal does not reach and
    a proposal reaching no event count apart, never as hits or misses — the
    join is the measurement. Bodies ride neither side.
    """
    out: dict[str, dict] = {}
    for addition in ("clap", "finish", "whistle"):
        tp = fp = fn = uncovered = 0
        for event in events:
            if event["part"] == "body":
                continue
            has = addition in event["sounds"]
            near = [u for u in alone if abs(u["time_ms"] - event["time"]) <= JOIN_MS]
            if not near:
                uncovered += 1
                fn += 1 if has else 0
                continue
            proposed = addition in min(
                near, key=lambda u: abs(u["time_ms"] - event["time"]))["proposal"]["additions"]
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
                         "precision": precision, "recall": recall, "f1": f1}
    return out


def score(h4: list[dict], alone: list[dict]) -> dict:
    """Coverage and agreement of H4's chain units against audio-only units."""
    chain = [u for u in h4 if not u["tail"]]
    solo = sorted(alone, key=lambda u: u["time_ms"])
    covered = agreed = 0
    for unit in chain:
        near = [v for v in solo if abs(v["time_ms"] - unit["time_ms"]) <= JOIN_MS]
        if not near:
            continue
        covered += 1
        pick = min(near, key=lambda v: abs(v["time_ms"] - unit["time_ms"]))
        agreed += sound_of(pick) == sound_of(unit)
    extra = 0
    for unit in solo:
        if not any(abs(w["time_ms"] - unit["time_ms"]) <= JOIN_MS for w in chain):
            extra += 1
    return {
        "h4": len(chain),
        "alone": len(solo),
        "covered": covered,
        "agreed": agreed,
        "extra": extra,
        "coverage": covered / len(chain) if chain else None,
        "agreement": agreed / covered if covered else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--songs", default=None,
                        help="osu! Songs folder (default: the library's)")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--cli", default=None)
    parser.add_argument("--json", default=None)
    args = parser.parse_args()
    songs = Path(args.songs) if args.songs else default_songs()
    cli = args.cli or default_cli()
    rows = []
    started = time.monotonic()
    for audio, osu in pairs(songs, args.limit):
        try:
            with_map = run(cli, "hitsound", str(audio), str(osu))
            without = run(cli, "hitsound", str(audio))
            beatmap = ov.read_osu_beatmap(osu)
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            print(f"{osu.parent.name}: SKIPPED ({exc})")
            continue
        result = score(with_map["units"], without["units"])
        result["mapper"] = score_mapper(ov.sound_events(beatmap), without["units"])
        result["set"] = osu.parent.name
        result["map"] = osu.name
        rows.append(result)
        coverage = f"{result['coverage']:.2f}" if result['coverage'] is not None else "-"
        agreement = f"{result['agreement']:.2f}" if result["agreement"] is not None else "-"
        print(f"{result['set'][:44]:44} H4 {result['h4']:4} alone {result['alone']:4} "
              f"covered {coverage} agreed {agreement} extra {result['extra']}")
    if not rows:
        print("no pairs scored")
        return 1
    for key in ("coverage", "agreement"):
        values = [r[key] for r in rows if r[key] is not None]
        print(f"median {key}: {statistics.median(values):.3f} "
              f"(n={len(values)} of {len(rows)}, {time.monotonic() - started:.0f} s)")
    for addition in ("clap", "finish", "whistle"):
        values = [r["mapper"][addition]["f1"] for r in rows
                  if r["mapper"][addition]["f1"] is not None]
        if values:
            print(f"median mapper-{addition}-f1: {statistics.median(values):.3f} "
                  f"(n={len(values)} of {len(rows)})")
    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
