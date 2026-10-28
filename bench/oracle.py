"""W11.2 oracle study: how much a per-song choice of engine could gain on the stages.

Each configuration is one server run of bench/stages.py (bench/remote.py),
whole stage or its first N songs, both splits in one run so every
configuration fits its conventions on its own dev part, as the stage does.
This joins the runs' per-map reports, keeps the maps every configuration
scored, and asks what picking the best configuration per song would score
(the oracle) against the best configuration alone. Then a first look at a
router: a one- or two-split rule on song features the runs carry, chosen on
dev and read once on held-out.

    .venv/Scripts/python.exe bench/oracle.py app=<run id> rust=<run id> ... --token-file T

A ``label=<run id>`` is fetched once into bench/.cache/remote/<id>.json;
``label=<path>`` reads a report already on disk. Runs of different stages
under one label are pooled. Metrics, per map, as bench/stages.py reads them:

- tempo ok: every red line at the map's octave and within 0.05 BPM
- octave x1: the first red line read at the map's octave
- beats 10 ms: beat F-measure at 10 ms, the run's dev beat convention off
- red lines 5 ms: tempo ok and every red line within 5 ms once the
  configuration's dev convention (median signed error) is off

The oracle picks one configuration per song (all its difficulties share
the audio), by the metric itself or, "joint", by the mean of the four.
Features come from the reports alone: whether a configuration answered,
how many red lines it gave, and whether two configurations gave the same
first red line on the song's maps (their errors identical: a property of
the two outputs, not of the map).

Reports name folders of a private library: they and this script's report
stay in bench/.cache/ (git-ignored). A measurement, not a gate.
"""
from __future__ import annotations

import argparse
import itertools
import json
import random
import statistics
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "bench"))

import stages as st  # noqa: E402

HERE = Path(__file__).resolve().parent
REMOTE = HERE / ".cache" / "remote"
OUT = HERE / ".cache" / "oracle"
SEED = 11
METRICS = ("tempo_ok", "octave_x1", "beat_f10", "conv_5")
NAMES = {"tempo_ok": "tempo ok", "octave_x1": "octave x1", "beat_f10": "beats 10 ms",
         "conv_5": "red lines 5 ms"}
#: Thresholds tried per feature: midpoints between dev values, thinned to this many.
CUTS = 16


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------

def load(source: str, token_file: str | None) -> dict:
    path = Path(source)
    if not path.is_file():
        path = REMOTE / f"{source}.json"
        if not path.is_file():
            import remote
            report = remote.Remote(remote.DEFAULT_URL, remote._token(token_file)).call(
                "GET", f"/api/v1/runs/{source}/result")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(report, indent=1), encoding="utf-8")
    return json.loads(path.read_text(encoding="utf-8"))


def map_keys(reports: list[dict]) -> set:
    return {(r["stage"]["id"], m["folder"], m["file"]) for r in reports for m in r["maps"]}


def config_maps(reports: list[dict], common: set) -> dict:
    """{(stage, folder, file): map} for one configuration, on the maps every
    configuration scored, its metrics set. red lines 5 ms is recomputed with
    the configuration's own dev convention fitted on those dev maps only, so a
    whole-stage run and a first-N-songs run are read on the same footing.
    beats 10 ms keeps the run's own beat convention (the report holds no
    beat distances to refit it)."""
    maps = {}
    for report in reports:
        if not any(m["split"] == "dev" for m in report["maps"]) or \
                not any(m["split"] == "holdout" for m in report["maps"]):
            raise SystemExit(f"{report['stage']['id']}: a run of one split only; the beat "
                             "convention needs both parts in one run")
        for m in report["maps"]:
            m = dict(m, stage=report["stage"]["id"])
            if "rows" not in m:
                # Reports before 2026-10-27 keep the first red line only: the
                # stage's own tempo-ok verdict stands, the 5 ms test reads
                # that first line (exact on one-line maps).
                m["rows"], m["first_only"] = [m["first"]], True
            key = (m["stage"], m["folder"], m["file"])
            if key in common:
                maps[key] = m
    shift = st.convention([m for m in maps.values() if m["split"] == "dev"])
    for m in maps.values():
        m["tempo_ok"] = float(m["tempo_ok"] if m.get("first_only") else st.tempo_ok(m))
        if m.get("first_only"):
            e = m["first"]["error_ms"]
            m["conv_5"] = float(bool(m["tempo_ok"]) and e is not None and abs(e - shift) <= 5)
        m["octave_x1"] = float(m["rows"][0]["octave"] == 1)
        m["beat_f10"] = float(m["beat_f10"])
        if not m.get("first_only"):
            m["conv_5"] = float(st.joint(m, 5, shift))
        m["composite"] = sum(m[k] for k in METRICS) / len(METRICS)
    return maps


def songs_table(configs: dict[str, dict]) -> list[dict]:
    """One row per song holding the maps every configuration scored."""
    common = set.intersection(*(set(maps) for maps in configs.values()))
    songs: dict[tuple, list] = {}
    for key in sorted(common):
        songs.setdefault(key[:2], []).append(key)
    names = list(configs)
    rows = []
    for (stage, folder), keys in songs.items():
        first = configs[names[0]][keys[0]]
        row = {"stage": stage, "folder": folder, "split": first["split"], "maps": len(keys),
               "configs": {}, "out": {}}
        for n in names:
            ms = [configs[n][k] for k in keys]
            row["configs"][n] = {k: statistics.mean(m[k] for m in ms) for k in (*METRICS, "composite")}
            row["out"][n] = {"answered": float(ms[0]["path"] not in ("refused", "error")),
                             "lines": float(ms[0]["detected_lines"]),
                             "first": [(m["first"]["error_ms"], m["first"]["bpm_error"],
                                        m["first"]["octave"]) for m in ms]}
        rows.append(row)
    for row in rows:
        f = {}
        for n in names:
            f[f"{n}:answered"] = row["out"][n]["answered"]
            f[f"{n}:lines"] = row["out"][n]["lines"]
        for a, b in itertools.combinations(names, 2):
            f[f"same:{a}/{b}"] = float(row["out"][a]["first"] == row["out"][b]["first"])
        row["features"] = f
    return rows


# ---------------------------------------------------------------------------
# Oracle
# ---------------------------------------------------------------------------

def mean_of(rows: list[dict], pick, metric: str) -> float | None:
    """Map-weighted mean of ``metric`` with each song's configuration ``pick(row)``."""
    total = sum(r["maps"] for r in rows)
    return sum(r["maps"] * r["configs"][pick(r)][metric] for r in rows) / total if total else None


def oracle_table(rows: list[dict], names: list[str]) -> dict:
    out = {"songs": len(rows), "maps": sum(r["maps"] for r in rows), "configs": {}, "oracle": {},
           "best": {}, "gap": {}}
    for name in names:
        out["configs"][name] = {k: mean_of(rows, lambda r, n=name: n, k) for k in METRICS}
    for k in METRICS:
        out["oracle"][k] = mean_of(rows, lambda r, k=k: max(names, key=lambda n: r["configs"][n][k]), k)
        best = max(names, key=lambda n: out["configs"][n][k])
        out["best"][k] = best
        out["gap"][k] = out["oracle"][k] - out["configs"][best][k]
    joint = lambda r: max(names, key=lambda n: r["configs"][n]["composite"])  # noqa: E731
    out["oracle_joint"] = {k: mean_of(rows, joint, k) for k in METRICS}
    best_joint = max(names, key=lambda n: mean_of(rows, lambda r, n=n: n, "composite"))
    out["best_joint"] = best_joint
    out["gap_joint"] = {k: out["oracle_joint"][k] - out["configs"][best_joint][k] for k in METRICS}
    ties = sum(1 for r in rows if len({round(r["configs"][n]["composite"], 9) for n in names}) == 1)
    out["all_tied_songs"] = ties
    out["wins"] = {}
    for r in rows:
        top = max(r["configs"][n]["composite"] for n in names)
        winners = [n for n in names if r["configs"][n]["composite"] >= top - 1e-12]
        if len(winners) < len(names):
            for n in winners:
                out["wins"][n] = out["wins"].get(n, 0) + 1
    return out


def bootstrap_gap(rows: list[dict], names: list[str], metric: str, n: int = 1000) -> tuple:
    """95 % interval of oracle minus the best configuration alone, songs resampled."""
    rng = random.Random(SEED)
    gaps = []
    for _ in range(n):
        sample = [rows[rng.randrange(len(rows))] for _ in rows]
        best = max(mean_of(sample, lambda r, x=x: x, metric) for x in names)
        orc = mean_of(sample, lambda r: max(names, key=lambda x: r["configs"][x][metric]), metric)
        gaps.append(orc - best)
    gaps.sort()
    return gaps[int(0.025 * n)], gaps[int(0.975 * n)]


# ---------------------------------------------------------------------------
# Router, first look
# ---------------------------------------------------------------------------

def _splits(rows: list[dict], feats: list[str]) -> list[tuple[str, float, bool]]:
    out = []
    for f in feats:
        values = sorted({r["features"][f] for r in rows})
        cuts = [(a + b) / 2 for a, b in zip(values, values[1:])]
        if len(cuts) > CUTS:
            cuts = [cuts[int(i * (len(cuts) - 1) / (CUTS - 1))] for i in range(CUTS)]
        out += [(f, t, above) for t in cuts for above in (True, False)]
    return out


def _test(f, t, above):
    return lambda r: (r["features"][f] > t) if above else (r["features"][f] <= t)


def _say(split) -> str:
    f, t, above = split
    return f"{f} {'>' if above else '<='} {t:.4g}"


def fit_router(rows: list[dict], base: str, alts: list[str], depth: int) -> dict:
    """The rule that best picks one ``alt`` over ``base`` on ``rows`` (dev):
    depth 1 one split, depth 2 two splits that must both hold. Exhaustive
    over the thinned thresholds, map-weighted composite score."""
    splits = _splits(rows, sorted(rows[0]["features"]))
    masks = np.array([[_test(*s)(r) for r in rows] for s in splits], dtype=float)
    weight = np.array([r["maps"] for r in rows], dtype=float)
    total = weight.sum()
    base_score = float(np.dot(weight, [r["configs"][base]["composite"] for r in rows]) / total)
    best = {"score": base_score, "alt": None, "desc": "always " + base, "rule": lambda r: False}
    tried = 0
    for alt in alts:
        gain = weight * np.array([r["configs"][alt]["composite"] - r["configs"][base]["composite"]
                                  for r in rows]) / total
        if depth == 1:
            values = masks @ gain
            i = int(np.argmax(values))
            found = (i, None, float(values[i]))
        else:
            values = masks @ (masks * gain).T
            i, j = np.unravel_index(int(np.argmax(values)), values.shape)
            found = (int(i), int(j), float(values[i, j]))
        tried += values.size
        if base_score + found[2] > best["score"] + 1e-12:
            i, j, value = found
            first = _test(*splits[i])
            if j is None:
                rule, desc = first, _say(splits[i])
            else:
                second = _test(*splits[j])
                rule = (lambda r, a=first, b=second: a(r) and b(r))
                desc = f"{_say(splits[i])} and {_say(splits[j])}"
            best.update(score=base_score + value, alt=alt, rule=rule,
                        desc=f"{alt} if {desc}, else {base}")
    best["tried"] = tried
    return best


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def pct(v) -> str:
    return "    -" if v is None else f"{100 * v:5.1f}"


def print_table(title: str, t: dict, names: list[str]) -> None:
    print(f"\n{title}: {t['songs']} songs, {t['maps']} maps "
          f"({t['all_tied_songs']} songs where every configuration scores the same)")
    print(f"  {'configuration':<18}" + "".join(f"{NAMES[k]:>16}" for k in METRICS))
    for name in names:
        print(f"  {name:<18}" + "".join(f"{pct(t['configs'][name][k]):>16}" for k in METRICS))
    print(f"  {'best alone':<18}" + "".join(
        f"{pct(t['configs'][t['best'][k]][k]):>8} {t['best'][k][:7]:<7}" for k in METRICS))
    print(f"  {'oracle, by metric':<18}" + "".join(f"{pct(t['oracle'][k]):>16}" for k in METRICS))
    print(f"  {'gap':<18}" + "".join(f"{100 * t['gap'][k]:>+16.1f}" for k in METRICS))
    print(f"  {'oracle, joint':<18}" + "".join(f"{pct(t['oracle_joint'][k]):>16}" for k in METRICS))
    print(f"  {'gap vs ' + t['best_joint'][:11]:<18}" + "".join(
        f"{100 * t['gap_joint'][k]:>+16.1f}" for k in METRICS))
    print("  songs each configuration wins or ties at the top (composite, all-tied songs aside): "
          + ", ".join(f"{n} {v}" for n, v in sorted(t["wins"].items(), key=lambda kv: -kv[1])))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("runs", nargs="+", metavar="LABEL=RUN",
                        help="a configuration and one of its runs (a server run id or a report path)")
    parser.add_argument("--token-file", help="the server's token, to fetch a run not yet here")
    parser.add_argument("--out", default=str(OUT / "report.json"))
    args = parser.parse_args(argv)

    sources: dict[str, list[dict]] = {}
    for item in args.runs:
        label, _, source = item.partition("=")
        report = load(source, args.token_file)
        sources.setdefault(label, []).append(report)
        print(f"{label:<16} {report['stage']['id']:<15} {report['engine']:<7} "
              f"{len(report['maps']):>5} maps  run {report.get('run', '?')}")
    names = list(sources)
    common = set.intersection(*(map_keys(reports) for reports in sources.values()))
    configs = {n: config_maps(reports, common) for n, reports in sources.items()}
    rows = songs_table(configs)
    stage_ids = sorted({r["stage"] for r in rows})
    report = {"configs": {n: [r["run"] for r in rs] for n, rs in sources.items()},
              "tables": {}, "routers": {}, "pairs": []}

    groups = [("all", lambda r: True)] + [(s, lambda r, s=s: r["stage"] == s) for s in stage_ids]
    for gid, keep in groups:
        if gid == "all" and len(stage_ids) == 1:
            continue
        for split in ("dev", "holdout"):
            part = [r for r in rows if r["split"] == split and keep(r)]
            if not part:
                continue
            t = oracle_table(part, names)
            if split == "holdout":
                t["gap_ci"] = {k: bootstrap_gap(part, names, k) for k in METRICS}
            report["tables"][f"{gid}/{split}"] = t
            print_table(f"{gid}, {split}", t, names)
            if t.get("gap_ci"):
                print("  gap 95 % (songs resampled): " + ", ".join(
                    f"{NAMES[k]} {100 * lo:+.1f}..{100 * hi:+.1f}" for k, (lo, hi) in t["gap_ci"].items()))

    dev = [r for r in rows if r["split"] == "dev"]
    held = [r for r in rows if r["split"] == "holdout"]
    if len(names) > 2:
        pairs = []
        for a, b in itertools.combinations(names, 2):
            pick = lambda r, a=a, b=b: max((a, b), key=lambda n: r["configs"][n]["composite"])  # noqa: E731
            pairs.append((mean_of(dev, pick, "composite"), a, b, {k: mean_of(held, pick, k) for k in METRICS}))
        pairs.sort(key=lambda p: -p[0])
        report["pairs"] = [{"dev_composite": p[0], "a": p[1], "b": p[2], "holdout": p[3]} for p in pairs]
        print("\noracle of two configurations, best by dev composite, read on held out:")
        for s, a, b, h in pairs[:5]:
            print(f"  {a:>14} + {b:<14} dev {pct(s)}  held out "
                  + ", ".join(f"{NAMES[k]} {pct(v).strip()}" for k, v in h.items()))

    base = max(names, key=lambda n: mean_of(dev, lambda r, n=n: n, "composite"))
    for depth in (1, 2):
        fitted = fit_router(dev, base, [n for n in names if n != base], depth)
        rule, alt = fitted["rule"], fitted["alt"] or base
        pick = lambda r, rule=rule, alt=alt: alt if rule(r) else base  # noqa: E731
        res = {"rule": fitted["desc"], "rules_tried": fitted["tried"], "base": base}
        for split, part in (("dev", dev), ("holdout", held)):
            res[split] = {k: mean_of(part, pick, k) for k in METRICS}
            res[split + "_base"] = {k: mean_of(part, lambda r: base, k) for k in METRICS}
            res[split + "_switched"] = sum(rule(r) for r in part)
        report["routers"][f"depth{depth}"] = res
        print(f"\nrouter, depth {depth} ({fitted['tried']} rules tried on dev): {fitted['desc']}")
        for split in ("dev", "holdout"):
            print(f"  {split:<8} {res[split + '_switched']:>3} songs switched: " + ", ".join(
                f"{NAMES[k]} {pct(res[split + '_base'][k]).strip()} -> {pct(res[split][k]).strip()}"
                for k in METRICS))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1, default=str), encoding="utf-8")
    print(f"\nwritten: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
