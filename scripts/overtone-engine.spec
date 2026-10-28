# PyInstaller spec: overtone.exe, the v3 Python engine's command line
# (python/overtone.py), one folder, no window. Run it through the release
# script, which also lays the model and the version beside the executable and
# smoke-tests the result:
#
#     .venv\Scripts\python.exe scripts\release.py <version>
#
# Adapted from the desktop app's spec (branch parked/desktop-app,
# installer/overtone.spec) with the window, its page and the Rust engine left
# out. numba, llvmlite, librosa, soundfile, soxr and onnxruntime are collected
# by pyinstaller-hooks-contrib's own hooks, which is why no hidden import is
# listed: the parked build froze the same engine the same way.
#
# The engine looks for its data at the repository's layout, one folder above
# its code (python/overtone.py: ROOT = parent of the code's folder). Frozen,
# its code sits in _internal, so ROOT is the folder holding overtone.exe, and
# the release script copies assets/models/ and the version file there rather
# than into _internal.
import sys
from pathlib import Path

ROOT = Path(SPECPATH).resolve().parent
sys.path.insert(0, str(ROOT / "python"))
from overtone_paths import app_version  # noqa: E402  (standard library only)

from PyInstaller.utils.win32 import versioninfo as vi  # noqa: E402

VERSION = app_version()
NUMBERS = tuple(int(part) for part in VERSION.split("-", 1)[0].split(".")) + (0,)
NAME = "overtone"


def version_resource() -> vi.VSVersionInfo:
    """What Explorer's Details tab shows for the file."""
    strings = [vi.StringStruct("CompanyName", "Overtone"),
               vi.StringStruct("FileDescription", "Overtone command line (Python engine)"),
               vi.StringStruct("FileVersion", VERSION),
               vi.StringStruct("InternalName", NAME + ".exe"),
               vi.StringStruct("OriginalFilename", NAME + ".exe"),
               vi.StringStruct("ProductName", "Overtone"),
               vi.StringStruct("ProductVersion", VERSION)]
    return vi.VSVersionInfo(
        ffi=vi.FixedFileInfo(filevers=NUMBERS, prodvers=NUMBERS),
        kids=[vi.StringFileInfo([vi.StringTable("040904B0", strings)]),
              vi.VarFileInfo([vi.VarStruct("Translation", [0x0409, 1200])])])


cli = Analysis(
    [str(ROOT / "python" / "overtone.py")],
    pathex=[str(ROOT / "python")],
    binaries=[],
    datas=[],
    hiddenimports=[],
    # Nothing on the command line's path draws a window or a plot.
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "webview"],
    noarchive=False,
    optimize=0,
)
exe = EXE(
    PYZ(cli.pure), cli.scripts, [],
    exclude_binaries=True,
    name=NAME,
    icon=str(ROOT / "assets" / "logo.ico"),
    version=version_resource(),
    console=True,
)
COLLECT(exe, cli.binaries, cli.datas, name=NAME)
