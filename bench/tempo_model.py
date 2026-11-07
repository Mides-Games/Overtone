"""Phase 27.8: a small tempo and octave model trained on mapped tempi.

Clean room: written from the idea of TempoCNN (Schreiber and Müller, ISMIR 2018)
-- tempo as a classification over log-spaced BPM classes, trained on labelled
music -- without its code or weights (AGPL, non-commercial). The labels are
the mappers': each ranked or loved song's dominant red-line tempo, at the
octave they mapped it. No new dependency: numpy features, a numpy MLP, and the
weights saved as one .npz that ports to Rust as arithmetic.

Its use is a judge, never the red lines: given the engine's tempo b, which of
b/2, b, 2b do mappers write? The bar is roadmap 27.4's: octave x1 at 90 %+ on
held-out songs, against MAP_OCTAVE_RANGE's fixed (120, 240) on the same songs.

    python bench/tempo_model.py features --ranked-db osu!.db --db library.sqlite3 --cache DIR --jobs 4
    python bench/tempo_model.py train --cache DIR --out model.npz
    python bench/tempo_model.py eval --cache DIR --model model.npz
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "python"))
sys.path.insert(0, str(HERE))

from overtone.tempo_judge import (BINS, BPM_HI, BPM_LO, CENTRES, PER_OCTAVE,  # noqa: E402,F401
                                    bpm_bin, song_features)

SEED = 27


def dominant_bpm(path: str, duration_s: float) -> float | None:
    """The red-line tempo that spans most of the map, at the mapper's octave."""
    import overtone as ta
    rows = ta._beatmap_red_rows(ta.read_osu_beatmap(path))
    if not rows:
        return None
    spans: dict[float, float] = {}
    for i, (offset, bpm, _meter) in enumerate(rows):
        end = rows[i + 1][0] if i + 1 < len(rows) else duration_s * 1000.0
        if BPM_LO <= bpm <= BPM_HI:
            key = round(bpm * 2) / 2
            spans[key] = spans.get(key, 0.0) + max(0.0, end - offset)
    return max(spans, key=spans.get) if spans else None


# -------------------------------------------------------------- features


def _one(song: dict, cache: str) -> tuple[str, str]:
    out = Path(cache) / (hashlib.sha1(song["audio"].encode("utf-8")).hexdigest()[:16] + ".npz")
    if out.exists():
        return "cached", song["folder"]
    import overtone as ta
    import soxr
    y44, sr44 = ta._load_audio(song["audio"], lambda _m: None)
    y, sr = soxr.resample(np.asarray(y44, np.float64), sr44, 22050).astype(np.float32), 22050
    duration = y.size / sr
    labels = [b for b in (dominant_bpm(m["path"], duration) for m in song["maps"]) if b]
    if not labels or duration < 20:
        return "no label", song["folder"]
    vals, counts = np.unique(labels, return_counts=True)
    label = float(vals[np.argmax(counts)])
    np.savez_compressed(out, x=song_features(y, sr), bpm=label, folder=song["folder"],
                        split=song["split"], duration=duration)
    return "ok", song["folder"]


def cmd_features(args) -> int:
    import stages
    manifest = stages.load_manifest()
    ranked, _ = stages.ranked_maps(Path(args.ranked_db))
    songs, skipped = stages.build_stage({"where": "1 = 1"}, Path(args.db),
                                        manifest.get("holdout_share", 0.3), ranked)
    if args.max_songs:
        songs = songs[:args.max_songs]
    Path(args.cache).mkdir(parents=True, exist_ok=True)
    print(f"{len(songs)} ranked songs ({len(skipped)} skip notes)", flush=True)
    counts: dict[str, int] = {}
    started = time.perf_counter()
    with ProcessPoolExecutor(args.jobs) as pool:
        futures = [pool.submit(_one, s, args.cache) for s in songs]
        for i, f in enumerate(as_completed(futures), 1):
            try:
                status, _folder = f.result()
            except Exception as exc:  # noqa: BLE001 -- one bad song never stops the run
                status = type(exc).__name__
            counts[status] = counts.get(status, 0) + 1
            if i % 200 == 0:
                print(f"{i}/{len(songs)} {counts} ({time.perf_counter() - started:.0f} s)", flush=True)
    print(counts)
    return 0


# ----------------------------------------------------------------- model


def load(cache: str) -> dict:
    xs, bpm, split, folder = [], [], [], []
    for p in sorted(Path(cache).glob("*.npz")):
        d = np.load(p)
        xs.append(d["x"]); bpm.append(float(d["bpm"])); split.append(str(d["split"]))
        folder.append(str(d["folder"]))
    return {"x": np.asarray(xs, np.float64), "bpm": np.asarray(bpm), "split": np.asarray(split),
            "folder": np.asarray(folder)}


def targets(bpm: np.ndarray, sigma: float = 1.0) -> np.ndarray:
    centre = np.log2(bpm / BPM_LO) * PER_OCTAVE
    t = np.exp(-0.5 * ((np.arange(BINS)[None, :] - centre[:, None]) / sigma) ** 2)
    return t / t.sum(1, keepdims=True)


def forward(m: dict, x: np.ndarray):
    z = (x - m["mu"]) / m["sd"]
    h = np.maximum(0.0, z @ m["w1"] + m["b1"])
    logits = h @ m["w2"] + m["b2"]
    logits -= logits.max(1, keepdims=True)
    p = np.exp(logits)
    return z, h, p / p.sum(1, keepdims=True)


def train(x: np.ndarray, bpm: np.ndarray, hidden: int = 96, epochs: int = 80,
          lr: float = 1e-3, decay: float = 1e-4, seed: int = SEED) -> dict:
    rng = np.random.default_rng(seed)
    mu, sd = x.mean(0), x.std(0) + 1e-6
    d = x.shape[1]
    m = {"mu": mu, "sd": sd,
         "w1": rng.normal(0, np.sqrt(2 / d), (d, hidden)), "b1": np.zeros(hidden),
         "w2": rng.normal(0, np.sqrt(1 / hidden), (hidden, BINS)), "b2": np.zeros(BINS)}
    keys = ("w1", "b1", "w2", "b2")
    mom = {k: np.zeros_like(m[k]) for k in keys}
    vel = {k: np.zeros_like(m[k]) for k in keys}
    t_all, step = targets(bpm), 0
    for _epoch in range(epochs):
        order = rng.permutation(len(x))
        for a in range(0, len(x), 128):
            idx = order[a:a + 128]
            z, h, p = forward(m, x[idx])
            g = (p - t_all[idx]) / len(idx)
            grads = {"w2": h.T @ g + decay * m["w2"], "b2": g.sum(0)}
            gh = (g @ m["w2"].T) * (h > 0)
            grads["w1"] = z.T @ gh + decay * m["w1"]
            grads["b1"] = gh.sum(0)
            step += 1
            for k in keys:
                mom[k] = 0.9 * mom[k] + 0.1 * grads[k]
                vel[k] = 0.999 * vel[k] + 0.001 * grads[k] ** 2
                m[k] -= lr * (mom[k] / (1 - 0.9 ** step)) / (np.sqrt(vel[k] / (1 - 0.999 ** step)) + 1e-8)
    return m


def judge(m: dict, x: np.ndarray, reading: np.ndarray) -> np.ndarray:
    """For each song, the factor in (1/2, 1, 2) whose tempo the model rates highest."""
    _z, _h, p = forward(m, x)
    factors = np.array([0.5, 1.0, 2.0])
    scores = []
    for f in factors:
        b = np.clip(np.array([bpm_bin(v) for v in reading * f]), 0, BINS - 1)
        lo = np.floor(b).astype(int); hi = np.minimum(lo + 1, BINS - 1); w = b - lo
        s = (1 - w) * p[np.arange(len(x)), lo] + w * p[np.arange(len(x)), hi]
        inside = (reading * f >= BPM_LO) & (reading * f <= BPM_HI)
        scores.append(np.where(inside, s, -1.0))
    return factors[np.argmax(np.asarray(scores), 0)]


def fold(b: np.ndarray, lo: float) -> np.ndarray:
    out = b.copy()
    while np.any(out < lo):
        out = np.where(out < lo, out * 2, out)
    while np.any(out >= 2 * lo):
        out = np.where(out >= 2 * lo, out / 2, out)
    return out


def report(m: dict, data: dict, part: str) -> dict:
    sel = data["split"] == part
    x, bpm = data["x"][sel], data["bpm"][sel]
    _z, _h, p = forward(m, x)
    top = CENTRES[np.argmax(p, 1)]
    ratio = top / bpm
    acc1 = float(np.mean(np.abs(ratio - 1) <= 0.04))
    acc2 = float(np.mean(np.min(np.abs(np.log2(ratio)[:, None] - np.array([-1, 0, 1])), 1)
                         <= np.log2(1.04)))
    out = {"songs": int(sel.sum()), "top1_within_4pct": acc1, "top1_any_octave": acc2}
    # The judge's question: the engine reads the right tempo at some octave;
    # which octave? Simulated by presenting each octave of the truth.
    for start in (0.5, 1.0, 2.0):
        f = judge(m, x, bpm * start)
        out[f"judge_from_x{start:g}"] = float(np.mean(np.isclose(f * start, 1.0)))
    folded = fold(bpm, 120.0)
    out["fixed_120_240"] = float(np.mean(np.isclose(folded, bpm)))
    return out


def cmd_train(args) -> int:
    data = load(args.cache)
    dev = data["split"] == "dev"
    print(f"{len(data['bpm'])} songs, {int(dev.sum())} dev, {int((~dev).sum())} held out", flush=True)
    m = train(data["x"][dev], data["bpm"][dev], hidden=args.hidden, epochs=args.epochs)
    np.savez(args.out, **m, centres=CENTRES)
    for part in ("dev", "holdout"):
        print(part, json.dumps({k: round(v, 4) if isinstance(v, float) else v
                                for k, v in report(m, data, part).items()}))
    return 0


def cmd_eval(args) -> int:
    data = load(args.cache)
    m = dict(np.load(args.model))
    for part in ("dev", "holdout"):
        print(part, json.dumps({k: round(v, 4) if isinstance(v, float) else v
                                for k, v in report(m, data, part).items()}))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("features")
    f.add_argument("--ranked-db", required=True)
    f.add_argument("--db", required=True)
    f.add_argument("--cache", required=True)
    f.add_argument("--jobs", type=int, default=4)
    f.add_argument("--max-songs", type=int, default=0)
    t = sub.add_parser("train")
    t.add_argument("--cache", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--hidden", type=int, default=96)
    t.add_argument("--epochs", type=int, default=80)
    e = sub.add_parser("eval")
    e.add_argument("--cache", required=True)
    e.add_argument("--model", required=True)
    args = parser.parse_args(argv)
    return {"features": cmd_features, "train": cmd_train, "eval": cmd_eval}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
