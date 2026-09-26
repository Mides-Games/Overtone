# PyInstaller spec: Overtone.exe (the web shell window) and overtone-py.exe
# (the Python engine's command line) in one folder, sharing one _internal.
#
# Run it through the build script, which builds the Rust engine first:
#
#     .venv\Scripts\python.exe installer\build.py
#
# Two Analyses and one COLLECT is PyInstaller's supported way to ship two
# executables over one set of libraries: each executable carries its own
# bytecode, the DLLs and data files are collected once.
import sys
from pathlib import Path

sys.path.insert(0, SPECPATH)
import release  # noqa: E402  (installer/release.py)

from PyInstaller.utils.win32 import versioninfo as vi  # noqa: E402

ROOT = release.ROOT
VERSION = release.version()
NUMBERS = release.numeric_version(VERSION) + (0,)
RUST = ROOT / "target" / "release" / release.RUST_CLI
if not RUST.is_file():
    raise SystemExit(f"{RUST} is missing: cargo build --release -p overtone-cli")


def version_resource(description: str, name: str) -> vi.VSVersionInfo:
    """What Explorer's Details tab and Task Manager show for the file."""
    strings = [vi.StringStruct("CompanyName", "Overtone"),
               vi.StringStruct("FileDescription", description),
               vi.StringStruct("FileVersion", VERSION),
               vi.StringStruct("InternalName", name),
               vi.StringStruct("OriginalFilename", name),
               vi.StringStruct("ProductName", "Overtone"),
               vi.StringStruct("ProductVersion", VERSION)]
    return vi.VSVersionInfo(
        ffi=vi.FixedFileInfo(filevers=NUMBERS, prodvers=NUMBERS),
        kids=[vi.StringFileInfo([vi.StringTable("040904B0", strings)]),
              vi.VarFileInfo([vi.VarStruct("Translation", [0x0409, 1200])])])


def analysis(script: str) -> Analysis:
    return Analysis(
        [str(ROOT / script)],
        pathex=[str(ROOT)],
        binaries=[(str(RUST), ".")],
        datas=release.data_files(),
        hiddenimports=[],
        excludes=[],
        noarchive=False,
        optimize=0,
    )


app = analysis("overtone_web.py")
cli = analysis("overtone.py")

app_exe = EXE(
    PYZ(app.pure), app.scripts, [],
    exclude_binaries=True,
    name=Path(release.APP_EXE).stem,
    icon=str(ROOT / "assets" / "logo.ico"),
    version=version_resource("Overtone", release.APP_EXE),
    console=False,
    contents_directory=release.CONTENTS,
)
cli_exe = EXE(
    PYZ(cli.pure), cli.scripts, [],
    exclude_binaries=True,
    name=Path(release.CLI_EXE).stem,
    icon=str(ROOT / "assets" / "logo.ico"),
    version=version_resource("Overtone command line (Python engine)", release.CLI_EXE),
    console=True,
    contents_directory=release.CONTENTS,
)
COLLECT(
    app_exe, app.binaries, app.datas,
    cli_exe, cli.binaries, cli.datas,
    name=release.TREE.name,
)
