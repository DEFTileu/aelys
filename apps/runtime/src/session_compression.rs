//! Phase 5 / task 1: bounded, in-memory decoding of one Codex zstd frame.
//! The caller supplies bytes from AuthorizedRoot::read_child_bounded; this
//! module never opens files, spawns commands, or loads dictionaries.
use std::io::Read;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DecodeError {
    InvalidFrame,
    OutputLimit,
}

/// The decoder's back-reference window is bounded BEFORE reading the frame.
/// Memory is input bytes + output cap+1 + <=4 MiB history window + fixed zstd
/// context/block overhead. This is not a process-wide memory/CPU quota.
const WINDOW_LOG_MAX: u32 = 22;

pub(super) fn decode(bytes: &[u8], max_output: usize) -> Result<Vec<u8>, DecodeError> {
    // Standard magic only: no skippable/magicless frames. A dictionary-ID field
    // is unsupported even when its encoded ID is zero. No dictionary callbacks.
    if bytes.len() < 5 || bytes[..4] != [0x28, 0xb5, 0x2f, 0xfd] || bytes[4] & 3 != 0 {
        return Err(DecodeError::InvalidFrame);
    }
    // Exactly one complete frame, no concatenation or trailing bytes. This
    // bounded scan checks framing; decoding below still verifies checksums.
    if zstd::zstd_safe::find_frame_compressed_size(bytes).ok() != Some(bytes.len()) {
        return Err(DecodeError::InvalidFrame);
    }
    if let Ok(Some(size)) = zstd::zstd_safe::get_frame_content_size(bytes) {
        if size > max_output as u64 {
            return Err(DecodeError::OutputLimit);
        }
    }
    let mut decoder = zstd::stream::read::Decoder::with_buffer(bytes)
        .map_err(|_| DecodeError::InvalidFrame)?
        .single_frame();
    decoder
        .window_log_max(WINDOW_LOG_MAX)
        .map_err(|_| DecodeError::InvalidFrame)?;
    // Fixed capacity avoids allocation based on untrusted frame sizes and
    // Vec growth beyond the configured cap. One probe byte detects overflow.
    let mut output = vec![0; max_output + 1];
    let mut used = 0;
    loop {
        let read = decoder
            .read(&mut output[used..])
            .map_err(|_| DecodeError::InvalidFrame)?;
        if read == 0 {
            break;
        }
        used += read;
        if used > max_output {
            return Err(DecodeError::OutputLimit);
        }
    }
    if !decoder.finish().is_empty() {
        return Err(DecodeError::InvalidFrame);
    }
    output.truncate(used);
    Ok(output)
}
