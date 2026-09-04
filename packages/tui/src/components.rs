use std::sync::Arc;

use parking_lot::Mutex;
use unicode_segmentation::UnicodeSegmentation;

use crate::{matches_key, truncate_to_width, visible_width, wrap_text_with_ansi};

pub trait Component: Send {
    fn render(&mut self, width: usize) -> Vec<String>;
    fn handle_input(&mut self, _data: &str) {}
    fn invalidate(&mut self) {}
}

pub type SharedComponent = Arc<Mutex<dyn Component>>;

pub struct Container {
    children: Vec<SharedComponent>,
}
impl Container {
    #[must_use]
    pub fn new() -> Self {
        Self { children: Vec::new() }
    }
    pub fn add_child(&mut self, child: SharedComponent) {
        self.children.push(child)
    }
    pub fn remove_child(&mut self, child: &SharedComponent) {
        self.children.retain(|candidate| !Arc::ptr_eq(candidate, child));
    }
    #[must_use]
    pub fn children(&self) -> &[SharedComponent] {
        &self.children
    }
}
impl Default for Container {
    fn default() -> Self {
        Self::new()
    }
}
impl Component for Container {
    fn render(&mut self, width: usize) -> Vec<String> {
        self.children
            .iter()
            .flat_map(|child| child.lock().render(width))
            .collect()
    }
    fn invalidate(&mut self) {
        for child in &self.children {
            child.lock().invalidate()
        }
    }
}

pub struct Text {
    text: String,
    padding_x: usize,
    padding_y: usize,
}
impl Text {
    #[must_use]
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            padding_x: 0,
            padding_y: 0,
        }
    }
    #[must_use]
    pub fn with_padding(text: impl Into<String>, x: usize, y: usize) -> Self {
        Self {
            text: text.into(),
            padding_x: x,
            padding_y: y,
        }
    }
    pub fn set_text(&mut self, text: impl Into<String>) {
        self.text = text.into();
    }
}
impl Component for Text {
    fn render(&mut self, width: usize) -> Vec<String> {
        let inner = width.saturating_sub(self.padding_x * 2);
        let padding = " ".repeat(self.padding_x);
        let mut lines = vec![String::new(); self.padding_y];
        for line in wrap_text_with_ansi(&self.text, inner) {
            lines.push(format!("{padding}{line}"));
        }
        lines.extend(std::iter::repeat_n(String::new(), self.padding_y));
        lines
    }
}

pub struct TruncatedText {
    pub text: String,
    padding_x: usize,
    padding_y: usize,
}
impl TruncatedText {
    #[must_use]
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            padding_x: 0,
            padding_y: 0,
        }
    }
    #[must_use]
    pub fn with_padding(text: impl Into<String>, x: usize, y: usize) -> Self {
        Self {
            text: text.into(),
            padding_x: x,
            padding_y: y,
        }
    }
}
impl Component for TruncatedText {
    fn render(&mut self, width: usize) -> Vec<String> {
        let mut lines = vec![String::new(); self.padding_y];
        let inner = width.saturating_sub(self.padding_x * 2);
        lines.push(format!(
            "{}{}",
            " ".repeat(self.padding_x),
            truncate_to_width(&self.text, inner, "...")
        ));
        lines.extend(std::iter::repeat_n(String::new(), self.padding_y));
        lines
    }
}

pub struct Spacer(pub usize);
impl Component for Spacer {
    fn render(&mut self, _: usize) -> Vec<String> {
        vec![String::new(); self.0]
    }
}

pub struct BoxComponent {
    pub child: SharedComponent,
    padding_x: usize,
    padding_y: usize,
    border: bool,
}
impl BoxComponent {
    #[must_use]
    pub fn new(child: SharedComponent, padding_x: usize, padding_y: usize) -> Self {
        Self {
            child,
            padding_x,
            padding_y,
            border: false,
        }
    }
    pub fn set_border(&mut self, border: bool) {
        self.border = border
    }
}
impl Component for BoxComponent {
    fn render(&mut self, width: usize) -> Vec<String> {
        let border = usize::from(self.border);
        let inner = width.saturating_sub(self.padding_x * 2 + border * 2);
        let content = self.child.lock().render(inner);
        let mut output = Vec::new();
        if self.border {
            output.push(format!("┌{}┐", "─".repeat(width.saturating_sub(2))))
        }
        output.extend(std::iter::repeat_n(String::new(), self.padding_y));
        for line in content {
            let mut row = format!("{}{}", " ".repeat(self.padding_x), line);
            let remaining = inner.saturating_sub(visible_width(&row).saturating_sub(self.padding_x));
            row.push_str(&" ".repeat(remaining + self.padding_x));
            output.push(if self.border { format!("│{row}│") } else { row });
        }
        output.extend(std::iter::repeat_n(String::new(), self.padding_y));
        if self.border {
            output.push(format!("└{}┘", "─".repeat(width.saturating_sub(2))))
        }
        output
    }
}

pub struct VStack {
    children: Vec<SharedComponent>,
    spacing: usize,
}
impl VStack {
    #[must_use]
    pub fn new(children: Vec<SharedComponent>) -> Self {
        Self { children, spacing: 0 }
    }
    pub fn set_spacing(&mut self, spacing: usize) {
        self.spacing = spacing
    }
}
impl Component for VStack {
    fn render(&mut self, width: usize) -> Vec<String> {
        let mut output = Vec::new();
        for (index, child) in self.children.iter().enumerate() {
            if index > 0 {
                output.extend(std::iter::repeat_n(String::new(), self.spacing))
            }
            output.extend(child.lock().render(width));
        }
        output
    }
}

pub struct HStack {
    children: Vec<SharedComponent>,
    spacing: usize,
}
impl HStack {
    #[must_use]
    pub fn new(children: Vec<SharedComponent>) -> Self {
        Self { children, spacing: 1 }
    }
}
impl Component for HStack {
    fn render(&mut self, width: usize) -> Vec<String> {
        if self.children.is_empty() {
            return Vec::new();
        }
        let each = width.saturating_sub(self.spacing * (self.children.len() - 1)) / self.children.len();
        let rendered = self
            .children
            .iter()
            .map(|child| child.lock().render(each))
            .collect::<Vec<_>>();
        let height = rendered.iter().map(Vec::len).max().unwrap_or(0);
        (0..height)
            .map(|row| {
                rendered
                    .iter()
                    .map(|lines| {
                        let line = lines.get(row).cloned().unwrap_or_default();
                        format!("{line}{}", " ".repeat(each.saturating_sub(visible_width(&line))))
                    })
                    .collect::<Vec<_>>()
                    .join(&" ".repeat(self.spacing))
            })
            .collect()
    }
}

pub struct Input {
    value: String,
    cursor: usize,
    pub focused: bool,
    pub on_submit: Option<Box<dyn FnMut(String) + Send>>,
    pub on_change: Option<Box<dyn FnMut(String) + Send>>,
}
impl Input {
    #[must_use]
    pub fn new() -> Self {
        Self {
            value: String::new(),
            cursor: 0,
            focused: false,
            on_submit: None,
            on_change: None,
        }
    }
    pub fn set_value(&mut self, value: impl Into<String>) {
        self.value = value.into();
        self.cursor = self.value.len();
    }
    #[must_use]
    pub fn value(&self) -> &str {
        &self.value
    }
    fn changed(&mut self) {
        if let Some(callback) = &mut self.on_change {
            callback(self.value.clone())
        }
    }
    fn previous_boundary(&self) -> usize {
        self.value[..self.cursor]
            .grapheme_indices(true)
            .last()
            .map_or(0, |(index, _)| index)
    }
    fn next_boundary(&self) -> usize {
        self.value[self.cursor..]
            .grapheme_indices(true)
            .nth(1)
            .map_or(self.value.len(), |(index, _)| self.cursor + index)
    }
}
impl Default for Input {
    fn default() -> Self {
        Self::new()
    }
}
impl Component for Input {
    fn render(&mut self, width: usize) -> Vec<String> {
        let before = &self.value[..self.cursor];
        let after = &self.value[self.cursor..];
        let cursor = after.graphemes(true).next().unwrap_or(" ");
        let rest = &after[cursor.len().min(after.len())..];
        vec![truncate_to_width(
            &format!("{before}\x1b[7m{cursor}\x1b[27m{rest}"),
            width,
            "",
        )]
    }
    fn handle_input(&mut self, data: &str) {
        if matches_key(data, "enter") {
            if let Some(callback) = &mut self.on_submit {
                callback(self.value.clone())
            }
            return;
        }
        if matches_key(data, "left") {
            self.cursor = self.previous_boundary()
        } else if matches_key(data, "right") {
            self.cursor = self.next_boundary()
        } else if matches_key(data, "home") || matches_key(data, "ctrl+a") {
            self.cursor = 0
        } else if matches_key(data, "end") || matches_key(data, "ctrl+e") {
            self.cursor = self.value.len()
        } else if matches_key(data, "backspace") {
            let previous = self.previous_boundary();
            self.value.replace_range(previous..self.cursor, "");
            self.cursor = previous;
            self.changed()
        } else if matches_key(data, "delete") {
            let next = self.next_boundary();
            self.value.replace_range(self.cursor..next, "");
            self.changed()
        } else if matches_key(data, "ctrl+u") {
            self.value.replace_range(..self.cursor, "");
            self.cursor = 0;
            self.changed()
        } else if matches_key(data, "ctrl+k") {
            self.value.truncate(self.cursor);
            self.changed()
        } else if !data.starts_with('\x1b') && !data.chars().any(char::is_control) {
            self.value.insert_str(self.cursor, data);
            self.cursor += data.len();
            self.changed()
        }
    }
}

pub struct Editor {
    value: String,
    cursor: usize,
    history: Vec<String>,
    history_index: Option<usize>,
    pub disable_submit: bool,
    pub on_submit: Option<Box<dyn FnMut(String) + Send>>,
    pub on_change: Option<Box<dyn FnMut(String) + Send>>,
}
impl Editor {
    #[must_use]
    pub fn new() -> Self {
        Self {
            value: String::new(),
            cursor: 0,
            history: Vec::new(),
            history_index: None,
            disable_submit: false,
            on_submit: None,
            on_change: None,
        }
    }
    #[must_use]
    pub fn value(&self) -> &str {
        &self.value
    }
    pub fn set_text(&mut self, text: impl Into<String>) {
        self.value = text.into();
        self.cursor = self.value.len();
    }
    pub fn clear(&mut self) {
        self.value.clear();
        self.cursor = 0;
    }
    fn notify(&mut self) {
        if let Some(callback) = &mut self.on_change {
            callback(self.value.clone())
        }
    }
    fn submit(&mut self) {
        if self.disable_submit || self.value.trim().is_empty() {
            return;
        }
        let value = std::mem::take(&mut self.value);
        self.cursor = 0;
        self.history.push(value.clone());
        self.history_index = None;
        if let Some(callback) = &mut self.on_submit {
            callback(value)
        }
    }
}
impl Default for Editor {
    fn default() -> Self {
        Self::new()
    }
}
impl Component for Editor {
    fn render(&mut self, width: usize) -> Vec<String> {
        let before = &self.value[..self.cursor];
        let after = &self.value[self.cursor..];
        let marked = format!(
            "{before}\x1b[7m{}\x1b[27m{}",
            after.chars().next().unwrap_or(' '),
            after.chars().skip(1).collect::<String>()
        );
        let mut lines = wrap_text_with_ansi(&marked, width.saturating_sub(2));
        for line in &mut lines {
            *line = format!("> {line}")
        }
        lines
    }
    fn handle_input(&mut self, data: &str) {
        if matches_key(data, "enter") {
            self.submit();
            return;
        }
        if matches_key(data, "shift+enter") || matches_key(data, "alt+enter") || matches_key(data, "ctrl+enter") {
            self.value.insert(self.cursor, '\n');
            self.cursor += 1;
            self.notify();
            return;
        }
        if matches_key(data, "left") {
            self.cursor = self.value[..self.cursor]
                .grapheme_indices(true)
                .last()
                .map_or(0, |(i, _)| i)
        } else if matches_key(data, "right") {
            self.cursor = self.value[self.cursor..]
                .grapheme_indices(true)
                .nth(1)
                .map_or(self.value.len(), |(i, _)| self.cursor + i)
        } else if matches_key(data, "backspace") {
            let previous = self.value[..self.cursor]
                .grapheme_indices(true)
                .last()
                .map_or(0, |(i, _)| i);
            self.value.replace_range(previous..self.cursor, "");
            self.cursor = previous;
            self.notify()
        } else if matches_key(data, "ctrl+c") {
            self.clear();
            self.notify()
        } else if !data.starts_with('\x1b') && !data.chars().any(char::is_control) {
            self.value.insert_str(self.cursor, data);
            self.cursor += data.len();
            self.notify()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectItem {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}
pub struct SelectList {
    items: Vec<SelectItem>,
    filtered: Vec<usize>,
    selected: usize,
    max_visible: usize,
    pub on_select: Option<Box<dyn FnMut(SelectItem) + Send>>,
    pub on_cancel: Option<Box<dyn FnMut() + Send>>,
}
impl SelectList {
    #[must_use]
    pub fn new(items: Vec<SelectItem>, max_visible: usize) -> Self {
        let filtered = (0..items.len()).collect();
        Self {
            items,
            filtered,
            selected: 0,
            max_visible,
            on_select: None,
            on_cancel: None,
        }
    }
    pub fn set_filter(&mut self, filter: &str) {
        let needle = filter.to_ascii_lowercase();
        self.filtered = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                item.label.to_ascii_lowercase().contains(&needle)
                    || item
                        .description
                        .as_ref()
                        .is_some_and(|x| x.to_ascii_lowercase().contains(&needle))
            })
            .map(|(i, _)| i)
            .collect();
        self.selected = 0;
    }
    #[must_use]
    pub fn selected(&self) -> Option<&SelectItem> {
        self.filtered.get(self.selected).and_then(|i| self.items.get(*i))
    }
}
impl Component for SelectList {
    fn render(&mut self, width: usize) -> Vec<String> {
        if self.filtered.is_empty() {
            return vec!["No matches".into()];
        }
        let start = self
            .selected
            .saturating_sub(self.max_visible / 2)
            .min(self.filtered.len().saturating_sub(self.max_visible));
        self.filtered
            .iter()
            .skip(start)
            .take(self.max_visible)
            .enumerate()
            .map(|(offset, index)| {
                let absolute = start + offset;
                let item = &self.items[*index];
                truncate_to_width(
                    &format!(
                        "{} {}{}",
                        if absolute == self.selected { ">" } else { " " },
                        item.label,
                        item.description
                            .as_ref()
                            .map_or(String::new(), |description| format!(" — {description}"))
                    ),
                    width,
                    "...",
                )
            })
            .collect()
    }
    fn handle_input(&mut self, data: &str) {
        if matches_key(data, "up") {
            self.selected = self.selected.saturating_sub(1)
        } else if matches_key(data, "down") {
            self.selected = (self.selected + 1).min(self.filtered.len().saturating_sub(1))
        } else if matches_key(data, "enter") {
            let selected = self.selected().cloned();
            if let (Some(callback), Some(item)) = (&mut self.on_select, selected) {
                callback(item)
            }
        } else if matches_key(data, "escape") || matches_key(data, "ctrl+c") {
            if let Some(callback) = &mut self.on_cancel {
                callback()
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingItem {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub current_value: String,
    pub values: Vec<String>,
}
pub struct SettingsList {
    items: Vec<SettingItem>,
    selected: usize,
    max_visible: usize,
    pub on_change: Option<Box<dyn FnMut(String, String) + Send>>,
    pub on_cancel: Option<Box<dyn FnMut() + Send>>,
}
impl SettingsList {
    #[must_use]
    pub fn new(items: Vec<SettingItem>, max_visible: usize) -> Self {
        Self {
            items,
            selected: 0,
            max_visible,
            on_change: None,
            on_cancel: None,
        }
    }
    pub fn update_value(&mut self, id: &str, value: impl Into<String>) {
        if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
            item.current_value = value.into()
        }
    }
}
impl Component for SettingsList {
    fn render(&mut self, width: usize) -> Vec<String> {
        let start = self
            .selected
            .saturating_sub(self.max_visible / 2)
            .min(self.items.len().saturating_sub(self.max_visible));
        self.items
            .iter()
            .skip(start)
            .take(self.max_visible)
            .enumerate()
            .map(|(offset, item)| {
                truncate_to_width(
                    &format!(
                        "{} {}: {}",
                        if start + offset == self.selected { ">" } else { " " },
                        item.label,
                        item.current_value
                    ),
                    width,
                    "...",
                )
            })
            .collect()
    }
    fn handle_input(&mut self, data: &str) {
        if matches_key(data, "up") {
            self.selected = self.selected.saturating_sub(1)
        } else if matches_key(data, "down") {
            self.selected = (self.selected + 1).min(self.items.len().saturating_sub(1))
        } else if matches_key(data, "enter") || matches_key(data, "space") {
            if let Some(item) = self.items.get_mut(self.selected)
                && !item.values.is_empty()
            {
                let current = item
                    .values
                    .iter()
                    .position(|value| value == &item.current_value)
                    .unwrap_or(0);
                item.current_value = item.values[(current + 1) % item.values.len()].clone();
                if let Some(callback) = &mut self.on_change {
                    callback(item.id.clone(), item.current_value.clone())
                }
            }
        } else if matches_key(data, "escape") {
            if let Some(callback) = &mut self.on_cancel {
                callback()
            }
        }
    }
}

pub struct ScrollView {
    child: SharedComponent,
    offset: usize,
    height: usize,
    follow_end: bool,
}
impl ScrollView {
    #[must_use]
    pub fn new(child: SharedComponent, height: usize) -> Self {
        Self {
            child,
            offset: 0,
            height,
            follow_end: true,
        }
    }
    pub fn scroll_by(&mut self, delta: isize) {
        self.offset = self.offset.saturating_add_signed(delta);
        self.follow_end = false
    }
    pub fn scroll_to_end(&mut self) {
        self.follow_end = true
    }
}
impl Component for ScrollView {
    fn render(&mut self, width: usize) -> Vec<String> {
        let lines = self.child.lock().render(width);
        let height = self.height.max(1);
        let max = lines.len().saturating_sub(height);
        if self.follow_end {
            self.offset = max
        } else {
            self.offset = self.offset.min(max)
        }
        let mut output = lines.into_iter().skip(self.offset).take(height).collect::<Vec<_>>();
        output.resize(height, String::new());
        output
    }
    fn handle_input(&mut self, data: &str) {
        if matches_key(data, "pageup") {
            self.scroll_by(-(self.height as isize))
        } else if matches_key(data, "pagedown") {
            self.scroll_by(self.height as isize)
        } else if matches_key(data, "home") {
            self.offset = 0;
            self.follow_end = false
        } else if matches_key(data, "end") {
            self.scroll_to_end()
        }
    }
}

pub struct Loader {
    frames: Vec<String>,
    index: usize,
    message: String,
}
impl Loader {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            frames: vec!["⠋".into(), "⠙".into(), "⠹".into(), "⠸".into(), "⠼".into(), "⠴".into()],
            index: 0,
            message: message.into(),
        }
    }
    pub fn tick(&mut self) {
        self.index = (self.index + 1) % self.frames.len()
    }
    pub fn set_message(&mut self, message: impl Into<String>) {
        self.message = message.into()
    }
}
impl Component for Loader {
    fn render(&mut self, width: usize) -> Vec<String> {
        vec![truncate_to_width(
            &format!("{} {}", self.frames[self.index], self.message),
            width,
            "...",
        )]
    }
}

pub struct Markdown {
    source: String,
    padding_x: usize,
    padding_y: usize,
}
impl Markdown {
    #[must_use]
    pub fn new(source: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            padding_x: 0,
            padding_y: 0,
        }
    }
    pub fn set_text(&mut self, text: impl Into<String>) {
        self.source = text.into();
    }
}
impl Component for Markdown {
    fn render(&mut self, width: usize) -> Vec<String> {
        let mut output = vec![String::new(); self.padding_y];
        let inner = width.saturating_sub(self.padding_x * 2);
        let mut code = false;
        for source in self.source.lines() {
            let rendered = if source.starts_with("```") {
                code = !code;
                String::new()
            } else if code {
                format!("  {source}")
            } else if let Some(heading) = source.strip_prefix("# ") {
                format!("\x1b[1m{heading}\x1b[0m")
            } else if let Some(quote) = source.strip_prefix("> ") {
                format!("│ {quote}")
            } else {
                source.to_owned()
            };
            for line in wrap_text_with_ansi(&rendered, inner) {
                output.push(format!("{}{}", " ".repeat(self.padding_x), line));
            }
        }
        output.extend(std::iter::repeat_n(String::new(), self.padding_y));
        output
    }
}
