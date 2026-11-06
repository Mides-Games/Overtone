//! Where the repository is, and which cases each mode reads.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

/// Find the repository root by walking up for the things this tool needs.
///
/// Deliberately resolved at runtime. `CARGO_MANIFEST_DIR` is baked in at
/// compile time, so a binary built before the project folder was renamed went
/// looking for its fixtures under the old absolute path — which is exactly
/// what happened when this project was renamed to Overtone. Searching from the
/// working directory first, then from the executable, keeps the binary
/// relocatable and makes it work from any subdirectory.
pub(crate) fn repo_root() -> Result<PathBuf> {
    fn looks_like_root(dir: &Path) -> bool {
        dir.join("Cargo.toml").is_file() && dir.join("bench").join("golden").is_dir()
    }
    fn walk_up(start: &Path) -> Option<PathBuf> {
        let mut dir = Some(start);
        while let Some(current) = dir {
            if looks_like_root(current) {
                return Some(current.to_path_buf());
            }
            dir = current.parent();
        }
        None
    }

    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = walk_up(&cwd) {
            return Ok(root);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = exe.parent().and_then(walk_up) {
            return Ok(root);
        }
    }
    // Last resort, and the one that breaks on a rename — so it is last.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = manifest.parent().and_then(Path::parent) {
        if looks_like_root(root) {
            return Ok(root.to_path_buf());
        }
    }
    bail!(
        "could not find the repository root (a directory with Cargo.toml and \
         bench/golden/) from {:?} or the executable's path",
        std::env::current_dir().ok()
    )
}

/// One fixture as `bench/fixtures.json` lists it.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Fixture {
    /// The exact command that renders it, printed when it is not there.
    pub(crate) render: String,
    /// A golden vector is committed for it, so the stage, map and elastic
    /// gates walk it.
    pub(crate) golden: bool,
    /// The density gate must measure it.
    pub(crate) density: bool,
    /// Its beat tempo steps with the time signature over a constant bar, so
    /// the density and map gates have no truth for it and read those real
    /// steps as false changes; `gates.py signatures` judges it instead.
    pub(crate) signature: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Fixtures {
    pub(crate) format: u32,
    pub(crate) fixtures: std::collections::BTreeMap<String, Fixture>,
}

/// Bumped with the manifest's shape, so an older file is named rather than
/// read as this one.
pub(crate) const FIXTURES_FORMAT: u32 = 1;

/// The one list of fixtures, as Python derives it from its own definitions
/// and the committed vectors (`bench/fixtures.py`; `bench/facts.py` holds the
/// file to them). Read here rather than rebuilt, so neither side carries a
/// copy of the other's list: the three coverage fixtures have no golden
/// vector, and walking `bench/golden/` for cases used to miss them until a
/// hand-written copy of their names was added back for the density gate.
pub(crate) fn fixtures(root: &Path) -> Result<std::collections::BTreeMap<String, Fixture>> {
    let path = root.join("bench/fixtures.json");
    let text = std::fs::read_to_string(&path).with_context(|| {
        format!(
            "reading {} (write it with `python bench/fixtures.py --update`)",
            path.display()
        )
    })?;
    let manifest: Fixtures =
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    if manifest.format != FIXTURES_FORMAT {
        bail!(
            "{} is format {}, this bench reads {FIXTURES_FORMAT} -- write it again with \
             `python bench/fixtures.py --update`",
            path.display(),
            manifest.format
        );
    }
    Ok(manifest.fixtures)
}

/// The fixtures a golden vector is committed for, in one order.
pub(crate) fn all_cases(root: &Path) -> Result<Vec<String>> {
    Ok(fixtures(root)?
        .into_iter()
        .filter(|(_, fixture)| fixture.golden)
        .map(|(name, _)| name)
        .collect())
}

/// The fixtures the density gate measures: every one with a vector plus the
/// coverage ones, which have none.
pub(crate) fn density_cases(root: &Path) -> Result<Vec<String>> {
    Ok(fixtures(root)?
        .into_iter()
        .filter(|(_, fixture)| fixture.density)
        .map(|(name, _)| name)
        .collect())
}

/// (change time, ratio) of the exact 2x relationships the detector should find.
/// The three coverage cases live outside the 24-case corpus so the published
/// numbers stay comparable; `change-175-87.5` is in it.
pub(crate) fn density_truth(name: &str) -> Option<(f64, f64)> {
    match name {
        "halftime-175-87.5" => Some((32.0, 0.5)),
        "halftime-150-75" => Some((28.0, 0.5)),
        "doubletime-110-220" => Some((26.0, 2.0)),
        "change-175-87.5" => Some((32.0, 0.5)),
        _ => None,
    }
}

/// Real density changes the density gate is documented to find (4/4).
pub(crate) const DENSITY_TRUTH_CASES: usize = 4;

/// Whether the signature gate judges this fixture instead of the others.
pub(crate) fn is_signature(root: &Path, name: &str) -> bool {
    fixtures(root)
        .ok()
        .and_then(|all| all.get(name).map(|fixture| fixture.signature))
        .unwrap_or(false)
}

/// The command that renders a bench fixture (bench/audio/ is not committed),
/// as the manifest gives it.
pub(crate) fn render_hint(root: &Path, name: &str) -> String {
    match fixtures(root).ok().and_then(|all| all.get(name).cloned()) {
        Some(fixture) => format!("render it with `{}`", fixture.render),
        None => format!("{name} is in no fixture list -- see bench/fixtures.py"),
    }
}
