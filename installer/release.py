"""What every installer step shares: the repository, the version, the tree.

The PyInstaller spec, the build script and the smoke test all read this, so
the files the frozen app needs are listed once and the version comes from
one place: the Rust workspace's ``Cargo.toml``, which the timeline's release
names follow.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
BUILD = ROOT / "build"
#: The frozen application, unpacked: what the installers carry.
TREE = DIST / "Overtone"
#: PyInstaller's folder beside the executables. The app's own files sit in it
#: at their repository paths, which is where the code looks for them: beside
#: ``__file__``, which a frozen module reports inside this folder.
CONTENTS = "_internal"
APP_EXE = "Overtone.exe"
#: The Python engine's command line (``overtone.py``). Not ``overtone-cli``:
#: that is the Rust engine's name, and it ships too.
CLI_EXE = "overtone-py.exe"
#: The Rust engine, found by ``overtone_rust`` beside its own code, so inside
#: the contents folder, where the C runtime it links against also lies.
RUST_CLI = "overtone-cli.exe"

#: Read at run time from beside the code, and bundled at the same relative
#: path: the window's page, its icon, Overtone's own hitsound samples, the
#: hitsound profiles and the library index's schema. The asset generators
#: (``assets/*.py``) are build tools and stay out.
DATA = ("app", "assets/logo.ico", "assets/logo.png", "assets/samples", "profiles",
        "python/library.sql")
#: Never bundled from inside a data folder: a frontend toolchain's leftovers.
SKIP_DIRS = {"node_modules", "dist", "__pycache__"}


def version() -> str:
    """The workspace version, e.g. ``4.0.0-dev``."""
    text = (ROOT / "Cargo.toml").read_text(encoding="utf-8")
    block = re.search(r"^\[workspace\.package\]\s*$(.*?)(?=^\[|\Z)", text, re.M | re.S)
    found = re.search(r'^version\s*=\s*"([^"]+)"', block.group(1) if block else "", re.M)
    if found is None:
        raise ValueError("Cargo.toml states no [workspace.package] version")
    return found.group(1)


def numeric_version(text: str) -> tuple[int, int, int]:
    """``4.0.0-dev`` as the three numbers an MSI and a version resource take."""
    found = re.match(r"(\d+)\.(\d+)\.(\d+)", text)
    if found is None:
        raise ValueError(f"not a version: {text!r}")
    major, minor, patch = (int(part) for part in found.groups())
    if major > 255 or minor > 255 or patch > 65535:
        raise ValueError(f"an MSI version holds 255.255.65535 at most, not {text!r}")
    return major, minor, patch


def data_files() -> list[tuple[str, str]]:
    """PyInstaller ``datas``: (file, its folder inside the contents folder)."""
    pairs = []
    for name in DATA:
        source = ROOT / name
        if not source.exists():
            raise FileNotFoundError(f"the installer bundles {name}, which is missing")
        files = [source] if source.is_file() else sorted(
            path for path in source.rglob("*")
            if path.is_file() and not SKIP_DIRS & set(path.relative_to(ROOT).parts))
        for path in files:
            pairs.append((str(path), path.parent.relative_to(ROOT).as_posix() or "."))
    return pairs
