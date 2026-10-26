"""Build Overtone's installer and portable ZIP in one line, from a checkout.

    .venv\\Scripts\\python.exe installer\\build.py [--no-msi] [--no-verify] [--clean]

Each step is timed, and its output goes to ``build\\logs``:

1. the Rust engine: ``cargo build --release -p overtone-cli``;
2. PyInstaller (``installer/overtone.spec``): ``dist\\Overtone``, the tree the
   MSI installs and the ZIP holds;
3. the bundled licences, gathered into the tree (``installer/notices.py``);
4. the smoke test on that tree (``installer/smoke.py``);
5. the MSI, with WiX 5.0.2 (``installer/Overtone.wxs``), per user;
6. the portable ZIP: the same tree in one ``Overtone`` folder, and beside it
   the SBOM and the SHA-256 of everything a release publishes;
7. both unpacked into temporary folders, the MSI by an administrative install
   (``msiexec /a``, which installs and registers nothing), each compared with
   the tree file for file and smoke-tested;
8. sizes, SHA-256 and timings, printed and written beside the MSI.

Nothing here reaches the network. The toolchain is set up once, per user and
without an administrator (docs/11-msi-distribution.md, "Building it"), and a
missing piece stops the build before it starts, named. So does a venv whose
wheels differ from ``requirements.lock`` or ``requirements-build.lock``: the
bundle carries what the venv holds, and the lock is what was measured. So does
a licence notice that is missing from ``installer/notices.json``, because an
artefact with a notice missing must not exist in the first place.

``--no-msi`` builds the tree and the ZIP only (no .NET or WiX needed);
``--no-verify`` skips step 6; ``--clean`` rebuilds PyInstaller's cache.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from datetime import datetime
from importlib import metadata
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import notices  # noqa: E402
import release  # noqa: E402
import sbom  # noqa: E402

LOGS = release.BUILD / "logs"
WIX_EXTENSION = "WixToolset.UI.wixext"


def _canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _pins(lock: Path) -> dict[str, str]:
    pins = {}
    for line in lock.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if "==" in line:
            name, version = line.split("==", 1)
            pins[_canonical(name)] = version.strip()
    return pins


def wheel_problems() -> list[str]:
    """Every pinned wheel, installed at its pinned version, in this venv."""
    installed = {_canonical(dist.metadata["Name"]): dist.version
                 for dist in metadata.distributions()}
    problems = []
    for lock in (release.ROOT / "python" / "requirements.lock", HERE / "requirements-build.lock"):
        for name, version in _pins(lock).items():
            if installed.get(name) != version:
                problems.append(f"{name} {installed.get(name, 'missing')}, "
                                f"{lock.name} pins {version}")
    return problems


def wix_version() -> str:
    tools = json.loads((HERE / "dotnet-tools.json").read_text(encoding="utf-8"))
    return tools["tools"]["wix"]["version"]


def find_dotnet() -> Path | None:
    """A dotnet with an SDK: DOTNET_ROOT, the per-user install that Microsoft's
    dotnet-install.ps1 makes, then PATH (which may hold a runtime only)."""
    found = []
    if os.environ.get("DOTNET_ROOT"):
        found.append(Path(os.environ["DOTNET_ROOT"]) / "dotnet.exe")
    found.append(Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "dotnet" / "dotnet.exe")
    if shutil.which("dotnet"):
        found.append(Path(shutil.which("dotnet")))
    for dotnet in found:
        if dotnet.is_file():
            listed = subprocess.run([str(dotnet), "--list-sdks"], capture_output=True, text=True,
                                    env=dotnet_env(dotnet))
            if listed.returncode == 0 and listed.stdout.strip():
                return dotnet
    return None


def dotnet_env(dotnet: Path) -> dict[str, str]:
    """No telemetry, no update checks, no first-run changes to PATH or the
    certificate store: the build stays offline and leaves the machine as is."""
    env = dict(os.environ)
    env.update(DOTNET_ROOT=str(dotnet.parent), DOTNET_CLI_TELEMETRY_OPTOUT="1",
               DOTNET_NOLOGO="1", DOTNET_ADD_GLOBAL_TOOLS_TO_PATH="false",
               DOTNET_GENERATE_ASPNET_CERTIFICATE="false", DOTNET_SKIP_FIRST_TIME_EXPERIENCE="1",
               DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE="1", DOTNET_CLI_UI_LANGUAGE="en")
    return env


class Steps:
    """Runs and times the build's steps; a failed one ends the build."""

    def __init__(self) -> None:
        self.timings: list[tuple[str, float]] = []
        LOGS.mkdir(parents=True, exist_ok=True)

    def run(self, name: str, argv: list[str] | str, cwd: Path,
            env: dict[str, str] | None = None) -> None:
        log = LOGS / (re.sub(r"\W+", "-", name.split(" (")[0].lower()).strip("-") + ".log")
        started = time.perf_counter()
        with open(log, "wb") as handle:
            done = subprocess.run(argv, cwd=cwd, env=env, stdout=handle,
                                  stderr=subprocess.STDOUT)
        self.done(name, started, ok=done.returncode == 0,
                  why=f"exit {done.returncode}, see {log}")
        if done.returncode:
            tail = log.read_text(encoding="utf-8", errors="replace").splitlines()[-25:]
            print("\n".join("    " + line for line in tail))
            raise SystemExit(1)

    def done(self, name: str, started: float, ok: bool = True, why: str = "") -> float:
        seconds = time.perf_counter() - started
        self.timings.append((name, seconds))
        print(f"  {name}: {seconds:.1f} s" + ("" if ok else f"  FAILED ({why})"), flush=True)
        return seconds


def listing(tree: Path) -> dict[str, tuple[int, str]]:
    """Every file under ``tree``: its size and SHA-256."""
    files = {}
    for path in sorted(tree.rglob("*")):
        if path.is_file():
            files[path.relative_to(tree).as_posix()] = (path.stat().st_size, sha256(path))
    return files


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_licence_rtf(target: Path) -> Path:
    """Overtone's licence, as the only format the licence page can read.

    WixUI's licence control takes RTF, so the page is generated from
    ``LICENSE`` at build time rather than kept beside it as a second copy
    that could drift. A blank line starts a paragraph; inside one, the
    control does the wrapping.
    """
    text = (release.ROOT / "LICENSE").read_text(encoding="utf-8")
    if not text.isascii():
        raise SystemExit("LICENSE is not ASCII: the licence page would need an RTF codepage")
    paragraphs = [" ".join(block.split()) for block in re.split(r"\n\s*\n", text.strip())]
    body = "\\par\\par\n".join(
        block.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
        for block in paragraphs)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss Segoe UI;}}\\fs18\n"
                      + body + "\n}\n", encoding="ascii")
    return target


def write_wix_files(tree: Path, target: Path) -> tuple[int, int]:
    """The tree as WiX source, ComponentGroup ``AppFiles``: every folder one
    component, holding its files, with an HKCU value as key path and a
    RemoveFolder. Windows Installer asks that of a per-user package (ICE38,
    ICE64), so repair can tell the folder is installed and an uninstall
    removes every folder, the ones holding only folders included. IDs and
    GUIDs derive from the folder's path: a rebuild names everything the same.
    Returns (folders, files)."""
    from xml.sax.saxutils import quoteattr
    wxs = (HERE / "Overtone.wxs").read_text(encoding="utf-8")
    namespace = uuid.UUID(re.search(r'UpgradeCode="([0-9A-Fa-f-]{36})"', wxs).group(1))
    root = Path(".")
    folders = [root] + sorted((path.relative_to(tree) for path in tree.rglob("*")
                               if path.is_dir()), key=lambda rel: rel.parts)
    children: dict[Path, list[Path]] = {rel: [] for rel in folders}
    for rel in folders[1:]:
        children[rel.parent].append(rel)
    files: dict[Path, list[Path]] = {rel: [] for rel in folders}
    for path in sorted(tree.rglob("*")):
        if path.is_file():
            files[path.parent.relative_to(tree)].append(path)

    def ident(kind: str, rel: Path) -> str:
        return kind + hashlib.sha1(rel.as_posix().lower().encode("utf-8")).hexdigest()[:24]

    def folder_id(rel: Path) -> str:
        return "INSTALLFOLDER" if rel == root else ident("d", rel)

    lines = ['<?xml version="1.0" encoding="utf-8"?>',
             "<!-- Generated by installer\\build.py from the built tree. Do not edit. -->",
             '<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">', "  <Fragment>",
             '    <DirectoryRef Id="INSTALLFOLDER">']

    def directories(parent: Path, depth: int) -> None:
        for rel in children[parent]:
            head = f'{"  " * depth}<Directory Id="{folder_id(rel)}" Name={quoteattr(rel.name)}'
            if children[rel]:
                lines.append(head + ">")
                directories(rel, depth + 1)
                lines.append(f'{"  " * depth}</Directory>')
            else:
                lines.append(head + " />")

    directories(root, 3)
    lines += ["    </DirectoryRef>", '    <ComponentGroup Id="AppFiles">']
    for rel in folders:
        guid = str(uuid.uuid5(namespace, "folder:" + rel.as_posix().lower())).upper()
        lines += [f'      <Component Id="{ident("c", rel)}" Directory="{folder_id(rel)}" '
                  f'Guid="{{{guid}}}">',
                  '        <RegistryValue Root="HKCU" Key="Software\\Overtone\\Installer\\Folders" '
                  f'Name={quoteattr(str(rel))} Type="integer" Value="1" KeyPath="yes" />',
                  f'        <RemoveFolder Id="{ident("r", rel)}" On="uninstall" />']
        lines += [f'        <File Id="{ident("f", path.relative_to(tree))}" '
                  f"Source={quoteattr(str(path))} />" for path in files[rel]]
        lines.append("      </Component>")
    lines += ["    </ComponentGroup>", "  </Fragment>", "</Wix>"]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(folders), sum(len(listed) for listed in files.values())


def ice_findings(log: Path) -> dict[str, dict[str, int]]:
    """``wix msi validate``'s output, counted: {"error": {ICE: n}, "warning": ...}."""
    found: dict[str, dict[str, int]] = {"error": {}, "warning": {}}
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        hit = re.search(r"\b(error|warning) WIX\d+: (ICE\d+)", line)
        if hit:
            counts = found[hit.group(1)]
            counts[hit.group(2)] = counts.get(hit.group(2), 0) + 1
    return found


def write_zip(tree: Path, target: Path) -> None:
    """The tree under one top folder, so it unpacks into ``Overtone\\``, and the
    portable marker beside the executables: the ZIP alone is portable."""
    target.unlink(missing_ok=True)
    partial = target.with_name(target.name + ".part")
    with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(tree.rglob("*")):
            if path.is_file():
                archive.write(path, f"{tree.name}/{path.relative_to(tree).as_posix()}")
        archive.writestr(f"{tree.name}/{release.PORTABLE_MARKER}",
                         release.PORTABLE_NOTE.encode("ascii"))
    os.replace(partial, target)


def portable_listing(expected: dict[str, tuple[int, str]]) -> dict[str, tuple[int, str]]:
    """What the ZIP holds once unpacked: the tree and the marker beside it."""
    note = release.PORTABLE_NOTE.encode("ascii")
    return {**expected, release.PORTABLE_MARKER: (len(note), hashlib.sha256(note).hexdigest())}


def admin_image(msi: Path, target: Path, log: Path) -> Path:
    """The MSI's files, unpacked by an administrative install: Windows
    Installer lays them out and registers nothing. Returns the folder that
    holds Overtone.exe."""
    # One string: msiexec reads PROPERTY="value", not "PROPERTY=value".
    done = subprocess.run(f'msiexec /a "{msi}" /qn TARGETDIR="{target}" /l*v "{log}"',
                          timeout=1800)
    if done.returncode != 0:
        raise RuntimeError(f"msiexec /a exited {done.returncode}, see {log}")
    found = sorted(target.rglob(release.APP_EXE))
    if not found:
        raise RuntimeError(f"the administrative image in {target} holds no {release.APP_EXE}")
    return found[0].parent


def verify(name: str, tree: Path, expected: dict[str, tuple[int, str]], smoke) -> dict:
    """The unpacked copy against the built tree, file for file, then smoked."""
    got = listing(tree)
    differ = sorted(path for path in expected.keys() | got.keys()
                    if expected.get(path) != got.get(path))
    result = smoke.smoke(tree)
    print(f"  {name}: {len(got)} files, "
          + ("identical to the tree" if not differ else f"{len(differ)} DIFFER from the tree"))
    print("\n".join("    " + line for line in smoke.report_lines(result)), flush=True)
    return {"name": name, "files": len(got), "bytes": sum(size for size, _ in got.values()),
            "differ": differ, "smoke": result, "ok": not differ and result["ok"]}


def git_head() -> str:
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=release.ROOT,
                          capture_output=True, text=True).stdout.strip() or "unknown"
    dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"],
                           cwd=release.ROOT, capture_output=True, text=True).stdout.strip()
    return head + (" (with uncommitted changes)" if dirty else "")


def tool_line(dotnet: Path | None) -> str:
    rustc = subprocess.run(["rustc", "--version"], capture_output=True, text=True).stdout.split()
    parts = [f"Python {sys.version.split()[0]}",
             f"PyInstaller {metadata.version('pyinstaller')} "
             f"(hooks {metadata.version('pyinstaller-hooks-contrib')})",
             f"rustc {rustc[1] if len(rustc) > 1 else '?'}"]
    if dotnet is not None:
        sdk = subprocess.run([str(dotnet), "--version"], capture_output=True, text=True,
                             env=dotnet_env(dotnet)).stdout.strip()
        parts += [f".NET SDK {sdk}", f"WiX {wix_version()}"]
    return " · ".join(parts)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--no-msi", action="store_true", help="the tree and the ZIP only")
    parser.add_argument("--no-verify", action="store_true",
                        help="skip unpacking the MSI and the ZIP to smoke-test them")
    parser.add_argument("--clean", action="store_true", help="rebuild PyInstaller's cache")
    args = parser.parse_args()

    version = release.version()
    numbers = ".".join(str(n) for n in release.numeric_version(version))
    msi = release.DIST / f"Overtone-{version}-x64.msi"
    portable = release.DIST / f"Overtone-{version}-x64-portable.zip"

    missing = [f"wheels: {problem}" for problem in wheel_problems()]
    if shutil.which("cargo") is None:
        missing.append("cargo (the Rust toolchain) is not on PATH")
    else:
        # The licences travel with the binary, so a gap in them is not a
        # late failure: it is a reason not to build (roadmap 10.13.3).
        rows, broken = notices.components()
        offers = notices.listed().get("offers", [])
        missing += [f"notices: {problem}" for problem in
                    broken + notices.stale_versions(rows) + notices.problems(rows, offers)]
    dotnet = None
    if not args.no_msi:
        dotnet = find_dotnet()
        if dotnet is None:
            missing.append("no .NET SDK: install one per user with Microsoft's dotnet-install.ps1")
        else:
            tools = subprocess.run([str(dotnet), "tool", "run", "wix", "--", "extension", "list",
                                    "-g"], cwd=HERE, capture_output=True, text=True,
                                   env=dotnet_env(dotnet))
            if tools.returncode != 0:
                missing.append(f"WiX {wix_version()} is not restored: dotnet tool restore, "
                               "in installer\\")
            elif f"{WIX_EXTENSION} {wix_version()}" not in tools.stdout:
                missing.append(f"the WiX UI extension is not cached: dotnet tool run wix -- "
                               f"extension add -g {WIX_EXTENSION}/{wix_version()}")
    if missing:
        print("Cannot build yet (docs/11-msi-distribution.md, \"Building it\"):")
        print("\n".join("  - " + line for line in missing))
        return 2

    print(f"Overtone {version}, commit {git_head()}", flush=True)
    steps = Steps()
    total = time.perf_counter()
    steps.run("Rust engine (cargo)", ["cargo", "build", "--release", "-p", "overtone-cli"],
              release.ROOT)
    steps.run("PyInstaller", [sys.executable, "-m", "PyInstaller", str(HERE / "overtone.spec"),
                              "--distpath", str(release.DIST), "--workpath",
                              str(release.BUILD / "pyinstaller"), "--noconfirm"]
              + (["--clean"] if args.clean else []), release.ROOT)

    started = time.perf_counter()
    written = notices.write(release.TREE, version, rows, offers)
    steps.done(f"licence notices ({sum(len(row['texts']) for row in rows)} notices from "
               f"{len(rows)} components)", started)
    print("\n".join(f"    {file.name}: {file.stat().st_size / 1e3:.1f} kB"
                     for file in written), flush=True)

    # What this copy says it is, read by the window, the about box and the
    # diagnostics: stamped into the frozen code, so the build names itself.
    (release.TREE / release.CONTENTS / release.BUILD_INFO).write_text(
        json.dumps({"version": version, "commit": git_head(),
                    "built": datetime.now().strftime("%Y-%m-%d %H:%M")}, indent=1) + "\n",
        encoding="utf-8")

    import smoke  # imports the benchmark's renderer, and with it the engine
    started = time.perf_counter()
    tree_smoke = smoke.smoke(release.TREE)
    steps.done("smoke test, dist\\Overtone", started, ok=tree_smoke["ok"], why="see below")
    print("\n".join("    " + line for line in smoke.report_lines(tree_smoke)), flush=True)
    if not tree_smoke["ok"]:
        return 1

    ice: dict[str, dict[str, int]] = {}
    if not args.no_msi:
        msi.unlink(missing_ok=True)
        wix = release.BUILD / "wix"
        shutil.rmtree(wix, ignore_errors=True)
        folders, count = write_wix_files(release.TREE, wix / "files.wxs")
        rtf = write_licence_rtf(wix / "license.rtf")
        wix_run = [str(dotnet), "tool", "run", "wix", "--"]
        steps.run(f"MSI (WiX, {count} files in {folders} folders)",
                  wix_run + ["build", "Overtone.wxs", str(wix / "files.wxs"), "-arch", "x64",
                             "-ext", WIX_EXTENSION, "-d", f"SourceDir={release.TREE}",
                             "-d", f"Version={numbers}", "-d", f"LicenseRtf={rtf}",
                             "-intermediatefolder", str(wix / "obj"),
                             "-pdb", str(wix / "Overtone.wixpdb"), "-o", str(msi)],
                  HERE, env=dotnet_env(dotnet))
        # Windows Installer's own consistency evaluators; warnings are listed,
        # an error stops the build.
        started = time.perf_counter()
        log = LOGS / "msi-validation.log"
        with open(log, "wb") as handle:
            subprocess.run(wix_run + ["msi", "validate", str(msi), "-pdb",
                                      str(wix / "Overtone.wixpdb"), "-intermediatefolder",
                                      str(wix / "validate")],
                           cwd=HERE, env=dotnet_env(dotnet), stdout=handle,
                           stderr=subprocess.STDOUT)
        ice = ice_findings(log)
        steps.done("MSI validation (ICE)", started, ok=not ice["error"], why=f"see {log}")
        for level in ("error", "warning"):
            for name, n in sorted(ice[level].items()):
                print(f"    {level}: {name} x{n}")
        if ice["error"]:
            return 1
    started = time.perf_counter()
    write_zip(release.TREE, portable)
    steps.done("portable ZIP", started)

    # What a release publishes beside the two artefacts: the inventory an
    # audit reads, and the hashes anyone can check a download against
    # without trusting this machine.
    started = time.perf_counter()
    bom = release.DIST / f"Overtone-{version}-sbom.json"
    if sbom.write_cyclonedx(bom):
        return 1
    sums = release.DIST / f"Overtone-{version}-checksums.txt"
    published = ([msi] if not args.no_msi else []) + [portable, bom]
    sums.write_text(
        f"# Overtone {version}, SHA-256 of everything this release publishes.\n"
        f"# Check one file:   certutil -hashfile {published[0].name} SHA256\n"
        f"# Check them all:   sha256sum -c {sums.name}\n"
        + "".join(f"{sha256(path)}  {path.name}\n" for path in published),
        encoding="utf-8")
    steps.done(f"SBOM and checksums ({len(published)} files)", started)

    expected = listing(release.TREE)
    checks = []
    if not args.no_verify:
        with tempfile.TemporaryDirectory(prefix="overtone-verify-") as tmp:
            scratch = Path(tmp)
            if not args.no_msi:
                started = time.perf_counter()
                image = admin_image(msi, scratch / "msi", LOGS / "msiexec-admin.log")
                steps.done("MSI administrative install", started)
                checks.append(verify("MSI, installed files", image, expected, smoke))
            started = time.perf_counter()
            with zipfile.ZipFile(portable) as archive:
                archive.extractall(scratch / "zip")
            steps.done("ZIP unpacked", started)
            checks.append(verify("ZIP, unpacked", scratch / "zip" / release.TREE.name,
                                 portable_listing(expected), smoke))

    lines = [f"Overtone {version}, built {datetime.now():%Y-%m-%d %H:%M} from commit {git_head()}",
             f"toolchain: {tool_line(dotnet)}",
             f"tree: {len(expected)} files, {sum(s for s, _ in expected.values()) / 1e6:.1f} MB"]
    for artefact in published:
        lines.append(f"{artefact.name}: {artefact.stat().st_size / 1e6:.1f} MB, "
                     f"sha256 {sha256(artefact)}")
    lines.append(f"{sums.name}: the sha256 lines above, to hand to a downloader")
    if ice:
        findings = [f"{level} {name} x{n}" for level in ("error", "warning")
                    for name, n in sorted(ice[level].items())]
        lines.append("ICE validation: " + (", ".join(findings) if findings else "clean"))
    lines.append("steps: " + " · ".join(f"{name} {seconds:.1f} s"
                                          for name, seconds in steps.timings))
    lines.append(f"total: {time.perf_counter() - total:.1f} s")
    for check in [{"name": "dist\\Overtone", "smoke": tree_smoke, "differ": [],
                   "ok": tree_smoke["ok"]}] + checks:
        runs = ", ".join(
            f"{run['name']} " + (f"{run['bpm']:.4f} BPM" if run.get("bpm") is not None else
                                 f"{sum(c['ok'] for c in run.get('checks', []))}/"
                                 f"{len(run.get('checks', []))} checks")
            + f" in {run['seconds']:.1f} s" for run in check["smoke"]["runs"])
        lines.append(f"{check['name']}: {'ok' if check['ok'] else 'FAILED'}"
                     + (f", {len(check['differ'])} files differ" if check["differ"] else "")
                     + f"; {runs}")
    ok = tree_smoke["ok"] and all(check["ok"] for check in checks)
    lines.append("build: ok" if ok else "build: FAILED")
    summary = release.DIST / f"Overtone-{version}-build.txt"
    summary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n" + "\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
