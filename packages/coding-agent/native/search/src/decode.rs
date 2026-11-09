// Preserve decoder EOF output when a streaming search requests fewer than four bytes.
use encoding_rs_io::DecodeReaderBytesBuilder;
use std::io::{self, Read};

/// Decode BOM-marked input without losing pending replacement bytes in tiny reads.
pub fn decoded_reader<R: Read>(reader: R, scratch: &mut [u8]) -> io::Result<impl Read> {
    let reader = DecodeReaderBytesBuilder::new()
        .utf8_passthru(true)
        .strip_bom(true)
        .bom_override(true)
        .bom_sniffing(true)
        .build_with_buffer(reader, scratch)?;
    Ok(DecodedReader {
        reader,
        pending: [0; 4],
        start: 0,
        end: 0,
    })
}

struct DecodedReader<R> {
    reader: R,
    pending: [u8; 4],
    start: usize,
    end: usize,
}

impl<R: Read> Read for DecodedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.start == self.end {
            if buffer.len() >= 4 {
                return self.reader.read(buffer);
            }
            // The pinned decoder can report EOF before draining its own tiny-read
            // buffer. Always give it four bytes, then drain our pending bytes first.
            let count = self.reader.read(&mut self.pending)?;
            self.start = 0;
            self.end = count;
        }
        let count = buffer.len().min(self.end - self.start);
        buffer[..count].copy_from_slice(&self.pending[self.start..self.start + count]);
        self.start += count;
        Ok(count)
    }
}
