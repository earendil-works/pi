//! Port of Durable's `LineScanner` (`env/line-scan.ts`): locates lines `[start_line, end_line)` of a file fed in order
//! and measures their decoded UTF-8 size as `new TextDecoder().decode(file)` would produce it.

use crate::decode::{decode_into, range_decoder, starts_with_bom};
use encoding_rs::Decoder;
use serde_json::{Value, json};

const NEWLINE: u8 = 0x0a;

pub struct LineScanner {
    start_line: u64,
    end_line: Option<u64>,
    position: u64,
    newlines: u64,
    line_start: u64,
    start: Option<u64>,
    end: Option<u64>,
    first_line_end: Option<u64>,
    last_line_start: Option<u64>,
    selected_bytes: u64,
    first_line_bytes: u64,
    selection: Option<Decoder>,
    first_line: Option<Decoder>,
    head: Option<Vec<u8>>,
    bom: bool,
}

impl LineScanner {
    /// `end_line`, when given, must be greater than `start_line`.
    pub fn new(start_line: u64, end_line: Option<u64>) -> LineScanner {
        let mut scanner = LineScanner {
            start_line,
            end_line,
            position: 0,
            newlines: 0,
            line_start: 0,
            start: None,
            end: None,
            first_line_end: None,
            last_line_start: None,
            selected_bytes: 0,
            first_line_bytes: 0,
            selection: None,
            first_line: None,
            head: Some(Vec::with_capacity(3)),
            bom: false,
        };
        if start_line == 0 {
            scanner.begin(0);
        }
        scanner
    }

    fn is_last_line(&self, line: u64) -> bool {
        self.end_line.is_some_and(|end| line + 1 == end)
    }

    pub fn push(&mut self, mut chunk: &[u8]) {
        if let Some(head) = &mut self.head {
            let take = (3 - head.len()).min(chunk.len());
            head.extend_from_slice(&chunk[..take]);
            if head.len() < 3 {
                return;
            }
            chunk = &chunk[take..];
            self.release_head();
        }
        self.process(chunk);
    }

    fn release_head(&mut self) {
        let head = self.head.take().unwrap_or_default();
        self.bom = starts_with_bom(&head);
        self.process(&head);
    }

    fn process(&mut self, chunk: &[u8]) {
        let base = self.position;
        let mut from = 0;
        let mut index = 0;
        while let Some(found) = chunk[index..].iter().position(|byte| *byte == NEWLINE) {
            let newline = index + found;
            // The newline ends line `self.newlines`; it belongs to the selection between selected lines only.
            self.feed(chunk, base, from, newline);
            let line = self.newlines;
            let position = base + newline as u64;
            if line == self.start_line {
                self.end_first_line(position);
            }
            if self.is_last_line(line) {
                self.end_selection(position);
            }
            self.feed(chunk, base, newline, newline + 1);
            from = newline + 1;
            self.newlines += 1;
            self.line_start = position + 1;
            if self.newlines == self.start_line {
                self.begin(self.line_start);
            }
            if self.is_last_line(self.newlines) {
                self.last_line_start = Some(self.line_start);
            }
            index = newline + 1;
        }
        self.feed(chunk, base, from, chunk.len());
        self.position += chunk.len() as u64;
    }

    pub fn finish(mut self) -> Value {
        if self.head.is_some() {
            self.release_head();
        }
        let size = self.position;
        let Some(start) = self.start else {
            return json!({
                "newlines": self.newlines, "start": size, "end": size, "firstLineEnd": size,
                "lastLineStart": size, "selectedBytes": 0, "firstLineBytes": 0,
            });
        };
        if self.first_line_end.is_none() {
            self.end_first_line(size);
        }
        if self.end.is_none() {
            self.end_selection(size);
        }
        json!({
            "newlines": self.newlines,
            "start": start,
            "end": self.end.unwrap_or(size),
            "firstLineEnd": self.first_line_end.unwrap_or(size),
            // A selection that reaches past the last line ends with the last line.
            "lastLineStart": self.last_line_start.unwrap_or(self.line_start),
            "selectedBytes": self.selected_bytes,
            "firstLineBytes": self.first_line_bytes,
        })
    }

    fn begin(&mut self, start: u64) {
        self.start = Some(start);
        if self.is_last_line(self.start_line) {
            self.last_line_start = Some(start);
        }
        self.selection = Some(range_decoder());
        self.first_line = Some(range_decoder());
    }

    fn end_first_line(&mut self, position: u64) {
        self.first_line_end = Some(position);
        if let Some(mut decoder) = self.first_line.take() {
            self.first_line_bytes += decode_into(&mut decoder, &[], true).len() as u64;
        }
    }

    fn end_selection(&mut self, position: u64) {
        self.end = Some(position);
        if let Some(mut decoder) = self.selection.take() {
            self.selected_bytes += decode_into(&mut decoder, &[], true).len() as u64;
        }
    }

    fn feed(&mut self, chunk: &[u8], base: u64, mut from: usize, to: usize) {
        // Decoding the whole file drops a leading byte-order mark.
        if self.bom && base + (from as u64) < 3 {
            from = to.min((3 - base) as usize);
        }
        if to <= from {
            return;
        }
        let bytes = &chunk[from..to];
        if let Some(decoder) = &mut self.selection {
            self.selected_bytes += decode_into(decoder, bytes, false).len() as u64;
        }
        if let Some(decoder) = &mut self.first_line {
            self.first_line_bytes += decode_into(decoder, bytes, false).len() as u64;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(file: &[u8], start: u64, end: Option<u64>, chunk: usize) -> Value {
        let mut scanner = LineScanner::new(start, end);
        for piece in file.chunks(chunk.max(1)) {
            scanner.push(piece);
        }
        scanner.finish()
    }

    #[test]
    fn locates_and_measures_lines_like_whole_file_decoding() {
        // BOM, "a", invalid sequence, empty line, a later U+FEFF, and no final newline.
        let file = [
            0xef, 0xbb, 0xbf, 0x61, 0x0a, 0xe2, 0x82, 0x0a, 0x0a, 0xef, 0xbb, 0xbf, 0x62, 0x0a,
            0xc3, 0xa9,
        ];
        for chunk in 1..6 {
            let all = scan(&file, 0, None, chunk);
            assert_eq!(all["newlines"], 4);
            // "a\n\u{fffd}\n\n\u{feff}b\né" is 1+1+3+1+1+3+1+1+2 = 14 bytes.
            assert_eq!(all["selectedBytes"], 14);
            assert_eq!(all["firstLineBytes"], 1);
            let middle = scan(&file, 1, Some(3), chunk);
            assert_eq!(
                (middle["start"].as_u64(), middle["end"].as_u64()),
                (Some(5), Some(8))
            );
            assert_eq!(middle["selectedBytes"], 4);
            assert_eq!(middle["lastLineStart"], 8);
            let past = scan(&file, 9, None, chunk);
            assert_eq!(past["start"], 16);
        }
    }
}
