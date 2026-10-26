"""Measurements read from one person's own osu! Songs folder, kept out of the repository.

Corpus B, the health sample and the real-audio snapshot name the folders,
files, mappers and SHA-1s of a private library. They live beside the scripts as ``bench/<name>.local.json`` (and
``.local.md``), which ``.gitignore`` keeps out of every commit; the repository
ships ``bench/<name>.example.json`` instead, a few rows showing the shape.

A script that needs one of them and finds it missing says which file, what
writes it and where the shape is shown, then ends cleanly: a measurement of a
library this machine does not hold is not a failure, and it is never faked.

Before 2026-10-26 these files were committed as ``bench/<name>.json``. A
checkout that had them gets them back, as committed (LF line endings), with::

    .venv/Scripts/python.exe bench/local_data.py --restore
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

#: Each local file: what writes it, and the name it was committed under.
FILES = {
    "corpus_b.local.json": ("chosen by hand; see docs/10-precision-plan.md", "corpus_b.json"),
    "health_sample.local.json": ("bench/health_sample.py --songs <Songs folder>",
                                 "health_sample.json"),
    "health_sample.local.md": ("bench/health_sample.py --songs <Songs folder>",
                               "health_sample.md"),
    "real_audio_snapshot.local.json": ("bench/gates.py real-audio --update",
                                       "real_audio_snapshot.json"),
}

CORPUS_B = HERE / "corpus_b.local.json"
HEALTH_SAMPLE = HERE / "health_sample.local.json"
HEALTH_SHEET = HERE / "health_sample.local.md"
REAL_SNAPSHOT = HERE / "real_audio_snapshot.local.json"


def missing(path: Path) -> str:
    """One paragraph naming the missing file, what writes it and its shape."""
    writer, _ = FILES.get(path.name, ("", ""))
    example = path.with_name(path.name.replace(".local.", ".example."))
    lines = [f"No {path.relative_to(ROOT).as_posix()}: it holds measurements of a "
             f"private osu! library and is never committed."]
    if writer:
        lines.append(f"  written by: {writer}")
    if example.is_file():
        lines.append(f"  its shape:  {example.relative_to(ROOT).as_posix()}")
    lines.append("  a checkout that had it committed: python bench/local_data.py --restore")
    return "\n".join(lines)


def restore() -> int:
    """Copy each file back out of the last commit that held it, never overwriting."""
    code = 0
    for local, (_, committed) in FILES.items():
        target = HERE / local
        if target.exists():
            print(f"{local}: already here, left alone")
            continue
        old = f"bench/{committed}"
        removed = subprocess.run(["git", "log", "-n", "1", "--format=%H", "--diff-filter=D",
                                  "--", old], cwd=ROOT, capture_output=True, text=True)
        sha = removed.stdout.strip()
        if removed.returncode or not sha:
            print(f"{local}: no commit removed {old} here, nothing to restore")
            continue
        blob = subprocess.run(["git", "show", f"{sha}~1:{old}", "--"], cwd=ROOT, capture_output=True)
        if blob.returncode:
            print(f"{local}: could not read {old} at {sha[:9]}~1")
            code = 1
            continue
        target.write_bytes(blob.stdout)
        print(f"{local}: restored from {sha[:9]}~1:{old}")
    return code


if __name__ == "__main__":
    if sys.argv[1:] == ["--restore"]:
        sys.exit(restore())
    print(__doc__)
    for name in FILES:
        print(f"  {name:<32} {'here' if (HERE / name).exists() else 'missing'}")
