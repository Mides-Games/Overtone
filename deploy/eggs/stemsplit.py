"""The drums separator for the worker: Stemsplit's release, pinned and checked.

    python deploy/eggs/stemsplit.py .overtone/stemsplit

Run by deploy/eggs/start.sh before the worker starts. A live band's hint
(`band`, worker/timing_result.py) separates the drums with it; without it the
worker reads the mix and the result says so, so a failure here is a warning,
never a reason not to start.

Downloads the CLI and the weights of one release, checks each against the
SHA-256 written here (not one served beside them), and keeps them until the
pinned release changes. The glibc build is the one Overtone measured; the
static musl build, a third slower, is taken only where glibc is older than it
needs. Standard library only: the runtime image has Python, not curl.
"""
from __future__ import annotations

import hashlib
import os
import platform
import sys
import urllib.request
from pathlib import Path

VERSION = "v0.1.0"
BASE = f"https://github.com/Mides-Games/Stemsplit/releases/download/{VERSION}/"
SHA256 = {
    "stemsplit-x86_64-linux-gnu": "b45245fa5660b91ac0b4daaa5fa1c93af667b95dc4031068e2c2854b187daa68",
    "stemsplit-x86_64-linux-musl": "be3e1c917fa6ea22eae6e5efba7e13f32e58bd2eaf0c0d1944c0149e17193518",
    "stemsplit.safetensors": "07e337023c1ff56e7453de4aa5b2df877b5bac91f0ba9d878c8c702648deea43",
}
#: The glibc the gnu build links against (objdump -T: GLIBC_2.39).
GLIBC_NEEDED = (2, 39)


def binary_name() -> str:
    """The build this system runs: gnu where glibc is new enough, else musl."""
    lib, version = platform.libc_ver()
    try:
        have = tuple(int(x) for x in version.split(".")[:2])
    except ValueError:
        have = (0, 0)
    return "stemsplit-x86_64-linux-gnu" if lib == "glibc" and have >= GLIBC_NEEDED else "stemsplit-x86_64-linux-musl"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch(name: str, dest: Path) -> None:
    """``name`` of the pinned release into ``dest``, or an error; a file that
    is already there with the right SHA-256 is kept."""
    if dest.is_file() and sha256(dest) == SHA256[name]:
        return
    part = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(BASE + name, timeout=120) as r, part.open("wb") as f:
        while block := r.read(1 << 20):
            f.write(block)
    if sha256(part) != SHA256[name]:
        part.unlink()
        raise RuntimeError(f"{name} does not match its SHA-256")
    os.replace(part, dest)


def main(argv: list[str]) -> int:
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        print(f"stemsplit: no {VERSION} build for {platform.system()} {platform.machine()}")
        return 1
    folder = Path(argv[1] if len(argv) > 1 else ".overtone/stemsplit")
    folder.mkdir(parents=True, exist_ok=True)
    name = binary_name()
    try:
        fetch(name, folder / "stemsplit")
        fetch("stemsplit.safetensors", folder / "stemsplit.safetensors")
    except Exception as exc:  # noqa: BLE001 -- the worker starts without it
        print(f"stemsplit: {VERSION} not installed: {exc}")
        return 1
    (folder / "stemsplit").chmod(0o755)
    print(f"stemsplit: {VERSION} ({name}) ready")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
