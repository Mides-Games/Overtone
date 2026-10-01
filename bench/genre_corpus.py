"""Where each genre puts its hitsounds, measured from the user's own Songs.

The hitsound decision scores a candidate's *metrical fit* — is a finish right
here, is this where a clap goes — and until now that fit was written by hand,
and said so: "starting points, not measurements". This measures it instead.

For every mapset of a genre, the difficulty carrying the hitsounding is read
with the engine's own reader and ``hitsound_report``, which resolves what osu!
actually plays and places each sound on a sixteenth of the map's own bar. The
placements are pooled per genre into one distribution per addition — the share
of this genre's claps that land on beat 2, and so on — and that table ships in
``profiles/<genre>.json`` for the Rust decision to read.

Nothing of anyone's map is copied: the manifest holds folder names, the file
measured and its SHA-1, and the pooled counts. No audio, no map text, no
samples. The corpus is the user's library, so another machine cannot rerun it;
that is stated rather than hidden, exactly as Corpus B states it.

    python bench/genre_corpus.py                   # the report
    python bench/genre_corpus.py --holdout         # against the hand rule, held out
    python bench/genre_corpus.py --update          # write bench/genre_corpus.json
    python bench/genre_corpus.py --profiles        # write profiles/<genre>.json

**How a table is estimated.** Pooled counts over the maps, then 2 % of the mass
spread evenly so a slot no map in the sample used is unlikely rather than
impossible. Pooled-and-2 % was chosen by measurement, not taste: over the 27
genre-and-addition cells, three estimators (pooled counts, the mean of each
map's shares, the median of them) at five smoothing levels were scored on a
third of the maps held back for choosing, and it won (-3.066 bits against
-3.077 for the next).

**Whether a table is shipped.** Only where it beats the hand-written rule on a
third of the maps it never saw, with the rule given its own best temperature on
the choosing third. It wins 25 of 27 cells, median +0.29 bits a placement. The
two it loses are jazz, the smallest pool here, so jazz ships no table and keeps
the rule — a genre with 28 mapsets of swing and mixed meters has not been
measured enough to overrule anything.
"""
from __future__ import annotations

import hashlib
import json
import re
import math
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT))

import overtone as ov  # noqa: E402

MANIFEST = HERE / "genre_corpus.json"
PROFILES = ROOT / "profiles"
CACHE = HERE / ".cache" / "genre_corpus"
FORMAT = 1
SLOTS_PER_BEAT = 4
SLOTS = 16
ADDITIONS = ("whistle", "finish", "clap")

#: Genre comes from the engine's own classifier (``overtone.hitsound_genre``),
#: which is what the app uses to preselect a profile. One definition: a song
#: graded under one genre here and hitsounded under another in the app would
#: make every number on this page a lie.
genre_of = ov.hitsound_genre

#: Mapsets measured per genre, newest set id first: modern hitsounding, and a
#: cap so one huge genre does not decide the estimator for the rest.
CAP = 110
#: A map with fewer additions than this an object has no hitsounding to learn
#: from; counting it would weight silence as taste.
MIN_ADDITIONS_PER_OBJECT = 0.25
#: Below this, a map is a lesson in nothing: too short to carry a bar pattern.
MIN_OBJECTS = 100
#: Of the addition's mass, spread evenly over the slots. See the module note.
SMOOTHING = 0.02
#: A cell needs this many placements on each side of the split to be judged.
MIN_PLACEMENTS = 200


def songs_folder() -> Path:
    """Where the maps are, from the app's own config if it is set."""
    for candidate in (Path(r"C:\osu!\Songs"),):
        if candidate.is_dir():
            return candidate
    return Path()


def header(path: Path) -> dict:
    """Artist, tags and mode, read from the top of a .osu only."""
    keys = ("Artist", "Title", "Tags", "Mode")
    out: dict[str, str] = {}
    try:
        with path.open("r", encoding="utf-8-sig", errors="replace") as fh:
            for line in fh:
                if line.startswith("[TimingPoints]") or line.startswith("[HitObjects]"):
                    break
                key, sep, value = line.partition(":")
                if sep and key in keys and key not in out:
                    out[key] = value.strip()
    except OSError:
        return {}
    return out


def pools(songs: Path) -> dict[str, list[Path]]:
    """Every mapset folder, in its genre, newest set id first."""
    found: dict[str, list[tuple[int, Path]]] = {}
    for folder in sorted(p for p in songs.iterdir() if p.is_dir()):
        osus = sorted(folder.glob("*.osu"))
        if not osus:
            continue
        head = header(osus[0])
        name = genre_of(head.get("Artist", ""), head.get("Tags", ""))
        if not name:
            continue
        first = folder.name.split(" ")[0]
        found.setdefault(name, []).append((int(first) if first.isdigit() else 0, folder))
    return {name: [p for _id, p in sorted(rows, key=lambda r: -r[0])]
            for name, rows in found.items()}


def hitsounded(folder: Path) -> Path | None:
    """The std difficulty most likely to carry the hitsounding: the largest.

    Hitsounds are usually copied across a set, so any difficulty would do; the
    largest is the one whose pattern is densest and least likely to be a cut
    version with half the map missing.
    """
    best, size = None, -1
    for path in sorted(folder.glob("*.osu")):
        head = header(path)
        if head.get("Mode", "0") not in ("0", ""):
            continue
        try:
            bytes_ = path.stat().st_size
        except OSError:
            continue
        if bytes_ > size:
            best, size = path, bytes_
    return best


def measure(path: Path) -> dict | None:
    """One map's placements per slot, or None when it teaches nothing."""
    try:
        report = ov.hitsound_report(ov.read_osu_beatmap(str(path)))
    except Exception:
        return None
    sounds = report["sounds"]
    if not sounds or report["meter"] != 4:
        return None
    objects = len({s["object"] for s in sounds})
    additions = report["additions"]
    total = sum(a["total"] for a in additions.values())
    if objects < MIN_OBJECTS or total / objects < MIN_ADDITIONS_PER_OBJECT:
        return None
    banks = report["sets"]["normal"]
    played = sum(banks.values()) or 1
    return {
        "file": path.name,
        "sha1": hashlib.sha1(path.read_bytes()).hexdigest(),
        "objects": objects,
        "additions_per_object": round(total / objects, 4),
        "slots": {name: additions[name]["slots"][:SLOTS] for name in ADDITIONS},
        "banks": {name: round(count / played, 4) for name, count in banks.items()},
        "volume": statistics.median(s["volume"] for s in sounds),
    }


def corpus(songs: Path, only: list[str] | None = None) -> dict[str, list[dict]]:
    """Measure every pool, newest first, to the cap."""
    out: dict[str, list[dict]] = {}
    for name, folders in pools(songs).items():
        if only and name not in only:
            continue
        rows = []
        for folder in folders:
            if len(rows) >= CAP:
                break
            path = hitsounded(folder)
            if path is None:
                continue
            row = measure(path)
            if row is not None:
                row["folder"] = folder.name
                rows.append(row)
        out[name] = rows
    return out


def table(rows: list[dict], addition: str, smoothing: float = SMOOTHING) -> list[float]:
    """Pooled counts as a distribution over the bar, lightly smoothed."""
    counts = [0.0] * SLOTS
    for row in rows:
        for slot, count in enumerate(row["slots"][addition][:SLOTS]):
            counts[slot] += count
    mass = sum(counts)
    if mass <= 0:
        return [1.0 / SLOTS] * SLOTS
    return [round((1.0 - smoothing) * c / mass + smoothing / SLOTS, 6) for c in counts]


# -- the hand-written rule, for the comparison -------------------------------

def hand_fit(addition: str, slot: int) -> float:
    """``role_fit`` in crates/overtone-hitsound/src/emission.rs, read onto the
    sixteen slots of a proven 4/4 bar through ``role::metrical_weight``."""
    weight = {0: 1.0, 4: 0.5, 8: 0.7, 12: 0.5}.get(slot, 0.25 if slot % 2 == 0 else 0.10)
    division = 1 if slot % 4 == 0 else (2 if slot % 2 == 0 else 4)
    if addition == "finish":
        return 1.0 if division == 1 and weight >= 0.8 else (0.2 if division == 1 else -0.3)
    if addition == "clap":
        if division == 1 and 0.4 <= weight <= 0.8:
            return 0.6
        return -0.2 if division == 1 else -0.1
    return 0.4 if division >= 2 else -0.1


def softmax(fits: list[float], temperature: float) -> list[float]:
    top = max(f / temperature for f in fits)
    raw = [math.exp(f / temperature - top) for f in fits]
    total = sum(raw)
    return [r / total for r in raw]


def bits(distribution: list[float], counts: list[int]) -> float:
    """Mean log2 probability the distribution gives the placements."""
    total = sum(counts)
    if not total:
        return float("nan")
    return sum(c * math.log2(max(p, 1e-9)) for p, c in zip(distribution, counts)) / total


def counts_of(rows: list[dict], addition: str) -> list[int]:
    out = [0] * SLOTS
    for row in rows:
        for slot, count in enumerate(row["slots"][addition][:SLOTS]):
            out[slot] += count
    return out


def holdout(rows: list[dict], addition: str) -> tuple[float, float, int] | None:
    """(hand rule, measured table, placements) on a third the table never saw.

    Thirds by position in the list, which is set-id order: nothing the table
    can see decides the split. The rule is scored at the temperature that
    suits it best on the middle third, so it competes at its strongest.
    """
    build = [r for n, r in enumerate(rows) if n % 3 == 0]
    choose = [r for n, r in enumerate(rows) if n % 3 == 1]
    score = [r for n, r in enumerate(rows) if n % 3 == 2]
    dev, test = counts_of(choose, addition), counts_of(score, addition)
    if sum(dev) < MIN_PLACEMENTS or sum(test) < MIN_PLACEMENTS:
        return None
    fits = [hand_fit(addition, slot) for slot in range(SLOTS)]
    temperature = max((bits(softmax(fits, t), dev), t)
                      for t in (0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0))[1]
    return (bits(softmax(fits, temperature), test),
            bits(table(build, addition), test),
            sum(test))


def report(measured: dict[str, list[dict]], with_holdout: bool) -> None:
    beats = ["1", ".", ".", ".", "2", ".", ".", ".", "3", ".", ".", ".", "4", ".", ".", "."]
    for genre, rows in measured.items():
        if not rows:
            print(f"\n== {genre}: nothing measured")
            continue
        print(f"\n== {genre}   {len(rows)} mapsets   "
              f"additions an object {statistics.median(r['additions_per_object'] for r in rows):.2f}"
              f"   volume {statistics.median(r['volume'] for r in rows):.0f}")
        banks = {k: statistics.median(r["banks"][k] for r in rows)
                 for k in ("normal", "soft", "drum")}
        print("   plain hit: " + "  ".join(f"{k} {v*100:.0f}%" for k, v in banks.items()))
        print("   slot:      " + " ".join(f"{b:>4}" for b in beats))
        for addition in ADDITIONS:
            row = table(rows, addition)
            print(f"   {addition:<8}: " + " ".join(f"{v*100:4.0f}" for v in row))
        if with_holdout:
            for addition in ADDITIONS:
                got = holdout(rows, addition)
                if got is None:
                    print(f"   {addition:<8}  too few placements to judge")
                    continue
                hand, measured_bits, placements = got
                print(f"   {addition:<8}  held out on {placements:6d} placements: "
                      f"hand {hand:+.2f} bits, table {measured_bits:+.2f} bits "
                      f"({measured_bits - hand:+.2f})")


def dumps(body: dict) -> str:
    """JSON a person can read and git can diff: indented, but a row of numbers
    on one line. Indenting the 48 counts a map carries would make the manifest
    five times the size for no reader's benefit."""
    text = json.dumps(body, indent=1)
    return re.sub(r"\[\s+((?:-?[\d.eE+-]+,\s+)*-?[\d.eE+-]+)\s+\]",
                  lambda m: "[" + re.sub(r"\s+", " ", m.group(1)) + "]", text) + "\n"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    songs = songs_folder()
    if not songs.is_dir():
        print("No Songs folder here: this corpus is the user's own library.")
        return 0
    only = None
    if "--only" in args:
        only = args[args.index("--only") + 1].split(",")
    measured = corpus(songs, only)
    report(measured, "--holdout" in args or "--profiles" in args)
    if "--update" in args:
        body = {
            "_comment": "Where each genre puts its hitsounds, measured by "
                        "bench/genre_corpus.py from the user's own Songs folder. Folder "
                        "names, the file measured and its SHA-1 only: no map text, no "
                        "audio, no samples.",
            "format": FORMAT,
            "measured": "2026-09-27",
            "songs_folder": str(songs),
            "selection": [
                "Genre by the mapper's own tags, most specific first, plus a list of "
                "bands whose genre is not in doubt.",
                f"The largest osu!standard difficulty of each set, at most {CAP} sets a "
                "genre, newest set id first.",
                f"Maps of at least {MIN_OBJECTS} objects carrying at least "
                f"{MIN_ADDITIONS_PER_OBJECT} additions an object, in 4/4.",
            ],
            "genres": {name: {"sets": rows} for name, rows in measured.items()},
        }
        MANIFEST.write_text(dumps(body), encoding='utf-8')
        print(f"\nWrote {MANIFEST.name}: "
              f"{sum(len(r) for r in measured.values())} mapsets over {len(measured)} genres.")
    if "--profiles" in args:
        third = args[args.index("--third") + 1] if "--third" in args else None
        where = Path(args[args.index("--profiles-dir") + 1]) if "--profiles-dir" in args             else PROFILES
        write_profiles(measured, third, where)
    return 0


def write_profiles(measured: dict[str, list[dict]], third: str | None = None,
                   where: Path = PROFILES) -> None:
    """A profile a genre earned: balanced's affinity plus its measured table.

    ``third`` writes the table from one third of the maps only (``build``, the
    same third :func:`holdout` builds from), so a profile can be measured
    end to end on maps it never saw. The shipped profiles use every map.
    """
    base = json.loads((PROFILES / "balanced.json").read_text(encoding="utf-8"))
    for genre, all_rows in sorted(measured.items()):
        rows = all_rows
        if third == "build":
            rows = [r for n, r in enumerate(all_rows) if n % 3 == 0]
        verdicts = {a: holdout(all_rows, a) for a in ADDITIONS}
        judged = [v for v in verdicts.values() if v is not None]
        if not judged or any(v[1] <= v[0] for v in judged):
            print(f"   {genre}: no table — it did not beat the rule on maps it never saw")
            continue
        body = dict(base)
        body["_comment"] = (
            f"{genre}: balanced's affinity with the metrical table measured from "
            f"{len(rows)} {genre} mapsets in the user's Songs folder (bench/genre_corpus.py, "
            f"2026-09-27). The table is the share of that addition's placements landing on "
            f"each sixteenth of a 4/4 bar, pooled over the maps and smoothed by 2 %. Held "
            f"out against the hand-written rule on the third it never saw: "
            + ", ".join(f"{a} {v[1] - v[0]:+.2f} bits" for a, v in verdicts.items()
                        if v is not None)
            + ".")
        body["metrical"] = {"slots_per_bar": SLOTS,
                            **{a: table(rows, a) for a in ADDITIONS}}
        path = where / f"{genre}.json"
        path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
        print(f"   {genre}: wrote {path.name}")


if __name__ == "__main__":
    raise SystemExit(main())
