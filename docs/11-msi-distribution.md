# MSI distribution — everything the app needs, in one installer

Overtone ships as a single **Windows MSI installer**, self-contained: no
internet connection required at install or at runtime, no external
dependencies beyond what Windows already provides, no user-managed model
downloads. The user double-clicks the `.msi`, clicks through Next / Install,
and every capability of the app is available immediately.

This is the concrete plan to build that, and, first, what of it is built.

---

## What is built — 2026-10-03

Sub-phases 10.13.1 (the build harness), 10.13.3 (the licences and the SBOM), 10.13.5 (the
portable ZIP) and 10.13.7 (the release checklist), with 10.13.2 (the WiX authoring) in
part: the install flow, per user, with the licence page, the Start menu shortcut, the
feature tree (`.osz` by default; audio associations and a desktop icon when picked),
but no Explorer menu, no `overtone://` scheme and no bare-`.osu` association — a map
without its song has nothing to analyse. **v0.1.0-alpha was published from this on
2026-10-03** — the first build anyone other than the author can install.

All of it is for the app as it is today: the Python engine and the web window, with the
Rust engine beside them. None of Phase 10's models exist yet, so none ship; the component
table below is still the plan for when they do.

One line, from a checkout, builds everything and checks it:

```
.venv\Scripts\python.exe installer\build.py            # --no-msi, --no-verify, --clean
```

| In `dist\` (git-ignored) | What it is |
|---|---|
| `Overtone\` | the tree: `Overtone.exe` (the window, what `Overtone.bat` starts), `overtone-py.exe` (the Python engine's command line, what `overtone.py` is in a checkout), and `_internal\`: Python 3.14, the wheels of `requirements.lock`, the app's own files and the Rust engine, `overtone-cli.exe` |
| `Overtone-0.1.0-alpha-x64.msi` | the installer: per user, no administrator, into `%LOCALAPPDATA%\Programs\Overtone`, with a Start menu shortcut and the licence on its second page; uninstalled from Windows' Apps list |
| `Overtone-0.1.0-alpha-x64-portable.zip` | the same tree in one `Overtone` folder |
| `Overtone-0.1.0-alpha-sbom.json` | CycloneDX 1.6: every wheel, crate and native component with its version, licence and origin |
| `Overtone-0.1.0-alpha-checksums.txt` | the SHA-256 of the three above, with the commands to check them |
| `Overtone-0.1.0-alpha-build.txt` | the toolchain, sizes, SHA-256, every step's time and the smoke results |

The tree itself carries `LICENSE.txt` and `THIRD-PARTY-NOTICES.txt` in its root, written
by `installer\notices.py` from the build's own files (see "Licences and the SBOM").

What the script does, in order, each step timed and logged to `build\logs`:

1. refuses to start if the venv's wheels differ from `requirements.lock` or
   `installer\requirements-build.lock` (the bundle carries what the venv holds, and the
   locks are what was measured), if a tool is missing, or if a bundled licence has no
   notice (`installer\notices.py --check`) — naming which, in every case. A notice that is
   missing is a reason not to build the artefact, not a late failure after twenty minutes;
2. `cargo build --release -p overtone-cli`;
3. PyInstaller, `installer\overtone.spec`: two executables over one `_internal`. The app's
   files (`app\`, `assets\logo.*`, `assets\samples\`, `profiles\`, `python\library.sql`, listed
   once in `installer\release.py`) land at their repository paths, which is where the code
   looks for them; the Rust engine lands beside the modules, where `overtone_rust` looks,
   and beside the MSVC runtime it links;
4. the smoke test on the tree (below);
5. the MSI, with WiX 5.0.2: `installer\Overtone.wxs`, plus the file list that the script
   writes from the tree (one component per folder, an HKCU value as its key path and a
   `RemoveFolder`) and the licence page rendered to RTF from the repository's `LICENSE`,
   then Windows Installer's own validation (ICE), where an error stops the build;
6. the ZIP, the SBOM and the checksums;
7. both unpacked in temporary folders — the MSI by an administrative install
   (`msiexec /a … /qn`, which lays the files out and registers nothing), the ZIP by
   extraction — each compared with the tree file by file (size and SHA-256), and each
   smoke-tested.

**The smoke test** (`installer\smoke.py [TREE]`, also runnable on its own) needs no window
and plays nothing. With a scratch profile (USERPROFILE, LOCALAPPDATA, APPDATA, TEMP and TMP
in a temporary folder, PATH holding only Windows' folders) it runs `overtone-py.exe` and
`_internal\overtone-cli.exe` on the benchmark's `edm-174` case, each of which must read
174 BPM within the benchmark's 0.05, and `Overtone.exe --self-check REPORT.json` (the
window's executable has no console, so the verdict goes to the file and the exit code;
anyone can run it on an installed copy). The self-check is
the window's own executable looking for everything it reads where the code looks for it
(page, icon, samples, library schema), loading the window's libraries without opening a
window (pythonnet and the WebView2 assemblies; it fails if the WebView2 runtime is
missing), and running both engines on twenty seconds of clicks at 150 BPM, the Rust one
through the same sidecar call the app makes. The tree must come out byte for byte as it
went in: a program that writes into its own folder leaves files an uninstall does not
remove.

**Measured** on 2026-10-03, `build.py --clean` at commit `c505211` on this machine —
**the build v0.1.0-alpha was published from**:

| | |
|---|---|
| Tree | 1670 files, 316.8 MB unpacked: llvmlite (numba's compiler) and scipy are still the two largest parts, and the licence notices add 1.08 MB |
| MSI | **112.2 MB** (WiX's "high" compression), sha256 `6b2b147b…254b`; unpacked, the same 1670 files |
| ZIP | **138.1 MB** (deflate, level 9), sha256 `1b28a764…ec79`; unpacked, the same 1670 files |
| SBOM | 87 components, sha256 `b7deca7f…7fb5` |
| ICE validation | no error; warnings: ICE91 ×1670 (files in a per-user folder, as intended) and ICE61 ×1 (a rebuild of the same version replaces the installed one, as intended) |
| Build | **325.7 s** in all: cargo 0.2 s (already built), PyInstaller 109.5 s, licence notices 0.0 s, smoke 18.1 s, MSI 106.6 s, ICE 11.9 s, ZIP 12.7 s, SBOM and checksums 1.0 s, administrative install 5.8 s, unzip 2.3 s |
| Toolchain | Python 3.14.4 · PyInstaller 6.22.3 (hooks 2026.7) · rustc 1.98.1 · .NET SDK 10.0.401 · WiX 5.0.2 |

| Smoke test | `overtone-py.exe`, edm-174 | `_internal\overtone-cli.exe`, edm-174 | `Overtone.exe --self-check` |
|---|---|---|---|
| `dist\Overtone` | 174.0000 BPM, 8.8 s | 174.0000 BPM, 0.3 s | 8 of 8, 8.8 s |
| the MSI's files (administrative install) | 174.0000 BPM, 3.3 s | 174.0000 BPM, 0.3 s | 8 of 8, 8.8 s |
| the ZIP, unpacked | 174.0000 BPM, 3.2 s | 174.0000 BPM, 0.3 s | 8 of 8, 8.6 s |

All three copies were byte for byte identical to the tree (size and SHA-256 of every file)
and came out of their runs unchanged; the scratch profile received numba's cache (2 files,
8 kB) and nothing else.

Two numbers moved a long way from the 2026-09-26 build (734 files, 314.5 MB, 1296 s) and
both have a reason. The **file count more than doubled** because this machine's Python
3.14.4 carries Tcl/Tk **8.6**, whose script library is a folder of files
(`_tcl_data`, `_tk_data`, `tcl8`), where the Python of the earlier build carried Tk 9 with
its scripts inside the DLL. The **build got four times faster** (PyInstaller 109.5 s
against 486 s, the MSI 106.6 s against 317 s) because that build shared the machine with
other work and this one did not; the earlier note that its timings vary by up to a third
between runs understated it.

The MSI's own tables, read back out of the package: `ProductName` Overtone,
`ProductVersion` 0.1.0, the `UpgradeCode` unchanged, and the dialog chain
WelcomeDlg → **LicenseAgreementDlg** → InstallDirDlg → VerifyReadyDlg with
`LicenseAccepted = "1"` on the Next. The licence text is in the `Control` table as the
page's `ScrollableText`, not in the `Binary` table where a bitmap would be — worth
writing down, because looking in the wrong one of the two is a convincing way to conclude
the page is blank.

Not exercised, since it opens windows: the app's window itself, and the classic Tk window
(`overtone-py.exe` with no arguments). The Tk window's toolkit does ship — `tcl86t.dll`,
`tk86t.dll`, `_tkinter.pyd` and the `_tcl_data`, `_tk_data` and `tcl8` script folders,
Tcl/Tk 8.6 as this machine's Python 3.14.4 carries it. The 2026-09-26 build was made with
a Python carrying Tk 9, whose scripts live inside the DLL; that is where this document's
earlier claim that the tree has no `_tcl_data` folder came from, and it is not true of
the published build.

**Not built yet**, so none of it is claimed:

- **Code signing** (10.13.6), out of scope here: the MSI and the executables are unsigned,
  so SmartScreen can be expected to warn on a downloaded copy (not tried).
- **Windows integration beyond the Start menu, the licence page and the feature
  tree** (the rest of 10.13.2): no Explorer menu or `overtone://` scheme, and no bare-`.osu`
  association. The tree offers `.osz`, the five audio kinds and a desktop icon.
- **The portable `data\` folder**: the ZIP's copy keeps its settings and cache where the
  installed one does (see "User data locations"), not beside the executable.
- **An install and uninstall on a real profile**: not exercised here, by instruction; the
  build proves the MSI's files (administrative install), its tables (ICE, above) and its
  authoring, not the install itself. The first real install is worth a before-and-after
  listing of `%LOCALAPPDATA%\Programs` and the Start menu.
- **WiX 6 or 7**: their NuGet packages require accepting the Open Source Maintenance Fee
  EULA (`requireLicenseAcceptance` true, licence file `OSMFEULA.txt`): whoever accesses or
  uses the binaries "agrees to be bound by the terms of this Agreement", and a fee applies
  to users who use WiX in revenue-generating activities with US$10,000 or more of annual
  gross revenue. That is the maintainer's decision, not the build's, so the build pins
  5.0.2, which is MS-RL alone and requires no acceptance.

### Building it

Once, per user, with no administrator and nothing on `PATH` changed (PowerShell, from the
repository):

```
.venv\Scripts\python.exe -m pip install -r installer\requirements-build.lock
powershell -ExecutionPolicy Bypass -File dotnet-install.ps1 -Version 10.0.401 -NoPath
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"; $env:DOTNET_ADD_GLOBAL_TOOLS_TO_PATH = "false"
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = "false"; $env:DOTNET_NOLOGO = "1"
$dotnet = "$env:LOCALAPPDATA\Microsoft\dotnet\dotnet.exe"
cd installer; & $dotnet tool restore
& $dotnet tool run wix -- extension add -g WixToolset.UI.wixext/5.0.2
```

`dotnet-install.ps1` is Microsoft's script (https://dot.net/v1/dotnet-install.ps1,
Authenticode-signed by Microsoft); it puts the SDK in `%LOCALAPPDATA%\Microsoft\dotnet`,
where `build.py` looks first. The four variables keep the SDK's telemetry off and stop its
first run from adding a folder to `PATH` or a development certificate to the store; they
must be set before any `dotnet` command, since one run without them is enough (it happened
here once: see the timeline). `build.py` sets them, and turns off update checks, for every
`dotnet` it runs.
`dotnet tool restore` reads `installer\dotnet-tools.json`, which pins WiX 5.0.2; the UI
extension goes to `%USERPROFILE%\.wix\extensions`. The Rust toolchain is the one CLAUDE.md
names. After this the build needs no network, and `--no-msi` needs neither .NET nor WiX.

### Publishing a release (10.13.7)

The checklist, in order. Nothing here is automated on purpose: a release is the one thing
in this repository that cannot be taken back, and a person should have read each line.

1. **The version.** `Cargo.toml`'s `[workspace.package] version` is the release's version
   and the only place it is written: the artefacts' names, the MSI's numeric version and
   both executables' version resources all come from it through `installer\release.py`.
   Bump it in its own commit, and remember the sixteen inter-crate pins move with it.
2. **The gates, on the commit that will be tagged.** All of CLAUDE.md's "Verification",
   plus `cargo test --workspace` and the five `overtone-bench` modes. A release is not the
   place to find out which gate was skipped.
3. **The licences.** `installer\sbom.py --check` and `installer\notices.py --check`.
   The build runs the second one in its preflight anyway, but run it first: a new
   dependency's missing notice is cheaper to answer before a twenty-minute build.
4. **`installer\build.py --clean`**, then read `dist\Overtone-<version>-build.txt` and
   not just the exit code. Three smoke tests must say `ok` (the tree, the MSI's files, the
   ZIP's), ICE must report no error, and no file may differ between the tree and either
   artefact.
5. **Install it, for real.** The build proves the MSI's files and tables, never the
   install. List `%LOCALAPPDATA%\Programs` and the Start menu folder before and after,
   install, open the app, uninstall, and list them again: the uninstall must leave the
   program folder gone and the user's own data untouched.
6. **Tag and publish.** `git tag -a v<version>`, push it, and
   `gh release create v<version> --prerelease` with the five files of the table at the top
   of this document. An alpha is a pre-release on GitHub, which is what keeps it off the
   "latest release" badge.
7. **What the notes must say**, because the artefact cannot: that it is **unsigned** and
   SmartScreen will warn; the `certutil -hashfile` line to check the download against the
   checksums; what the app writes and where; and what it deliberately does not do (no
   network, no auto-update, no file associations).
8. **Afterwards**, in the same pull request as the release or the next one: the roadmap's
   10.13 row, the README's two installer lines, and a `timeline.md` entry carrying the
   artefacts' sizes and SHA-256 — the numbers are the only way a later reader can tell
   which build a download came from.

## What the installer bundles

Every piece of code and every trained model that Phase 10 needs, so no runtime
download is ever required.

Sizes and licences re-checked on 2026-09-23 (see the licence audit in
`10-precision-plan.md`). The totals further down predate that check: they
still count ~500 MB of Demucs weights that no longer ship. Today's build (above) holds
the rows that exist, the app, the Python runtime, the DSP wheels and libsndfile, plus
numba's llvmlite (120 MB of the tree, the largest single part), scikit-learn (which
librosa brings), pythonnet and the WebView2 assemblies for the window, and the Rust
engine: 314.5 MB unpacked.

| Component | Size | Licence | Purpose |
|---|---:|---|---|
| Overtone Python source | ~5 MB | MIT | the app |
| Python embedded 3.14 runtime | ~30 MB | PSF | Python without a system install |
| PyTorch CPU 2.x | ~200 MB | BSD-3 | run BeatThis and Demucs on CPU |
| Beat This! weights + inference | ~78 MB (small model ~8 MB) | MIT, code and weights | neural beat & downbeat tracking |
| ~~Demucs v4 weights~~ | — | weights "only for scientific purposes" | **not bundled**; the HPSS percussive part (built in) replaces it |
| madmom + models (fallback) | size to measure | code BSD, models CC BY-NC-SA 4.0 | fallback; free app only, with attribution |
| librosa + scipy + numpy | ~120 MB | ISC / BSD | DSP baseline |
| Chromaprint DLL | ~2 MB | LGPL-2.1 | fingerprint against the user's own `osu!/Songs` |
| soundfile / libsndfile | ~2 MB | LGPL-2.1 | audio decode |
| FFmpeg CLI (optional) | ~80 MB | LGPL-2.1 | MP3/M4A fallback for what Symphonia doesn't decode |
| App icons, sounds, samples | ~5 MB | MIT | click track, UI icons |
| Documentation and licence texts | ~2 MB | project | full third-party notices |

**Estimated total: 1.15–1.25 GB.**

Two options for how that lands in the user's storage after install:

- **Full**: everything installs to `%ProgramFiles%\Overtone\`, ~1.2 GB.
- **Optional components**: user picks between "Standard" (BeatThis only, ~700 MB)
  and "Full" (BeatThis + madmom + Demucs, ~1.2 GB) in the installer's Custom
  Setup screen.

## How the installer is built

### Toolchain

- **WiX Toolset** (MS-RL; releases need the Open Source Maintenance Fee
  EULA, with a fee if used to generate revenue) — the industry-standard MSI builder. Turns a
  declarative XML into a signed `.msi`. Built with **5.0.2**, the last release under MS-RL
  alone: 6.x and 7.x (7.0.0 on 2026-09-26) ship the OSMF EULA and ask for its acceptance, a
  decision left to the maintainer (see "What is built").
- **PyOxidizer** or **PyInstaller** — bundle Python plus the app into a single
  redistributable directory tree.
  - PyInstaller is more mature and better documented.
  - PyOxidizer produces smaller and faster startup but is finicky with PyTorch.
  - Decision: PyInstaller for the first release; evaluate PyOxidizer for v4.
    **PyInstaller 6.22.3** freezes Python 3.14.7 and every wheel of the lock, numba and
    pythonnet included, with the hooks it ships.
- **A code-signing certificate** — required for Windows SmartScreen to not
  warn on install. Options in order of cost:
  1. **Self-signed** for beta releases (SmartScreen will still warn).
  2. **OV certificate** (~$100/year via SSL.com, Certum, DigiCert).
  3. **EV certificate** (~$400/year) — no SmartScreen warning even on first
     download, requires a hardware token.
  4. **Azure Trusted Signing** ($10/month, Microsoft-managed) — cheapest way
     to get past SmartScreen.

### Structure

As built (PyInstaller's onedir layout; the MSI installs it, the ZIP holds it):

```
Overtone\
├─ Overtone.exe                 # the window (no console)
├─ overtone-py.exe              # the Python engine's command line, as overtone.py
└─ _internal\                   # PyInstaller's contents folder
   ├─ python314.dll, base_library.zip, VCRUNTIME140*.dll …
   ├─ numpy\ scipy\ librosa\ numba\ llvmlite\ sklearn\ webview\ pythonnet\ …
   ├─ app\  assets\  profiles\  python\library.sql  # the app's files, at their repo paths
   └─ overtone-cli.exe          # the Rust engine, where overtone_rust finds it
```

The Python command line is not called `overtone-cli.exe`, as the plan had it: that is the
Rust engine's name, and both ship. The Rust engine sits in `_internal` rather than beside
`Overtone.exe` because it links the MSVC runtime (`VCRUNTIME140.dll`), which PyInstaller
copies there; beside it, the DLL is found without relying on a copy in `System32`.
Uninstalling is Windows Installer's own, so there is no `uninstall.exe`.

Planned for when Phase 10's models land:

```
Overtone\
├─ models\
│  ├─ beat_this.pt              # BeatThis weights
│  ├─ htdemucs.pt               # Demucs weights
│  ├─ madmom\                   # madmom models
│  └─ manifest.json             # hash / version / licence per model
├─ ffmpeg\                      # optional, for MP3/M4A fallback
└─ docs\                        # licences + user manual
```

Every model file is checksummed and its checksum verified at first launch.
Missing or corrupt files trigger a clear error, never a silent download.

## Windows integration

Built: 1 (the shortcut carries the app's taskbar identity, `Overtone.TimingWorkbench`, so
the running window groups under it) and 6. The rest is not built yet.

1. **Start Menu entry**: `Overtone`, launches the GUI.
2. **Desktop shortcut**: in the Typical/Complete/Custom tree, off unless picked.
3. **File associations**, each its own feature in the tree (Typical takes `.osz`;
   Complete takes all; `ADDLOCAL` names them on a quiet install):
    - `.osz` — "Import into Overtone" (the archive is copied into Songs, never moved)
    - `.mp3`, `.ogg`, `.flac`, `.wav`, `.m4a` — "Analyze with Overtone"
    - A bare `.osu` is deliberately not associated: with no song beside it there
      is nothing to analyse, and the Train view picks maps that have one.
4. **Right-click context menu** in Explorer: "Analyze with Overtone". Not built.
5. **URI scheme**: `overtone://` for deep links (e.g. from a browser plugin). Not built.
6. **Uninstall via Windows Settings** or the classic Control Panel entry.

## Update path

- The installer detects a previous Overtone install by its Upgrade Code
  (a fixed GUID for the whole product family): `EE97BBEC-80EB-4D3C-BE6D-5963826D82CA`,
  in `installer\Overtone.wxs`. Never change it.
- New versions install cleanly over old ones (a major upgrade; a rebuild of the same
  version replaces the installed one too), preserving the user's data, below, which no
  install or uninstall touches.
- Planned, not built: the app checks a local file for the installed version at start;
  there is no network update check. Users see a "new version available" banner only if
  they open the app after a manual update.

## User data locations

Where the app keeps what it writes, as of 2026-09-26 (the plan had `%APPDATA%\Overtone\`
for settings; the code never used it):

- `%USERPROFILE%\.overtone.json` — settings and recents, shared by the window and the
  classic Tk window (`~\.timing_analyzer.json`, the old name, is still read).
- `%LOCALAPPDATA%\Overtone\` — `cache\` (analysis results keyed by the audio's SHA-256,
  ten entries and 50 MB at most, purgeable in Settings), `writes.jsonl` (the write
  history), `library.sqlite3` (the library index), `drops\` (files dropped on the window)
  and `webview\` (the window's browser storage).
- `%USERPROFILE%\Documents\Overtone\` — exports, unless told otherwise.
- `<name>.osu.bak` (then `.bak2`, `.bak3`…) beside each beatmap it writes.
- `%LOCALAPPDATA%\numba\Cache\` — frozen builds only: numba's compiled librosa
  functions, keyed to the executable. A frozen module has no source file on disk, so numba
  uses its user-wide cache there instead of a `__pycache__` beside the code (the smoke test
  lists it: two files, 8 kB, after one analysis).

The installer creates none of these and removes none of them: the app creates them when
it first needs them, outside the program folder, and writes nothing into the program
folder itself (the smoke test checks that, in the tree, the MSI's files and the ZIP's).
Everything the MSI does write, its uninstall is authored to remove (not yet run on a real
profile): the program folder, the Start menu shortcut, and its own bookkeeping key,
`HKCU\Software\Overtone\Installer`.

## The audit trail

Every installer produces:

1. **The signed `.msi`** — the artefact users get.
2. **A SHA-256 checksum file** — for offline verification.
3. **A software bill of materials (SBOM)** in CycloneDX format — every
   bundled dependency, its version, its licence, its source. This is what
   makes the LGPL, CC-BY and CC BY-NC-SA obligations reviewable.
4. **A build log** — every wheel, every model, every checksum, reproducibly.

These four are the reason a user can install this on a work machine or a
managed PC and defend the audit: nothing is fetched at runtime, nothing is
undocumented.

## Portable variant

A parallel **portable ZIP** ships alongside the MSI. Same tree, packaged in
a ZIP the user unpacks anywhere:

- No registry entries, no file associations, no Start Menu.
- Reads settings and cache from a `data\` subfolder next to the executable,
  not from `%APPDATA%`. **Not built yet**: today's ZIP keeps them where the installed
  copy does (see "User data locations"), so the two share settings and cache.
- Useful for USB sticks, sandbox testing, and machines where the user cannot
  install software.
- Same 1.2 GB, unpacked to ~1.4 GB on disk. As built, without models: 138.4 MB, unpacked
  to 314.5 MB (the MSI: 113.0 MB).

## Size reduction options

If 1.2 GB is a problem for distribution (some hosting has limits), the tools
to shrink it, ranked by risk:

1. **INT8 quantisation** of BeatThis and Demucs. Halves model size (~275 MB
   saved). Small accuracy hit (~0.5 % on BeatThis benchmarks, negligible on
   Demucs SDR). **Recommended default.**
2. **ONNX Runtime** in place of PyTorch. Saves ~150 MB. Requires converting
   the models, and Demucs has custom ops that need adapters. **Recommended
   long-term.**
3. **Drop madmom** as a bundled fallback (BeatThis is more accurate anyway).
   Saves ~200 MB. **Recommended.** madmom becomes an optional pip install for
   users who want it for research parity.
4. **Ship only the drums stem model of Demucs**, not the full four-source
   model. Saves ~350 MB. **Recommended.** Overtone only needs drums.
5. **Distillation** of Demucs into a smaller model trained just for drums.
   Saves ~400 MB. Larger accuracy hit (~1 dB SDR). Only worth it if size is
   critical.

With 1 + 3 + 4, the installer drops to **~450 MB**. That fits on any hosting.

## Build automation

The whole release process reproducibly, from a fresh checkout:

```
scripts\build_release.py --version 4.0.0 --sign --output dist\
```

Produces:

- `dist\Overtone-4.0.0-x64.msi`
- `dist\Overtone-4.0.0-x64-portable.zip`
- `dist\Overtone-4.0.0-checksums.txt`
- `dist\Overtone-4.0.0-sbom.json`
- `dist\Overtone-4.0.0-buildlog.txt`

The script pins every wheel and every model version, so a build at commit X
today produces byte-identical artefacts to a build at commit X in a year.

As built, `installer\build.py` (see "What is built") is this script without signing, the
SBOM or models: it produces the tree, the MSI, the ZIP and a build summary holding the
SHA-256 of both artefacts, the toolchain's versions, every step's time and the smoke
results, while `build\logs\` keeps each step's full output. It refuses a venv whose wheels
differ from the two locks, so the wheel set is reproducible. The artefacts are not
byte-identical from build to build: WiX gives every build of the MSI a new package code
(two builds here: `{D5481272-…}`, then `{133122E1-…}`), which is 10.13.7's to settle.

## Cost summary

- **Code-signing certificate**: $0 self-signed / $10/month Azure Trusted
  Signing / $100–400/year commercial CA.
- **Distribution hosting**: GitHub Releases handles 2 GB per file, free.
- **CDN for updates**: not needed — no network update path.
- **Build machine**: a single Windows dev box; the whole build runs in
  ~5 minutes. Measured on 2026-09-26, without models: 22 minutes for a clean build on a
  busy machine, 8 of them PyInstaller's and 5 WiX's compression, and 32 minutes under
  heavier load (see "What is built").

Zero recurring cost if the beta releases stay self-signed and hosting stays
on GitHub Releases.

## Timeline within Phase 10

- **10.13.1** — build harness: PyInstaller wrapper, reproducible wheel set,
  first unsigned MSI. **2 days.** **Built 2026-09-26.**
- **10.13.2** — WiX authoring: install flow, custom setup screen, file
  associations, uninstall. **3 days.** **Partly built 2026-09-26**: the install flow
  (welcome, folder, install), per user, the Start menu shortcut, uninstall; no custom
  setup screen or file associations.
- **10.13.3** — model manifest and integrity checks: checksums, licence
  packaging, SBOM. **1 day.** The artefacts' SHA-256 is in the build summary; nothing
  else yet.
- **10.13.4** — size reduction: quantise models, drop madmom, ship
  Demucs-drums-only. **2 days.**
- **10.13.5** — portable ZIP variant. **1 day.** **Built 2026-09-26**, without the
  `data\` folder.
- **10.13.6** — code signing: obtain certificate, integrate into build,
  document the signed release process. **2 days.**
- **10.13.7** — build automation script + release checklist. **1 day.**

Total: **~12 days** on top of Phase 10.

## What this specifically does not include

- **Cross-platform installers.** macOS `.pkg` and Linux `.AppImage` are
  possible but out of scope for this document. The precision plan runs on
  those platforms in principle (every dependency is portable), but the
  installer is Windows-first.
- **Store distribution.** Microsoft Store and Winget submission are not
  planned. Direct MSI download from GitHub Releases is enough.
- **Auto-update.** Deliberately not implemented. Overtone has no network
  requirements, so silent auto-update would be a policy change. Users
  update by downloading and re-running the new installer.
