"""Freeze and verify a local ranked-map accuracy cohort.

The manifest is private (absolute paths and hashes) and must stay gitignored.
It locks audio/map identity and the content-derived song split; it contains no
audio. A frozen cohort is still not ground truth until its map/audio pairing
has been reviewed.

The third split is a separate cohort: ``--confirmation`` freezes a later report
(new maps, curated after dev and held out were tuned) with every row in the
``confirmation`` split, and refuses any audio, map or set folder that the
``--exclude`` cohorts already hold. ``verify`` re-checks that disjointness.

    .venv/Scripts/python.exe bench/accuracy_manifest.py freeze bench/.cache/stages/anime-variable-python-ranked.json bench/accuracy.local.json --songs-root "C:\\osu!\\Songs"
    .venv/Scripts/python.exe bench/accuracy_manifest.py verify bench/accuracy.local.json
    .venv/Scripts/python.exe bench/accuracy_manifest.py freeze <later ranked report> bench/accuracy-confirm.local.json --songs-root <Songs> --confirmation --exclude bench/accuracy.local.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FORMATS = (1, 2)
CONFIRMATION = "confirmation"


def expected_split(audio_sha1: str, share: float) -> str:
    """Validate the cohort rule before assigning a content identity."""
    if not isinstance(share, (int, float)) or not math.isfinite(share) or not 0 < share < 1:
        raise ValueError("holdout_share must be between zero and one")
    if not isinstance(audio_sha1, str) or len(audio_sha1) != 40:
        raise ValueError("audio_sha1 must be a 40-character SHA-1")
    digest = bytes.fromhex(audio_sha1)
    if len(digest) != 20:
        raise ValueError("audio_sha1 must be a 40-character SHA-1")
    return "holdout" if int.from_bytes(digest[:4], "big") / 2 ** 32 < share else "dev"


def sha1_file(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def identities(entries: list[dict]) -> dict[str, set[str]]:
    """What makes two cohorts overlap: a recording, a map file or a set."""
    return {"audio": {e["audio_sha1"] for e in entries},
            "map": {e["osu_sha1"] for e in entries},
            "set": {e["folder"].casefold() for e in entries}}


def overlaps(entries: list[dict], other: list[dict]) -> dict[str, int]:
    mine, theirs = identities(entries), identities(other)
    return {kind: len(mine[kind] & theirs[kind]) for kind in mine if mine[kind] & theirs[kind]}


def straddling(entries: list[dict]) -> list[str]:
    """Recordings or sets found in more than one split."""
    seen: dict[tuple[str, str], set[str]] = {}
    for e in entries:
        for key in (("audio", e["audio_sha1"]), ("set", e["folder"].casefold())):
            seen.setdefault(key, set()).add(e["split"])
    return sorted(f"{kind} {value[:40]}" for (kind, value), splits in seen.items()
                  if len(splits) > 1)


def freeze(report_path: Path, output: Path, songs_root: Path, confirmation: bool = False,
           exclude: list[Path] | None = None) -> int:
    if output.exists():
        raise FileExistsError(f"refusing to replace locked manifest: {output}")
    if confirmation and not exclude:
        raise ValueError("a confirmation cohort must name the cohorts it is disjoint from (--exclude)")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if not report.get("ranked"):
        raise ValueError("source report must be restricted with --ranked-db")
    maps = report.get("maps", [])
    if not maps:
        raise ValueError("source report has no scored maps")
    excluded = [(path, json.loads(path.read_text(encoding="utf-8"))) for path in exclude or []]
    entries = []
    for row in maps:
        folder = songs_root / row["folder_name"]
        audio, osu = folder / row["audio_filename"], folder / row["file"]
        if not audio.is_file() or not osu.is_file():
            raise ValueError(f"missing audio or map: {row['file']}")
        audio_hash, osu_hash = sha1_file(audio), sha1_file(osu)
        for field, actual in (("audio_sha1", audio_hash), ("osu_sha1", osu_hash)):
            if row.get(field) != actual:
                raise ValueError(f"missing or stale {field} in report: {row['file']}; rerun the stage")
        split_key = row.get("split_key", audio_hash)
        if row["split"] != expected_split(split_key, report["holdout_share"]):
            raise ValueError(f"split does not match audio hash: {row['file']}")
        entries.append({
            "audio_sha1": audio_hash,
            "osu_sha1": osu_hash,
            "audio_path": str(audio.resolve()),
            "osu_path": str(osu.resolve()),
            "folder": row["folder"],
            "folder_path": row.get("folder_path") or str(folder),
            "file": row["file"],
            "split": CONFIRMATION if confirmation else row["split"],
            "split_key": split_key,
            "map_lines": row["map_lines"],
            "duration_s": row.get("duration_s"),
        })
    problems = straddling(entries)
    if problems:
        raise ValueError(f"split straddles a recording or set: {problems[0]}; rerun the stage")
    for path, other in excluded:
        shared = overlaps(entries, other.get("entries", []))
        if shared:
            raise ValueError(f"not disjoint from {path.name}: shares {shared}")
    payload = {
        "format": 2,
        "cohort": CONFIRMATION if confirmation else "dev-holdout",
        "source_report": str(report_path.resolve()),
        "source_engine_fingerprint": report.get("fingerprint"),
        "stage": report.get("stage", {}).get("id"),
        "ranked": report.get("ranked"),
        "split_rule": ("every row confirmation: locked after the excluded cohorts were tuned"
                       if confirmation else report.get("split_rule")),
        "holdout_share": report["holdout_share"],
        "dense_rule": "map_lines >= 20 OR map_lines / audio_minutes >= 1",
        "excluded": [{"path": str(path.resolve()), "sha1": sha1_file(path)}
                     for path, _ in excluded],
        "entries": entries,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(payload, indent=1))
    print(f"frozen {len(entries)} ranked map rows to {output}; keep this file local")
    return 0


def verify(manifest_path: Path) -> int:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format") not in FORMATS or not manifest.get("entries"):
        print("invalid manifest: format 1 or 2 and nonempty entries required")
        return 1
    confirmation = manifest.get("cohort") == CONFIRMATION
    errors = []
    for row in manifest.get("entries", []):
        audio, osu = Path(row["audio_path"]), Path(row["osu_path"])
        for path, field in ((audio, "audio_sha1"), (osu, "osu_sha1")):
            if not path.is_file():
                errors.append(f"missing {path}")
                continue
            actual = sha1_file(path)
            if actual != row[field]:
                errors.append(f"changed {path}")
        if confirmation:
            if row["split"] != CONFIRMATION:
                errors.append(f"confirmation cohort row in split {row['split']}: {row['audio_sha1']}")
            continue
        try:
            expected = expected_split(row.get("split_key", row["audio_sha1"]),
                                      manifest["holdout_share"])
        except (KeyError, ValueError) as exc:
            errors.append(f"invalid split rule: {exc}")
            continue
        if row["split"] != expected:
            errors.append(f"split does not match audio hash: {row['audio_sha1']}")
    errors += [f"assigned to multiple splits: {item}"
               for item in straddling(manifest.get("entries", []))]
    if confirmation and not manifest.get("excluded"):
        errors.append("confirmation cohort names no excluded cohort")
    for other in manifest.get("excluded", []):
        path = Path(other["path"])
        if not path.is_file():
            errors.append(f"excluded cohort missing, disjointness unchecked: {path}")
            continue
        if sha1_file(path) != other["sha1"]:
            errors.append(f"excluded cohort changed since this one was frozen: {path}")
            continue
        shared = overlaps(manifest["entries"],
                          json.loads(path.read_text(encoding="utf-8")).get("entries", []))
        if shared:
            errors.append(f"not disjoint from {path.name}: shares {shared}")
    if errors:
        print("\n".join(errors))
        return 1
    print(f"verified {len(manifest['entries'])} map rows; hashes and song/set splits match"
          + (f", disjoint from {len(manifest['excluded'])} cohort(s)" if manifest.get("excluded") else ""))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p_freeze = sub.add_parser("freeze")
    p_freeze.add_argument("report", type=Path)
    p_freeze.add_argument("output", type=Path)
    p_freeze.add_argument("--songs-root", type=Path, required=True)
    p_freeze.add_argument("--confirmation", action="store_true",
                          help="every row in the confirmation split (needs --exclude)")
    p_freeze.add_argument("--exclude", type=Path, action="append", default=[],
                          help="a cohort this one must share no audio, map or set with")
    p_verify = sub.add_parser("verify")
    p_verify.add_argument("manifest", type=Path)
    args = parser.parse_args(argv)
    return (freeze(args.report, args.output, args.songs_root, args.confirmation, args.exclude)
            if args.command == "freeze" else verify(args.manifest))


if __name__ == "__main__":
    sys.exit(main())
