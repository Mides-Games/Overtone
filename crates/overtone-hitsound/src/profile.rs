//! Hitsound profiles as data (H4b): instrument-to-hitsound affinity plus
//! the emission and transition weights, loaded from JSON.
//!
//! `profiles/balanced.json` ships the table from docs/06 section 6. A
//! profile is a file so mappers retune taste without rebuilding; the loader
//! is strict — an unknown class, bank or addition fails with its name —
//! because a profile that silently drops a row explains decisions it never
//! scored.

use std::collections::HashMap;

use serde::Deserialize;

use crate::corpus::HitClass;

/// Sample bank a candidate plays from. `Inherit` keeps the object's own
/// bank (affinity side only; never a proposed candidate).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Bank {
    Normal,
    Soft,
    Drum,
    Inherit,
}

impl Bank {
    pub fn as_str(self) -> &'static str {
        match self {
            Bank::Normal => "normal",
            Bank::Soft => "soft",
            Bank::Drum => "drum",
            Bank::Inherit => "inherit",
        }
    }

    fn parse(text: &str) -> Result<Bank, String> {
        match text {
            "normal" => Ok(Bank::Normal),
            "soft" => Ok(Bank::Soft),
            "drum" => Ok(Bank::Drum),
            "inherit" => Ok(Bank::Inherit),
            other => Err(format!("unknown bank {other:?}")),
        }
    }
}

/// Additions in bit order, as the `.osu` hitSound field reads them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Addition {
    Whistle,
    Finish,
    Clap,
}

impl Addition {
    pub fn as_str(self) -> &'static str {
        match self {
            Addition::Whistle => "whistle",
            Addition::Finish => "finish",
            Addition::Clap => "clap",
        }
    }

    fn parse(text: &str) -> Result<Addition, String> {
        match text {
            "whistle" => Ok(Addition::Whistle),
            "finish" => Ok(Addition::Finish),
            "clap" => Ok(Addition::Clap),
            other => Err(format!("unknown addition {other:?}")),
        }
    }

    /// The hitSound bits carrying exactly this set.
    pub fn bits(set: &[Addition]) -> u8 {
        let mut bits = 0u8;
        for addition in set {
            bits |= match addition {
                Addition::Whistle => 2,
                Addition::Finish => 4,
                Addition::Clap => 8,
            };
        }
        bits
    }
}

fn parse_class(text: &str) -> Result<HitClass, String> {
    HitClass::ALL
        .iter()
        .find(|c| c.as_str() == text)
        .copied()
        .ok_or_else(|| format!("unknown class {text:?}"))
}

/// One affinity row: what an instrument wants to sound like, and how much.
#[derive(Debug, Clone)]
pub struct Affinity {
    pub bank: Bank,
    pub additions: Vec<Addition>,
    pub weight: f64,
}

#[derive(Debug, Clone, Deserialize)]
struct AffinityJson {
    bank: String,
    additions: Vec<String>,
    w: f64,
}

#[derive(Debug, Clone, Deserialize)]
struct WeightsJson {
    role: f64,
    energy: f64,
    context: f64,
    prior: f64,
}

#[derive(Debug, Clone, Deserialize)]
struct TransitionJson {
    stream_consistency: f64,
    phrase_symmetry: f64,
    finish_spacing: f64,
    switch_cost: f64,
}

#[derive(Debug, Clone, Deserialize)]
struct MetricalJson {
    slots_per_bar: u32,
    whistle: Vec<f64>,
    finish: Vec<f64>,
    clap: Vec<f64>,
}

#[derive(Debug, Clone, Deserialize)]
struct ProfileJson {
    affinity: HashMap<String, Vec<AffinityJson>>,
    weights: WeightsJson,
    transition: TransitionJson,
    #[serde(default)]
    metrical: Option<MetricalJson>,
}

/// Where a genre puts each addition inside the bar, as a share of that
/// addition's placements per sixteenth slot — measured from maps, not chosen.
///
/// A profile without one keeps the hand-written metrical rule, so the shipped
/// balanced profile decides exactly as it did before this existed.
#[derive(Debug, Clone)]
pub struct Metrical {
    pub slots_per_bar: u32,
    whistle: Vec<f64>,
    finish: Vec<f64>,
    clap: Vec<f64>,
}

impl Metrical {
    /// The share of this addition's placements that land on `slot`.
    pub fn share(&self, addition: Addition, slot: u32) -> Option<f64> {
        let row = match addition {
            Addition::Whistle => &self.whistle,
            Addition::Finish => &self.finish,
            Addition::Clap => &self.clap,
        };
        row.get(slot as usize).copied()
    }

    fn parse(raw: &MetricalJson) -> Result<Metrical, String> {
        let slots = raw.slots_per_bar;
        if !(1..=64).contains(&slots) {
            return Err(format!("metrical: {slots} slots a bar is not a bar"));
        }
        let mut rows = Vec::with_capacity(3);
        for (name, row) in [("whistle", &raw.whistle), ("finish", &raw.finish),
                            ("clap", &raw.clap)] {
            if row.len() != slots as usize {
                return Err(format!(
                    "metrical {name}: {} slots against {slots} a bar", row.len()));
            }
            if row.iter().any(|v| !v.is_finite() || *v < 0.0) {
                return Err(format!("metrical {name}: a share is negative or not finite"));
            }
            let mass: f64 = row.iter().sum();
            if mass <= 0.0 {
                return Err(format!("metrical {name}: every slot is zero"));
            }
            // Normalised on load, so a table written as counts, as percentages
            // or as shares all mean the same thing.
            rows.push(row.iter().map(|v| v / mass).collect::<Vec<f64>>());
        }
        let mut rows = rows.into_iter();
        Ok(Metrical {
            slots_per_bar: slots,
            whistle: rows.next().expect("three rows"),
            finish: rows.next().expect("three rows"),
            clap: rows.next().expect("three rows"),
        })
    }
}

/// A profile: affinity per instrument, emission weights, transition
/// weights. `energy` rides along for H5, when volume is decided; H4 never
/// reads it.
#[derive(Debug, Clone)]
pub struct Profile {
    pub affinity: HashMap<HitClass, Vec<Affinity>>,
    pub role_weight: f64,
    pub energy_weight: f64,
    pub context_weight: f64,
    pub prior_weight: f64,
    pub stream_consistency: f64,
    pub phrase_symmetry: f64,
    pub finish_spacing: f64,
    pub switch_cost: f64,
    /// Where each addition falls inside the bar, measured from maps of one
    /// genre. `None` keeps the hand-written rule.
    pub metrical: Option<Metrical>,
}

impl Profile {
    /// Parse a profile document. Strict: every name must resolve, every
    /// class should appear (a missing class never fires, which is a silent
    /// taste of its own — refused instead).
    pub fn parse(text: &str) -> Result<Profile, String> {
        let raw: ProfileJson =
            serde_json::from_str(text).map_err(|e| format!("profile is not JSON: {e}"))?;
        let mut affinity = HashMap::new();
        for (name, rows) in &raw.affinity {
            let class = parse_class(name)?;
            let mut parsed = Vec::with_capacity(rows.len());
            for row in rows {
                if !row.w.is_finite() {
                    return Err(format!("affinity weight for {name} is not finite"));
                }
                let mut additions = Vec::with_capacity(row.additions.len());
                for addition in &row.additions {
                    additions.push(Addition::parse(addition)?);
                }
                parsed.push(Affinity {
                    bank: Bank::parse(&row.bank)?,
                    additions,
                    weight: row.w,
                });
            }
            affinity.insert(class, parsed);
        }
        for class in HitClass::ALL {
            if !affinity.contains_key(&class) {
                return Err(format!("profile has no affinity for {}", class.as_str()));
            }
        }
        Ok(Profile {
            affinity,
            role_weight: raw.weights.role,
            energy_weight: raw.weights.energy,
            context_weight: raw.weights.context,
            prior_weight: raw.weights.prior,
            stream_consistency: raw.transition.stream_consistency,
            phrase_symmetry: raw.transition.phrase_symmetry,
            finish_spacing: raw.transition.finish_spacing,
            switch_cost: raw.transition.switch_cost,
            metrical: match &raw.metrical {
                Some(table) => Some(Metrical::parse(table)?),
                None => None,
            },
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn balanced() -> Profile {
        Profile::parse(include_str!("../../../profiles/balanced.json")).expect("ships valid")
    }

    pub(crate) fn rock() -> Profile {
        Profile::parse(include_str!("../../../profiles/rock.json")).expect("ships valid")
    }

    #[test]
    fn a_measured_table_loads_normalised_and_a_broken_one_says_why() {
        // The shipped genre profile carries a table; the shipped balanced one
        // does not, which is what keeps its decisions where they were.
        assert!(balanced().metrical.is_none());
        let table = rock().metrical.expect("rock is measured");
        assert_eq!(table.slots_per_bar, 16);
        for addition in [Addition::Whistle, Addition::Finish, Addition::Clap] {
            let mass: f64 = (0..16)
                .map(|slot| table.share(addition, slot).expect("every slot"))
                .sum();
            assert!((mass - 1.0).abs() < 1e-9, "{} sums to {mass}", addition.as_str());
            assert!(table.share(addition, 16).is_none(), "past the bar");
        }
        // Rock claps land on 2 and 4, and the numbers are the corpus's, not a
        // guess: 26.2 % on beat 2 and 25.5 % on beat 4 against 10.5 % on beat 3
        // and 1.0 % on the downbeat, over 110 mapsets. The hand-written rule
        // scores beats 2, 3 and 4 identically, which is the difference this
        // table exists to carry.
        let clap = |slot| table.share(Addition::Clap, slot).unwrap();
        assert!(clap(4) > 2.4 * clap(8), "beat 2 {} over beat 3 {}", clap(4), clap(8));
        assert!(clap(12) > 2.4 * clap(8), "beat 4 {} over beat 3 {}", clap(12), clap(8));
        assert!(clap(8) > 5.0 * clap(1), "beat 3 still beats a sixteenth");

        let text = include_str!("../../../profiles/rock.json");
        let short = text.replace("\"slots_per_bar\": 16", "\"slots_per_bar\": 8");
        assert!(Profile::parse(&short).unwrap_err().contains("16 slots against 8"));
        let negative = text.replace("\"slots_per_bar\": 16,", "\"slots_per_bar\": 16,
    \"unused\": 0,");
        assert!(Profile::parse(&negative).is_ok(), "an unknown key is not a broken table");
    }

    #[test]
    fn the_shipped_profile_loads_whole() {
        let profile = balanced();
        assert_eq!(profile.affinity.len(), HitClass::ALL.len());
        let snare = &profile.affinity[&HitClass::Snare];
        assert_eq!(snare.len(), 2);
        assert_eq!(
            (snare[0].bank, snare[0].additions.clone(), snare[0].weight),
            (Bank::Drum, vec![Addition::Clap], 1.0)
        );
        assert!((profile.prior_weight - 1.2).abs() < 1e-12);
    }

    #[test]
    fn unknown_names_and_missing_classes_fail_saying_which() {
        assert!(Profile::parse("{}").is_err());
        let renamed = include_str!("../../../profiles/balanced.json").replace("\"kick\"", "\"kickdrum\"");
        assert!(Profile::parse(&renamed)
            .unwrap_err()
            .contains("kickdrum"));
        // Every class must appear: a missing class never fires, which is a
        // silent taste of its own.
        let mut rows = String::from("{");
        for (i, class) in HitClass::ALL.iter().enumerate() {
            if class.as_str() == "vocal" {
                continue;
            }
            if i > 0 {
                rows.push(',');
            }
            rows.push_str(&format!(
                "\"{}\": [{{\"bank\": \"normal\", \"additions\": [], \"w\": 1.0}}]",
                class.as_str()
            ));
        }
        rows.push('}');
        // `{"affinity": ..., ...}` with one class short of thirteen.
        let document = format!(
            "{{\"affinity\": {rows}, \"weights\": {{\"role\": 1.0, \"energy\": 0.6, \
             \"context\": 0.8, \"prior\": 1.2}}, \"transition\": \
             {{\"stream_consistency\": 1.4, \"phrase_symmetry\": 0.9, \
             \"finish_spacing\": 1.1, \"switch_cost\": 0.5}}}}"
        );
        assert!(Profile::parse(&document).unwrap_err().contains("vocal"));
    }
}
