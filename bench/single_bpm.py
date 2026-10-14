"""Single-BPM bulk truth: the engine against every one-red-line map in Songs.

Corpus B (``bench/corpus_b.py``) scores 20 hand-picked maps in depth. This
scores the other end of the shelf: every map with exactly one red line in the
user's own Songs folder (17,128 of 25,171 here, 2,338 of them TV Size) — the
songs most likely to hold one tempo all the way through, and the minimum the
engine must time correctly: one BPM, right, with the grid on the sound.

    .venv/Scripts/python.exe bench/single_bpm.py --max-songs 12 --jobs 3    # pilot
    .venv/Scripts/python.exe bench/single_bpm.py --tv                       # TV Size slice
    .venv/Scripts/python.exe bench/single_bpm.py                            # the full slice
    .venv/Scripts/python.exe bench/single_bpm.py --engine rust              # overtone-cli

One analysis per song (per set/audio, grouped so difficulties sharing a song
cost one run), every difficulty scored on it. A song whose difficulties
disagree with each other (offsets spread past 10 ms or tempi past 0.05 BPM)
is reported apart: mapper truth with an argument in it is still truth, but
the agreeing subset is the number a stranger can repeat. A measurement, not
a gate: there is no bar yet, only the first reading and, beside it, the
diagnostic of how much of the gap one constant offset would close (fitted
here, so it flatters — shown apart, never as the result).

The maps' lines sit a median 21 ms before the sound (10.0a), so the offset
shares are reported raw: a perfect engine reads late against mappers by
design until the export convention is decided. The BPM column is free of
that: the convention cannot move a tempo.

Reads the Songs folder and the library index only; analyses are cached in
``bench/.cache/single_bpm/`` (git-ignored) keyed by the audio's size, mtime
and the engine code, so a re-run scores in seconds and an engine change is
never served a stale answer.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import sqlite3
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "bench"))

import overtone as ta  # noqa: E402
import overtone_library as lib  # noqa: E402
import corpus_b as cb  # noqa: E402

HERE = Path(__file__).resolve().parent
CACHE_DIR = HERE / ".cache" / "single_bpm"
SONGS = Path(r"C:\osu!\Songs")
ENGINES = ("python", "rust")

#: Bumped when the cached analysis changes shape.
CACHE_FORMAT = 1
#: The slice's own seed: which songs a sample holds must re-derive.
SAMPLE_SEED = 7
#: Difficulties agreeing this closely are one truth, not several.
AGREE_OFFSET_MS = 10.0
AGREE_BPM = 0.05
AUDIO_SUFFIXES = (".mp3", ".ogg", ".wav", ".m4a", ".flac", ".opus", ".mp4")


def engine_fingerprint(engine: str, cli: Path | None) -> str:
    """The code that produced an analysis, as in corpus_b with our own key."""
    files = [ROOT / "python" / "overtone.py"]
    if engine == "rust":
        files += [ROOT / "python" / "overtone_rust.py", cli]
    digest = hashlib.sha1(f"single_bpm cache {CACHE_FORMAT}".encode())
    for path in files:
        digest.update(cb.sha1_file(path).encode())
    return digest.hexdigest()[:16]


def _audio_of(folder: Path, osu_path: Path) -> Path | None:
    """The map's song by its AudioFilename, case-honestly: the listing, not
    the OS lookup, so a mismatch that silences Linux is found here too."""
    try:
        beatmap = ta.read_osu_beatmap(osu_path)
    except (OSError, ValueError):
        return None
    named = str(beatmap.get("general", {}).get("AudioFilename") or "").strip().strip('"')
    if not named:
        return None
    files = {entry.name.lower(): entry for entry in folder.iterdir() if entry.is_file()}
    found = files.get(named.lower())
    return found if found and found.suffix.lower() in AUDIO_SUFFIXES else None


def build_slice(songs: Path, db_path: Path | None, tv_only: bool) -> tuple[list[dict], list[str]]:
    """Every one-red-line map, grouped by song. The library index finds them
    (it already holds every .osu's red-line count); each file is re-checked
    on disk, so a stale index row cannot smuggle a second red line in. A
    missing map or song is skipped and named, never guessed at."""
    skipped: list[str] = []
    by_audio: dict[str, dict] = {}
    if db_path is not None and db_path.is_file():
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        rows = db.execute(
            "select beatmaps.path, beatmaps.audio_file, sets.folder"
            " from beatmaps join sets on beatmaps.set_id = sets.id"
            " where beatmaps.red_lines = 1").fetchall()
        db.close()
    else:
        rows = []
        for osu in sorted(songs.rglob("*.osu")):
            try:
                reds = ta.read_osu_red_lines(osu)
            except (OSError, ValueError):
                continue
            if len(reds) != 1:
                continue
            rows.append((str(osu), "", osu.parent.name))
    for path, _audio_hint, folder_name in rows:
        osu = Path(path)
        if tv_only and "tv size" not in f"{folder_name} {osu.name}".lower():
            continue
        if not osu.is_file():
            skipped.append(f"{folder_name}/{osu.name}: map no longer there")
            continue
        try:
            if len(ta.read_osu_red_lines(osu)) != 1:
                skipped.append(f"{folder_name}/{osu.name}: no longer one red line")
                continue
        except (OSError, ValueError) as exc:
            skipped.append(f"{folder_name}/{osu.name}: unreadable ({exc})")
            continue
        folder = osu.parent
        audio = _audio_of(folder, osu)
        if audio is None:
            skipped.append(f"{folder_name}/{osu.name}: song not found")
            continue
        song = by_audio.setdefault(str(audio), {"audio": str(audio), "folder": folder_name,
                                                "maps": []})
        song["maps"].append({"file": osu.name, "path": str(osu)})
    return list(by_audio.values()), skipped


def safe_id(folder: str, audio: str) -> str:
    """A cache-file stem from a folder and audio name: letters and digits,
    the rest underscores, short enough for Windows."""
    stem = f"{folder} {Path(audio).name}"
    cleaned = "".join(ch if (ch.isalnum() or ch in ("-", "_", ".")) else "_" for ch in stem)
    return cleaned[:80]


def cache_path(engine: str, song: dict, fingerprint: str) -> Path:
    audio = Path(song["audio"])
    try:
        stat = audio.stat()
        tag = f"{stat.st_size}-{stat.st_mtime_ns}"
    except OSError:
        tag = "missing"
    return CACHE_DIR / f"{engine}-{safe_id(song['folder'], song['audio'])}-{tag}-{fingerprint}.json"


def score_song(song: dict, analysis: dict) -> dict:
    """Every difficulty of one song against one analysis, plus whether the
    difficulties agree with each other closely enough to be one truth."""
    detected = [(line[0], line[1]) for line in analysis["lines"]]
    maps = []
    for entry in song["maps"]:
        try:
            reds = ta.read_osu_red_lines(entry["path"])
        except (OSError, ValueError):
            continue
        if len(reds) != 1:
            continue
        rows = cb.score_track(reds, detected)
        maps.append({"file": entry["file"], "offset_ms": reds[0][0], "bpm": reds[0][1],
                     "rows": rows})
    offsets = [m["offset_ms"] for m in maps]
    bpms = [m["bpm"] for m in maps]
    agreeing = (len(maps) >= 2 and max(offsets) - min(offsets) <= AGREE_OFFSET_MS
                and max(bpms) - min(bpms) <= AGREE_BPM)
    rows = [row for m in maps for row in m["rows"]]
    return {"audio": song["audio"], "folder": song["folder"], "maps": maps,
            "agreeing": agreeing, "tally": cb.tally(rows), "rows": rows,
            "path": analysis["path"], "message": analysis.get("message"),
            "detected": len(detected), "seconds": analysis["seconds"],
            "cached": analysis["cached"]}


def print_report(engine: str, scored: list[dict], skipped: list[str], summary: dict) -> None:
    pool = [row for s in scored for row in s["rows"]]
    print(f"\nSingle-BPM bulk truth, {engine} engine: {len(scored)} songs scored, "
          f"{len(pool)} maps, {len(skipped)} skipped")
    for name, rows in (("all maps", pool),
                       ("agreeing songs", [row for s in scored if s["agreeing"]
                                           for row in s["rows"]])):
        t = cb.tally(rows)
        err = t["error_ms"]
        spread = "-" if err is None else f"{err['median']:+.1f} [{err['q1']:+.1f}..{err['q3']:+.1f}]"
        bpm = t["bpm_error"]
        dbpm = "-" if bpm is None else f"{bpm['median']:.3f} (worst {t['worst_bpm_error']:.2f})"
        print(f"  {name:<15} {t['lines']:>6} maps  "
              f"<=5 ms {100 * t['share']['5']:5.1f} %   <=50 ms {100 * t['share']['50']:5.1f} %   "
              f"signed {spread}   BPM<=.05 {t['bpm_within']['0.05']}/{t['lines'] - t['undetected']} "
              f"dBPM {dbpm}")
    octaves = summary["all"]["octaves"]
    print(f"  octave of each reading against the map: "
          + (", ".join(f"{k} {v}" for k, v in octaves.items()) or "-"))
    diag = summary.get("diagnostic")
    if diag:
        print(f"  diagnostic only, not a result: less the median error of the maps within "
              f"50 ms ({diag['shift_ms']:+.1f} ms), {100 * diag['share_5']:.1f} % would be "
              f"within 5 ms")
    print(f"  analysis time {summary['analysis_seconds']:.0f} s "
          f"({summary['cached']} of {len(scored)} from the cache); run {summary['run_seconds']:.1f} s")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--engine", choices=ENGINES, default="python")
    parser.add_argument("--songs", default=str(SONGS), help="the osu! Songs folder (read only)")
    parser.add_argument("--db", default=str(lib.default_path()),
                        help="the library index (read only; empty to scan the folder)")
    parser.add_argument("--tv", action="store_true", help="TV Size slice only")
    parser.add_argument("--sample", type=int, default=0, metavar="N",
                        help="a seeded sample of N songs (seed 7)")
    parser.add_argument("--max-songs", type=int, default=0, metavar="N",
                        help="cap the songs scored (the first N, in order)")
    parser.add_argument("--refresh", action="store_true", help="analyse again, ignoring the cache")
    parser.add_argument("--jobs", type=int, default=1, help="analyses at once (each can take ~2 GB)")
    parser.add_argument("--cli", help="overtone-cli binary (default: OVERTONE_CLI, then the build)")
    parser.add_argument("--json", help="where to write the summary "
                                       "(default: bench/.cache/single_bpm/summary-<engine>.json)")
    args = parser.parse_args(argv)
    run_started = time.perf_counter()

    cli = None
    if args.engine == "rust":
        import overtone_rust
        cli = Path(args.cli) if args.cli else overtone_rust.find_cli()
        if cli is None or not cli.is_file():
            print("No overtone-cli: set OVERTONE_CLI, pass --cli, or build it with "
                  "cargo build --release -p overtone-cli")
            return 2
    fingerprint = engine_fingerprint(args.engine, cli)

    songs = Path(args.songs)
    db_path = Path(args.db) if args.db else None
    playlist, skipped = build_slice(songs, db_path, args.tv)
    print(f"{len(playlist)} songs with one-red-line maps"
          f"{' (TV Size)' if args.tv else ''}, {len(skipped)} skipped finding them")
    if args.sample:
        playlist = random.Random(SAMPLE_SEED).sample(playlist, min(args.sample, len(playlist)))
        print(f"seeded sample of {len(playlist)} (seed {SAMPLE_SEED})")
    if args.max_songs:
        playlist = playlist[:args.max_songs]
        print(f"capped at the first {len(playlist)} song(s)")

    analyses: dict[str, dict] = {}
    todo = []
    for n, song in enumerate(playlist):
        song["id"] = f"s{n:05d}"
        cached = None if args.refresh else cb.read_cache(cache_path(args.engine, song, fingerprint))
        if cached is not None:
            analyses[song["id"]] = {**cached, "cached": True}
        else:
            todo.append((song, song["audio"]))
    if todo:
        print(f"analysing {len(todo)} song(s) with the {args.engine} engine"
              f"{f', {args.jobs} at a time' if args.jobs > 1 else ''}:", flush=True)
    for song, result in cb.run_analyses(todo, args.engine, cli, args.jobs):
        if result["path"] != "error":
            cb.write_cache(cache_path(args.engine, song, fingerprint), result)
        analyses[song["id"]] = {**result, "cached": False}

    scored = [score_song(song, analyses[song["id"]]) for song in playlist]
    scored = [s for s in scored if s["maps"]]
    summary = {"all": cb.aggregate(scored)}
    near = summary["all"]["near_error_ms"]
    if near is not None:
        shifted = cb.tally([row for s in scored for row in s["rows"]], shift_ms=near["median"])
        summary["diagnostic"] = {"shift_ms": near["median"], "share_5": shifted["share"]["5"]}
    summary["agreeing_songs"] = sum(s["agreeing"] for s in scored)
    summary["analysis_seconds"] = sum(s["seconds"] for s in scored)
    summary["cached"] = sum(s["cached"] for s in scored)
    summary["run_seconds"] = time.perf_counter() - run_started

    print()
    print_report(args.engine, scored, skipped, summary)
    errors = [s for s in scored if s["path"] == "error"]
    for s in errors:
        print(f"ERROR {s['folder']}: {s['message']}")

    out = Path(args.json) if args.json else CACHE_DIR / f"summary-{args.engine}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "engine": args.engine, "fingerprint": fingerprint,
        "run": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "slice": {"tv_only": args.tv, "sample": args.sample, "songs": len(scored)},
        "tolerances_ms": list(cb.TOLERANCES_MS), "headline_ms": cb.HEADLINE_MS,
        "summary": summary, "skipped": skipped, "songs": scored,
    }, indent=1), encoding="utf-8")
    print(f"  summary: {out}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
