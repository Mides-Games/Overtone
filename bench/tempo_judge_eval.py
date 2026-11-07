"""The tempo model's octave judge (roadmap 27.8) on a stage, against the same analyses.

Reads a stage's cached analyses (the run cache of a baseline run), lets the
model trained by bench/tempo_model.py pick x1/2, x1 or x2 for each song from its
features, scales every red line by that factor and scores both with stages.py.
The analyses are the same, so the difference is the judge's alone.

Halving keeps each line's offset: a cached analysis has no attacks to pick
the stronger half-beat from, so beat_f10 on halved songs is a lower bound.

Usage (on the server)::

    .venv/bin/python bench/tempo_judge_eval.py anime-variable --ranked-db /srv/osu/osu!.db \\
        --db <library.sqlite3> --cache <runs/cache/novote/base> --features <npz dir> --model <npz>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "python"))
sys.path.insert(0, str(HERE))

import corpus_b as cb  # noqa: E402
import single_bpm as sb  # noqa: E402
import stages  # noqa: E402
from overtone import tempo_judge as tj  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    manifest = stages.load_manifest()
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("stage", choices=[s["id"] for s in manifest["stages"]])
    p.add_argument("--db", required=True)
    p.add_argument("--ranked-db", required=True)
    p.add_argument("--cache", required=True, help="a baseline run's cache folder")
    p.add_argument("--features", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--engine", default="app")
    p.add_argument("--cli")
    p.add_argument("--margin", type=float, default=10.0,
                   help="change the octave only when the model rates it this many times the reading")
    p.add_argument("--out")
    args = p.parse_args(argv)
    sb.CACHE_DIR = Path(args.cache) / "single_bpm"
    import overtone_rust
    cli = Path(args.cli) if args.cli else overtone_rust.find_cli()
    fingerprint = sb.engine_fingerprint(args.engine, cli)
    stage = next(s for s in manifest["stages"] if s["id"] == args.stage)
    ranked, _h = stages.ranked_maps(Path(args.ranked_db))
    songs, _skipped = stages.build_stage(stage, Path(args.db), manifest.get("holdout_share", 0.3), ranked)
    model = {k: v.astype(np.float64) for k, v in np.load(args.model).items()}

    base_maps, judged_maps, factors, missing = [], [], {}, 0
    for n, song in enumerate(songs):
        song["id"] = f"s{n:05d}"
        analysis = cb.read_cache(sb.cache_path(args.engine, song, fingerprint))
        feat = Path(args.features) / (hashlib.sha1(song["audio"].encode("utf-8")).hexdigest()[:16] + ".npz")
        if analysis is None or not feat.is_file() or not analysis.get("lines"):
            missing += 1
            continue
        reading = float(analysis.get("global_bpm") or analysis["lines"][0][1])
        f = tj.factor(model, np.load(feat)["x"].astype(np.float64), reading, args.margin)
        factors[f] = factors.get(f, 0) + 1
        judged = dict(analysis, lines=[[o, b * f, *rest] for o, b, *rest in analysis["lines"]],
                      global_bpm=reading * f)
        base_maps += stages.score_song(song, analysis)
        judged_maps += stages.score_song(song, judged)

    out = {"stage": args.stage, "margin": args.margin, "songs_missing": missing, "factors": {str(k): v for k, v in factors.items()}}
    for name, maps in (("base", base_maps), ("judged", judged_maps)):
        dev = [m for m in maps if m["split"] == "dev"]
        shift, beat_shift = stages.convention(dev), stages.beat_convention(dev)
        out[name] = {part: stages.summarise([m for m in maps if m["split"] == part], shift, beat_shift)
                     for part in ("dev", "holdout")}
    changed = {"fixed": 0, "broken": 0}
    for b, j in zip(base_maps, judged_maps):
        if b["split"] == "holdout" and stages.tempo_ok(b) != stages.tempo_ok(j):
            changed["fixed" if stages.tempo_ok(j) else "broken"] += 1
    out["holdout_maps_changed"] = changed
    print(json.dumps({k: v for k, v in out.items()}, indent=1, default=str))
    if args.out:
        Path(args.out).write_text(json.dumps(out, indent=1, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
