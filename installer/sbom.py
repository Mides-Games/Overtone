"""Inventory the licences of the pinned wheels (Phase 10.13, SBOM groundwork).

The MSI/ZIP tree bundles the venv's wheels, so nothing ships before their
licence notices are gathered -- and gathering starts from knowing what is
in there. This lists every pin of ``requirements.lock`` (shipped in the
tree) and ``installer/requirements-build.lock`` (build-time only) with the
licence its installed metadata declares, into ``installer/sbom.json``
(committed):

    .venv\\Scripts\\python.exe installer\\sbom.py            # rewrite sbom.json
    .venv\\Scripts\\python.exe installer\\sbom.py --check    # exit 1 on drift

``--check`` is the gate: a lock changed without re-running fails it, and so
does a venv whose wheels differ from the lock (build.py refuses those too,
so generation happens where the pins hold). Licence STRINGS come from the
venv's metadata at generation time. Native bits no wheel carries
(libsndfile LGPL, Tcl/Tk, WebView2, the MSVC runtime, Python itself) are not
wheels and are not inventoried here -- gathering their notices into the tree
is the step after this one.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from importlib import metadata
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SBOM = HERE / "sbom.json"
#: (lock file, shipped in the tree). Runtime first, so it wins on overlap.
LOCKS = ((ROOT / "python" / "requirements.lock", True),
         (HERE / "requirements-build.lock", False))


def _canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def pins(lock: Path) -> list[tuple[str, str]]:
    """``(canonical name, version)`` pins of one lock file."""
    out = []
    for line in lock.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if "==" in line:
            name, version = line.split("==", 1)
            out.append((_canonical(name), version.strip()))
    return out


def licence_of(dist) -> str:
    """What a wheel declares, as a short identifier: SPDX expression, else
    the OSI classifier, else a short License first line, else an explicit
    UNKNOWN -- a missing declaration is data, not a pass. Full licence texts
    (scipy's License field carries kilobytes, GPL included) stay out of this
    inventory; gathering the notice texts into the tree is the step after it.
    """
    meta = dist.metadata
    expr = (meta.get("License-Expression") or "").strip()
    if expr:
        return expr
    for classifier in meta.get_all("Classifier") or []:
        head, _, tail = classifier.partition("License :: OSI Approved :: ")
        if head == "" and tail.strip():
            return tail.strip()
    first = (meta.get("License") or "").strip().splitlines()
    # An identifier, not prose: "MIT" names a licence, "Copyright (c)"
    # starts one.
    if first and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+_-]*",
                              first[0].strip()):
        return first[0].strip()
    return "UNKNOWN"


def inventory(dists=None) -> dict:
    """Every pin with its licence, keyed by canonical name."""
    if dists is None:
        dists = {_canonical(d.metadata["Name"]): d
                 for d in metadata.distributions()}
    packages = {}
    for lock, shipped in LOCKS:
        for name, version in pins(lock):
            if name in packages:
                continue
            dist = dists.get(name)
            installed = dist.version if dist is not None else None
            packages[name] = {
                "version": version,
                "installed": installed,
                "licence": licence_of(dist) if dist is not None else "UNKNOWN",
                "shipped": shipped,
            }
    return {"format": 1, "packages": packages}


def drift(committed: dict, fresh: dict) -> list[str]:
    """Pins the committed file no longer covers, and versions it misstates."""
    old = committed.get("packages", {})
    new = fresh.get("packages", {})
    found = []
    for name, row in sorted(new.items()):
        if name not in old:
            found.append(f"{name}=={row['version']} is not inventoried")
        elif old[name].get("version") != row["version"]:
            found.append(f"{name} pins {row['version']}, sbom.json says "
                         f"{old[name].get('version')}")
    for name in sorted(old):
        if name not in new:
            found.append(f"{name} left the locks but stays inventoried")
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true",
                        help="fail when sbom.json drifts from the locks")
    args = parser.parse_args(argv)
    if args.check:
        try:
            committed = json.loads(SBOM.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"sbom.json is not readable: {exc}")
            return 1
        found = drift(committed, inventory())
        for line in found:
            print("drift:", line)
        mismatched = [f"{name}=={row['version']} (venv has "
                       f"{row['installed']})"
                       for name, row in sorted(inventory()["packages"].items())
                       if row["installed"] != row["version"]]
        for line in mismatched:
            print("venv differs from the lock:", line)
        if found or mismatched:
            return 1
        print(f"sbom.json matches the locks "
              f"({len(committed.get('packages', {}))} wheels)")
        return 0
    SBOM.write_text(json.dumps(inventory(), indent=1) + "\n", encoding="utf-8")
    print(f"wrote {SBOM} ({len(inventory()['packages'])} wheels)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
