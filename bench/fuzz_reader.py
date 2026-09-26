"""Fuzz the .osu reader and everything that reads what it returns.

    .venv/Scripts/python.exe bench/fuzz_reader.py [--n 3000] [--seed 1] [--timeout 5]

Seeds are small maps covering every object kind, sections the reader only
carries, BOMs and mixed line endings. Each mutant (lines deleted, duplicated,
swapped; fields replaced by hostile tokens; truncated bytes; stray line
breaks, BOMs and non-UTF-8 bytes) must:

- read, or be refused with a ValueError that says why; nothing else;
- write back byte for byte when read (the writer's contract);
- pass through every consumer of a parsed beatmap without any exception but
  ValueError, and within ``--timeout`` seconds (a hang ends the run with the
  stuck stack, printed by faulthandler).

Exits 1 on the first kind of failure it finds, with the mutant written next
to the report so it can be replayed. Offline; writes only to a temp folder.
"""
from __future__ import annotations

import argparse
import faulthandler
import random
import sys
import tempfile
import time
import traceback
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

import overtone as ta  # noqa: E402

SEEDS = [
    """osu file format v14

[General]
AudioFilename: audio.mp3
SampleSet: Soft
Mode: 0

[Editor]
Bookmarks: 1000,2000

[Metadata]
Title:Song
Version:Hard
BeatmapID:1

[Difficulty]
SliderMultiplier:1.4
SliderTickRate:1

[Events]
0,0,"bg.jpg",0,0
2,3000,4000

[TimingPoints]
0,500,4,0,0,70,1,0
2000,-50,4,3,2,40,0,0
2500,400,3,2,1,60,1,1

[Colours]
Combo1 : 255,0,0

[HitObjects]
256,192,1000,1,8,0:0:0:0:
256,192,1500,1,2,1:2:0:0:
256,192,1995,5,4,0:0:0:0:
256,192,2500,2,0,L|356:192,1,140,4|8,0:0|3:1,0:0:0:0:
256,192,3000,2,2,B|300:100|356:192,2,70
256,192,4000,12,4,5000,0:0:0:0:
256,192,6000,1,0,0:0:0:0:hit.wav
64,192,7000,128,2,7500:0:0:0:0:
""",
    """﻿osu file format v128

[General]
AudioFilename:a.ogg
Mode: 3

[Difficulty]
CircleSize:4

[TimingPoints]
120.5,333.333333333333,4,2,0,100,1,0

[HitObjects]
64,192,120,1,0,0:0:0:0:
192,192,453.8,128,8,900:0:0:0:0:
""",
    "osu file format v7\n\n[General]\nAudioFilename: x.mp3\n\n[HitObjects]\n",
]

TOKENS = ["", "-1", "0", "1", "2", "NaN", "nan", "inf", "-inf", "1e308", "-1e308",
          "999999999999999999999", "0.5", "-0.0", "abc", "|", ":", "::", ",", ",,",
          "L|", "B|0:0|", "P|a:b", "|||", "1|2|3", "0:0|0:0", "日本",
          "65535", "2147483648", "18446744073709551616", "  ", "1,2,3,4,5,6,7,8,9,10,11"]


def mutate(text: str, rng: random.Random) -> bytes:
    lines = text.split("\n")
    for _ in range(rng.randint(1, 4)):
        op = rng.randrange(9)
        if op == 0 and lines:
            del lines[rng.randrange(len(lines))]
        elif op == 1 and lines:
            k = rng.randrange(len(lines))
            lines.insert(k, lines[k])
        elif op == 2 and len(lines) > 1:
            a, b = rng.randrange(len(lines)), rng.randrange(len(lines))
            lines[a], lines[b] = lines[b], lines[a]
        elif op in (3, 4) and lines:
            k = rng.randrange(len(lines))
            sep = rng.choice([",", ":", "|"])
            fields = lines[k].split(sep)
            fields[rng.randrange(len(fields))] = rng.choice(TOKENS)
            lines[k] = sep.join(fields)
        elif op == 5:
            lines.insert(rng.randrange(len(lines) + 1),
                         rng.choice(["[HitObjects]", "[TimingPoints]", "[General]", "[", "]",
                                     "[]", "//comment", "osu file format v14"]))
        elif op == 6 and lines:
            k = rng.randrange(len(lines))
            cut = rng.randrange(len(lines[k]) + 1)
            lines[k] = lines[k][:cut] + rng.choice(["\r", "\x0b", "\x85", " ", "\t"]) + lines[k][cut:]
        elif op == 7 and lines:
            k = rng.randrange(len(lines))
            lines[k] = lines[k] * rng.randint(2, 4)
    newline = rng.choice(["\r\n", "\n", "\r\n"])
    data = newline.join(lines).encode("utf-8")
    roll = rng.random()
    if roll < 0.08:
        data = data[:rng.randrange(len(data) + 1)]
    elif roll < 0.14:
        k = rng.randrange(len(data) + 1)
        data = data[:k] + bytes(rng.randrange(256) for _ in range(rng.randint(1, 6))) + data[k:]
    elif roll < 0.18:
        data = b"\xef\xbb\xbf" + data
    return data


def consumers(beatmap: dict, folder: Path) -> None:
    """Every function that takes a parsed beatmap; ValueError is a fair refusal."""
    times = np.linspace(0.5, 8.0, 40)
    weights = np.ones_like(times)
    calls = [
        lambda: ta.sound_events(beatmap),
        lambda: ta.hitsound_report(beatmap),
        lambda: ta.hitsound_consistency(beatmap),
        lambda: ta.hitsound_silence_check(beatmap, times, weights),
        lambda: ta.hitsound_playback(beatmap, folder),
        lambda: ta.hitsound_difficulty(beatmap),
        lambda: ta.snap_audit(beatmap, duration_s=10.0),
        lambda: ta.grade_reference_timing(beatmap, times, weights, 10.0),
        lambda: ta.alignment_report(SimpleNamespace(attack_times=times, attack_weights=weights), beatmap),
        lambda: ta.mod_report(beatmap, times, weights, 10.0),
        lambda: ta.scroll_profile(beatmap),
        lambda: ta.proposal_changes(beatmap, []),
        lambda: ta.copy_hitsounds(beatmap, beatmap),
    ]
    for call in calls:
        try:
            call()
        except ValueError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--n", type=int, default=3000)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=5.0,
                        help="seconds one mutant may take before the run is ended as hung")
    args = parser.parse_args()
    rng = random.Random(args.seed)
    counts = {"read": 0, "refused": 0}
    started = time.time()
    slowest = (0.0, None)
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        path = folder / "map.osu"
        for n in range(args.n):
            data = mutate(rng.choice(SEEDS), rng)
            path.write_bytes(data)
            faulthandler.dump_traceback_later(args.timeout, exit=True)
            t0 = time.perf_counter()
            try:
                try:
                    beatmap = ta.read_osu_beatmap(path)
                except ValueError:
                    counts["refused"] += 1
                    continue
                counts["read"] += 1
                text, bom = ta._load_osu_text(path)
                written = ta.beatmap_text(beatmap)
                if written != text:
                    raise AssertionError("the writer did not give the read text back")
                consumers(beatmap, folder)
            except Exception:  # noqa: BLE001 -- the finding itself
                keep = ROOT / "bench" / f"fuzz_failure_{args.seed}_{n}.osu.bin"
                keep.write_bytes(data)
                print(f"mutant {n} failed; saved to {keep.name}")
                traceback.print_exc()
                return 1
            finally:
                faulthandler.cancel_dump_traceback_later()
            spent = time.perf_counter() - t0
            if spent > slowest[0]:
                slowest = (spent, n)
    print(f"{args.n} mutants in {time.time() - started:.1f} s: {counts['read']} read, "
          f"{counts['refused']} refused with a reason; slowest {slowest[0] * 1000:.0f} ms "
          f"(mutant {slowest[1]}); no crash, no hang, every read written back byte for byte")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
