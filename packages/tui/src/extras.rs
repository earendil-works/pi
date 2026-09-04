use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};

use base64::Engine;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::{
    Component, ImageProtocol, SharedComponent, TerminalCapabilities, calculate_image_rows, encode_iterm2, encode_kitty,
    get_image_dimensions, image_fallback, visible_width,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RgbColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalColorScheme {
    Dark,
    Light,
}
#[must_use]
pub fn parse_osc11_background_color(value: &str) -> Option<RgbColor> {
    let captures = Regex::new(r"rgb:([0-9a-fA-F]{2,4})/([0-9a-fA-F]{2,4})/([0-9a-fA-F]{2,4})")
        .ok()?
        .captures(value)?;
    let channel = |index| {
        u16::from_str_radix(captures.get(index)?.as_str(), 16)
            .ok()
            .map(|value| (value >> (captures.get(index).unwrap().as_str().len().saturating_sub(2) * 4)) as u8)
    };
    Some(RgbColor {
        r: channel(1)?,
        g: channel(2)?,
        b: channel(3)?,
    })
}
#[must_use]
pub fn parse_terminal_color_scheme_report(value: &str) -> Option<TerminalColorScheme> {
    let color = parse_osc11_background_color(value)?;
    let luminance = 0.2126 * f64::from(color.r) + 0.7152 * f64::from(color.g) + 0.0722 * f64::from(color.b);
    Some(if luminance >= 128.0 {
        TerminalColorScheme::Light
    } else {
        TerminalColorScheme::Dark
    })
}
#[must_use]
pub fn detect_capabilities() -> TerminalCapabilities {
    let term = std::env::var("TERM").unwrap_or_default().to_ascii_lowercase();
    let program = std::env::var("TERM_PROGRAM").unwrap_or_default().to_ascii_lowercase();
    let protocol = if std::env::var_os("KITTY_WINDOW_ID").is_some()
        || term.contains("kitty")
        || program.contains("wezterm")
        || program.contains("ghostty")
    {
        ImageProtocol::Kitty
    } else if program.contains("iterm") {
        ImageProtocol::ITerm2
    } else {
        ImageProtocol::None
    };
    TerminalCapabilities {
        protocol,
        true_color: std::env::var("COLORTERM").is_ok_and(|value| matches!(value.as_str(), "truecolor" | "24bit")),
    }
}

pub struct Image {
    data: Vec<u8>,
    mime_type: String,
    filename: Option<String>,
    max_width: Option<u32>,
    max_height: Option<u32>,
    capabilities: TerminalCapabilities,
}
impl Image {
    pub fn new(base64: &str, mime_type: impl Into<String>) -> Result<Self, base64::DecodeError> {
        Ok(Self {
            data: base64::engine::general_purpose::STANDARD.decode(base64)?,
            mime_type: mime_type.into(),
            filename: None,
            max_width: None,
            max_height: None,
            capabilities: detect_capabilities(),
        })
    }
    pub fn set_filename(&mut self, name: impl Into<String>) {
        self.filename = Some(name.into())
    }
    pub fn set_limits(&mut self, width: Option<u32>, height: Option<u32>) {
        self.max_width = width;
        self.max_height = height
    }
}
impl Component for Image {
    fn render(&mut self, width: usize) -> Vec<String> {
        let dimensions = get_image_dimensions(&self.data, &self.mime_type);
        let cells = self
            .max_width
            .unwrap_or(u32::try_from(width).unwrap_or(u32::MAX))
            .min(u32::try_from(width).unwrap_or(u32::MAX));
        let rows = dimensions
            .map_or(1, |dimensions| calculate_image_rows(dimensions, cells, 2.0))
            .min(self.max_height.unwrap_or(u32::MAX));
        match self.capabilities.protocol {
            ImageProtocol::Kitty => {
                let mut lines = vec![encode_kitty(&self.data, crate::allocate_image_id(), cells, rows)];
                lines.extend(std::iter::repeat_n(String::new(), rows.saturating_sub(1) as usize));
                lines
            }
            ImageProtocol::ITerm2 => vec![encode_iterm2(&self.data, self.filename.as_deref(), cells, rows)],
            ImageProtocol::None => vec![image_fallback(&self.mime_type, dimensions)],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TuiMouseEventType {
    Press,
    Release,
    Click,
    Move,
    Drag,
    Wheel,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TuiMouseButton {
    Left,
    Middle,
    Right,
    None,
}
#[derive(Clone, Debug)]
pub struct TuiMouseEvent {
    pub event_type: TuiMouseEventType,
    pub button: TuiMouseButton,
    pub x: usize,
    pub y: usize,
    pub screen_x: usize,
    pub screen_y: usize,
    pub wheel_delta: isize,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub click_count: u8,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct TuiMouseEventResult {
    pub handled: bool,
    pub capture: bool,
    pub focus: bool,
    pub render: Option<bool>,
}
pub trait MouseComponent: Component {
    fn handle_mouse(&mut self, event: &TuiMouseEvent) -> TuiMouseEventResult;
}
pub struct MouseRegion {
    child: SharedComponent,
    handler: Box<dyn FnMut(&TuiMouseEvent) -> TuiMouseEventResult + Send>,
}
impl MouseRegion {
    #[must_use]
    pub fn new(
        child: SharedComponent,
        handler: impl FnMut(&TuiMouseEvent) -> TuiMouseEventResult + Send + 'static,
    ) -> Self {
        Self {
            child,
            handler: Box::new(handler),
        }
    }
    pub fn handle_mouse(&mut self, event: &TuiMouseEvent) -> TuiMouseEventResult {
        (self.handler)(event)
    }
}
impl Component for MouseRegion {
    fn render(&mut self, width: usize) -> Vec<String> {
        self.child.lock().render(width)
    }
    fn handle_input(&mut self, data: &str) {
        self.child.lock().handle_input(data)
    }
    fn invalidate(&mut self) {
        self.child.lock().invalidate()
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct KeybindingsConfig(pub HashMap<String, Vec<String>>);
#[derive(Clone, Default)]
pub struct KeybindingsManager {
    bindings: Arc<Mutex<HashMap<String, Vec<String>>>>,
}
impl KeybindingsManager {
    #[must_use]
    pub fn new(defaults: HashMap<String, Vec<String>>) -> Self {
        Self {
            bindings: Arc::new(Mutex::new(defaults)),
        }
    }
    pub fn apply(&self, config: KeybindingsConfig) {
        self.bindings.lock().extend(config.0)
    }
    #[must_use]
    pub fn keys(&self, action: &str) -> Vec<String> {
        self.bindings.lock().get(action).cloned().unwrap_or_default()
    }
    #[must_use]
    pub fn matches(&self, action: &str, data: &str) -> bool {
        self.keys(action).iter().any(|key| crate::matches_key(data, key))
    }
    #[must_use]
    pub fn conflicts(&self) -> Vec<(String, String, String)> {
        let bindings = self.bindings.lock();
        let mut owners = HashMap::<&str, &str>::new();
        let mut conflicts = Vec::new();
        for (action, keys) in bindings.iter() {
            for key in keys {
                if let Some(previous) = owners.insert(key, action) {
                    conflicts.push((key.clone(), previous.into(), action.clone()))
                }
            }
        }
        conflicts
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StdinBufferEvent {
    Data(String),
    Paste(String),
}
#[derive(Default)]
pub struct StdinBuffer {
    buffer: String,
    in_paste: bool,
}
impl StdinBuffer {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
    pub fn push(&mut self, data: &str) -> Vec<StdinBufferEvent> {
        self.buffer.push_str(data);
        let mut events = Vec::new();
        loop {
            if self.in_paste {
                if let Some(end) = self.buffer.find("\x1b[201~") {
                    events.push(StdinBufferEvent::Paste(self.buffer[..end].to_owned()));
                    self.buffer.drain(..end + 6);
                    self.in_paste = false;
                    continue;
                }
                break;
            }
            if let Some(start) = self.buffer.find("\x1b[200~") {
                if start > 0 {
                    events.push(StdinBufferEvent::Data(self.buffer[..start].to_owned()))
                }
                self.buffer.drain(..start + 6);
                self.in_paste = true;
                continue;
            }
            if !self.buffer.is_empty() {
                events.push(StdinBufferEvent::Data(std::mem::take(&mut self.buffer)))
            }
            break;
        }
        events
    }
}

#[derive(Clone, Debug)]
pub struct UndoStack<T: Clone> {
    undo: Vec<T>,
    redo: Vec<T>,
    limit: usize,
}
impl<T: Clone> UndoStack<T> {
    #[must_use]
    pub fn new(limit: usize) -> Self {
        Self {
            undo: Vec::new(),
            redo: Vec::new(),
            limit,
        }
    }
    pub fn push(&mut self, value: T) {
        self.undo.push(value);
        self.redo.clear();
        if self.undo.len() > self.limit {
            self.undo.remove(0);
        }
    }
    pub fn undo(&mut self, current: T) -> Option<T> {
        let value = self.undo.pop()?;
        self.redo.push(current);
        Some(value)
    }
    pub fn redo(&mut self, current: T) -> Option<T> {
        let value = self.redo.pop()?;
        self.undo.push(current);
        Some(value)
    }
}
#[derive(Default)]
pub struct KillRing {
    entries: VecDeque<String>,
    max: usize,
    index: usize,
}
impl KillRing {
    #[must_use]
    pub fn new(max: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            max,
            index: 0,
        }
    }
    pub fn push(&mut self, text: String) {
        if text.is_empty() {
            return;
        }
        self.entries.push_front(text);
        self.entries.truncate(self.max);
        self.index = 0;
    }
    pub fn yank(&mut self) -> Option<&str> {
        let value = self.entries.get(self.index);
        if !self.entries.is_empty() {
            self.index = (self.index + 1) % self.entries.len()
        }
        value.map(String::as_str)
    }
}

#[must_use]
pub fn render_latex(source: &str) -> String {
    let replacements = [
        ("\\alpha", "α"),
        ("\\beta", "β"),
        ("\\gamma", "γ"),
        ("\\delta", "δ"),
        ("\\pi", "π"),
        ("\\lambda", "λ"),
        ("\\to", "→"),
        ("\\infty", "∞"),
        ("\\leq", "≤"),
        ("\\geq", "≥"),
        ("\\neq", "≠"),
        ("\\times", "×"),
        ("\\sum", "∑"),
    ];
    let mut output = source.trim_matches('$').to_owned();
    for (from, to) in replacements {
        output = output.replace(from, to)
    }
    output
        .replace("^{2}", "²")
        .replace("^2", "²")
        .replace("_{1}", "₁")
        .replace("_1", "₁")
}

#[must_use]
pub fn pad_to_width(text: &str, width: usize) -> String {
    format!("{text}{}", " ".repeat(width.saturating_sub(visible_width(text))))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_terminal_background() {
        assert_eq!(
            parse_osc11_background_color("\x1b]11;rgb:ffff/0000/8080\x07"),
            Some(RgbColor { r: 255, g: 0, b: 128 })
        );
    }
    #[test]
    fn separates_bracketed_paste() {
        let mut buffer = StdinBuffer::new();
        assert_eq!(
            buffer.push("a\x1b[200~many\nlines\x1b[201~b"),
            vec![
                StdinBufferEvent::Data("a".into()),
                StdinBufferEvent::Paste("many\nlines".into()),
                StdinBufferEvent::Data("b".into())
            ]
        );
    }
    #[test]
    fn renders_common_latex() {
        assert_eq!(render_latex("$\\alpha \\to \\infty$"), "α → ∞");
    }
}
