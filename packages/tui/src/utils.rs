use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[must_use]
pub fn strip_terminal_sequences(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut output = String::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b {
            if index + 1 < bytes.len() && bytes[index + 1] == b'[' {
                index += 2;
                while index < bytes.len() {
                    let byte = bytes[index];
                    index += 1;
                    if (0x40..=0x7e).contains(&byte) {
                        break;
                    }
                }
                continue;
            }
            if index + 1 < bytes.len() && matches!(bytes[index + 1], b']' | b'_') {
                index += 2;
                while index < bytes.len() {
                    if bytes[index] == 0x07 {
                        index += 1;
                        break;
                    }
                    if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
                        index += 2;
                        break;
                    }
                    index += 1;
                }
                continue;
            }
        }
        let tail = &text[index..];
        let character = tail.chars().next().expect("valid UTF-8 character boundary");
        output.push(character);
        index += character.len_utf8();
    }
    output
}

#[must_use]
pub fn visible_width(text: &str) -> usize {
    strip_terminal_sequences(text)
        .graphemes(true)
        .map(UnicodeWidthStr::width)
        .sum()
}

#[must_use]
pub fn truncate_to_width(text: &str, width: usize, ellipsis: &str) -> String {
    if visible_width(text) <= width {
        return text.to_owned();
    }
    let ellipsis_width = visible_width(ellipsis).min(width);
    let available = width.saturating_sub(ellipsis_width);
    let plain = strip_terminal_sequences(text);
    let mut output = String::new();
    let mut used = 0;
    for grapheme in plain.graphemes(true) {
        let grapheme_width = UnicodeWidthStr::width(grapheme);
        if used + grapheme_width > available {
            break;
        }
        output.push_str(grapheme);
        used += grapheme_width;
    }
    output.push_str(&truncate_plain(ellipsis, width.saturating_sub(used)));
    output
}

fn truncate_plain(text: &str, width: usize) -> String {
    let mut result = String::new();
    let mut used = 0;
    for grapheme in text.graphemes(true) {
        let current = UnicodeWidthStr::width(grapheme);
        if used + current > width {
            break;
        }
        result.push_str(grapheme);
        used += current;
    }
    result
}

#[must_use]
pub fn wrap_text_with_ansi(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![String::new()];
    }
    let plain = strip_terminal_sequences(text);
    let mut output = Vec::new();
    for source_line in plain.split('\n') {
        if source_line.is_empty() {
            output.push(String::new());
            continue;
        }
        let mut line = String::new();
        let mut line_width = 0;
        for word in source_line.split_inclusive(char::is_whitespace) {
            let word_width = visible_width(word);
            if line_width > 0 && line_width + word_width > width {
                output.push(line.trim_end().to_owned());
                line.clear();
                line_width = 0;
            }
            if word_width > width {
                for grapheme in word.graphemes(true) {
                    let current = UnicodeWidthStr::width(grapheme);
                    if line_width + current > width && !line.is_empty() {
                        output.push(std::mem::take(&mut line));
                        line_width = 0;
                    }
                    line.push_str(grapheme);
                    line_width += current;
                }
            } else {
                line.push_str(word);
                line_width += word_width;
            }
        }
        if !line.is_empty() {
            output.push(line.trim_end().to_owned());
        }
    }
    if output.is_empty() {
        output.push(String::new())
    }
    output
}

#[must_use]
pub fn slice_by_column(text: &str, start: usize, end: usize) -> String {
    let plain = strip_terminal_sequences(text);
    let mut output = String::new();
    let mut column = 0;
    for grapheme in plain.graphemes(true) {
        let width = UnicodeWidthStr::width(grapheme);
        if column >= start && column + width <= end {
            output.push_str(grapheme)
        }
        column += width;
        if column >= end {
            break;
        }
    }
    output
}

#[must_use]
pub fn hyperlink(text: &str, url: &str) -> String {
    format!("\x1b]8;;{url}\x1b\\{text}\x1b]8;;\x1b\\")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn widths_handle_cjk_and_ansi() {
        assert_eq!(visible_width("\x1b[31m台灣\x1b[0m"), 4);
        assert_eq!(truncate_to_width("hello world", 8, "..."), "hello...");
    }
    #[test]
    fn wraps() {
        assert_eq!(wrap_text_with_ansi("one two three", 7), vec!["one", "two", "three"]);
    }
}
