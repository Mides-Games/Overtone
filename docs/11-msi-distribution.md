# MSI distribution — everything the app needs, in one installer

Overtone ships as a single **Windows MSI installer**, self-contained: no
internet connection required at install or at runtime, no external
dependencies beyond what Windows already provides, no user-managed model
downloads. The user double-clicks the `.msi`, clicks through Next / Install,
and every capability of the app is available immediately.

This is the concrete plan to build that.

---

## What the installer bundles

Every piece of code and every trained model that Phase 10 needs, so no runtime
download is ever required.

| Component | Size | Licence | Purpose |
|---|---:|---|---|
| Overtone Python source | ~5 MB | MIT | the app |
| Python embedded 3.14 runtime | ~30 MB | PSF | Python without a system install |
| PyTorch CPU 2.x | ~200 MB | BSD-3 | run BeatThis and Demucs on CPU |
| BeatThis weights + inference | ~50 MB | MIT + CC-BY-4.0 | neural beat & downbeat tracking |
| Demucs v4 (htdemucs) weights | ~500 MB | MIT + CC-BY-NC | source separation |
| madmom + models (fallback) | ~200 MB | MPI-2.0 | fallback if BeatThis is disabled |
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

- **WiX Toolset v5** (MIT) — the industry-standard MSI builder. Turns a
  declarative XML into a signed `.msi`.
- **PyOxidizer** or **PyInstaller** — bundle Python plus the app into a single
  redistributable directory tree.
  - PyInstaller is more mature and better documented.
  - PyOxidizer produces smaller and faster startup but is finicky with PyTorch.
  - Decision: PyInstaller for the first release; evaluate PyOxidizer for v4.
- **A code-signing certificate** — required for Windows SmartScreen to not
  warn on install. Options in order of cost:
  1. **Self-signed** for beta releases (SmartScreen will still warn).
  2. **OV certificate** (~$100/year via SSL.com, Certum, DigiCert).
  3. **EV certificate** (~$400/year) — no SmartScreen warning even on first
     download, requires a hardware token.
  4. **Azure Trusted Signing** ($10/month, Microsoft-managed) — cheapest way
     to get past SmartScreen.

### Structure

```
Overtone/
├─ Overtone.exe                 # PyInstaller wrapper, launches the GUI
├─ overtone-cli.exe             # PyInstaller wrapper for the CLI
├─ python\
│  ├─ python.dll                # Python runtime
│  ├─ site-packages\            # every wheel the app needs
│  └─ overtone\                 # the actual app
├─ models\
│  ├─ beat_this.pt              # BeatThis weights
│  ├─ htdemucs.pt               # Demucs weights
│  ├─ madmom\                   # madmom models
│  └─ manifest.json             # hash / version / licence per model
├─ ffmpeg\                      # optional, for MP3/M4A fallback
├─ docs\                        # licences + user manual
└─ uninstall.exe
```

Every model file is checksummed and its checksum verified at first launch.
Missing or corrupt files trigger a clear error, never a silent download.

## Windows integration

1. **Start Menu entry**: `Overtone`, launches the GUI.
2. **Desktop shortcut**: optional, checkbox in installer.
3. **File associations** (opt-in, checkbox in installer):
   - `.mp3`, `.ogg`, `.flac`, `.wav`, `.m4a` — "Analyze with Overtone"
   - `.osu` — "Open with Overtone" for map validation
   - `.osz` — "Import into Overtone"
4. **Right-click context menu** in Explorer: "Analyze with Overtone".
5. **URI scheme**: `overtone://` for deep links (e.g. from a browser plugin).
6. **Uninstall via Windows Settings** or the classic Control Panel entry.

## Update path

- The installer detects a previous Overtone install by its Upgrade Code
  (a fixed GUID for the whole product family).
- New versions install cleanly over old ones, preserving `%APPDATA%\Overtone\`
  (settings, project history, license state).
- The app checks a local file for the installed version at start; there is no
  network update check. Users see a "new version available" banner only if
  they open the app after a manual update.

## User data locations

- `%APPDATA%\Overtone\` — settings, per-user preferences, recents.
- `%APPDATA%\Overtone\projects\` — saved project files.
- `%LOCALAPPDATA%\Overtone\cache\` — analysis cache keyed by
  `blake3(audio bytes)`. Purgeable from within the app; automatic cap at
  10 GB.
- `%LOCALAPPDATA%\Overtone\logs\` — diagnostic logs. Rolling, 30 days.

The installer creates none of these; the app creates them on first run.

## The audit trail

Every installer produces:

1. **The signed `.msi`** — the artefact users get.
2. **A SHA-256 checksum file** — for offline verification.
3. **A software bill of materials (SBOM)** in CycloneDX format — every
   bundled dependency, its version, its licence, its source. This is what
   makes the LGPL and CC-BY-NC obligations reviewable.
4. **A build log** — every wheel, every model, every checksum, reproducibly.

These four are the reason a user can install this on a work machine or a
managed PC and defend the audit: nothing is fetched at runtime, nothing is
undocumented.

## Portable variant

A parallel **portable ZIP** ships alongside the MSI. Same tree, packaged in
a ZIP the user unpacks anywhere:

- No registry entries, no file associations, no Start Menu.
- Reads settings and cache from a `data\` subfolder next to the executable,
  not from `%APPDATA%`.
- Useful for USB sticks, sandbox testing, and machines where the user cannot
  install software.
- Same 1.2 GB, unpacked to ~1.4 GB on disk.

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

## Cost summary

- **Code-signing certificate**: $0 self-signed / $10/month Azure Trusted
  Signing / $100–400/year commercial CA.
- **Distribution hosting**: GitHub Releases handles 2 GB per file, free.
- **CDN for updates**: not needed — no network update path.
- **Build machine**: a single Windows dev box; the whole build runs in
  ~5 minutes.

Zero recurring cost if the beta releases stay self-signed and hosting stays
on GitHub Releases.

## Timeline within Phase 10

- **10.13.1** — build harness: PyInstaller wrapper, reproducible wheel set,
  first unsigned MSI. **2 days.**
- **10.13.2** — WiX authoring: install flow, custom setup screen, file
  associations, uninstall. **3 days.**
- **10.13.3** — model manifest and integrity checks: checksums, licence
  packaging, SBOM. **1 day.**
- **10.13.4** — size reduction: quantise models, drop madmom, ship
  Demucs-drums-only. **2 days.**
- **10.13.5** — portable ZIP variant. **1 day.**
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
