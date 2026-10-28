"""Build a release's executables, and publish them on GitHub when asked.

    .venv\\Scripts\\python.exe scripts\\release.py <version> [--publish] [--since TAG]
    .venv\\Scripts\\python.exe scripts\\release.py bump <version>

Without ``--publish`` it only builds, into ``dist/release/<version>/``
(gitignored), and prints what publishing would run. Each step is timed and its
output goes to ``build/release/<version>/logs``:

1. ``overtone-cli-<version>-windows-x64.exe``: the v4 Rust engine,
   ``cargo build --release -p overtone-cli``;
2. ``overtone-engine-<version>-windows-x64.zip``: the v3 Python engine's
   command line (``python/overtone.py``, what the site's worker runs), frozen
   by PyInstaller (``scripts/overtone-engine.spec``) into ``overtone.exe`` with
   the Beat This! model beside it, then run once on a two-tempo click track;
   it must read both red lines (128 and 142 BPM);
3. ``overtone-site-<version>.zip``: the built web (``site/web`` -> ``dist``),
   the API's tracked source (``site/api``, no ``node_modules``) and
   ``deploy/web/serve.mjs``, for self-hosting;
4. ``SHA256SUMS.txt`` over those three;
5. ``notes.md``: the "Changed" bullets of every ``docs/timeline.md`` entry
   added since the previous release tag (``--since`` names it instead).

The version is the product's: ``[workspace.package] version`` in Cargo.toml
(which ``python/overtone_paths.py``'s ``app_version()`` reads for the Python
engine) and ``version`` in ``site/web`` and ``site/api``'s package.json. The
script refuses to run unless all of them equal ``<version>``; ``bump`` sets
them, the crates' path-dependency pins and Cargo.lock's entries at once.

``--publish`` first checks that the tree is clean and HEAD is ``master``
(stable releases come from production), then builds, tags ``v<version>``,
pushes the tag and runs ``gh release create``, as a prerelease when the
version names ``alpha``, ``beta`` or ``rc``. docs/release.md is the routine.
Windows x64 only: the assets are Windows builds.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
import zlib
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
TIMELINE = ROOT / "docs" / "timeline.md"
PACKAGE_JSONS = (ROOT / "site" / "web" / "package.json", ROOT / "site" / "api" / "package.json")
CRATES = ROOT / "crates"
SPEC = SCRIPTS / "overtone-engine.spec"
RELEASE_REQUIREMENTS = SCRIPTS / "requirements-release.txt"
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$")
TAG_RE = re.compile(r"^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
PRERELEASE_RE = re.compile(r"alpha|beta|rc", re.I)
DEFAULT_BRANCH = "master"
#: GitHub refuses a release body longer than this.
NOTES_LIMIT = 125_000
#: The smoke test's audio: bench/benchmark.py's case, 128 BPM then 142 from 30 s.
SMOKE_CASE = "change-128-142"
SMOKE_TIMEOUT_S = 900


# ---------------------------------------------------------------------------
# Versions
# ---------------------------------------------------------------------------

def _workspace_block(text: str) -> re.Match:
    block = re.search(r"^\[workspace\.package\]\s*$(.*?)(?=^\[|\Z)", text, re.M | re.S)
    if block is None:
        raise SystemExit("Cargo.toml has no [workspace.package] table")
    return block


def cargo_version() -> str | None:
    block = _workspace_block((ROOT / "Cargo.toml").read_text(encoding="utf-8"))
    found = re.search(r'^version\s*=\s*"([^"]+)"', block.group(1), re.M)
    return found.group(1) if found else None


def package_version(path: Path) -> str | None:
    return json.loads(path.read_text(encoding="utf-8")).get("version")


def engine_version() -> str:
    """What the Python engine itself reports, read the way it reads it."""
    sys.path.insert(0, str(ROOT / "python"))
    try:
        from overtone_paths import app_version
    finally:
        sys.path.pop(0)
    return app_version()


def _crate_manifests() -> list[Path]:
    return sorted(CRATES.glob("*/Cargo.toml"))


_CRATE_PIN = re.compile(r'^(overtone-[a-z-]+\s*=\s*\{\s*version\s*=\s*")([^"]+)(")', re.M)
_LOCK_ENTRY = re.compile(r'(name = "overtone-[a-z-]+"\r?\nversion = ")([^"]+)(")')


def version_problems(version: str) -> list[str]:
    """Every place that names the product's version and names another one."""
    problems = []
    found = {"Cargo.toml [workspace.package]": cargo_version(),
             "python/overtone_paths.py app_version()": engine_version()}
    for path in PACKAGE_JSONS:
        found[path.relative_to(ROOT).as_posix()] = package_version(path)
    for manifest in _crate_manifests():
        for pin in _CRATE_PIN.finditer(manifest.read_text(encoding="utf-8")):
            found[f"{manifest.relative_to(ROOT).as_posix()} {pin.group(1).split()[0]}"] = pin.group(2)
    lock = (ROOT / "Cargo.lock").read_text(encoding="utf-8")
    for entry in _LOCK_ENTRY.finditer(lock):
        found[f"Cargo.lock {entry.group(1).split(chr(34))[1]}"] = entry.group(2)
    for where, value in found.items():
        if value != version:
            problems.append(f"{where} says {value!r}")
    return problems


def bump(version: str) -> None:
    """Set the product's version everywhere it is written, in one go."""
    cargo = ROOT / "Cargo.toml"
    text = _read(cargo)
    block = _workspace_block(text)
    body, count = re.subn(r'^(version\s*=\s*")[^"]+(")', rf"\g<1>{version}\g<2>",
                          block.group(1), count=1, flags=re.M)
    if count != 1:
        raise SystemExit("Cargo.toml's [workspace.package] states no version")
    _write(cargo, text[:block.start(1)] + body + text[block.end(1):])
    for manifest in _crate_manifests():
        _write(manifest, _CRATE_PIN.sub(rf"\g<1>{version}\g<3>", _read(manifest)))
    lock = ROOT / "Cargo.lock"
    _write(lock, _LOCK_ENTRY.sub(rf"\g<1>{version}\g<3>", _read(lock)))
    for path in PACKAGE_JSONS:
        new, count = re.subn(r'^(  "version":\s*")[^"]+(")', rf"\g<1>{version}\g<2>",
                             _read(path), count=1, flags=re.M)
        if count != 1:
            raise SystemExit(f"{path.relative_to(ROOT)} states no top-level version")
        _write(path, new)
    left = version_problems(version)
    if left:
        raise SystemExit("bumped, but these still differ:\n  " + "\n  ".join(left))
    print(f"Every version now reads {version}: Cargo.toml, the crates' pins, Cargo.lock, "
          "site/web and site/api. Commit it on its own: "
          f"chore(repo/version): set the version to {version}")


def _read(path: Path) -> str:
    """The file as stored, CRLF and all (newline='' translates nothing)."""
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def _write(path: Path, text: str) -> None:
    """Write text as given, and only when it changed."""
    if text != _read(path):
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)


# ---------------------------------------------------------------------------
# Running and timing the steps
# ---------------------------------------------------------------------------

class Steps:
    """Each step timed, its output in its own log, a failure named with its log."""

    def __init__(self, logs: Path) -> None:
        self.logs = logs
        self.times: list[tuple[str, float]] = []

    def run(self, name: str, argv: list[str], *, cwd: Path = ROOT,
            env: dict[str, str] | None = None) -> str:
        self.logs.mkdir(parents=True, exist_ok=True)
        log = self.logs / f"{name}.log"
        print(f"-- {name}: {' '.join(str(arg) for arg in argv)}", flush=True)
        started = time.perf_counter()
        done = subprocess.run([str(arg) for arg in argv], cwd=cwd, env=env, capture_output=True)
        seconds = time.perf_counter() - started
        output = (done.stdout + b"\n" + done.stderr).decode("utf-8", "replace")
        log.write_text(output, encoding="utf-8")
        self.times.append((name, seconds))
        if done.returncode != 0:
            tail = "\n".join(output.strip().splitlines()[-25:])
            raise SystemExit(f"{name} failed (exit {done.returncode}, {seconds:.1f} s), "
                             f"log {log}:\n{tail}")
        print(f"   {seconds:.1f} s", flush=True)
        return done.stdout.decode("utf-8", "replace")

    def timed(self, name: str, seconds: float) -> None:
        self.times.append((name, seconds))


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", check=True).stdout.strip()


# ---------------------------------------------------------------------------
# 1. The Rust engine
# ---------------------------------------------------------------------------

def build_rust_cli(version: str, out: Path, steps: Steps) -> Path:
    steps.run("cargo-build", ["cargo", "build", "--release", "-p", "overtone-cli"])
    meta = json.loads(subprocess.run(["cargo", "metadata", "--format-version", "1", "--no-deps"],
                                     cwd=ROOT, capture_output=True, text=True,
                                     check=True).stdout)
    built = Path(meta["target_directory"]) / "release" / "overtone-cli.exe"
    asset = out / f"overtone-cli-{version}-windows-x64.exe"
    shutil.copy2(built, asset)
    return asset


# ---------------------------------------------------------------------------
# 2. The Python engine, frozen
# ---------------------------------------------------------------------------

def _canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def release_tool_problems() -> list[str]:
    """The build tools pinned in requirements-release.txt, installed at their pins."""
    installed = {_canonical(dist.metadata["Name"]): dist.version
                 for dist in metadata.distributions()}
    problems = []
    for line in RELEASE_REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if "==" in line:
            name, pinned = (part.strip() for part in line.split("==", 1))
            if installed.get(_canonical(name)) != pinned:
                problems.append(f"{name} {installed.get(_canonical(name), 'missing')}, "
                                f"pinned {pinned}")
    return problems


def model_problems() -> list[str]:
    """The Beat This! model must be the real file, not its Git LFS pointer."""
    model = ROOT / "assets" / "models" / "beat_this_final0.onnx"
    if not model.is_file():
        return [f"{model.relative_to(ROOT)} is missing"]
    with open(model, "rb") as handle:
        head = handle.read(64)
    if head.startswith(b"version https://git-lfs"):
        return [f"{model.relative_to(ROOT)} is a Git LFS pointer: run git lfs pull"]
    return []


ENGINE_README = """Overtone {version} -- the Python engine's command line (Windows x64)

overtone.exe reads a song and prints its red lines (osu! timing points), the
same engine that analyses uploads on the Overtone website. It needs no Python
and no network: the Beat This! model in assets\\models is bundled, so the
beat vote runs offline.

    overtone.exe song.mp3                   red lines, as osu! [TimingPoints] rows
    overtone.exe song.mp3 --stats           plus a summary
    overtone.exe song.mp3 --json            the full report as JSON
    overtone.exe song.mp3 --osz out.osz     a beatmap archive carrying the timing
    overtone.exe --help                     every option

Keep the folder together: overtone.exe reads _internal and assets beside it.
The first run of a session compiles some kernels and takes longer.

Licence: MIT (LICENSE). The model's licence: assets\\models\\LICENSE-beat-this.txt.
Source: https://github.com/Mides-Games/Overtone
"""


def build_engine(version: str, out: Path, work: Path, steps: Steps) -> tuple[Path, dict]:
    pyi_dist, pyi_work = work / "pyinstaller-dist", work / "pyinstaller-work"
    shutil.rmtree(pyi_dist, ignore_errors=True)
    steps.run("pyinstaller", [sys.executable, "-m", "PyInstaller", "--noconfirm",
                              "--distpath", pyi_dist, "--workpath", pyi_work, SPEC])
    tree = pyi_dist / "overtone"
    # The engine reads its data one folder above its code (see the spec): the
    # model and the version go beside overtone.exe, at the repository's paths.
    shutil.copytree(ROOT / "assets" / "models", tree / "assets" / "models")
    (tree / "Cargo.toml").write_text(
        "# Read by the engine for the version it writes into every file's header\n"
        "# (python/overtone_paths.py, app_version()); nothing here is built.\n"
        f'[workspace.package]\nversion = "{version}"\n', encoding="utf-8")
    shutil.copy2(ROOT / "LICENSE", tree / "LICENSE")
    (tree / "README.txt").write_text(ENGINE_README.format(version=version).replace("\n", "\r\n"),
                                     encoding="utf-8", newline="")
    smoke = smoke_engine(tree, version, work, steps)
    asset = out / f"overtone-engine-{version}-windows-x64.zip"
    zip_tree(asset, {f"overtone-engine-{version}-windows-x64": tree})
    return asset, smoke


def smoke_audio(work: Path) -> tuple[Path, list[float]]:
    """The benchmark's two-tempo case, rendered by its own code."""
    sys.path.insert(0, str(ROOT / "bench"))
    try:
        from benchmark import CASES, build_track
    finally:
        sys.path.pop(0)
    path = work / f"{SMOKE_CASE}.wav"
    if not path.is_file():
        build_track(path, seed=zlib.crc32(SMOKE_CASE.encode()), **CASES[SMOKE_CASE])
    return path, [bpm for _start, bpm in CASES[SMOKE_CASE]["sections"]]


def scratch_env(profile: Path) -> dict[str, str]:
    """A user who has never run Overtone, with no Python or developer PATH."""
    local, roaming = profile / "AppData" / "Local", profile / "AppData" / "Roaming"
    temp = local / "Temp"
    for folder in (roaming, temp):
        folder.mkdir(parents=True, exist_ok=True)
    windows = os.environ.get("SystemRoot", r"C:\Windows")
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith(("PYTHON", "OVERTONE_", "NUMBA_", "VIRTUAL_ENV"))}
    env.update(USERPROFILE=str(profile), LOCALAPPDATA=str(local), APPDATA=str(roaming),
               TEMP=str(temp), TMP=str(temp),
               PATH=os.pathsep.join([str(Path(windows) / "System32"), windows,
                                     str(Path(windows) / "System32" / "Wbem")]))
    return env


def _snapshot(tree: Path) -> dict[str, tuple[int, int]]:
    return {str(path.relative_to(tree)): (path.stat().st_size, path.stat().st_mtime_ns)
            for path in tree.rglob("*") if path.is_file()}


def smoke_engine(tree: Path, version: str, work: Path, steps: Steps) -> dict:
    """One run of the frozen overtone.exe, as a user runs it: both red lines
    within the benchmark's 0.05 BPM, under a header naming this version."""
    audio, expected = smoke_audio(work)
    before = _snapshot(tree)
    with tempfile.TemporaryDirectory(prefix="overtone-smoke-") as tmp:
        scratch = Path(tmp)
        cwd = scratch / "work"
        cwd.mkdir()
        argv = [str(tree / "overtone.exe"), str(audio)]
        print(f"-- smoke: {subprocess.list2cmdline(argv)}", flush=True)
        started = time.perf_counter()
        done = subprocess.run(argv, capture_output=True, cwd=cwd, timeout=SMOKE_TIMEOUT_S,
                              env=scratch_env(scratch / "profile"))
        seconds = time.perf_counter() - started
    after = _snapshot(tree)
    steps.timed("smoke", seconds)
    text = done.stdout.decode("utf-8", "replace").strip()
    (steps.logs / "smoke.log").write_text(
        text + "\n\n" + done.stderr.decode("utf-8", "replace"), encoding="utf-8")
    reds = []
    for row in text.splitlines():
        fields = row.split(",")
        if len(fields) >= 7 and fields[6].strip() == "1":     # uninherited: a red line
            reds.append((int(float(fields[0])), round(60000.0 / float(fields[1]), 3)))
    ok = (done.returncode == 0 and text.startswith(f"// Generated by Overtone v{version}")
          and len(reds) == len(expected)
          and all(abs(bpm - want) <= 0.05 for (_ms, bpm), want in zip(reds, expected)))
    result = {"audio": audio.name, "expected_bpm": expected, "red_lines": reds,
              "seconds": round(seconds, 1), "ok": ok, "output": text,
              "tree_writes": sorted(name for name in before.keys() | after.keys()
                                    if before.get(name) != after.get(name))}
    print(f"   {seconds:.1f} s\n" + "\n".join("   " + row for row in text.splitlines()),
          flush=True)
    if not ok:
        raise SystemExit(f"smoke failed (exit {done.returncode}): expected {expected} BPM "
                         f"under a v{version} header, read {reds}\n"
                         + done.stderr.decode("utf-8", "replace")[-1500:])
    return result


def zip_tree(asset: Path, folders: dict[str, Path], files: dict[str, Path] | None = None,
             texts: dict[str, str] | None = None) -> None:
    """A ZIP of folders (each under its name), single files and generated texts."""
    asset.unlink(missing_ok=True)
    with zipfile.ZipFile(asset, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, folder in folders.items():
            for path in sorted(folder.rglob("*")):
                if path.is_file():
                    archive.write(path, f"{name}/{path.relative_to(folder).as_posix()}")
        for name, path in sorted((files or {}).items()):
            archive.write(path, name)
        for name, text in sorted((texts or {}).items()):
            archive.writestr(name, text.replace("\n", "\r\n"))


# ---------------------------------------------------------------------------
# 3. The site, for self-hosting
# ---------------------------------------------------------------------------

SITE_README = """Overtone {version} -- the website, for self-hosting

    web/         the built frontend (site/web, vite build): static files
    api/         the API's source (site/api): Express 5 and PostgreSQL
    serve.mjs    serves web/ and forwards /api to the API (deploy/web/serve.mjs)

Needs Node.js 22 or newer and a PostgreSQL database.

1. The API:
       cd api
       npm install --omit=dev
       copy .env.example .env      (fill it in; docs/site.md in the repository
                                    explains each value)
       npm run db:migrate
       npm start
2. The site, in another terminal, from this folder:
       set WEB_ROOT=web
       set API_UPSTREAM=http://127.0.0.1:4012     (the API's PORT)
       set HSTS=0                                  (plain http on one machine)
       node serve.mjs
   then open http://localhost:8080. serve.mjs's header lists its other settings.

Analyses are run by the worker (worker/main.py in the repository) with the
Python engine; overtone-engine-{version}-windows-x64.zip is that engine frozen.
The production setup (TLS, the proxy secret, the worker) is in docs/deploy.md.

Licence: MIT (LICENSE). Source: https://github.com/Mides-Games/Overtone
"""


def find_pnpm() -> str:
    found = os.environ.get("PNPM") or shutil.which("pnpm") or shutil.which("pnpm.cmd")
    if not found:
        raise SystemExit("pnpm is not on PATH; set PNPM to its path")
    return found


def build_site(version: str, out: Path, steps: Steps) -> Path:
    pnpm = find_pnpm()
    steps.run("pnpm-install", [pnpm, "install", "--frozen-lockfile"])
    steps.run("site-build", [pnpm, "--dir", "site/web", "build"])
    dist = ROOT / "site" / "web" / "dist"
    if not (dist / "index.html").is_file():
        raise SystemExit("site/web's build wrote no dist/index.html")
    # The API as Git tracks it: never node_modules, never a real .env.
    tracked = git("ls-files", "-z", "--", "site/api").split("\0")
    api = {f"overtone-site-{version}/api/{Path(name).relative_to('site/api').as_posix()}":
           ROOT / name for name in tracked if name and (ROOT / name).is_file()}
    if any("node_modules" in name or name.endswith("/.env") for name in api):
        raise SystemExit("site/api's tracked files hold node_modules or a .env")
    files = dict(api)
    files[f"overtone-site-{version}/serve.mjs"] = ROOT / "deploy" / "web" / "serve.mjs"
    files[f"overtone-site-{version}/LICENSE"] = ROOT / "LICENSE"
    asset = out / f"overtone-site-{version}.zip"
    zip_tree(asset, {f"overtone-site-{version}/web": dist}, files,
             {f"overtone-site-{version}/README.txt": SITE_README.format(version=version)})
    return asset


# ---------------------------------------------------------------------------
# 4-5. Checksums and notes
# ---------------------------------------------------------------------------

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_sums(out: Path, assets: list[Path]) -> Path:
    """sha256sum's own format, so `sha256sum -c SHA256SUMS.txt` checks it."""
    sums = out / "SHA256SUMS.txt"
    sums.write_text("".join(f"{sha256(path)}  {path.name}\n" for path in assets),
                    encoding="utf-8", newline="\n")
    return sums


def previous_tag(version: str) -> str | None:
    """The newest release tag other than this version's."""
    tags = git("tag", "--list", "v*", "--sort=-creatordate").splitlines()
    for tag in tags:
        if TAG_RE.match(tag) and tag != f"v{version}":
            return tag
    return None


def timeline_entries(text: str) -> list[tuple[str, str]]:
    """(heading, body) for every ``## `` entry, in the file's order."""
    entries, heading, body = [], None, []
    for line in text.splitlines():
        if line.startswith("## "):
            if heading is not None:
                entries.append((heading, "\n".join(body)))
            heading, body = line[3:].strip(), []
        elif heading is not None:
            body.append(line)
    if heading is not None:
        entries.append((heading, "\n".join(body)))
    return entries


def changed_bullets(body: str) -> str:
    """The entry's ``### Changed`` section, as written."""
    found = re.search(r"^### Changed[^\n]*\n(.*?)(?=^### |^## |^---\s*$|\Z)", body, re.M | re.S)
    return found.group(1).strip() if found else ""


def entry_title(heading: str) -> str:
    """``Unreleased -- 2026-10-27 · Title`` -> ``Title``."""
    return heading.split(" · ", 1)[1].strip() if " · " in heading else heading


def release_notes(version: str, since: str | None, assets: list[Path]) -> tuple[str, str]:
    """The notes, and a line saying where the entries were cut."""
    current = timeline_entries(TIMELINE.read_text(encoding="utf-8"))
    tag = since if since is not None else previous_tag(version)
    if tag:
        try:
            old = git("show", f"{tag}:docs/timeline.md")
        except subprocess.CalledProcessError:
            raise SystemExit(f"{tag} has no docs/timeline.md to compare with")
        seen = {heading for heading, _body in timeline_entries(old)}
        entries = [(h, b) for h, b in current if h not in seen]
        cut = f"entries added since {tag}"
    else:
        # No release tag here (a fresh clone carries none from the old
        # history): everything above the newest entry headed by a version.
        entries = []
        for heading, body in current:
            if re.match(r"v\d+\.\d+\.\d+", heading) and not heading.startswith(f"v{version} "):
                break
            entries.append((heading, body))
        cut = "entries above the timeline's newest released version (no release tag found)"
    sections = []
    for heading, body in entries:
        bullets = changed_bullets(body)
        if bullets:
            sections.append(f"### {entry_title(heading)}\n\n{bullets}\n")
    names = {asset.name: asset for asset in assets}
    lines = [f"Overtone {version}, built from {git('rev-parse', '--short', 'HEAD')}.", "",
             "## Downloads", ""]
    described = {
        "overtone-cli-": "the v4 Rust engine's command line, one file "
                         "(`overtone-cli analyze song.mp3`).",
        "overtone-engine-": "the v3 Python engine's command line, the one the website runs, "
                            "with the Beat This! model; unzip and run `overtone.exe song.mp3`. "
                            "No Python needed.",
        "overtone-site-": "the website for self-hosting: the built frontend, the API's source "
                          "and `serve.mjs`; `README.txt` inside says how to run it.",
        "SHA256SUMS": "the SHA-256 of each file above: `sha256sum -c SHA256SUMS.txt`, or "
                      "`Get-FileHash <file>` in PowerShell.",
    }
    for name in names:
        about = next((text for prefix, text in described.items() if name.startswith(prefix)), "")
        lines.append(f"- `{name}`: {about}")
    lines += ["", "## Changes", "",
              f"From `docs/timeline.md` ({len(sections)} {cut}); each entry there also "
              "carries what was fixed, hardened and measured.", ""]
    return "\n".join(lines) + "\n" + "\n".join(sections), cut


# ---------------------------------------------------------------------------
# Publishing
# ---------------------------------------------------------------------------

def publish_problems(version: str) -> list[str]:
    problems = []
    if git("status", "--porcelain"):
        problems.append("the working tree is not clean")
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    if branch != DEFAULT_BRANCH:
        problems.append(f"HEAD is on {branch}, not {DEFAULT_BRANCH}")
    if git("tag", "--list", f"v{version}"):
        problems.append(f"the tag v{version} already exists")
    if not shutil.which("gh"):
        problems.append("gh is not on PATH")
    return problems


def publish_commands(version: str, out: Path, assets: list[Path]) -> list[list[str]]:
    tag = f"v{version}"
    create = ["gh", "release", "create", tag, "--verify-tag", "--title", f"Overtone {version}",
              "--notes-file", str(out / "notes.md")]
    if PRERELEASE_RE.search(version):
        create.append("--prerelease")
    return [["git", "tag", "-a", tag, "-m", f"Overtone {version}"],
            ["git", "push", "origin", tag],
            create + [str(asset) for asset in assets]]


# ---------------------------------------------------------------------------

def build(version: str, publish: bool, since: str | None) -> None:
    if not VERSION_RE.match(version):
        raise SystemExit(f"not a version: {version!r} (e.g. 1.0.0-stable, 1.1.0-rc.1)")
    if sys.platform != "win32" or platform.machine().upper() not in ("AMD64", "X86_64"):
        raise SystemExit("the release assets are Windows x64 builds: run this on Windows x64")
    problems = version_problems(version)
    problems += [f"release tools: {line}" for line in release_tool_problems()]
    problems += model_problems()
    if publish:
        problems += publish_problems(version)
    if since is not None and not git("tag", "--list", since):
        problems.append(f"--since {since}: no such tag")
    if problems:
        hint = (f"\n(scripts/release.py bump {version} sets every version)"
                if version_problems(version) else "")
        raise SystemExit("refusing to build:\n  " + "\n  ".join(problems) + hint)

    out = ROOT / "dist" / "release" / version
    work = ROOT / "build" / "release" / version
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    work.mkdir(parents=True, exist_ok=True)
    steps = Steps(work / "logs")
    started = time.perf_counter()

    cli = build_rust_cli(version, out, steps)
    engine, smoke = build_engine(version, out, work, steps)
    site = build_site(version, out, steps)
    assets = [cli, engine, site]
    sums = write_sums(out, assets)
    notes, cut = release_notes(version, since, assets + [sums])
    (out / "notes.md").write_text(notes, encoding="utf-8", newline="\n")
    (out / "smoke.json").write_text(json.dumps(smoke, indent=2), encoding="utf-8")
    total = time.perf_counter() - started

    print(f"\nRelease {version} in {out}")
    for asset in assets + [sums]:
        print(f"  {asset.name:<48} {asset.stat().st_size / 1e6:>8.2f} MB")
    print(f"  notes.md: {len(notes):,} characters, {cut}")
    if len(notes) > NOTES_LIMIT:
        print(f"  notes.md is over GitHub's {NOTES_LIMIT:,}-character limit: pass --since, "
              "or shorten it by hand before publishing")
    print("Smoke: overtone.exe on " + smoke["audio"] + f" read {smoke['red_lines']} "
          f"in {smoke['seconds']} s" + ("" if not smoke["tree_writes"] else
                                         f"; it wrote into its own folder: {smoke['tree_writes']}"))
    print("Times: " + ", ".join(f"{name} {seconds:.1f} s" for name, seconds in steps.times)
          + f"; total {total:.1f} s")

    commands = publish_commands(version, out, assets + [sums])
    if not publish:
        print("\nDry run. --publish would now run:")
        for argv in commands:
            print("  " + subprocess.list2cmdline(argv))
        return
    if len(notes) > NOTES_LIMIT:
        raise SystemExit("not publishing: notes.md is too long for a GitHub release")
    for argv in commands:
        print("-- " + subprocess.list2cmdline(argv), flush=True)
        subprocess.run(argv, cwd=ROOT, check=True)
    print(f"Published v{version}.")


def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] == "bump":
        parser = argparse.ArgumentParser(prog="release.py bump",
                                         description="Set the product's version everywhere.")
        parser.add_argument("version")
        args = parser.parse_args(sys.argv[2:])
        if not VERSION_RE.match(args.version):
            parser.error(f"not a version: {args.version!r}")
        bump(args.version)
        return
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("version", help="the release's version, e.g. 1.0.0-stable")
    parser.add_argument("--publish", action="store_true",
                        help="tag v<version>, push the tag and create the GitHub release")
    parser.add_argument("--since", metavar="TAG",
                        help="the release whose notes end where these begin "
                             "(default: the newest release tag)")
    args = parser.parse_args()
    build(args.version, args.publish, args.since)


if __name__ == "__main__":
    main()
