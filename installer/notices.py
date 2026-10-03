"""Gather every bundled licence notice into the release tree (roadmap 10.13.3).

Nothing may be published without this. The MSI and the ZIP carry Python, the
pinned wheels, every Rust crate the engine links and a handful of native
libraries, and most of their licences -- MIT and the BSDs among them -- ask
that their notice travel with the binary. A few ask for more: libsndfile and
libsoxr are LGPL-2.1, Symphonia and certifi are MPL-2.0, and PyInstaller's
bootloader is GPLv2 with the exception that makes a frozen app distributable.

    .venv\\Scripts\\python.exe installer\\notices.py            # write into the tree
    .venv\\Scripts\\python.exe installer\\notices.py --check    # the gate
    .venv\\Scripts\\python.exe installer\\notices.py --print    # to stdout

The texts are not written by hand: a wheel's come from its ``.dist-info`` (or
from the package itself -- soundfile keeps libsndfile's ``COPYING`` beside the
DLL), a crate's from the cargo registry's source cache, and Python's and
Tcl/Tk's from the interpreter this venv was made from. So the notice is this
build's own files, not a description of them.

``installer/notices.json`` holds only what no package carries: the natives,
the wheels and crates that ship no text, and the written offer each copyleft
licence asks for. ``--check`` fails when a shipped component has neither a
text nor an entry, when an entry names something that is no longer there, and
when a copyleft licence turns up with no offer recorded against it -- which is
the line between adding a dependency and changing what the release promises.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import subprocess
import sys
from fnmatch import fnmatch
from importlib import metadata
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import release  # noqa: E402
import sbom  # noqa: E402

NOTICES = HERE / "notices.json"
#: Written into the tree's root, beside the two executables, so a user who
#: unpacks the ZIP or opens the program folder finds them without looking.
LICENCE_FILE = "LICENSE.txt"
NOTICES_FILE = "THIRD-PARTY-NOTICES.txt"
#: A file named like one of these is a notice, and is gathered whole.
NOTICE_NAME = re.compile(r"licen[cs]e|copying|notice|authors", re.I)
#: Code, not notices, however the file is named.
NOT_TEXT = {".py", ".pyc", ".pyd", ".dll", ".so", ".exe", ".lib", ".pyi"}
#: Licences that ask for more than attribution. A shipped component whose
#: licence matches must carry an offer in notices.json or the gate fails.
COPYLEFT = re.compile(r"\b(lgpl|agpl|gpl|mpl|mozilla|cddl|epl|osl|cc.by)", re.I)


def _text_of(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None


# ---------------------------------------------------------------- the wheels
def wheel_texts(dist) -> list[tuple[str, str]]:
    """Every notice file a wheel installed, by its path inside the wheel."""
    found = []
    for entry in dist.files or ():
        name = PurePosixPath(str(entry).replace("\\", "/"))
        if name.suffix.lower() in NOT_TEXT or not NOTICE_NAME.search(name.name):
            continue
        text = _text_of(Path(dist.locate_file(entry)))
        if text:
            found.append((str(name), text))
    return sorted(found)


def wheels() -> list[dict]:
    """The pins of ``python/requirements.lock``: what the tree's Python holds."""
    dists = {sbom._canonical(d.metadata["Name"]): d for d in metadata.distributions()}
    found = []
    for name, version in sbom.pins(sbom.LOCKS[0][0]):
        dist = dists.get(name)
        found.append({
            "kind": "wheel",
            "name": name,
            "version": version,
            "licence": sbom.licence_of(dist) if dist is not None else "UNKNOWN",
            "what": "a Python wheel, frozen into _internal",
            "source": f"https://pypi.org/project/{name}/{version}/",
            "texts": wheel_texts(dist) if dist is not None else [],
        })
    return found


# ---------------------------------------------------------------- the crates
def cargo_sources() -> list[Path]:
    """Where cargo unpacked the crates it built: one folder per registry."""
    home = Path(os.environ.get("CARGO_HOME") or (Path.home() / ".cargo"))
    src = home / "registry" / "src"
    return sorted(p for p in src.iterdir() if p.is_dir()) if src.is_dir() else []


def crate_texts(name: str, version: str, roots: list[Path]) -> list[tuple[str, str]]:
    """A crate's own notice files, from the source cargo compiled."""
    for root in roots:
        folder = root / f"{name}-{version}"
        if not folder.is_dir():
            continue
        found = []
        for path in sorted(folder.iterdir()):
            if (path.is_file() and path.suffix.lower() not in NOT_TEXT
                    and NOTICE_NAME.search(path.name)):
                text = _text_of(path)
                if text:
                    found.append((f"{folder.name}/{path.name}", text))
        return found
    return []


def crates() -> tuple[list[dict], str | None]:
    """Every crate the workspace links, from ``cargo metadata --locked``.

    Offline and from the lock, so the list is the one that built the engine
    in the tree. Without cargo there is no list, and that is the gate's
    answer rather than an empty one.
    """
    run = subprocess.run(["cargo", "metadata", "--format-version", "1", "--locked",
                          "--offline"], cwd=release.ROOT, capture_output=True, text=True)
    if run.returncode != 0:
        detail = (run.stderr or run.stdout).strip().splitlines()
        return [], f"cargo metadata failed: {detail[-1] if detail else run.returncode}"
    data = json.loads(run.stdout)
    members = set(data["workspace_members"])
    roots = cargo_sources()
    found = []
    for package in data["packages"]:
        if package["id"] in members:
            continue
        name, version = package["name"], package["version"]
        found.append({
            "kind": "crate",
            "name": name,
            "version": version,
            "licence": package.get("license") or "UNKNOWN",
            "what": "a Rust crate, linked into overtone-cli.exe",
            "source": f"https://crates.io/crates/{name}/{version}",
            "texts": crate_texts(name, version, roots),
        })
    return sorted(found, key=lambda row: (row["name"], row["version"])), None


# -------------------------------------------------- what no package carries
def listed() -> dict:
    """``installer/notices.json``: the natives, the gaps and the offers."""
    return json.loads(NOTICES.read_text(encoding="utf-8"))


def versions_now() -> dict[str, str]:
    """The versions notices.json states and this machine can confirm."""
    found = {"Python": platform.python_version()}
    try:
        import tkinter
    except Exception:  # pragma: no cover - a Python built without Tk
        pass
    else:
        found["Tcl/Tk"] = str(tkinter.TclVersion)
    return found


def natives(root: Path | None = None) -> list[dict]:
    """The hand-listed components, with their texts read off this machine."""
    base = Path(root if root is not None else sys.base_prefix)
    found = []
    for row in listed()["components"]:
        texts: list[tuple[str, str]] = []
        for name in row.get("from_path", []):
            text = _text_of(base / name)
            if text:
                texts.append((f"{base.name}/{name}", text))
        for name in row.get("from_wheel", []):
            try:
                texts += wheel_texts(metadata.distribution(name))
            except metadata.PackageNotFoundError:
                pass
        found.append({**row, "kind": "native", "texts": texts})
    return found


def components() -> tuple[list[dict], list[str]]:
    """Everything the tree carries that Overtone did not write, in one list."""
    crate_rows, why = crates()
    rows = natives() + wheels() + crate_rows
    terms = listed().get("terms", {})
    for row in rows:
        if not row.get("terms") and row["name"] in terms:
            row["terms"] = terms[row["name"]]
    return rows, ([why] if why else [])


def offer_for(name: str, offers: list[dict]) -> dict | None:
    """The written offer covering one component, if one is recorded.

    One offer covers a family: Symphonia is fifteen crates under the same
    MPL-2.0 and the same source, and saying so fifteen times would hide the
    one thing a reader needs, which is where the source is.
    """
    return next((offer for offer in offers
                 if any(fnmatch(name, pattern) for pattern in offer["for"])), None)


# -------------------------------------------------------------- the document
def _table(rows: list[dict]) -> list[str]:
    width = max((len(f"{row['name']} {row['version']}") for row in rows), default=0)
    return [f"  {row['name']} {row['version']}".ljust(width + 4) + f"  {row['licence']}"
            for row in rows]


def render(rows: list[dict], version: str, offers: list[dict]) -> str:
    kinds = {kind: [row for row in rows if row["kind"] == kind]
             for kind in ("native", "wheel", "crate")}
    missing = [row for row in rows if not row["texts"]]
    lines = [
        f"Overtone {version} -- third-party notices",
        "",
        "Overtone itself is MIT; its licence is in LICENSE.txt, beside this file. What",
        "follows is every piece of code this installer carries that Overtone did not",
        f"write: {len(kinds['native'])} runtime and native components, "
        f"{len(kinds['wheel'])} Python wheels and {len(kinds['crate'])} Rust crates.",
        "",
        "Each notice below is the file the component itself ships, read out of this",
        "build's own wheels, out of the cargo source cache the engine was compiled",
        "from, and out of the Python installation it was frozen from. None of it is",
        "retyped. Generated by installer\\notices.py, gated by notices.py --check.",
        "",
        "",
        "1. WHAT IS IN HERE",
        "",
        "Runtime and native components",
        *_table(kinds["native"]),
        "",
        "Python wheels (python/requirements.lock)",
        *_table(kinds["wheel"]),
        "",
        "Rust crates (Cargo.lock)",
        *_table(kinds["crate"]),
        "",
        "",
        "2. SOURCE, FOR THE COMPONENTS WHOSE LICENCE ASKS FOR IT",
        "",
    ]
    for offer in offers:
        lines += [offer["title"], ""]
        lines += [f"  {line}" if line else "" for line in offer["text"].splitlines()]
        lines.append("")
    lines += ["", "3. THE NOTICES", ""]
    if missing:
        lines += ["These ship no notice text of their own. Their licence is named above,",
                  "and their terms are where the entry says:", ""]
        for row in missing:
            lines.append(f"  {row['name']} {row['version']}: "
                         + (row.get("terms") or row["licence"]))
        lines.append("")
    for row in rows:
        if not row["texts"]:
            continue
        lines += ["=" * 76,
                  f"{row['name']} {row['version']} -- {row['licence']}",
                  f"    {row['what']}",
                  f"    {row['source']}", ""]
        for name, text in row["texts"]:
            lines += [f"---- {name}", ""] + text.splitlines() + [""]
    return "\n".join(lines).rstrip() + "\n"


# ----------------------------------------------------------------- the gate
def stale_versions(rows: list[dict]) -> list[str]:
    """Where notices.json's hand-written versions differ from this machine's.

    The natives are the only versions nobody can read off a lock, so they
    are the only ones that can go quietly stale.
    """
    found = []
    for name, stated in sorted(versions_now().items()):
        entry = next((row for row in rows if row["name"] == name), None)
        if entry is None:
            found.append(f"{name} is not listed in notices.json")
        elif entry["version"] != stated:
            found.append(f"notices.json says {name} {entry['version']}, "
                         f"this venv has {stated}")
    return found


def problems(rows: list[dict], offers: list[dict]) -> list[str]:
    """Why this must not be published yet, one line each."""
    found = []
    for offer in offers:
        if not any(offer_for(row["name"], offers) is offer for row in rows):
            found.append(f"notices.json offers source under {offer['title']!r}, which "
                         f"covers nothing the tree ships")
    for row in rows:
        if not row["texts"] and not row.get("terms"):
            found.append(f"{row['name']} {row['version']} ships no notice text and "
                         f"notices.json gives it no terms")
        if row["licence"] == "UNKNOWN" and not row.get("terms"):
            found.append(f"{row['name']} {row['version']} declares no licence and "
                         f"notices.json gives it no terms")
        if COPYLEFT.search(row["licence"]) and offer_for(row["name"], offers) is None:
            found.append(f"{row['name']} {row['version']} is {row['licence']}, which asks "
                         f"for source: notices.json records no offer for it")
    return found


def write(tree: Path, version: str, rows: list[dict], offers: list[dict]) -> list[Path]:
    """``LICENSE.txt`` and ``THIRD-PARTY-NOTICES.txt`` in the tree's root."""
    licence = tree / LICENCE_FILE
    licence.write_bytes((release.ROOT / "LICENSE").read_bytes())
    notices = tree / NOTICES_FILE
    notices.write_text(render(rows, version, offers), encoding="utf-8", newline="\r\n")
    return [licence, notices]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("tree", nargs="?", default=None,
                        help=f"where to write the two files (default: {release.TREE})")
    parser.add_argument("--check", action="store_true",
                        help="only report what would stop a release, and exit 1 on any")
    parser.add_argument("--print", dest="show", action="store_true",
                        help="write the notices to stdout instead of into a tree")
    args = parser.parse_args(argv)

    rows, broken = components()
    offers = listed().get("offers", [])
    found = broken + stale_versions(rows) + problems(rows, offers)
    if args.check or found:
        for line in found:
            print("notices:", line)
        if found:
            return 1
        texts = sum(len(row["texts"]) for row in rows)
        print(f"notices: {len(rows)} components, {texts} notice files, "
              f"{len(offers)} source offers, nothing missing")
        return 0
    version = release.version()
    if args.show:
        sys.stdout.write(render(rows, version, offers))
        return 0
    tree = Path(args.tree) if args.tree else release.TREE
    if not tree.is_dir():
        print(f"no tree at {tree}: build it first (installer\\build.py)")
        return 2
    for path in write(tree, version, rows, offers):
        print(f"wrote {path} ({path.stat().st_size / 1e3:.1f} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
