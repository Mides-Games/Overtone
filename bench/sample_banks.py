"""H6 sample bank on real folders: what skins and beatmap folders hold, and
how long reading one takes.

    python bench/sample_banks.py OSU_FOLDER [--sample 200] [--offset 0]

OSU_FOLDER is an osu! install: every folder in its Skins, and a sample of the
folders in its Songs, are read through ``sample_bank``, as the Samples card
reads them. Read only: nothing is written, renamed or created under it.

The sample rule, set before the first run: the Songs folder's subfolders
sorted by name (Python's str order, which for osu!'s "<set id> <artist> -
<title>" is close to set-id order), every k-th one from the first, where
k = count // sample. It is deterministic, and it spans the whole folder
rather than its oldest or newest corner. ``--offset n`` starts from the n-th
instead: another sample of the same size, sharing no folder with the first
while n < k. Beatmap folders are read without a skin, so a missing sample
counts as Overtone's; which skin a player would hear is theirs to choose.

Each folder is read twice in a row: "first" is the first read in this run
(the system may still hold the folder's files from an earlier walk: a sample
no program has read lately is the cold case), "again" is the second, from
what the first one left in memory.
"""

from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import overtone as ov  # noqa: E402


def pick(folders: list[Path], sample: int, offset: int = 0) -> list[Path]:
    """Every k-th folder by name from the ``offset``-th: the rule in the docstring."""
    ordered = sorted(folders, key=lambda p: p.name)
    step = max(1, len(ordered) // sample)
    return ordered[offset::step][:sample]


def read(folder: Path) -> tuple[dict, float, float]:
    start = time.perf_counter()
    bank = ov.sample_bank(folder)
    first = time.perf_counter() - start
    start = time.perf_counter()
    ov.sample_bank(folder)
    return bank, first, time.perf_counter() - start


def spread(values: list[float]) -> str:
    if not values:
        return "none"
    ordered = sorted(values)
    q = statistics.quantiles(ordered, n=4) if len(ordered) > 1 else [ordered[0]] * 3
    return (f"min {ordered[0]:g} · p25 {q[0]:g} · median {q[1]:g} · p75 {q[2]:g} · "
            f"max {ordered[-1]:g}")


def ms(values: list[float]) -> str:
    ordered = sorted(v * 1000.0 for v in values)
    p90 = ordered[min(len(ordered) - 1, int(round(0.9 * (len(ordered) - 1))))]
    return (f"median {statistics.median(ordered):.2f} ms · p90 {p90:.2f} ms · "
            f"max {ordered[-1]:.2f} ms")


def report(title: str, folders: list[Path]) -> None:
    rows = [read(folder) for folder in folders]
    banks = [bank for bank, _first, _again in rows]
    counts = [bank["counts"] for bank in banks]
    print(f"\n{title}: {len(banks)} folders")
    print(f"  kind              " + " · ".join(
        f"{kind} {sum(b['kind'] == kind for b in banks)}" for kind in ("skin", "beatmap")))
    hits = [c["hits"] for c in counts]
    print(f"  hits of 12        {spread(hits)}")
    print(f"                    all 12: {hits.count(12)} · none: {hits.count(0)}")
    slides = [c["slides"] for c in counts]
    print(f"  slides of 6       {spread(slides)} · all 6: {slides.count(6)} · none: {slides.count(0)}")
    custom = [c["custom"] for c in counts]
    with_custom = [n for n in custom if n]
    print(f"  custom indices    in {len(with_custom)} folders; per folder with any: "
          f"{spread(with_custom)}; {sum(custom)} samples in all")
    highest = [max(b["indices"]) for b in banks if b["indices"]]
    if highest:
        print(f"  highest index     {spread(highest)}")
    empty = [c["empty"] for c in counts]
    print(f"  empty samples     {sum(empty)} in {sum(1 for n in empty if n)} folders")
    unused = [c["unused"] for c in counts]
    shadowed = [c["shadowed"] for c in counts]
    print(f"  never played      {sum(unused)} names no lookup reaches, in "
          f"{sum(1 for n in unused if n)} folders; {sum(shadowed)} shadowed by another "
          f"extension, in {sum(1 for n in shadowed if n)}")
    exts: dict[str, int] = {}
    for bank in banks:
        for x in bank["cells"] + bank["custom"]:
            if x["file"]:
                ext = Path(x["file"]).suffix.lower()
                exts[ext] = exts.get(ext, 0) + 1
    print(f"  extensions        " + " · ".join(f"{k} {v}" for k, v in sorted(exts.items())))
    print(f"  read, first       {ms([first for _b, first, _a in rows])}")
    print(f"  read, again       {ms([again for _b, _f, again in rows])}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("osu_folder")
    parser.add_argument("--sample", type=int, default=200)
    parser.add_argument("--offset", type=int, default=0)
    args = parser.parse_args()
    base = Path(args.osu_folder)
    skins = sorted((p for p in (base / "Skins").iterdir() if p.is_dir()), key=lambda p: p.name) \
        if (base / "Skins").is_dir() else []
    songs = [p for p in (base / "Songs").iterdir() if p.is_dir()] if (base / "Songs").is_dir() else []
    if not skins and not songs:
        print(f"No Skins or Songs folder under {base}.")
        return 1
    chosen = pick(songs, max(1, args.sample), max(0, args.offset))
    print(f"{base}: {len(skins)} skins; {len(chosen)} of {len(songs)} beatmap folders "
          f"(every {max(1, len(songs) // max(1, args.sample))}th by name from the "
          f"{max(0, args.offset)}th, counting from 0)")
    if skins:
        report("Skins", skins)
    if chosen:
        report("Beatmap folders", chosen)
    return 0


if __name__ == "__main__":
    sys.exit(main())
