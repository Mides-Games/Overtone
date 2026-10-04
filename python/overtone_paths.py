"""Where Overtone keeps what it writes: the one place that knows a portable build.

A build is portable when a file named ``portable.txt`` sits beside its frozen
executable. Only the portable ZIP carries it (installer/build.py), and then
settings, the result cache, the write history, the library index, dropped
files and the window's browser storage all live in a ``data`` folder beside the
executable, so a copy on a USB stick keeps its own state and two copies never
share a profile. The installed copy, and every checkout, keeps them where they
have always been: the user's profile.

Deliberately imports nothing but the standard library: the library index reads
this module and must not pay for librosa to find its own file.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

#: The file whose presence beside the executable makes the build portable.
PORTABLE_MARKER = "portable.txt"
#: The folder a portable build writes into, beside its executable.
PORTABLE_DATA = "data"


def portable_root() -> Path | None:
    """``<executable folder>\\data`` for a portable build, else ``None``."""
    if not getattr(sys, "frozen", False):
        return None
    folder = Path(sys.executable).resolve().parent
    return folder / PORTABLE_DATA if (folder / PORTABLE_MARKER).is_file() else None


def data_root() -> Path:
    """Overtone's own folder: the portable ``data`` folder, else ``%LOCALAPPDATA%\\Overtone``."""
    portable = portable_root()
    if portable is not None:
        return portable
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Overtone"


def settings_home() -> Path:
    """Where the settings file and the legacy one are looked for.

    The user's profile for an installed copy, as it always was (an existing
    install keeps its preferences). The portable ``data`` folder for a portable
    one, so the profile of the machine it runs on is never read or written.
    """
    return portable_root() or Path.home()


#: What installer/build.py writes beside the frozen code: the release's version,
#: the commit it was built from and when. A checkout has no such file.
BUILD_INFO = "build_info.json"


def _frozen_code_folder() -> Path | None:
    """PyInstaller's ``_internal`` folder, where the frozen code and its data sit."""
    if not getattr(sys, "frozen", False):
        return None
    return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent / "_internal"))


def build_info() -> dict:
    """What this copy says it is: the version, commit and build time from the
    build that made it, or ``{}`` for a checkout (see :func:`app_version`)."""
    folder = _frozen_code_folder()
    if folder is None:
        return {}
    try:
        import json
        return json.loads((folder / BUILD_INFO).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def app_version() -> str:
    """The product's version, as the window, the about box and every written
    ``.osu`` header state it: the release's, not the engine generation's.

    A frozen copy reads it from its build; a checkout reads the Rust workspace's
    ``[workspace.package] version``, the same line installer/release.py reads, so
    the two cannot name different releases.
    """
    stamped = build_info().get("version")
    if stamped:
        return str(stamped)
    import re
    cargo = Path(__file__).resolve().parent.parent / "Cargo.toml"
    try:
        text = cargo.read_text(encoding="utf-8")
    except OSError:
        return "unknown"
    block = re.search(r"^\[workspace\.package\]\s*$(.*?)(?=^\[|\Z)", text, re.M | re.S)
    found = re.search(r'^version\s*=\s*"([^"]+)"', block.group(1) if block else "", re.M)
    return found.group(1) if found else "unknown"
