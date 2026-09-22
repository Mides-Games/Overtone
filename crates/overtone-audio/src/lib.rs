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

/// Decoded audio, exactly as the file holds it: interleaved, native rate.
pub struct Decoded {
    pub samples: Vec<f32>,
    pub channels: usize,
    pub sample_rate: u32,
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
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| Error::Decode("audio track has no codec parameters".into()))?
        .clone();

    // Duration from metadata, before decoding anything. v3 does the same via
    // libsndfile's header, and for the same reason.
    if let (Some(frames), rate) = (track.num_frames, params.sample_rate) {
        if let Some(rate) = rate {
            if rate > 0 && frames as f64 / rate as f64 > MAX_AUDIO_SECONDS {
                return Err(Error::TooLong);
            }
        }
    }

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|e| Error::Decode(e.to_string()))?;

    let mut samples: Vec<f32> = Vec::new();
    let mut scratch: Vec<f32> = Vec::new();
    let mut channels = 0usize;
    let mut sample_rate = params.sample_rate.unwrap_or(0);

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
                samples.extend_from_slice(&scratch);
                if samples.len() > (MAX_AUDIO_SECONDS as usize + 1) * TARGET_SR as usize * 2 {
                    return Err(Error::TooLong);
                }
            }
            // A corrupt packet mid-stream is not a reason to lose the file.
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(Error::Decode(e.to_string())),
        }
    }

    if samples.is_empty() || channels == 0 || sample_rate == 0 {
        return Err(Error::Decode("decoded no audio".into()));
    }
    Ok(Decoded {
        samples,
        channels,
        sample_rate,
    })
}

fn copy_interleaved(buffer: &GenericAudioBufferRef<'_>, out: &mut Vec<f32>) {
    buffer.copy_to_vec_interleaved(out);
}

/// Mono, 44.1 kHz, peak-normalised to 0.99 — the engine's input contract.
pub fn load(path: &Path) -> Result<(Vec<f32>, u32)> {
    let decoded = decode(path)?;
    let mut mono = downmix(&decoded.samples, decoded.channels);
    if decoded.sample_rate != TARGET_SR {
        mono = resample::resample(&mono, decoded.sample_rate, TARGET_SR);
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

    #[test]
    fn missing_file_is_an_io_error_not_a_panic() {
        let err = load(Path::new("definitely-not-here.wav")).unwrap_err();
        assert!(matches!(err, Error::Io(_)), "got {err:?}");
    }
}
