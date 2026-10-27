"""Where Overtone keeps what it writes, and which release this checkout is.

Everything the engine, the library index and the measurement server write
lives in ``%LOCALAPPDATA%\\Overtone`` (the home folder where that is not
set). The portable and installed builds that once kept their own folders were
removed with the installer on 2026-10-26 (branch ``parked/desktop-app``).

Deliberately imports nothing but the standard library: the library index reads
this module and must not pay for librosa to find its own file.
"""
from __future__ import annotations

import os
import re
from pathlib import Path


def data_root() -> Path:
    """Overtone's own folder: ``%LOCALAPPDATA%\\Overtone``."""
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Overtone"


def app_version() -> str:
    """The product's version, as every written file's header states it: the
    release's, not the engine generation's. Read from the Rust workspace's
    ``[workspace.package] version``, so the two cannot name different releases.
    """
    cargo = Path(__file__).resolve().parent.parent / "Cargo.toml"
    try:
        text = cargo.read_text(encoding="utf-8")
    except OSError:
        return "unknown"
    block = re.search(r"^\[workspace\.package\]\s*$(.*?)(?=^\[|\Z)", text, re.M | re.S)
    found = re.search(r'^version\s*=\s*"([^"]+)"', block.group(1) if block else "", re.M)
    return found.group(1) if found else "unknown"
