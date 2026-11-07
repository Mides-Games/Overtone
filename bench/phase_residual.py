"""Measure beat-grid phase drift inside each ranked-map timing section.

This separates a constant map/audio lead from a local tempo mismatch. It is a
diagnostic only: it never changes the engine result or fits a correction.

    .venv/Scripts/python.exe bench/phase_residual.py bench/.cache/stages/bands-variable-python-ranked.json --split dev
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.stats import theilslopes

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "python"), str(ROOT / "bench")]
import corpus_b as cb  # noqa: E402


MIN_BEATS = 8
MAX_FIT_BEATS = 512


def signed_nearest(src_ms: np.ndarray, dst_ms: np.ndarray) -> np.ndarray:
    """Nearest destination beat minus each source beat, with stable ties-left."""
    if dst_ms.size == 0:
        return np.full(src_ms.shape, np.nan)
    index = np.searchsorted(dst_ms, src_ms)
    left_i = np.clip(index - 1, 0, dst_ms.size - 1)
    right_i = np.clip(index, 0, dst_ms.size - 1)
    left, right = dst_ms[left_i], dst_ms[right_i]
    return np.where(np.abs(left - src_ms) <= np.abs(right - src_ms), left, right) - src_ms


def phase_metrics(times_s: np.ndarray, errors_ms: np.ndarray) -> dict | None:
    keep = np.isfinite(times_s) & np.isfinite(errors_ms)
    times_s, errors_ms = times_s[keep], errors_ms[keep]
    if len(times_s) < MIN_BEATS:
        return None
    if np.ptp(times_s) <= 0:
        return None
    # Theil-Sen forms every pair: bound its memory on long sections while
    # evaluating residuals on every beat. Keep endpoints deterministically.
    sample = np.linspace(0, len(times_s) - 1, min(len(times_s), MAX_FIT_BEATS), dtype=int)
    slope, intercept, _low, _high = theilslopes(errors_ms[sample], times_s[sample])
    residual = errors_ms - (slope * times_s + intercept)
    return {
        "beats": int(len(times_s)),
        "fit_beats": int(len(sample)),
        "drift_ms_per_min": float(slope * 60.0),
        "phase_offset_ms": float(intercept),
        "median_abs_phase_residual_ms": float(np.median(np.abs(residual))),
        "p95_abs_phase_residual_ms": float(np.quantile(np.abs(residual), 0.95)),
        "raw_median_abs_grid_error_ms": float(np.median(np.abs(errors_ms))),
    }


def section_metrics(rows: list[dict], detected: list[tuple[float, float]],
                    duration_s: float) -> list[dict]:
    reds = [(float(r["offset_ms"]), float(r["bpm"])) for r in rows]
    if not reds or not detected or duration_s <= 0:
        return []
    map_beats = np.asarray(cb.grid_beats(reds, duration_s), dtype=float) * 1000.0
    engine_beats = np.asarray(cb.grid_beats(detected, duration_s), dtype=float) * 1000.0
    output = []
    for n, (start, bpm) in enumerate(reds):
        stop = reds[n + 1][0] if n + 1 < len(reds) else duration_s * 1000.0
        chosen = map_beats[(map_beats >= start - 1e-6) & (map_beats < stop - 1e-6)]
        if len(chosen) < MIN_BEATS:
            continue
        errors = signed_nearest(chosen, engine_beats)
        result = phase_metrics((chosen - start) / 1000.0, errors)
        if result is not None:
            result.update(start_ms=start, end_ms=stop, map_bpm=bpm)
            output.append(result)
    return output


def plot_sections(report: dict, sections: list[dict], output: Path) -> None:
    """Plot the worst dev sections without changing or unwrapping their phase."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    worst = sorted(sections, key=lambda s: abs(s["drift_ms_per_min"]), reverse=True)[:6]
    if not worst:
        raise ValueError("no sections to plot")
    fig, axes = plt.subplots(len(worst), 1, figsize=(11, 3 * len(worst)), squeeze=False)
    for ax, section in zip(axes[:, 0], worst):
        row = next(r for r in report["maps"] if r.get("folder") == section["folder"]
                   and r.get("file") == section["file"])
        reds = [(r["offset_ms"], r["bpm"]) for r in row["rows"]]
        beats = np.asarray(cb.grid_beats(reds, row["duration_s"])) * 1000
        chosen = beats[(beats >= section["start_ms"] - 1e-6) &
                       (beats < section["end_ms"] - 1e-6)]
        detected = np.asarray(cb.grid_beats(row["lines"], row["duration_s"])) * 1000
        elapsed = (chosen - section["start_ms"]) / 1000
        ax.plot(elapsed, signed_nearest(chosen, detected), ".", ms=2, label="Nearest-beat phase")
        ax.plot(elapsed, section["phase_offset_ms"] + elapsed * section["drift_ms_per_min"] / 60,
                label="Robust linear fit")
        ax.set(title=f"{section['file'][:80]} @ {section['start_ms'] / 1000:.1f} s",
               xlabel="Seconds from section start", ylabel="Phase error (ms)")
        ax.grid(alpha=.25)
        ax.legend()
    fig.tight_layout()
    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=140)
    plt.close(fig)


def analyze(report: dict, split: str | None = None, dense_only: bool = False) -> list[dict]:
    output = []
    for row in report.get("maps", []):
        if split and row.get("split") != split:
            continue
        if dense_only and not (row.get("map_lines", 0) >= 20 or
                               (row.get("duration_s") and
                                row["map_lines"] / (row["duration_s"] / 60.0) >= 1.0)):
            continue
        if row.get("path") in ("refused", "error") or not row.get("lines"):
            continue
        result = section_metrics(row.get("rows", []),
                                 [(float(o), float(b)) for o, b in row["lines"]],
                                 float(row.get("duration_s") or 0))
        for section in result:
            section.update(folder=row.get("folder"), file=row.get("file"),
                           split=row.get("split"), audio_sha1=row.get("audio_sha1"))
            output.append(section)
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("report", type=Path)
    parser.add_argument("--split", choices=("dev", "holdout"))
    parser.add_argument("--dense-only", action="store_true")
    parser.add_argument("--json", type=Path, help="write private section-level results")
    parser.add_argument("--plot", type=Path, help="private phase plot (requires matplotlib)")
    args = parser.parse_args(argv)
    report = json.loads(args.report.read_text(encoding="utf-8"))
    sections = analyze(report, args.split, args.dense_only)
    if args.plot:
        if args.split != "dev":
            parser.error("--plot requires --split dev; keep held-out diagnostics untouched")
        plot_sections(report, sections, args.plot)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(sections, indent=1), encoding="utf-8")
    print(f"{len(sections)} timing sections with at least {MIN_BEATS} beats")
    ranked = sorted(sections, key=lambda s: abs(s["drift_ms_per_min"]), reverse=True)
    for row in ranked[:25]:
        print(f"{row['folder']} / {row['file']} @ {row['start_ms']:.0f} ms "
              f"{row['map_bpm']:.3f} BPM: drift {row['drift_ms_per_min']:+.2f} ms/min, "
              f"phase {row['phase_offset_ms']:+.2f} ms, detrended median "
              f"{row['median_abs_phase_residual_ms']:.2f} ms, "
              f"raw median {row['raw_median_abs_grid_error_ms']:.2f} ms "
              f"({row['beats']} beats)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
