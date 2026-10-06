//! WHATWG UTF-8 decoding that matches Node's `new TextDecoder().decode(bytes)` of a whole input when the input arrives
//! in pieces (Durable `env/decode.ts`): invalid sequences become U+FFFD by the maximal-subpart rule, and only a
//! byte-order mark at the very start is dropped.

use encoding_rs::{Decoder, UTF_8};

/// Decodes one stream chunk by chunk, dropping a leading byte-order mark.
pub struct StreamDecoder {
    decoder: Decoder,
}

impl StreamDecoder {
    pub fn new() -> StreamDecoder {
        // Removes a UTF-8 BOM only; plain `new_decoder()` would also sniff UTF-16 BOMs and switch encodings.
        StreamDecoder {
            decoder: UTF_8.new_decoder_with_bom_removal(),
        }
    }

    /// Text for `bytes`, holding back an incomplete character; with `last`, the end of the stream.
    pub fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        decode_into(&mut self.decoder, bytes, last)
    }
}

/// A decoder for a byte range that does not start at the beginning of its input: no BOM handling at all.
pub fn range_decoder() -> Decoder {
    UTF_8.new_decoder_without_bom_handling()
}

pub fn decode_into(decoder: &mut Decoder, bytes: &[u8], last: bool) -> String {
    let capacity = decoder
        .max_utf8_buffer_length(bytes.len())
        .unwrap_or(bytes.len() * 3 + 16);
    let mut text = String::with_capacity(capacity);
    let (_result, read, _replaced) = decoder.decode_to_string(bytes, &mut text, last);
    debug_assert_eq!(read, bytes.len());
    text
}

/// Whether decoding the whole input drops its first three bytes as a byte-order mark.
pub fn starts_with_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xef, 0xbb, 0xbf])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_feff_that_does_not_start_the_stream() {
        let mut decoder = StreamDecoder::new();
        let bytes = [0xe2, 0x82, 0xef, 0xbb, 0xbf, 0x61];
        let text: String = bytes
            .iter()
            .map(|byte| decoder.decode(&[*byte], false))
            .collect::<String>()
            + &decoder.decode(&[], true);
        assert_eq!(text, "\u{fffd}\u{feff}a");
    }

    #[test]
    fn drops_only_a_leading_mark_and_never_sniffs_utf16() {
        let mut decoder = StreamDecoder::new();
        assert_eq!(
            decoder.decode(&[0xef, 0xbb], false) + &decoder.decode(&[0xbf, 0x61], true),
            "a"
        );
        let mut decoder = StreamDecoder::new();
        assert_eq!(
            decoder.decode(&[0xff, 0xfe, 0x41, 0x00], true),
            "\u{fffd}\u{fffd}A\u{0}"
        );
    }

    #[test]
    fn replaces_an_incomplete_sequence_once() {
        let mut decoder = StreamDecoder::new();
        assert_eq!(decoder.decode(&[0xe2, 0x82, 0x41], true), "\u{fffd}A");
        let mut decoder = StreamDecoder::new();
        assert_eq!(decoder.decode(&[0xe2, 0x82], true), "\u{fffd}");
    }
}
