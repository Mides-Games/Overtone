//! Minimal read-only `.osu` input for the hitsound decision (H4a).
//!
//! Not the Phase 0 port: no writer, no storyboards, no editor metadata —
//! just what a proposal needs, which is hit objects with their sounds and
//! the timing lines behind the bar grid. One rule shapes it, taken from the
//! Python reader: a hand-broken line never hides the rest of the map, so
//! bad objects come back [`ObjectKind::Unparsed`] and numberless timing
//! lines are skipped. Infallible on text by construction; file errors stay
//! with the caller.

/// `normal:addition:index:volume:file`, short forms padded like Python.
#[derive(Debug, Clone, PartialEq)]
pub struct HitSample {
    pub normal_set: i64,
    pub addition_set: i64,
    pub index: i64,
    pub volume: i64,
    pub file: String,
}

fn parse_sample(text: &str) -> HitSample {
    let mut parts = text.split(':');
    let number = |part: Option<&str>| part.unwrap_or("").trim().parse::<i64>().unwrap_or(0);
    let file = text.split(':').nth(4).unwrap_or("").to_string();
    HitSample {
        normal_set: number(parts.next()),
        addition_set: number(parts.next()),
        index: number(parts.next()),
        volume: number(parts.next()),
        file,
    }
}

/// What an object is, with what H4 decides on. Curve points are not kept:
/// placement is the mapper's job, sound is ours.
#[derive(Debug, Clone, PartialEq)]
pub enum ObjectKind {
    Circle,
    Slider {
        slides: i64,
        length: f64,
        edge_sounds: Vec<u8>,
        edge_sets: Vec<(i64, i64)>,
    },
    Spinner {
        end_time: f64,
    },
    Hold {
        end_time: f64,
    },
    /// A hand-broken line: kept in place, decided nothing.
    Unparsed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HitObject {
    pub x: i64,
    pub y: i64,
    pub time: f64,
    pub new_combo: bool,
    pub hit_sound: u8,
    pub kind: ObjectKind,
    pub sample: HitSample,
}

/// One `[TimingPoints]` line: red lines carry the tempo, green lines the
/// slider velocity and the sounding state. A negative beat length is
/// inherited whatever the flag says — the length beats a contradictory
/// flag, as in legacy maps.
#[derive(Debug, Clone, PartialEq)]
pub struct TimingPoint {
    pub offset: f64,
    pub beat_len: f64,
    pub meter: i64,
    pub sample_set: i64,
    pub sample_index: i64,
    pub volume: i64,
    pub uninherited: bool,
}

#[derive(Debug, Clone)]
pub struct Beatmap {
    pub sample_set: i64,
    pub slider_multiplier: f64,
    pub timing: Vec<TimingPoint>,
    pub objects: Vec<HitObject>,
}

fn parse_object(line: &str) -> HitObject {
    let unparsed = || HitObject {
        x: 0,
        y: 0,
        time: f64::NAN,
        new_combo: false,
        hit_sound: 0,
        kind: ObjectKind::Unparsed,
        sample: parse_sample(""),
    };
    let fields: Vec<&str> = line.split(',').collect();
    if fields.len() < 5 {
        return unparsed();
    }
    let (x, y, time, type_bits, hit_sound) = match (
        fields[0].trim().parse::<i64>(),
        fields[1].trim().parse::<i64>(),
        fields[2].trim().parse::<f64>(),
        fields[3].trim().parse::<i64>(),
        fields[4].trim().parse::<u8>(),
    ) {
        (Ok(x), Ok(y), Ok(time), Ok(type_bits), Ok(hit_sound)) if time.is_finite() => {
            (x, y, time, type_bits, hit_sound)
        }
        _ => return unparsed(),
    };
    let rest = &fields[5..];
    let (kind, sample) = if type_bits & 128 != 0 {
        // Mania hold: endTime, then the sample.
        match rest.first() {
            Some(first) => {
                let (end, _, sample) = split_once(first, ':');
                match end.trim().parse::<f64>() {
                    Ok(end_time) if end_time.is_finite() => (
                        ObjectKind::Hold { end_time },
                        parse_sample(&sample),
                    ),
                    _ => return unparsed(),
                }
            }
            None => return unparsed(),
        }
    } else if type_bits & 8 != 0 {
        // Spinner: endTime, then the sample.
        match rest.first().and_then(|s| s.trim().parse::<f64>().ok()) {
            Some(end_time) if end_time.is_finite() => (
                ObjectKind::Spinner { end_time },
                parse_sample(rest.get(1).copied().unwrap_or("")),
            ),
            _ => return unparsed(),
        }
    } else if type_bits & 2 != 0 {
        // Slider: curve, slides, length, then edges and the sample. A
        // slider without its numbers is not an object to decide on.
        if rest.len() < 3 {
            return unparsed();
        }
        let (slides, length) = match (
            rest[1].trim().parse::<i64>(),
            rest[2].trim().parse::<f64>(),
        ) {
            (Ok(slides), Ok(length)) if length.is_finite() => (slides, length),
            _ => return unparsed(),
        };
        let edge_sounds = rest
            .get(3)
            .map(|s| {
                s.split('|')
                    .filter_map(|b| b.trim().parse::<u8>().ok())
                    .collect()
            })
            .unwrap_or_default();
        let edge_sets = rest
            .get(4)
            .map(|s| {
                s.split('|')
                    .filter_map(|pair| {
                        let (normal, _, addition) = split_pair(pair, ':');
                        Some((
                            normal.trim().parse::<i64>().unwrap_or(0),
                            addition.trim().parse::<i64>().unwrap_or(0),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        (
            ObjectKind::Slider {
                slides,
                length,
                edge_sounds,
                edge_sets,
            },
            parse_sample(rest.get(5).copied().unwrap_or("")),
        )
    } else if type_bits & 1 != 0 {
        (
            ObjectKind::Circle,
            parse_sample(rest.first().copied().unwrap_or("")),
        )
    } else {
        return unparsed();
    };
    HitObject {
        x,
        y,
        time,
        new_combo: type_bits & 4 != 0,
        hit_sound,
        kind,
        sample,
    }
}

fn split_once(text: &str, delimiter: char) -> (&str, char, String) {
    match text.find(delimiter) {
        Some(i) => (&text[..i], delimiter, text[i + 1..].to_string()),
        None => (text, delimiter, String::new()),
    }
}

fn split_pair(text: &str, delimiter: char) -> (&str, char, &str) {
    match text.find(delimiter) {
        Some(i) => (&text[..i], delimiter, &text[i + 1..]),
        None => (text, delimiter, ""),
    }
}

fn parse_timing(line: &str) -> Option<TimingPoint> {
    let fields: Vec<&str> = line.split(',').collect();
    if fields.len() < 2 {
        return None;
    }
    let offset = fields[0].trim().parse::<f64>().ok()?;
    let beat_len = fields[1].trim().parse::<f64>().ok()?;
    if !offset.is_finite() || !beat_len.is_finite() || beat_len == 0.0 {
        return None;
    }
    let number = |i: usize| {
        fields
            .get(i)
            .map(|s| s.trim().parse::<i64>().unwrap_or(0))
            .unwrap_or(0)
    };
    let inherited_by_length = beat_len < 0.0;
    let uninherited = fields
        .get(6)
        .map(|s| s.trim() == "1")
        .unwrap_or(true)
        && !inherited_by_length;
    Some(TimingPoint {
        offset,
        beat_len,
        meter: if fields.len() > 2 { number(2) } else { 4 },
        sample_set: number(3),
        sample_index: number(4),
        volume: number(5),
        uninherited,
    })
}

fn section_value(text: &str, section: &str, key: &str) -> Option<String> {
    let mut inside = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            inside = trimmed.eq_ignore_ascii_case(&format!("[{section}]"));
            continue;
        }
        if inside {
            if let Some((name, value)) = trimmed.split_once(':') {
                if name.trim().eq_ignore_ascii_case(key) {
                    return Some(value.trim().to_string());
                }
            }
        }
    }
    None
}

fn sample_set_name(name: &str) -> i64 {
    match name.trim().to_lowercase().as_str() {
        "soft" => 2,
        "drum" => 3,
        _ => 1,
    }
}

/// The decision input of one `.osu` file's text: BOM tolerated, either line
/// ending, sections in any order, unknown sections ignored.
pub fn parse(text: &str) -> Beatmap {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let sample_set = section_value(text, "General", "SampleSet")
        .map(|name| sample_set_name(&name))
        .unwrap_or(1);
    let slider_multiplier = section_value(text, "Difficulty", "SliderMultiplier")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(1.4);
    let mut timing = Vec::new();
    let mut objects = Vec::new();
    let mut section = "";
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            section = match &trimmed[1..trimmed.len() - 1] {
                "TimingPoints" => "timing",
                "HitObjects" => "objects",
                _ => "",
            };
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }
        match section {
            "timing" => {
                if let Some(point) = parse_timing(trimmed) {
                    timing.push(point);
                }
            }
            "objects" => objects.push(parse_object(trimmed)),
            _ => {}
        }
    }
    Beatmap {
        sample_set,
        slider_multiplier,
        timing,
        objects,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAP: &str = "osu file format v14\r\n\
        \r\n\
        [General]\r\n\
        SampleSet: Soft\r\n\
        \r\n\
        [Difficulty]\r\n\
        SliderMultiplier: 1.6\r\n\
        \r\n\
        [TimingPoints]\r\n\
        1000,500,4,2,1,70,1,0\r\n\
        9000,-100,4,2,1,60,0,0\r\n\
        9500,400\r\n\
        broken\r\n\
        \r\n\
        [HitObjects]\r\n\
        256,192,1000,1,4,0:0:0:0:\r\n\
        256,192,2000,2,2,L|356:192,1,140,2|2|2,0:0|0:0,0:0:0:0:\r\n\
        256,192,3000,12,0,4000,0:0:0:0:\r\n\
        100,100,4000,128,0,5000:0:0:0:0:\r\n\
        nonsense\r\n";

    #[test]
    fn every_object_kind_parses_with_its_sound() {
        let map = parse(MAP);
        assert_eq!(map.sample_set, 2);
        assert!((map.slider_multiplier - 1.6).abs() < 1e-12);
        assert_eq!(map.objects.len(), 5);
        let circle = &map.objects[0];
        assert!(matches!(circle.kind, ObjectKind::Circle));
        assert_eq!((circle.x, circle.y, circle.time, circle.hit_sound), (256, 192, 1000.0, 4));
        assert!(!circle.new_combo);
        assert_eq!(map.objects[2].new_combo, true);
        match &map.objects[1].kind {
            ObjectKind::Slider { slides, length, edge_sounds, edge_sets } => {
                assert_eq!((*slides, *length), (1, 140.0));
                assert_eq!(*edge_sounds, vec![2, 2, 2]);
                assert_eq!(*edge_sets, vec![(0, 0), (0, 0)]);
            }
            kind => panic!("slider misread as {kind:?}"),
        }
        assert!(matches!(
            map.objects[2].kind,
            ObjectKind::Spinner { end_time } if end_time == 4000.0
        ));
        assert!(matches!(
            map.objects[3].kind,
            ObjectKind::Hold { end_time } if end_time == 5000.0
        ));
        assert!(matches!(map.objects[4].kind, ObjectKind::Unparsed));
    }

    #[test]
    fn red_green_and_legacy_timing_lines_parse_and_junk_skips() {
        let map = parse(MAP);
        assert_eq!(map.timing.len(), 3);
        assert!(map.timing[0].uninherited);
        assert_eq!(map.timing[0].meter, 4);
        assert!(!map.timing[1].uninherited);
        assert!(map.timing[1].beat_len < 0.0);
        // Legacy two-field line: red when the length is positive.
        assert!(map.timing[2].uninherited);
        assert_eq!(map.timing[2].meter, 4);
    }

    #[test]
    fn missing_sections_fall_back_to_defaults() {
        let map = parse("[HitObjects]\n256,192,1000,1,0,0:0:0:0:\n");
        assert_eq!((map.sample_set, map.slider_multiplier), (1, 1.4));
        assert!(map.timing.is_empty());
        assert!(matches!(map.objects[0].kind, ObjectKind::Circle));
    }

    #[test]
    fn negative_length_beats_a_red_flag() {
        // A legacy map's line with a contradictory flag stays inherited.
        let map = parse("[TimingPoints]\n1000,-50,4,2,1,60,1,0\n");
        assert_eq!(map.timing.len(), 1);
        assert!(!map.timing[0].uninherited);
    }
}
