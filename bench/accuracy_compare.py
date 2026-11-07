"""Compare paired accuracy reports with confidence intervals by audio.

Both reports must score exactly the same locked maps, audio and split. Refusals
remain misses. This is evidence for an ablation, not an automatic release gate.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def dense(row: dict) -> bool:
    return row["map_lines"] >= 20 or bool(row.get("duration_s") and
                                        row["map_lines"] * 60 / row["duration_s"] >= 1)


def within_5ms(row: dict) -> tuple[int, int]:
    lines = row["rows"]
    if not lines or len(lines) != row["map_lines"]:
        raise ValueError("every reference red line must remain in the denominator")
    hits = (sum(r["error_ms"] is not None and abs(r["error_ms"]) <= 5 for r in lines)
            if row["path"] not in ("refused", "error") else 0)
    return hits, len(lines)


def compare_reports(baseline: dict, candidate: dict, split: str = "holdout") -> dict:
    if not baseline.get("ranked") or not candidate.get("ranked"):
        raise ValueError("both reports must be ranked-only")
    if baseline["stage"]["id"] != candidate["stage"]["id"]:
        raise ValueError("reports must use the same stage")
    if (not baseline.get("split_rule") or baseline["split_rule"] != candidate.get("split_rule")
            or baseline.get("holdout_share") != candidate.get("holdout_share")):
        raise ValueError("reports must use the same content-based split rule")
    if (baseline.get("cohort") or {}).get("sha1") != (candidate.get("cohort") or {}).get("sha1"):
        raise ValueError("reports must score the same locked cohort (or both none)")

    def index(report):
        selected = [r for r in report["maps"] if r["split"] == split]
        indexed = {(r["folder"], r["file"]): r for r in selected}
        if not selected or len(indexed) != len(selected):
            raise ValueError("split must contain unique map rows")
        return indexed

    before, after = index(baseline), index(candidate)
    if before.keys() != after.keys():
        raise ValueError("reports do not cover the same maps; missing results cannot be dropped")
    for key, row in before.items():
        other = after[key]
        for field in ("audio_sha1", "osu_sha1"):
            if not row.get(field) or row[field] != other.get(field):
                raise ValueError(f"missing or changed {field}: {key}")
        if row["map_lines"] != other["map_lines"] or dense(row) != dense(other):
            raise ValueError(f"reference cohort changed: {key}")
        within_5ms(row)
        within_5ms(other)

    result = {"split": split, "stage": baseline["stage"]["id"], "groups": {}}
    for label, select in (("all", lambda r: True), ("dense", dense),
                          ("single_line", lambda r: r["map_lines"] == 1),
                          ("multiline", lambda r: r["map_lines"] > 1)):
        clusters = {}
        for key, row in before.items():
            if not select(row):
                continue
            b_hits, total = within_5ms(row)
            c_hits, _ = within_5ms(after[key])
            values = clusters.setdefault(row["audio_sha1"], [0, 0, 0])
            values[0] += b_hits
            values[1] += c_hits
            values[2] += total
        if not clusters:
            result["groups"][label] = None
            continue
        values = np.asarray([clusters[k] for k in sorted(clusters)], dtype=float)
        b_scores, c_scores = values[:, 0] / values[:, 2], values[:, 1] / values[:, 2]
        delta = c_scores - b_scores
        ci = None
        if len(delta) >= 2:
            rng = np.random.default_rng(2713)
            draws = np.mean(rng.choice(delta, size=(10000, len(delta)), replace=True), axis=1)
            ci = np.quantile(draws, [.025, .975]).tolist()
        result["groups"][label] = {
            "audios": len(values), "reference_lines": int(values[:, 2].sum()),
            "baseline_macro": float(b_scores.mean()), "candidate_macro": float(c_scores.mean()),
            "delta_macro": float(delta.mean()), "delta_ci95": ci,
            "positive_interval": ci is not None and ci[0] > 0,
        }
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--split", choices=("dev", "holdout", "confirmation"), default="holdout")
    parser.add_argument("--json", type=Path)
    args = parser.parse_args(argv)
    result = compare_reports(json.loads(args.baseline.read_text(encoding="utf-8")),
                             json.loads(args.candidate.read_text(encoding="utf-8")), args.split)
    text = json.dumps(result, indent=1)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
