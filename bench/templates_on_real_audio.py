"""Do the instrument templates hold on real music, and what would fix them?

The roadmap's instrument-lane row waits on one number: at the places mappers
put claps, how sure is the classifier that it hears a snare or a clap? On the
Python templates, over 11 songs, the median was 0.138 — too weak to draw a lane
from, so the lanes waited. This re-measures it against the Rust classifier, and
measures the one change that looks likely to fix it.

    python bench/templates_on_real_audio.py            # the mix, as shipped
    python bench/templates_on_real_audio.py --features # which features separate at all
    python bench/templates_on_real_audio.py --fit      # and how far they reach unclipped
    python bench/templates_on_real_audio.py --stem     # and the percussive half

Mapper claps are the truth here for a reason: a mapper who puts a clap on a
beat is telling us a snare or a clap is audible there, over thousands of
examples, without anyone labelling anything. It is not perfect — some claps
ride a kick, some a vocal — but no other label of real music exists in this
quantity.

``--stem`` writes the percussive half of each song to a scratch file and reads
that instead. Nothing is written beside the user's songs; the stems are
temporary and deleted. It is a probe, not the engine: the engine reads the mix,
and this says what it would read if it did not.
"""
from __future__ import annotations

import json
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

import overtone as ta  # noqa: E402

CLI = ROOT / "target" / "release" / "overtone-cli.exe"
CORPUS = HERE / "genre_corpus.json"
#: A mapper's clap counts as heard when an attack sits this close to it.
TOLERANCE_MS = 50.0
#: Fewer claps than this in a map says nothing about a classifier.
MIN_CLAPS = 20
#: What the Python templates measured, 11 songs, in the timeline's H3 entry.
PYTHON_MEDIAN = 0.138
#: Genres walked, in this order; one map per audio file.
GENRES = ("rock", "metal", "pop", "electronic", "jrock", "punk")


def evidence(audio: Path) -> dict | None:
    """`overtone-cli hitsound-evidence`, or None when it cannot be read."""
    if not CLI.is_file():
        return None
    try:
        out = subprocess.run([str(CLI), "hitsound-evidence", str(audio)],
                             capture_output=True, text=True, timeout=900)
        return json.loads(out.stdout)
    except Exception:  # noqa: BLE001 -- one unreadable song is not a failure
        return None


def heard(found: dict, events: list[dict]) -> list[float]:
    """P(snare) + P(clap) at each mapper clap with an attack under it."""
    times = np.asarray([a["time_s"] * 1000.0 for a in found["attacks"]])
    order = np.argsort(times)
    sorted_times = times[order]
    out: list[float] = []
    for event in events:
        i = int(np.searchsorted(sorted_times, event["time"]))
        best, best_dt = -1, float("inf")
        for candidate in (i - 1, i):
            if 0 <= candidate < sorted_times.size:
                dt = abs(sorted_times[candidate] - event["time"])
                if dt < best_dt:
                    best, best_dt = int(order[candidate]), dt
        if best >= 0 and best_dt <= TOLERANCE_MS:
            classes = {c["class"]: c["probability"]
                       for c in found["attacks"][best]["classes"]}
            out.append(classes.get("snare", 0.0) + classes.get("clap", 0.0))
    return out


def percussive(audio: Path, out: Path) -> bool:
    """Write the percussive half of a song, for the probe only."""
    try:
        import librosa
        import soundfile
        y, sr = librosa.load(str(audio), sr=22050, mono=True)
        soundfile.write(str(out), librosa.effects.percussive(y, margin=3.0), sr)
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"    no stem: {type(exc).__name__}: {exc}")
        return False


def songs(limit: int):
    """(folder, audio, clap events) per song of the genre corpus."""
    if not CORPUS.is_file():
        return
    body = json.loads(CORPUS.read_text(encoding="utf-8"))
    root = Path(body["songs_folder"])
    seen: set[Path] = set()
    given = 0
    for genre in GENRES:
        for row in body["genres"].get(genre, {}).get("sets", []):
            if given >= limit:
                return
            folder = root / row["folder"]
            osu = folder / row["file"]
            if not osu.is_file():
                continue
            try:
                beatmap = ta.read_osu_beatmap(str(osu))
            except Exception:  # noqa: BLE001
                continue
            audio = folder / beatmap["general"].get("AudioFilename", "")
            if not audio.is_file() or audio in seen:
                continue
            events = [e for e in ta.sound_events(beatmap)
                      if e["part"] != "body" and "clap" in e["sounds"]]
            if len(events) < MIN_CLAPS:
                continue
            seen.add(audio)
            given += 1
            yield row["folder"], audio, events


def deciles(values: list[float]) -> str:
    values = sorted(values)

    def at(share: float) -> float:
        return values[min(len(values) - 1, int(share * len(values)))]

    return (f"{at(.1):.3f} / {at(.25):.3f} / {at(.5):.3f} / "
            f"{at(.75):.3f} / {at(.9):.3f}")


def auc(positive: list[float], negative: list[float]) -> float:
    """The chance a random clapped attack reads higher than a random bare one.

    0.5 is a feature that says nothing; below 0.5 it separates the other way,
    which is as useful and means the response curve should fall, not rise.
    Ranks, with ties counted as half.
    """
    if not positive or not negative:
        return float("nan")
    values = np.concatenate([np.asarray(positive), np.asarray(negative)])
    order = values.argsort()
    ranks = np.empty_like(order, dtype=float)
    ranks[order] = np.arange(1, values.size + 1)
    _, inverse, counts = np.unique(values, return_inverse=True, return_counts=True)
    sums = np.zeros(counts.size)
    np.add.at(sums, inverse, ranks)
    ranks = (sums / counts)[inverse]
    n_pos = len(positive)
    return (ranks[:n_pos].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * len(negative))


def features(limit: int) -> int:
    """Which features tell a clapped attack from a bare one, on real music.

    Before any knot moves, the prior question: does the feature separate the
    attacks mappers clap from the attacks they do not? One that does not should
    lose its weight rather than gain new knots, and one that separates the
    other way has its curve pointing the wrong way.
    """
    clapped: dict[str, list[float]] = {}
    bare: dict[str, list[float]] = {}
    songs_read = 0
    for folder, audio, events in songs(limit):
        found = evidence(audio)
        if not found:
            continue
        songs_read += 1
        times = np.asarray([a["time_s"] * 1000.0 for a in found["attacks"]])
        near = set()
        for event in events:
            i = int(np.argmin(np.abs(times - event["time"])))
            if abs(times[i] - event["time"]) <= TOLERANCE_MS:
                near.add(i)
        for i, attack in enumerate(found["attacks"]):
            into = clapped if i in near else bare
            for cls in attack["classes"]:
                for term in cls["terms"]:
                    into.setdefault(term["feature"], []).append(term["value"])
        print(f"{folder[:44]:<46} {len(near)} of {len(found['attacks'])} attacks clapped",
              flush=True)
    if not clapped:
        print("nothing read")
        return 0
    print(f"\n{songs_read} songs   {len(clapped['flux'])} clapped attacks, "
          f"{len(bare.get('flux', []))} not")
    print(f"\n{'feature':<18} {'AUC':>6}   {'clapped p25/med/p75':>26}   {'bare':>22}")
    rows = []
    for feature, yes in clapped.items():
        no = bare.get(feature, [])
        if no:
            rows.append((abs(auc(yes, no) - 0.5), feature, yes, no))
    for _spread, feature, yes, no in sorted(rows, reverse=True):
        ys, ns = sorted(yes), sorted(no)

        def q(v, s):
            return v[min(len(v) - 1, int(s * len(v)))]

        print(f"{feature:<18} {auc(yes, no):6.3f}   "
              f"{q(ys, .25):8.3f} {q(ys, .5):8.3f} {q(ys, .75):8.3f}   "
              f"{q(ns, .25):6.3f} {q(ns, .5):6.3f} {q(ns, .75):6.3f}")
    return 0


#: The features the fit below reads, in no particular order: everything the
#: templates already measure.
FIT_FEATURES = (
    "flux", "percussive_ratio", "low_mid_ratio", "sub_ratio", "flatness",
    "decay_tau_s", "high_mid_ratio", "high_ratio", "mid_ratio", "zcr",
    "harmonicity", "air_ratio", "sustain_s", "rise_s", "sub_attacks",
)


def auc_of(scores, labels) -> float:
    """[`auc`] for scores that carry their labels beside them."""
    scores = np.asarray(scores, dtype=float)
    labels = np.asarray(labels, dtype=bool)
    return auc(list(scores[labels]), list(scores[~labels]))


def _rows(limit: int) -> list[dict]:
    """Every attack of every song, with its features and whether it was
    clapped. One evidence run a song."""
    out = []
    for folder, audio, events in songs(limit):
        found = evidence(audio)
        if not found:
            continue
        times = np.asarray([a["time_s"] * 1000.0 for a in found["attacks"]])
        near = set()
        for event in events:
            i = int(np.argmin(np.abs(times - event["time"])))
            if abs(times[i] - event["time"]) <= TOLERANCE_MS:
                near.add(i)
        for i, attack in enumerate(found["attacks"]):
            values = {}
            for cls in attack["classes"]:
                for term in cls["terms"]:
                    values[term["feature"]] = term["value"]
            shipped = {c["class"]: c["probability"] for c in attack["classes"]}
            out.append({"song": folder, "clapped": i in near, "values": values,
                        "shipped": shipped.get("snare", 0.0) + shipped.get("clap", 0.0)})
        print(f"{folder[:44]:<46} {len(near):5d} clapped of {len(found['attacks'])}",
              flush=True)
    return out


def _fit(x: np.ndarray, y: np.ndarray, rounds: int = 600, rate: float = 1.0,
         ridge: float = 1e-3) -> np.ndarray:
    """Plain gradient descent on a logistic loss: fifteen features and a
    comparison to make, not a product to ship."""
    w = np.zeros(x.shape[1])
    for _ in range(rounds):
        p = 1.0 / (1.0 + np.exp(-x @ w))
        w -= rate * (x.T @ (p - y) / max(len(y), 1) + ridge * w)
    return w


def fitted(limit: int) -> int:
    """How far the hand-built features reach when nothing clips them.

    The templates' response curves were placed on isolated synthetic drums,
    and on real music most of what they measure falls outside them — the
    percussive ratio has to reach 0.45 to count for anything and real attacks
    sit at 0.08-0.44, so the single most discriminating feature contributes
    zero almost everywhere. This puts each curve between the tenth and
    ninetieth percentile of the songs it is fitted on, fits the weights there,
    and scores songs the fit never saw.

    It is a measurement, not a model to ship: one label (a mapper's clap) over
    two of thirteen classes cannot re-place the other eleven.
    """
    rows = _rows(limit)
    if not rows:
        print("nothing read")
        return 0
    order = sorted({r["song"] for r in rows})
    fit_on = set(order[: max(1, int(len(order) * 2 / 3))])
    train = [r for r in rows if r["song"] in fit_on]
    test = [r for r in rows if r["song"] not in fit_on]
    if not train or not test:
        print("need at least two songs")
        return 0
    y_train = np.asarray([r["clapped"] for r in train], dtype=float)
    y_test = np.asarray([r["clapped"] for r in test], dtype=float)
    knots = {}
    for feature in FIT_FEATURES:
        values = np.asarray([r["values"].get(feature, 0.0) for r in train], dtype=float)
        lo, hi = np.percentile(values, [10, 90])
        knots[feature] = (float(lo), float(hi if hi > lo else lo + 1e-6))

    def matrix(rows_in):
        return np.asarray([
            [min(1.0, max(0.0, (r["values"].get(f, 0.0) - knots[f][0])
                          / (knots[f][1] - knots[f][0])))
             for f in FIT_FEATURES] + [1.0]
            for r in rows_in])

    weights = _fit(matrix(train), y_train)
    print(f"\n{len(order)} songs, {len(train)} attacks fitted, {len(test)} held out "
          f"({int(y_test.sum())} of them clapped)\n")
    print(f"{'the classifier as it ships':<46} {auc_of([r['shipped'] for r in test], y_test):.3f}")
    best = max(FIT_FEATURES,
               key=lambda f: abs(auc_of([r['values'].get(f, 0.0) for r in test], y_test) - 0.5))
    print(f"{'the best single feature (' + best + ')':<46} "
          f"{auc_of([r['values'].get(best, 0.0) for r in test], y_test):.3f}")
    print(f"{'the same features, knots on real audio, refit':<46} "
          f"{auc_of(matrix(test) @ weights, y_test):.3f}")
    print("\nweights, largest first:")
    for name, weight in sorted(zip(FIT_FEATURES + ("bias",), weights),
                               key=lambda kv: -abs(kv[1]))[:8]:
        span = (f"   over {knots[name][0]:.3f}..{knots[name][1]:.3f}"
                if name in knots else "")
        print(f"  {name:<18} {weight:+.2f}{span}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    want = int(args[args.index("--songs") + 1]) if "--songs" in args else 12
    with_stem = "--stem" in args
    if "--features" in args and CLI.is_file() and CORPUS.is_file():
        return features(want)
    if "--fit" in args and CLI.is_file() and CORPUS.is_file():
        return fitted(want)
    if not CLI.is_file():
        print("No overtone-cli built: cargo build --release -p overtone-cli")
        return 0
    if not CORPUS.is_file():
        print(f"No {CORPUS.name}: run bench/genre_corpus.py --update first.")
        return 0

    mix_all: list[float] = []
    stem_all: list[float] = []
    for folder, audio, events in songs(want):
        found = evidence(audio)
        if not found:
            continue
        on_mix = heard(found, events)
        if len(on_mix) < MIN_CLAPS:
            continue
        mix_all += on_mix
        line = (f"{folder[:44]:<46} {len(events):4d} claps, {len(on_mix)} heard, "
                f"mix {statistics.median(on_mix):.3f}")
        if with_stem:
            with tempfile.TemporaryDirectory(prefix="overtone-stem-") as tmp:
                wav = Path(tmp) / "percussive.wav"
                side = evidence(wav) if percussive(audio, wav) else None
            if side:
                on_stem = heard(side, events)
                stem_all += on_stem
                line += f"   stem {statistics.median(on_stem):.3f}"
        print(line, flush=True)

    for name, pooled in (("mix", mix_all), ("percussive stem", stem_all)):
        if not pooled:
            continue
        print(f"\n{name:<16} {len(pooled)} mapper claps with an attack under them")
        print(f"{'':16} P(snare)+P(clap) deciles {deciles(pooled)}")
        print(f"{'':16} median {statistics.median(pooled):.3f}"
              + (f"   (the Python templates measured {PYTHON_MEDIAN} on 11 songs)"
                 if name == "mix" else ""))
        for cut in (0.25, 0.5):
            share = sum(1 for p in pooled if p >= cut) / len(pooled)
            print(f"{'':16} at or above {cut:.2f}: {share * 100:.0f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
