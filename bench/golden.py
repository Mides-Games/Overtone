"""Per-stage golden vectors from the v3 engine.

The accuracy benchmark compares the *output* of an analysis against ground
truth. That is the right gate for "is this tool correct", and the wrong one for
"does this port still compute what the original computed": a port can arrive at
the right BPM through a wrong envelope and a compensating peak-picker, and the
benchmark will call it green.

So this dumps what each stage of the pipeline actually produced — attacks,
seed grid, octave, atom sections, beat sections, meter, points — and can check
a later run against it stage by stage. A divergence then names its own stage
instead of surfacing as a mystery at the end.

    python bench/golden.py dump                # write bench/golden/*.json
    python bench/golden.py check               # compare against them
    python bench/golden.py check --only swing-120

This is the harness the Rust engine will be pointed at in Phase 1. Nothing here
duplicates pipeline logic: the private functions are wrapped with recording
proxies and ``analyze_audio`` is then run normally, so what is captured is
exactly what the shipped path computed.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import sys
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import benchmark as bm  # noqa: E402
import gates  # noqa: E402
import overtone as ta  # noqa: E402

GOLDEN_DIR = Path(__file__).resolve().parent / "golden"

#: Per-stage tolerances. Tight enough that a genuinely different computation
#: fails, loose enough to survive float-order differences between a NumPy
#: expression and a hand-written loop over the same arithmetic.
TOL = {
    "attack_time_s": 5e-5,      # 0.05 ms
    "weight": 1e-3,
    "period_s": 1e-6,           # 1e-6 s at 340 ms/beat is ~0.0002 BPM
    "phase_s": 5e-5,
    "offset_ms": 0.05,
    "bpm": 0.001,
    "residual_ms": 0.05,
    "confidence": 1e-3,
}


def _arr(values, decimals: int) -> list:
    return [round(float(v), decimals) for v in np.asarray(values).reshape(-1)]


@contextlib.contextmanager
def _recording():
    """Wrap the precision engine's stages so their inputs/outputs are captured."""
    log: dict = {}
    originals = {}

    def wrap(name, fn, record):
        originals[name] = fn

        def proxy(*args, **kwargs):
            result = fn(*args, **kwargs)
            try:
                record(log, args, kwargs, result)
            except Exception as exc:  # noqa: BLE001 — never break the run
                log.setdefault("_record_errors", []).append(f"{name}: {exc!r}")
            return result

        return proxy

    def on_attacks(log, args, kwargs, result):
        times, weights, env = result
        log["attacks"] = {
            "count": int(times.size),
            "times_s": _arr(times, 7),
            "weights": _arr(weights, 5),
            "envelope_frames": int(np.asarray(env).size),
            "envelope_sum": round(float(np.sum(env)), 4),
        }

    def on_seed(log, args, kwargs, result):
        if result is None:
            log.setdefault("seeds", []).append(None)
            return
        period, phase = result
        log.setdefault("seeds", []).append({
            "lo": round(float(args[2]), 4), "hi": round(float(args[3]), 4),
            "period_s": round(float(period), 9), "phase_s": round(float(phase), 7),
        })

    def on_candidates(log, args, kwargs, result):
        # Only the first sweep is recorded: it is the one that decides the atom,
        # and the growth loop runs hundreds more.
        if "candidates" in log:
            return
        log["candidates"] = [
            {"period_s": round(float(p), 9), "phase_s": round(float(ph), 7),
             "coherence": round(float(c), 5)}
            for p, ph, c in result[:12]
        ]

    def on_octave(log, args, kwargs, result):
        m, first_class = result
        log["octave"] = {"atoms_per_beat": int(m), "first_class": int(first_class)}

    def on_hints(log, args, kwargs, result):
        log["tempo_hints"] = [[round(float(h), 4), round(float(w), 5)]
                              for h, w in result[:6]]

    def _sections(sections) -> list:
        return [{
            "start_s": round(float(s.start_s), 6),
            "end_s": round(float(s.end_s), 6),
            "period_s": round(float(s.period), 9),
            "phase_s": round(float(s.phase), 7),
            "bpm": round(float(s.bpm), 6),
            "inliers": int(s.inliers),
            "residual_ms": round(float(s.residual_ms), 4),
            "coverage": round(float(s.coverage), 4),
        } for s in sections]

    def on_grow(log, args, kwargs, result):
        log["atom_sections"] = _sections(result)

    def on_beat_sections(log, args, kwargs, result):
        log["beat_sections"] = _sections(result)

    def on_settle(log, args, kwargs, result):
        log["settled_sections"] = _sections(result)

    def on_meter(log, args, kwargs, result):
        if "meter" in log:
            return
        text, downbeat, bar_beats = result
        log["meter"] = {"meter": str(text), "downbeat_class": int(downbeat),
                        "bar_beats": int(bar_beats)}

    ta._detect_attacks = wrap("_detect_attacks", ta._detect_attacks, on_attacks)
    ta._seed_grid = wrap("_seed_grid", ta._seed_grid, on_seed)
    ta._atomic_grid_candidates = wrap("_atomic_grid_candidates",
                                      ta._atomic_grid_candidates, on_candidates)
    ta._beat_from_atoms = wrap("_beat_from_atoms", ta._beat_from_atoms, on_octave)
    ta._tempo_hints = wrap("_tempo_hints", ta._tempo_hints, on_hints)
    ta._grow_sections = wrap("_grow_sections", ta._grow_sections, on_grow)
    ta._beat_sections = wrap("_beat_sections", ta._beat_sections, on_beat_sections)
    ta._settle_boundaries = wrap("_settle_boundaries", ta._settle_boundaries, on_settle)
    ta._meter_from_grid = wrap("_meter_from_grid", ta._meter_from_grid, on_meter)
    try:
        yield log
    finally:
        for name, fn in originals.items():
            setattr(ta, name, fn)


#: Fixtures from the measure and signature gates, for paths the 24-case corpus
#: never reaches: not one of its 34 red lines has a proven bar, and the
#: measure-grid path (points_from_meter) returns None on all of them.
EXTRA_CASES = {
    "downbeat-4-4": lambda path: gates.build_measures(path, **gates.MEASURE_CASES["downbeat-4-4"]),
    "downbeat-4-then-3": lambda path: gates.build_measures(
        path, **gates.MEASURE_CASES["downbeat-4-then-3"]),
    "signature-changes": gates.build_signatures,
}


def capture(name: str, audio_dir: Path, engine: str) -> dict:
    path = audio_dir / f"{name}.wav"
    if not path.exists():
        if name in EXTRA_CASES:
            EXTRA_CASES[name](path)
        else:
            bm.build_track(path, seed=zlib.crc32(name.encode()), **bm.CASES[name])
    with _recording() as log:
        analysis = ta.analyze_audio(str(path), engine=engine)
    log["result"] = {
        "engine": str(analysis.engine),
        "duration_s": round(float(analysis.duration), 4),
        "global_bpm": round(float(analysis.global_bpm), 6),
        "stability": round(float(analysis.stability), 5),
        "meter_text": str(analysis.meter),
        "fit_residual_ms": round(float(analysis.fit_residual_ms), 4),
        "points": [{"offset_ms": round(float(p.offset_ms), 4),
                    "bpm": round(float(p.bpm), 6),
                    "confidence": round(float(p.confidence), 5),
                    "meter": int(p.meter),
                    "meter_known": bool(p.meter_known)}
                   for p in ta.snap_timing_points(analysis.points)],
    }
    log["case"] = name
    return log


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------

def _cmp_scalar(path: str, got, want, tol: float, out: list) -> None:
    if isinstance(want, str) or isinstance(got, str):
        if got != want:
            out.append(f"{path}: {want!r} -> {got!r}")
        return
    if want is None or got is None:
        if got != want:
            out.append(f"{path}: {want} -> {got}")
        return
    if abs(float(got) - float(want)) > tol:
        out.append(f"{path}: {want} -> {got}  (tol {tol})")


def _cmp_sections(path: str, got: list, want: list, out: list) -> None:
    if len(got) != len(want):
        out.append(f"{path}: {len(want)} sections -> {len(got)}")
        return
    for i, (g, w) in enumerate(zip(got, want)):
        _cmp_scalar(f"{path}[{i}].period_s", g["period_s"], w["period_s"], TOL["period_s"], out)
        _cmp_scalar(f"{path}[{i}].phase_s", g["phase_s"], w["phase_s"], TOL["phase_s"], out)
        _cmp_scalar(f"{path}[{i}].bpm", g["bpm"], w["bpm"], TOL["bpm"], out)
        _cmp_scalar(f"{path}[{i}].residual_ms", g["residual_ms"], w["residual_ms"],
                    TOL["residual_ms"], out)


def compare(got: dict, want: dict) -> list[str]:
    out: list[str] = []

    ga, wa = got.get("attacks", {}), want.get("attacks", {})
    if ga.get("count") != wa.get("count"):
        out.append(f"attacks.count: {wa.get('count')} -> {ga.get('count')}")
    else:
        gt = np.asarray(ga.get("times_s", []), dtype=float)
        wt = np.asarray(wa.get("times_s", []), dtype=float)
        if gt.size and gt.size == wt.size:
            worst = float(np.max(np.abs(gt - wt)))
            if worst > TOL["attack_time_s"]:
                idx = int(np.argmax(np.abs(gt - wt)))
                out.append(f"attacks.times_s: worst {worst * 1000:.4f} ms at index {idx} "
                           f"({wt[idx]:.6f} -> {gt[idx]:.6f}), tol "
                           f"{TOL['attack_time_s'] * 1000:.3f} ms")

    go, wo = got.get("octave"), want.get("octave")
    if go and wo:
        if go["atoms_per_beat"] != wo["atoms_per_beat"]:
            out.append(f"octave.atoms_per_beat: {wo['atoms_per_beat']} -> "
                       f"{go['atoms_per_beat']}   <-- OCTAVE CHANGED")
        if go["first_class"] != wo["first_class"]:
            out.append(f"octave.first_class: {wo['first_class']} -> {go['first_class']}")

    for key in ("atom_sections", "beat_sections", "settled_sections"):
        if key in want:
            _cmp_sections(key, got.get(key, []), want[key], out)

    gm, wm = got.get("meter"), want.get("meter")
    if gm and wm:
        for field in ("meter", "downbeat_class", "bar_beats"):
            _cmp_scalar(f"meter.{field}", gm[field], wm[field], 0, out)

    gr, wr = got.get("result", {}), want.get("result", {})
    _cmp_scalar("result.engine", gr.get("engine"), wr.get("engine"), 0, out)
    _cmp_scalar("result.global_bpm", gr.get("global_bpm"), wr.get("global_bpm"),
                TOL["bpm"], out)
    gp, wp = gr.get("points", []), wr.get("points", [])
    if len(gp) != len(wp):
        out.append(f"result.points: {len(wp)} red lines -> {len(gp)}")
    else:
        for i, (g, w) in enumerate(zip(gp, wp)):
            _cmp_scalar(f"result.points[{i}].offset_ms", g["offset_ms"], w["offset_ms"],
                        TOL["offset_ms"], out)
            _cmp_scalar(f"result.points[{i}].bpm", g["bpm"], w["bpm"], TOL["bpm"], out)
            # Confidence, meter and whether the bar was proven were dumped (or
            # not) but never compared: a red line could lose its bar unseen.
            _cmp_scalar(f"result.points[{i}].confidence", g["confidence"],
                        w["confidence"], TOL["confidence"], out)
            for key in ("meter", "meter_known"):
                if g.get(key) != w.get(key):
                    out.append(f"result.points[{i}].{key}: {w.get(key)} -> {g.get(key)}")
    return out


# ---------------------------------------------------------------------------

def dump(names: list[str], audio_dir: Path, engine: str) -> int:
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    for name in names:
        log = capture(name, audio_dir, engine)
        target = GOLDEN_DIR / f"{name}.json"
        target.write_text(json.dumps(log, indent=1, sort_keys=True) + "\n",
                          encoding="utf-8")
        size = target.stat().st_size
        total += size
        stages = [k for k in ("attacks", "candidates", "octave", "atom_sections",
                              "beat_sections", "settled_sections", "meter") if k in log]
        print(f"{name:<18} {log['attacks']['count']:5d} attacks  "
              f"{size / 1024:7.1f} KB  stages: {len(stages)}")
    print(f"\nWrote {len(names)} file(s) to bench/golden/, {total / 1024:.0f} KB total.")
    return 0


def check(names: list[str], audio_dir: Path, engine: str) -> int:
    missing = [n for n in names if not (GOLDEN_DIR / f"{n}.json").exists()]
    if missing:
        print(f"No golden vectors for: {', '.join(missing)}")
        print("Create them with: python bench/golden.py dump")
        return 1
    failures = 0
    print(f"{'case':<18} verdict")
    print("-" * 70)
    for name in names:
        want = json.loads((GOLDEN_DIR / f"{name}.json").read_text(encoding="utf-8"))
        got = capture(name, audio_dir, engine)
        problems = compare(got, want)
        if problems:
            failures += 1
            print(f"{name:<18} {len(problems)} difference(s)")
            for line in problems[:6]:
                print(f"                   {line}")
            if len(problems) > 6:
                print(f"                   ... and {len(problems) - 6} more")
        else:
            print(f"{name:<18} ok")
    if failures:
        print(f"\n{failures}/{len(names)} case(s) diverged from the golden vectors.")
        print("A stage name above localises the change. If it is intended, record why")
        print("in timeline.md and re-run `dump`.")
        return 1
    print(f"\n{len(names)}/{len(names)} cases match stage for stage.")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=("dump", "check"))
    parser.add_argument("--only", nargs="*", metavar="CASE")
    parser.add_argument("--engine", choices=("auto", "precision", "legacy"),
                        default="auto")
    parser.add_argument("--dir", default=str(bm.AUDIO_DIR))
    args = parser.parse_args()

    names = args.only or list(bm.CASES) + list(EXTRA_CASES)
    unknown = [n for n in names if n not in bm.CASES and n not in EXTRA_CASES]
    if unknown:
        print(f"Unknown case(s): {', '.join(unknown)}")
        raise SystemExit(2)
    audio_dir = Path(args.dir)
    audio_dir.mkdir(parents=True, exist_ok=True)
    raise SystemExit((dump if args.mode == "dump" else check)(names, audio_dir, args.engine))


if __name__ == "__main__":
    main()
