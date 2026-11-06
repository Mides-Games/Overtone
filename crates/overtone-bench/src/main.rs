//! Validate the Rust engine against the v3 Python implementation, stage by
//! stage, on the committed golden vectors.
//!
//! The accuracy benchmark asks "is this tool correct". This asks a different
//! and, during a port, more useful question: "does this compute what the
//! original computed". A port can reach the right BPM through a wrong envelope
//! and a compensating peak-picker, and only a stage-by-stage diff catches it.
//!
//! ```text
//! cargo run -p overtone-bench --release -- golden
//! cargo run -p overtone-bench --release -- golden --only edm-174 shuffle-96
//! cargo run -p overtone-bench --release -- structure long-6min
//! cargo run -p overtone-bench --release -- resample
//! ```
//!
//! Vectors come from `bench/golden/*.json`, produced by
//! `python bench/golden.py dump`. The tolerances are the ones documented
//! there: attacks within 0.05 ms.

mod cases;
mod check;
mod density;
mod diff;
mod elastic;
mod map;
mod nogrid;
mod probes;
mod vectors;

use anyhow::{bail, Context, Result};

use crate::cases::repo_root;
use crate::check::{candidates_mode, golden_mode};
use crate::density::density_mode;
use crate::elastic::elastic_mode;
use crate::map::map_mode;
use crate::nogrid::nogrid_mode;
use crate::probes::{bands_mode, resample_mode, structure_mode};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("golden");
    let root = repo_root()?;
    if mode == "bands" {
        let only: Vec<String> = args
            .iter()
            .skip_while(|a| *a != "--only")
            .skip(1)
            .cloned()
            .collect();
        return bands_mode(&root, &only);
    }
    if mode == "density" {
        let only: Vec<String> = args
            .iter()
            .skip_while(|a| *a != "--only")
            .skip(1)
            .cloned()
            .collect();
        return density_mode(&root, &only);
    }
    if mode == "elastic" {
        let only: Vec<String> = args
            .iter()
            .skip_while(|a| *a != "--only")
            .skip(1)
            .cloned()
            .collect();
        return elastic_mode(&root, &only);
    }
    if mode == "map" {
        let only: Vec<String> = args
            .iter()
            .skip_while(|a| *a != "--only")
            .skip(1)
            .cloned()
            .collect();
        return map_mode(&root, &only);
    }
    if mode == "nogrid" {
        return nogrid_mode(&root);
    }
    if mode == "resample" {
        return resample_mode();
    }
    if mode == "structure" {
        let name = args.get(1).context("usage: structure <case>")?;
        return structure_mode(&root, name);
    }
    if mode == "candidates" {
        let name = args.get(1).context("usage: candidates <case>")?;
        return candidates_mode(&root, name);
    }
    if mode != "golden" {
        bail!(
            "usage: overtone-bench (golden | density | elastic | map) [--only CASE...] \r
             | nogrid | resample | structure <case> | candidates <case>"
        );
    }
    golden_mode(&root, &args)
}

#[cfg(test)]
mod tests {
    use crate::cases::repo_root;
    use crate::vectors::Golden;

    const ATTACKS: &str = r#""attacks": {"count": 0, "times_s": [], "weights": [],
        "envelope_frames": 0, "envelope_sum": 0.0}"#;

    #[test]
    fn a_vector_without_a_stage_names_it() {
        let bare: Golden = serde_json::from_str(&format!("{{\"case\": \"x\", {ATTACKS}}}"))
            .expect("every stage is optional to the parser");
        assert_eq!(
            bare.missing_stages(),
            [
                "candidates",
                "seeds",
                "octave",
                "atom_sections",
                "beat_sections",
                "settled_sections",
                "meter",
                "result.points"
            ]
        );
    }

    #[test]
    fn every_committed_vector_carries_every_stage() {
        let root = repo_root().expect("the repository root");
        let mut seen = 0;
        for entry in std::fs::read_dir(root.join("bench/golden")).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let golden: Golden =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            assert!(
                golden.missing_stages().is_empty(),
                "{}: {:?}",
                path.display(),
                golden.missing_stages()
            );
            seen += 1;
        }
        assert_eq!(seen, 27);
    }
}
