// Streaming ripgrep-library search with bounded file pages and match-centred snippets.
use crate::{
    Control,
    decode::decoded_reader,
    pcre::{JIT_STACK_LIMIT, Utf8Matcher},
    walk::{self, LineRange, SearchTarget},
};
use grep_matcher::Matcher;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkMatch};
use napi_derive::napi;
use std::{
    collections::VecDeque,
    fs::File,
    io::{self, Read},
};

#[napi(object)]
pub struct GrepOptions {
    pub targets: Vec<SearchTarget>,
    pub exclusions: Vec<String>,
    pub pattern: String,
    pub glob: Option<String>,
    pub ignore_case: bool,
    pub literal: bool,
    pub gitignore: bool,
    pub context_before: u32,
    pub context_after: u32,
    pub per_file_limit: u32,
    pub match_limit: u32,
    pub file_limit: u32,
    pub skip: u32,
}

#[napi(object)]
pub struct MatchLine {
    pub number: f64,
    pub text: String,
    pub is_match: bool,
    pub column: Option<f64>,
}

#[napi(object)]
pub struct FileMatches {
    pub path: String,
    pub lines: Vec<MatchLine>,
    pub match_count: u32,
    pub limit_reached: bool,
    pub lines_truncated: bool,
    pub output_lines: f64,
    pub content_bytes: f64,
    pub number_bytes: f64,
}

#[napi(object)]
pub struct GrepResult {
    pub files: Vec<FileMatches>,
    pub file_limit_reached: bool,
    pub match_limit_reached: bool,
    pub skipped_files: u32,
}

pub fn grep(options: &GrepOptions, control: &Control) -> io::Result<GrepResult> {
    let mut rust = grep_regex::RegexMatcherBuilder::new();
    rust.case_insensitive(options.ignore_case)
        .multi_line(true)
        .fixed_strings(options.literal);
    let multiline =
        options.pattern.contains('\n') || (!options.literal && options.pattern.contains("\\n"));
    if !multiline {
        rust.line_terminator(Some(b'\n'));
    }
    match rust.build(&options.pattern) {
        Ok(matcher) => search(&matcher, options, multiline, false, control),
        Err(_) => {
            let matcher = grep_pcre2::RegexMatcherBuilder::new()
                .caseless(options.ignore_case)
                .multi_line(true)
                .fixed_strings(options.literal)
                .utf(true)
                .ucp(true)
                .jit_if_available(true)
                .max_jit_stack_size(Some(JIT_STACK_LIMIT))
                .build(&options.pattern)
                .map_err(io::Error::other)?;
            search(&matcher, options, multiline, true, control)
        }
    }
}

const SEARCH_HEAP_LIMIT: usize = 64 * 1024 * 1024;
const BUFFER_LIMIT_ERROR: &str = "Search allocation limit (64 MiB) exceeded";

fn search<M: Matcher>(
    matcher: &M,
    options: &GrepOptions,
    multiline: bool,
    utf8_empty_matches: bool,
    control: &Control,
) -> io::Result<GrepResult> {
    let mut result = GrepResult {
        files: Vec::new(),
        file_limit_reached: false,
        match_limit_reached: false,
        skipped_files: 0,
    };
    let mut skipped_matches = 0;
    let mut remaining = options.match_limit;
    let mut decode = [0; 8 * 1024];
    let mut input = if multiline {
        SearchInput::Multiline(MultilineInput {
            bytes: Vec::new(),
            used: 0,
            utf8_matcher: if utf8_empty_matches {
                Some(Utf8Matcher::new(
                    &options.pattern,
                    options.ignore_case,
                    options.literal,
                )?)
            } else {
                None
            },
        })
    } else {
        SearchInput::Lines(
            SearcherBuilder::new()
                .line_number(true)
                .bom_sniffing(false)
                .heap_limit(Some(SEARCH_HEAP_LIMIT))
                .binary_detection(BinaryDetection::quit(0))
                .before_context(options.context_before as usize)
                .after_context(options.context_after as usize)
                .build(),
        )
    };
    walk::visit(
        &options.targets,
        &options.exclusions,
        walk::Entries::Files,
        options.gitignore,
        options.glob.as_deref(),
        control,
        |path, target, is_dir, explicit| {
            if is_dir {
                return Ok(true);
            }
            let probing = skipped_matches < options.skip
                || result.files.len() >= options.file_limit as usize
                || remaining == 0;
            let mut sink = MatchSink {
                matcher,
                utf8_empty_matches,
                control,
                before: options.context_before as u64,
                ranges: &target.ranges,
                probe: probing,
                limit: if probing {
                    1
                } else {
                    options.per_file_limit.min(remaining)
                },
                after: options.context_after as u64,
                trailing_end: 0,
                stored_bytes: 0,
                pending: VecDeque::new(),
                pending_bytes: 0,
                last_emitted: 0,
                output: FileMatches {
                    path: String::new(),
                    lines: Vec::new(),
                    match_count: 0,
                    limit_reached: false,
                    lines_truncated: false,
                    output_lines: 0.0,
                    content_bytes: 0.0,
                    number_bytes: 0.0,
                },
            };
            let searched = File::open(path).and_then(|file| {
                let reader = decoded_reader(CheckedReader { file, control }, &mut decode)?;
                match &mut input {
                    SearchInput::Multiline(input) => {
                        if input.read(reader, control)? {
                            sink.search_multiline(
                                &input.bytes[..input.used],
                                input.utf8_matcher.as_mut(),
                            )?;
                        }
                        Ok(())
                    }
                    SearchInput::Lines(searcher) => {
                        searcher.search_reader(matcher, reader, &mut sink)
                    }
                }
            });
            control.check()?;
            if let Err(error) = searched {
                if explicit {
                    return Err(io::Error::other(format!(
                        "Cannot search {}: {error}",
                        path.display()
                    )));
                }
                result.skipped_files += 1;
                return Ok(true);
            }
            if sink.output.match_count == 0 {
                return Ok(true);
            }
            if skipped_matches < options.skip {
                skipped_matches += 1;
                return Ok(true);
            }
            if remaining == 0 {
                result.match_limit_reached = true;
                return Ok(false);
            }
            if result.files.len() >= options.file_limit as usize {
                result.file_limit_reached = true;
                return Ok(false);
            }
            remaining -= sink.output.match_count;
            if remaining == 0 && sink.output.limit_reached {
                result.match_limit_reached = true;
            }
            sink.output.path = walk::display_path(path);
            result.files.push(sink.output);
            Ok(true)
        },
    )?;
    Ok(result)
}

struct CheckedReader<'a> {
    file: File,
    control: &'a Control,
}

impl Read for CheckedReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.control.check()?;
        self.file.read(buffer)
    }
}

enum SearchInput {
    Lines(Searcher),
    Multiline(MultilineInput),
}

struct MultilineInput {
    bytes: Vec<u8>,
    used: usize,
    utf8_matcher: Option<Utf8Matcher>,
}

impl MultilineInput {
    fn read(&mut self, mut decoder: impl Read, control: &Control) -> io::Result<bool> {
        self.used = 0;
        if self.bytes.is_empty() {
            self.bytes.resize(64 * 1024, 0);
        }
        let mut used = 0;
        let mut tail = [0; 1];
        loop {
            control.check()?;
            if self.bytes.len() == used && self.bytes.len() < SEARCH_HEAP_LIMIT {
                self.bytes
                    .resize((self.bytes.len() * 2).min(SEARCH_HEAP_LIMIT), 0);
            }
            let available = self.bytes.len() - used;
            let destination = if available == 0 {
                &mut tail[..]
            } else {
                &mut self.bytes[used..]
            };
            let read = match decoder.read(destination) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => result?,
            };
            if read > available {
                return Err(io::Error::other(BUFFER_LIMIT_ERROR));
            }
            // A nonempty tail is already rejected above: it exceeds the heap limit.
            if read == 0 {
                break;
            }
            if self.bytes[used..used + read].contains(&0) {
                return Ok(false);
            }
            used += read;
        }
        self.used = used;
        Ok(true)
    }
}

struct MatchSink<'a, M> {
    matcher: &'a M,
    utf8_empty_matches: bool,
    control: &'a Control,
    ranges: &'a [LineRange],
    probe: bool,
    before: u64,
    limit: u32,
    after: u64,
    trailing_end: u64,
    stored_bytes: usize,
    pending: VecDeque<PendingContext>,
    pending_bytes: usize,
    last_emitted: u64,
    output: FileMatches,
}

struct PendingContext {
    number: u64,
    text: String,
    text_bytes: usize,
    truncated: bool,
}

impl<M: Matcher> MatchSink<'_, M> {
    fn in_range(&self, number: u64) -> bool {
        self.ranges.is_empty()
            || self
                .ranges
                .iter()
                .any(|range| number >= range.start as u64 && number <= range.end as u64)
    }

    fn prune_context(&mut self, first: u64) {
        while self.pending.front().is_some_and(|line| line.number < first) {
            let line = self.pending.pop_front().expect("pending context exists");
            self.pending_bytes -= std::mem::size_of::<PendingContext>() + line.text.len();
        }
    }

    fn retain_context(&mut self, number: u64, bytes: &[u8]) -> io::Result<()> {
        self.prune_context(number.saturating_sub(self.before).saturating_add(1));
        if self.before == 0 || !self.in_range(number) || number <= self.last_emitted {
            return Ok(());
        }
        let content = String::from_utf8_lossy(display_bytes(bytes));
        let truncated = content.len() > 512;
        let (text, prefix, suffix) = snippet(&content, 0);
        let text_bytes = text.len() + prefix.len() + suffix.len();
        // After the output cap, retain only sizes needed for truthful truncation totals.
        let stored = self.stored_bytes <= 50 * 1024;
        let cost = std::mem::size_of::<PendingContext>() + if stored { text_bytes } else { 0 };
        if self.pending_bytes + cost > SEARCH_HEAP_LIMIT {
            return Err(io::Error::other(BUFFER_LIMIT_ERROR));
        }
        let text = if stored {
            display_text(text, prefix, suffix)
        } else {
            String::new()
        };
        self.pending_bytes += cost;
        self.pending.push_back(PendingContext {
            number,
            text,
            text_bytes,
            truncated,
        });
        Ok(())
    }

    fn flush_context(&mut self, number: u64) {
        self.prune_context(number.saturating_sub(self.before));
        while let Some(line) = self.pending.pop_front() {
            self.pending_bytes -= std::mem::size_of::<PendingContext>() + line.text.len();
            if line.number > self.last_emitted {
                self.record(
                    line.number,
                    false,
                    None,
                    line.truncated,
                    line.text_bytes,
                    || line.text,
                );
            }
        }
    }

    fn search_multiline(
        &mut self,
        buffer: &[u8],
        mut utf8_matcher: Option<&mut Utf8Matcher>,
    ) -> io::Result<()> {
        if buffer.is_empty() {
            return Ok(());
        }
        let subject = utf8_matcher
            .as_ref()
            .and_then(|_| std::str::from_utf8(buffer).ok());
        let mut lines = buffer.split_inclusive(|&byte| byte == b'\n');
        let mut next_line = 1u64;
        let mut emit_until =
            |sink: &mut Self, end: u64, selected: Option<(u64, usize)>| -> io::Result<()> {
                while next_line <= end {
                    let Some(line) = lines.next() else { break };
                    sink.control.check()?;
                    let is_match = selected.is_some_and(|(start, _)| next_line >= start);
                    let before = selected
                        .is_some_and(|(start, _)| next_line >= start.saturating_sub(sink.before));
                    if is_match || before || next_line <= sink.trailing_end {
                        let offset = selected
                            .filter(|(start, _)| next_line == *start)
                            .map_or(0, |(_, offset)| offset);
                        sink.push(next_line, line, is_match, || Ok(offset))?;
                    }
                    next_line += 1;
                }
                Ok(())
            };
        let mut scan = 0;
        let mut scan_line = 1u64;
        let mut line_start = 0;
        let mut at = 0;
        let mut previous_end = None;
        while at <= buffer.len() {
            self.control.check()?;
            // Keep the complete subject for lookbehind and input-boundary assertions.
            let found = match (utf8_matcher.as_deref_mut(), subject) {
                (Some(matcher), Some(subject)) => matcher.find_at(subject, at, self.matcher)?,
                _ => self
                    .matcher
                    .find_at(buffer, at)
                    .map_err(|error| io::Error::other(error.to_string()))?,
            };
            let Some(found) = found else {
                break;
            };
            at = found.end();
            if found.is_empty() {
                at += 1;
                // PCRE2's UTF mode must not restart inside a character and lose lookbehind.
                if self.utf8_empty_matches {
                    while at < buffer.len() && buffer[at] & 0xc0 == 0x80 {
                        at += 1;
                    }
                }
                if previous_end == Some(found.end()) {
                    continue;
                }
            }
            previous_end = Some(found.end());
            if found.start() == buffer.len() && buffer.ends_with(b"\n") {
                break;
            }
            for (index, byte) in buffer[scan..found.start()].iter().enumerate() {
                if *byte == b'\n' {
                    scan_line += 1;
                    line_start = scan + index + 1;
                }
            }
            let start_line = scan_line;
            let offset = found.start() - line_start;
            let bytes = &buffer[found.start()..found.end()];
            for (index, byte) in bytes.iter().enumerate() {
                if *byte == b'\n' {
                    scan_line += 1;
                    line_start = found.start() + index + 1;
                }
            }
            scan = found.end();
            let end_line = scan_line - u64::from(bytes.ends_with(b"\n"));
            if !self.in_range(start_line) {
                continue;
            }
            if self.probe {
                self.output.match_count = 1;
                break;
            }
            if self.output.match_count == self.limit {
                self.output.limit_reached = true;
                break;
            }
            self.output.match_count += 1;
            emit_until(self, end_line, Some((start_line, offset)))?;
            self.trailing_end = end_line.saturating_add(self.after);
        }
        if !self.probe {
            emit_until(self, self.trailing_end, None)?;
        }
        Ok(())
    }

    fn push(
        &mut self,
        number: u64,
        bytes: &[u8],
        is_match: bool,
        offset: impl FnOnce() -> io::Result<usize>,
    ) -> io::Result<()> {
        if !self.in_range(number) || number <= self.last_emitted {
            return Ok(());
        }
        let bytes = display_bytes(bytes);
        let content = String::from_utf8_lossy(bytes);
        let truncated = content.len() > 512;
        let (decoded_offset, column) = if is_match && truncated {
            let offset = offset()?.min(bytes.len());
            let mut decoded_offset = 0;
            let mut column = 1;
            for chunk in bytes[..offset].utf8_chunks() {
                decoded_offset += chunk.valid().len();
                column += chunk.valid().chars().count();
                if !chunk.invalid().is_empty() {
                    decoded_offset += "\u{fffd}".len();
                    column += 1;
                }
            }
            (decoded_offset.min(content.len()), Some(column))
        } else {
            (0, None)
        };
        let (text, prefix, suffix) = snippet(&content, decoded_offset);
        self.record(
            number,
            is_match,
            column,
            truncated,
            text.len() + prefix.len() + suffix.len(),
            || display_text(text, prefix, suffix),
        );
        Ok(())
    }

    fn record(
        &mut self,
        number: u64,
        is_match: bool,
        column: Option<usize>,
        truncated: bool,
        text_bytes: usize,
        text: impl FnOnce() -> String,
    ) {
        self.last_emitted = number;
        self.output.lines_truncated |= truncated;
        self.output.output_lines += 1.0;
        self.output.content_bytes +=
            (text_bytes + column.map_or(0, |value| 8 + value.ilog10() as usize)) as f64;
        self.output.number_bytes += (number.ilog10() + 1) as f64;
        // Keep one line past the byte budget so the TypeScript formatter can prove truncation.
        if self.stored_bytes <= 50 * 1024 {
            self.stored_bytes += text_bytes + 1;
            self.output.lines.push(MatchLine {
                number: number as f64,
                text: text(),
                is_match,
                column: column.map(|column| column as f64),
            });
        }
    }
}

impl<M: Matcher> Sink for MatchSink<'_, M> {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, matched: &SinkMatch<'_>) -> io::Result<bool> {
        self.control.check()?;
        let number = matched
            .line_number()
            .expect("searcher has line numbers enabled");
        self.prune_context(number.saturating_sub(self.before));
        if !self.in_range(number) {
            return Ok(true);
        }
        if self.probe {
            self.output.match_count = 1;
            return Ok(false);
        }
        let selected = self.output.match_count < self.limit;
        if selected {
            self.flush_context(number);
            self.output.match_count += 1;
        } else {
            self.output.limit_reached = true;
        }
        if selected || number <= self.trailing_end {
            let matcher = self.matcher;
            // Match against the same LF-stripped line subject used by grep-searcher.
            let subject = matched
                .bytes()
                .strip_suffix(b"\n")
                .unwrap_or(matched.bytes());
            self.push(number, matched.bytes(), selected, || {
                matcher
                    .find(subject)
                    .map_err(|error| io::Error::other(error.to_string()))?
                    .map(|found| found.start())
                    .ok_or_else(|| io::Error::other("Cannot locate matched line for snippet"))
            })?;
            if selected {
                self.trailing_end = number.saturating_add(self.after);
            }
        }
        Ok(selected || number < self.trailing_end)
    }

    fn context(&mut self, _searcher: &Searcher, context: &SinkContext<'_>) -> io::Result<bool> {
        self.control.check()?;
        let number = context
            .line_number()
            .expect("searcher has line numbers enabled");
        if self.probe {
            return Ok(true);
        }
        if number <= self.trailing_end {
            self.push(number, context.bytes(), false, || Ok(0))?;
        } else if self.output.match_count < self.limit {
            // Raw-match context can be needed again after an excluded match or a buffer roll.
            self.retain_context(number, context.bytes())?;
        }
        Ok(!self.output.limit_reached || number < self.trailing_end)
    }
}

fn display_bytes(bytes: &[u8]) -> &[u8] {
    bytes
        .strip_suffix(b"\n")
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line))
        .unwrap_or(bytes)
}

fn display_text(text: &str, prefix: &str, suffix: &str) -> String {
    let mut output = String::with_capacity(prefix.len() + text.len() + suffix.len());
    output.push_str(prefix);
    output.push_str(text);
    output.push_str(suffix);
    output
}

fn snippet(content: &str, offset: usize) -> (&str, &'static str, &'static str) {
    const WIDTH: usize = 512;
    if content.len() <= WIDTH {
        return (content, "", "");
    }
    let mut start = if offset < WIDTH - 3 {
        0
    } else {
        offset.saturating_sub(WIDTH / 2)
    };
    while !content.is_char_boundary(start) {
        start -= 1;
    }
    let prefix = if start > 0 { "..." } else { "" };
    let mut end = (start + WIDTH - prefix.len()).min(content.len());
    let suffix = if end < content.len() {
        end -= 3;
        "..."
    } else {
        ""
    };
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    (&content[start..end], prefix, suffix)
}
