"""Aim Overtone's own synthesiser at what each genre's hitsounds measure.

``bench/genre_samples.py`` says what a genre's samples sound like — how long
the hit rings, how bright it is, how much of it is noise. This searches the
synthesiser's own parameters for the setting whose *synthesised* sound lands
nearest that target, and prints the table ``assets/samples.py`` ships.

Nothing of anyone's audio is used here: the target is five numbers, and what
comes out is Overtone's own generator with different arguments. A kit is a
description of a sound, fitted to a measurement, not a recording of one.

    python bench/fit_kits.py                 # fit every genre, print the table
    python bench/fit_kits.py --only rock     # one of them
    python bench/fit_kits.py --update        # write assets/kits.json

The distance is relative, so a 20 % error in a 5 kHz centroid counts the same
as a 20 % error in a 200 ms decay; frequencies are compared in octaves, which
is how they are heard. What it cannot fit, it says: a role whose fitted sound
is further than ``TOLERANCE`` from the target is printed with its error rather
than shipped quietly.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "assets"))

import genre_samples as gs  # noqa: E402
import samples as syn  # noqa: E402

TARGETS = HERE / "genre_samples.json"
OUT = ROOT / "assets" / "kits.json"
FORMAT = 1
#: Further than this, in the distance below, and the fit is reported rather
#: than shipped: the generator cannot make that sound and should say so.
TOLERANCE = 0.55
#: The roles a kit ships. A genre that has no measurement for one keeps
#: Overtone's own default sample for it.
ROLES = ("hitnormal", "hitwhistle", "hitfinish", "hitclap")


def measure(signal: list[float]) -> dict | None:
    """The same features ``genre_samples`` reads, on a synthesised sound."""
    return gs.features(np.asarray(signal, dtype=np.float64), syn.RATE)


def distance(got: dict, want: dict) -> float:
    """How far one sound is from another, in the terms they are heard in."""
    if not got:
        return math.inf
    octaves = abs(math.log2(max(got["centroid_hz"], 20.0) / max(want["centroid_hz"], 20.0)))
    roll = abs(math.log2(max(got["rolloff_hz"], 20.0) / max(want["rolloff_hz"], 20.0)))
    decay = abs(math.log2(max(got["decay_ms"], 1.0) / max(want["decay_ms"], 1.0)))
    noise = abs(got["zcr"] - want["zcr"]) * 3.0
    attack = abs(math.log2(max(got["attack_ms"], 0.2) / max(want["attack_ms"], 0.2))) * 0.35
    return octaves + 0.6 * roll + 0.8 * decay + noise + attack


# -- the synthesiser, as a few parameters per role ---------------------------

#: The sound itself lives in the generator, so what is fitted here and what
#: is rendered there cannot drift apart.
hit = syn.hit


#: The coarse grid, searched for every role. Deliberately wide: the roles cover
#: a tom at 100 Hz and a crash at 10 kHz, and which is which is measured rather
#: than assumed.
SPECTRUM = {
    "centre": [90, 160, 320, 700, 1400, 2800, 5600, 9000],
    "q": [0.7, 1.4],
    "noise_mix": [0.0, 0.5, 1.0],
    "tone_mix": [0.0, 0.5, 1.0],
    "cut": [30, 400, 2000],
    "top": [3000, 9000, 20000],
}
ENVELOPE = {
    "decay": [0.02, 0.06, 0.15, 0.35, 0.7],
    "attack": [0.0, 0.01, 0.04, 0.1],
    "bursts": [1, 3],
}
#: What the refine pass tries around the winner, per parameter.
REFINE = ("centre", "decay", "attack", "top", "noise_mix", "tone_mix")
ROLES = ("hitnormal", "hitwhistle", "hitfinish", "hitclap")
#: Seconds rendered while the spectrum is being chosen. The features that
#: decide it are read from the first 50 ms, so rendering two seconds of tail to
#: measure them is ten times the work for the same answer.
SPECTRUM_S = 0.2


def spectral_distance(got: dict | None, want: dict) -> float:
    if not got:
        return math.inf
    return (abs(math.log2(max(got["centroid_hz"], 20.0) / max(want["centroid_hz"], 20.0)))
            + 0.6 * abs(math.log2(max(got["rolloff_hz"], 20.0) / max(want["rolloff_hz"], 20.0)))
            + 3.0 * abs(got["zcr"] - want["zcr"]))


def envelope_distance(got: dict | None, want: dict) -> float:
    if not got:
        return math.inf
    return (0.8 * abs(math.log2(max(got["decay_ms"], 1.0) / max(want["decay_ms"], 1.0)))
            + 0.35 * abs(math.log2(max(got["attack_ms"], 0.2) / max(want["attack_ms"], 0.2))))


def neighbours(key: str, value):
    """Values to try either side of a coarse winner."""
    if key in ("noise_mix", "tone_mix"):
        return [round(v, 3) for v in (value - 0.25, value + 0.25) if 0.0 <= v <= 1.25]
    if key == "attack":
        return [round(v, 4) for v in (value * 0.5, value * 2.0) if 0.0 <= v <= 0.2] or [0.005]
    if key in ("centre", "top"):
        return [round(value / 1.5), round(value * 1.5)]
    return [round(value / 1.7, 4), round(value * 1.7, 4)]


def walk(grid: dict, seed: dict):
    """Every combination of ``grid``, each merged onto ``seed``."""
    keys = list(grid)

    def step(at: int, chosen: dict):
        if at == len(keys):
            yield dict(chosen)
            return
        for value in grid[keys[at]]:
            yield from step(at + 1, {**chosen, keys[at]: value})

    yield from step(0, dict(seed))


def fit(role: str, want: dict) -> tuple[dict, float, dict]:
    """The setting whose sound lands nearest ``want``.

    In two stages, because the two halves of a hit barely see each other: what
    it sounds like is decided in the first 50 ms by the spectrum, and how long
    it lasts by the envelope. Searching them together is 52,000 renders a role,
    an hour and a half; searching them apart is about 1,400, and the refine
    afterwards is what keeps the answer from being a grid point rather than a
    sound.
    """
    start = {"decay": 0.15, "attack": 0.0, "bursts": 1}
    best_spec, best_score = None, math.inf
    for chosen in walk(SPECTRUM, start):
        if chosen["noise_mix"] == 0.0 and chosen["tone_mix"] == 0.0:
            continue
        got = measure(hit(**chosen, cap=SPECTRUM_S))
        score = spectral_distance(got, want)
        if score < best_score:
            best_spec, best_score = dict(chosen), score
    assert best_spec is not None

    best_env, best_score = None, math.inf
    for chosen in walk(ENVELOPE, best_spec):
        got = measure(hit(**chosen))
        score = envelope_distance(got, want)
        if score < best_score:
            best_env, best_score = dict(chosen), score
    assert best_env is not None

    best = (distance(measure(hit(**best_env)), want), best_env, measure(hit(**best_env)) or {})
    for _round in range(2):
        for key in REFINE:
            for value in neighbours(key, best[1][key]):
                chosen = {**best[1], key: value}
                if chosen["noise_mix"] == 0.0 and chosen["tone_mix"] == 0.0:
                    continue
                got = measure(hit(**chosen))
                score = distance(got, want)
                if score < best[0]:
                    best = (score, chosen, got or {})
    return best[1], best[0], best[2]


def verify() -> list[str]:
    """Render every shipped kit sound and hold it to the target it was fitted
    to. What is committed is a description; this is the check that the
    description still renders the sound it claims."""
    if not OUT.is_file() or not TARGETS.is_file():
        return ["no kits.json or genre_samples.json to check"]
    kits = json.loads(OUT.read_text(encoding="utf-8"))
    targets = json.loads(TARGETS.read_text(encoding="utf-8"))["genres"]
    problems = []
    for genre, sounds in kits.get("kits", {}).items():
        for name, row in sounds.items():
            want = targets.get(genre, {}).get("roles", {}).get(name)
            if want is None:
                problems.append(f"{genre} {name}: fitted to a target that is gone")
                continue
            got = measure(syn.hit(**row["params"]))
            score = distance(got, want)
            if score > kits.get("tolerance", TOLERANCE) + 1e-9:
                problems.append(f"{genre} {name}: renders {score:.2f} from its target, "
                                f"past {kits.get('tolerance', TOLERANCE)}")
            elif abs(score - row["error"]) > 0.02:
                problems.append(f"{genre} {name}: renders {score:.2f}, "
                                f"the file says {row['error']}")
    return problems


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not TARGETS.is_file():
        print(f"No {TARGETS.name}: run bench/genre_samples.py --update first.")
        return 0
    if "--verify" in args:
        problems = verify()
        for line in problems:
            print(f"  {line}")
        kits = json.loads(OUT.read_text(encoding="utf-8")) if OUT.is_file() else {"kits": {}}
        print(f"{sum(len(v) for v in kits.get('kits', {}).values())} sounds checked: "
              + ("every one renders what it says" if not problems else f"{len(problems)} wrong"))
        return 1 if problems else 0
    body = json.loads(TARGETS.read_text(encoding="utf-8"))
    only = args[args.index("--only") + 1].split(",") if "--only" in args else None
    kits: dict[str, dict] = {}
    print(f"{'genre':<11} {'role':<16} {'n':>4} {'error':>6}  "
          f"{'centroid: want -> got':<26} {'decay: want -> got'}")
    for genre, block in body["genres"].items():
        if only and genre not in only:
            continue
        for full, want in block["roles"].items():
            bank, _dash, role = full.partition("-")
            if role not in ROLES:
                continue
            chosen, score, got = fit(role, want)
            mark = " " if score <= TOLERANCE else "*"
            print(f"{genre:<11} {full:<16} {want['n']:4d} {score:6.2f}{mark} "
                  f"{want['centroid_hz']:8.0f} -> {got.get('centroid_hz', 0):<8.0f}    "
                  f"{want['decay_ms']:6.0f} -> {got.get('decay_ms', 0):.0f}")
            if score <= TOLERANCE:
                kits.setdefault(genre, {})[full] = {"role": role, "params": chosen,
                                                    "error": round(score, 3),
                                                    "from_maps": want["n"]}
    if "--update" in args:
        OUT.write_text(json.dumps(
            {"_comment": "Per genre, the synthesiser settings whose sound lands nearest what "
                         "that genre's own maps measure (bench/fit_kits.py). Overtone's own "
                         "generator with different arguments: no sample of anyone's is used, "
                         "kept or shipped.",
             "format": FORMAT, "fitted": "2026-09-27",
             "tolerance": TOLERANCE, "kits": kits}, indent=1) + "\n", encoding="utf-8")
        print(f"\nWrote {OUT.name}: {sum(len(v) for v in kits.values())} sounds "
              f"over {len(kits)} genres.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
