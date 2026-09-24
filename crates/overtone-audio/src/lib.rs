//! Audio loading for Overtone: decode, downmix, resample, normalise.
//!
//! Decoding is Symphonia, in-process, for WAV, FLAC, MP3, AAC, ALAC, Vorbis
//! and MP4/M4A. That is the one clear product win of the rewrite over v3,
//! which asks the user to install FFmpeg and put it on `PATH` for anything
//! compressed (audit F-06).
//!
//! The load contract is v3's, preserved deliberately: mono, 44.1 kHz, peak
//! normalised to 0.99, at least two seconds, at most an hour, and NaN/Inf
//! scrubbed. The duration check runs from the container's own metadata before
//! decoding, so a mistyped path to a three-hour file costs nothing.

pub mod resample;

use std::fs::File;
use std::path::Path;

use overtone_core::{Error, Result, MAX_AUDIO_SECONDS, TARGET_SR};
use symphonia::core::audio::GenericAudioBufferRef;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::TimeBase;

/// Decoded audio at the file's native rate, downmixed to mono packet by packet
/// as it is read: every channel of an hour at 96 kHz would take gigabytes, and
/// the mean of each frame is all the engine uses (v3's `np.mean(y, axis=1)`).
pub struct Decoded {
    /// Mono samples at `sample_rate`.
    pub samples: Vec<f32>,
    /// Channels in the file (of the last packet decoded).
    pub channels: usize,
    pub sample_rate: u32,
    /// Frames of packets the decoder rejected, replaced by silence of the
    /// same length so nothing after them moves. Zero for an intact file.
    pub concealed_frames: u64,
}

/// Frames in a packet of `dur` ticks of `time_base` at `sample_rate`, or
/// `fallback` (the last decoded packet's length) when either is unknown.
fn packet_frames(
    dur: u64,
    time_base: Option<TimeBase>,
    sample_rate: u32,
    fallback: usize,
) -> usize {
    match time_base {
        Some(tb) if sample_rate > 0 => {
            let ticks = dur as u128 * tb.numer.get() as u128 * sample_rate as u128;
            let denom = tb.denom.get() as u128;
            ((ticks + denom / 2) / denom) as usize
        }
        _ => fallback,
    }
}

/// True once `mono_samples` at `rate` run past the hour, plus a second of
/// slack: the in-decode guard for files whose container states no duration.
/// It counted interleaved samples against 44.1 kHz stereo, whatever the file,
/// so a 30-minute 96 kHz stereo FLAC was refused at 27.6 minutes.
fn past_the_hour(mono_samples: usize, rate: u32) -> bool {
    rate > 0 && mono_samples > (MAX_AUDIO_SECONDS as usize + 1) * rate as usize
}

/// Decode any container Symphonia understands.
pub fn decode(path: &Path) -> Result<Decoded> {
    let file = File::open(path)?;
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(extension);
    }
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| Error::Decode(e.to_string()))?;

    let track = format
        .default_track(TrackType::Audio)
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|t| t.codec_params.as_ref().is_some_and(|p| p.is_audio()))
        })
        .ok_or_else(|| Error::Decode("no audio track in this file".into()))?;
    let track_id = track.id;
    let time_base = track.time_base;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| Error::Decode("audio track has no codec parameters".into()))?
        .clone();

    // Duration from metadata, before decoding anything. v3 does the same via
    // libsndfile's header, and for the same reason.
    if let (Some(frames), Some(rate)) = (track.num_frames, params.sample_rate) {
        if rate > 0 && frames as f64 / rate as f64 > MAX_AUDIO_SECONDS {
            return Err(Error::TooLong);
        }
    }

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|e| Error::Decode(e.to_string()))?;

    let mut samples: Vec<f32> = Vec::new();
    let mut scratch: Vec<f32> = Vec::new();
    let mut channels = params.channels.as_ref().map_or(0, |c| c.count());
    let mut sample_rate = params.sample_rate.unwrap_or(0);
    let mut last_frames = 0usize;
    let mut concealed_frames = 0u64;

    while let Some(packet) = format
        .next_packet()
        .map_err(|e| Error::Decode(e.to_string()))?
    {
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buffer) => {
                let spec = buffer.spec();
                channels = spec.channels().count();
                if sample_rate == 0 {
                    sample_rate = spec.rate();
                }
                scratch.clear();
                copy_interleaved(&buffer, &mut scratch);
                let mono = downmix(&scratch, channels);
                last_frames = mono.len();
                samples.extend_from_slice(&mono);
                if past_the_hour(samples.len(), sample_rate) {
                    return Err(Error::TooLong);
                }
            }
            // A corrupt packet mid-stream is not a reason to lose the file,
            // nor to move everything after it: its frames become silence.
            // Dropped, one bad MP3 frame put every later red line 26 ms early.
            Err(symphonia::core::errors::Error::DecodeError(_)) => {
                let frames = packet_frames(packet.dur.get(), time_base, sample_rate, last_frames);
                samples.resize(samples.len() + frames, 0.0);
                concealed_frames += frames as u64;
            }
            Err(e) => return Err(Error::Decode(e.to_string())),
        }
    }

    // Silence standing in for every packet is not audio either.
    let concealed_all = concealed_frames as usize == samples.len();
    if samples.is_empty() || channels == 0 || sample_rate == 0 || concealed_all {
        return Err(Error::Decode("decoded no audio".into()));
    }
    Ok(Decoded {
        samples,
        channels,
        sample_rate,
        concealed_frames,
    })
}

fn copy_interleaved(buffer: &GenericAudioBufferRef<'_>, out: &mut Vec<f32>) {
    buffer.copy_to_vec_interleaved(out);
}

/// Mono, 44.1 kHz, peak-normalised to 0.99 — the engine's input contract.
pub fn load(path: &Path) -> Result<(Vec<f32>, u32)> {
    let decoded = decode(path)?;
    finish(decoded.samples, decoded.sample_rate)
}

/// The rest of the contract on decoded mono audio, in v3 `_load_audio`'s
/// order: resample, scrub NaN/Inf, at least two seconds, at most an hour,
/// peak 0.99.
fn finish(mut mono: Vec<f32>, rate: u32) -> Result<(Vec<f32>, u32)> {
    if rate != TARGET_SR {
        mono = resample::resample(&mono, rate, TARGET_SR);
    }
    for sample in &mut mono {
        if !sample.is_finite() {
            *sample = 0.0;
        }
    }
    if mono.len() < TARGET_SR as usize * 2 {
        return Err(Error::TooShort);
    }
    if mono.len() as f64 / TARGET_SR as f64 > MAX_AUDIO_SECONDS {
        return Err(Error::TooLong);
    }
    let peak = mono.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
    if peak > 1e-9 {
        let gain = 0.99 / peak;
        for sample in &mut mono {
            *sample *= gain;
        }
    }
    Ok((mono, TARGET_SR))
}

/// Mean across channels, which is what `np.mean(y, axis=1)` gives v3.
pub fn downmix(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_averages_channels() {
        let stereo = [1.0f32, 0.0, 0.5, 0.5, -1.0, 1.0];
        assert_eq!(downmix(&stereo, 2), vec![0.5, 0.5, 0.0]);
    }

    #[test]
    fn downmix_passes_mono_through() {
        let mono = [0.1f32, 0.2, 0.3];
        assert_eq!(downmix(&mono, 1), mono.to_vec());
    }

    #[test]
    fn a_partial_trailing_frame_is_dropped_not_misread() {
        // chunks_exact ignores a ragged tail; reading it as a full frame would
        // silently shift every later sample.
        let ragged = [1.0f32, 1.0, 2.0];
        assert_eq!(downmix(&ragged, 2), vec![1.0]);
    }

    /// Byte offset of every MPEG-1 Layer III frame at 44.1 kHz in `mp3`.
    fn mp3_frames(mp3: &[u8]) -> Vec<usize> {
        const KBPS: [usize; 15] = [
            0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
        ];
        let mut frames = Vec::new();
        let mut i = 0;
        while i + 4 <= mp3.len() {
            let (b1, b2) = (mp3[i + 1], mp3[i + 2]);
            let rate = (b2 >> 4) as usize;
            if mp3[i] == 0xFF && b1 & 0xFE == 0xFA && (1..15).contains(&rate) && b2 & 0x0C == 0 {
                frames.push(i);
                i += 144 * KBPS[rate] * 1000 / 44_100 + ((b2 >> 1) & 1) as usize;
            } else {
                i += 1;
            }
        }
        frames
    }

    /// Sample index where each click starts: loud after 2000 quiet samples.
    fn click_starts(samples: &[f32]) -> Vec<usize> {
        (2000..samples.len())
            .filter(|&i| {
                samples[i].abs() > 0.1 && samples[i - 2000..i].iter().all(|v| v.abs() < 0.05)
            })
            .collect()
    }

    #[test]
    fn a_corrupt_packet_keeps_the_timeline() {
        // Sixteen clicks, 250 ms apart, in a 4 s mono MP3 (libsndfile 1.2 /
        // LAME). One frame near 2 s gets big_values = 511 in its first
        // granule, past the 288 the format allows, so Symphonia rejects that
        // packet ("granule big_values > 288"). Dropping it moved every later
        // sample 1152 frames -- 26.1 ms -- earlier. Frame 74 sits just after
        // a click: most quiet frames also carry bits of the next click (LAME
        // borrows ahead through the bit reservoir), and losing one silences
        // that click too -- the file's loss, but still nothing may move.
        let clean = include_bytes!("../testdata/clicks.mp3");
        let frames = mp3_frames(clean);
        assert!(frames.len() > 150, "found {} frames", frames.len());
        let hit = frames[74];
        let mut corrupt = clean.to_vec();
        // Side info starts after the 4-byte header; for mono MPEG-1,
        // big_values of granule 0 is bits 30..=38.
        corrupt[hit + 4 + 3] |= 0x03;
        corrupt[hit + 4 + 4] |= 0xFE;

        let dir = std::env::temp_dir().join(format!("overtone-audio-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("clean.mp3"), dir.join("corrupt.mp3"));
        std::fs::write(&a, clean).unwrap();
        std::fs::write(&b, &corrupt).unwrap();
        let clean = decode(&a).unwrap();
        let corrupt = decode(&b).unwrap();
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(clean.concealed_frames, 0);
        assert_eq!(corrupt.concealed_frames, 1152);
        assert_eq!(corrupt.samples.len(), clean.samples.len());
        let (before, after) = (click_starts(&clean.samples), click_starts(&corrupt.samples));
        assert_eq!(before.len(), 16);
        assert_eq!(after, before, "clicks moved");
    }

    #[test]
    fn the_load_contract_holds() {
        let sr = TARGET_SR as usize;
        // At least two seconds.
        assert!(matches!(
            finish(vec![0.1; 2 * sr - 1], TARGET_SR),
            Err(Error::TooShort)
        ));
        assert!(finish(vec![0.1; 2 * sr], TARGET_SR).is_ok());
        // Non-finite samples are zeroed before the peak is taken, and the peak
        // lands on 0.99 whatever the level.
        let mut y = vec![0.0f32; 3 * sr];
        y[10] = f32::NAN;
        y[20] = f32::INFINITY;
        y[30] = f32::NEG_INFINITY;
        y[40] = -0.25;
        y[50] = 0.1;
        let (out, rate) = finish(y, TARGET_SR).unwrap();
        assert_eq!(rate, TARGET_SR);
        assert!(out.iter().all(|v| v.is_finite()));
        assert_eq!(out[10], 0.0);
        let peak = out.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
        assert!((peak - 0.99).abs() < 1e-6, "peak {peak}");
        assert!((out[40] + 0.99).abs() < 1e-6);
        // A rate other than 44.1 kHz comes out at 44.1 kHz.
        let (out, rate) = finish(vec![0.1; 3 * 48_000], 48_000).unwrap();
        assert_eq!(rate, TARGET_SR);
        assert!(
            (out.len() as i64 - 3 * sr as i64).abs() <= 2,
            "{}",
            out.len()
        );
    }

    #[test]
    fn the_hour_is_an_hour_at_any_rate() {
        // The in-decode guard counted interleaved samples against 44.1 kHz
        // stereo: 30 minutes at 96 kHz stereo tripped it at 27.6 minutes.
        assert!(!past_the_hour(1800 * 96_000, 96_000));
        assert!(!past_the_hour(3599 * 48_000, 48_000));
        assert!(!past_the_hour(3600 * 192_000, 192_000));
        assert!(past_the_hour(3602 * 44_100, 44_100));
        assert!(past_the_hour(3602 * 48_000, 48_000));
        assert!(!past_the_hour(usize::MAX / 2, 0), "no rate yet: no verdict");
    }

    #[test]
    fn missing_file_is_an_io_error_not_a_panic() {
        let err = load(Path::new("definitely-not-here.wav")).unwrap_err();
        assert!(matches!(err, Error::Io(_)), "got {err:?}");
    }
}
