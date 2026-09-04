use std::{
    io::{self, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crossterm::{cursor, execute, terminal};

use crate::{SharedComponent, visible_width};

pub const CURSOR_MARKER: &str = "\x1b_pi_cursor\x1b\\";

pub trait Terminal: Send {
    fn start(&mut self) -> io::Result<()>;
    fn stop(&mut self) -> io::Result<()>;
    fn write(&mut self, data: &str) -> io::Result<()>;
    fn columns(&self) -> usize;
    fn rows(&self) -> usize;
}

pub struct ProcessTerminal {
    stdout: io::Stdout,
    raw: bool,
}
impl ProcessTerminal {
    #[must_use]
    pub fn new() -> Self {
        Self {
            stdout: io::stdout(),
            raw: false,
        }
    }
}
impl Default for ProcessTerminal {
    fn default() -> Self {
        Self::new()
    }
}
impl Terminal for ProcessTerminal {
    fn start(&mut self) -> io::Result<()> {
        terminal::enable_raw_mode()?;
        execute!(self.stdout, cursor::Hide)?;
        self.raw = true;
        Ok(())
    }
    fn stop(&mut self) -> io::Result<()> {
        if self.raw {
            execute!(self.stdout, cursor::Show)?;
            terminal::disable_raw_mode()?;
            self.raw = false;
        }
        Ok(())
    }
    fn write(&mut self, data: &str) -> io::Result<()> {
        self.stdout.write_all(data.as_bytes())?;
        self.stdout.flush()
    }
    fn columns(&self) -> usize {
        terminal::size().map_or(80, |(width, _)| width as usize)
    }
    fn rows(&self) -> usize {
        terminal::size().map_or(24, |(_, height)| height as usize)
    }
}

impl Drop for ProcessTerminal {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub enum OverlayAnchor {
    #[default]
    Center,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    TopCenter,
    BottomCenter,
    LeftCenter,
    RightCenter,
}
#[derive(Clone, Debug, Default)]
pub struct OverlayOptions {
    pub width: Option<usize>,
    pub max_height: Option<usize>,
    pub anchor: OverlayAnchor,
    pub offset_x: isize,
    pub offset_y: isize,
    pub margin: usize,
    pub non_capturing: bool,
}
#[derive(Clone)]
pub struct OverlayHandle {
    hidden: Arc<AtomicBool>,
}
impl OverlayHandle {
    pub fn set_hidden(&self, hidden: bool) {
        self.hidden.store(hidden, Ordering::Relaxed)
    }
    #[must_use]
    pub fn is_hidden(&self) -> bool {
        self.hidden.load(Ordering::Relaxed)
    }
    pub fn hide(&self) {
        self.set_hidden(true)
    }
}
struct OverlayEntry {
    child: SharedComponent,
    options: OverlayOptions,
    hidden: Arc<AtomicBool>,
}

pub trait Tui: Send {
    fn add_child(&mut self, child: SharedComponent);
    fn remove_child(&mut self, child: &SharedComponent);
    fn set_focus(&mut self, child: Option<SharedComponent>);
    fn start(&mut self) -> io::Result<()>;
    fn stop(&mut self) -> io::Result<()>;
    fn handle_input(&mut self, data: &str) -> io::Result<()>;
    fn request_render(&mut self) -> io::Result<()>;
    fn show_overlay(&mut self, child: SharedComponent, options: OverlayOptions) -> OverlayHandle;
    fn hide_overlay(&mut self);
    fn has_overlay(&self) -> bool;
}

pub struct TuiMainScreen<T: Terminal> {
    terminal: T,
    children: Vec<SharedComponent>,
    focus: Option<SharedComponent>,
    previous: Vec<String>,
    overlays: Vec<OverlayEntry>,
    started: bool,
}
impl<T: Terminal> TuiMainScreen<T> {
    #[must_use]
    pub fn new(terminal: T) -> Self {
        Self {
            terminal,
            children: Vec::new(),
            focus: None,
            previous: Vec::new(),
            overlays: Vec::new(),
            started: false,
        }
    }
    #[must_use]
    pub fn terminal(&self) -> &T {
        &self.terminal
    }
    fn document(&mut self) -> io::Result<Vec<String>> {
        let width = self.terminal.columns();
        let mut lines = Vec::new();
        for child in &self.children {
            for line in child.lock().render(width) {
                if visible_width(&line) > width {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "component rendered a line wider than the terminal",
                    ));
                }
                lines.push(format!("{line}\x1b[0m\x1b]8;;\x1b\\"));
            }
        }
        for overlay in &self.overlays {
            if !overlay.hidden.load(Ordering::Relaxed) {
                let overlay_width = overlay.options.width.unwrap_or(width.saturating_sub(4)).min(width);
                lines.extend(overlay.child.lock().render(overlay_width));
            }
        }
        Ok(lines)
    }
}
impl<T: Terminal> Tui for TuiMainScreen<T> {
    fn add_child(&mut self, child: SharedComponent) {
        self.children.push(child)
    }
    fn remove_child(&mut self, child: &SharedComponent) {
        self.children
            .retain(|candidate| !std::sync::Arc::ptr_eq(candidate, child));
        if self
            .focus
            .as_ref()
            .is_some_and(|focus| std::sync::Arc::ptr_eq(focus, child))
        {
            self.focus = None
        }
    }
    fn set_focus(&mut self, child: Option<SharedComponent>) {
        self.focus = child
    }
    fn start(&mut self) -> io::Result<()> {
        self.terminal.start()?;
        self.started = true;
        self.request_render()
    }
    fn stop(&mut self) -> io::Result<()> {
        if self.started {
            self.terminal.stop()?;
            self.started = false;
        }
        Ok(())
    }
    fn handle_input(&mut self, data: &str) -> io::Result<()> {
        if let Some(focus) = &self.focus {
            focus.lock().handle_input(data)
        }
        self.request_render()
    }
    fn request_render(&mut self) -> io::Result<()> {
        let next = self.document()?;
        let first = next
            .iter()
            .zip(&self.previous)
            .position(|(a, b)| a != b)
            .unwrap_or(next.len().min(self.previous.len()));
        let mut output = String::from("\x1b[?2026h");
        if self.previous.is_empty() {
            output.push_str(&next.join("\r\n"));
        } else if first < next.len() || next.len() != self.previous.len() {
            let up = self.previous.len().saturating_sub(first);
            if up > 0 {
                output.push_str(&format!("\x1b[{up}A"))
            }
            output.push_str("\r\x1b[J");
            output.push_str(&next[first..].join("\r\n"));
        }
        output.push_str("\x1b[?2026l");
        self.terminal.write(&output)?;
        self.previous = next;
        Ok(())
    }
    fn show_overlay(&mut self, child: SharedComponent, options: OverlayOptions) -> OverlayHandle {
        let hidden = Arc::new(AtomicBool::new(false));
        if !options.non_capturing {
            self.focus = Some(child.clone());
        }
        self.overlays.push(OverlayEntry {
            child,
            options,
            hidden: hidden.clone(),
        });
        OverlayHandle { hidden }
    }
    fn hide_overlay(&mut self) {
        if let Some(overlay) = self
            .overlays
            .iter()
            .rev()
            .find(|overlay| !overlay.hidden.load(Ordering::Relaxed))
        {
            overlay.hidden.store(true, Ordering::Relaxed);
        }
    }
    fn has_overlay(&self) -> bool {
        self.overlays
            .iter()
            .any(|overlay| !overlay.hidden.load(Ordering::Relaxed))
    }
}
impl<T: Terminal> Drop for TuiMainScreen<T> {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

pub struct TuiAltScreen<T: Terminal> {
    terminal: T,
    root: Option<SharedComponent>,
    focus: Option<SharedComponent>,
    previous: Vec<String>,
    overlays: Vec<OverlayEntry>,
    scroll: usize,
    started: bool,
}
impl<T: Terminal> TuiAltScreen<T> {
    #[must_use]
    pub fn new(terminal: T) -> Self {
        Self {
            terminal,
            root: None,
            focus: None,
            previous: Vec::new(),
            overlays: Vec::new(),
            scroll: 0,
            started: false,
        }
    }
    pub fn set_layout_root(&mut self, root: SharedComponent) {
        self.root = Some(root)
    }
    pub fn scroll_by(&mut self, delta: isize) {
        self.scroll = self.scroll.saturating_add_signed(delta)
    }
}
impl<T: Terminal> Tui for TuiAltScreen<T> {
    fn add_child(&mut self, child: SharedComponent) {
        self.root = Some(child)
    }
    fn remove_child(&mut self, child: &SharedComponent) {
        if self
            .root
            .as_ref()
            .is_some_and(|root| std::sync::Arc::ptr_eq(root, child))
        {
            self.root = None
        }
    }
    fn set_focus(&mut self, child: Option<SharedComponent>) {
        self.focus = child
    }
    fn start(&mut self) -> io::Result<()> {
        self.terminal.start()?;
        self.terminal.write("\x1b[?1049h\x1b[?1006h\x1b[?1003h")?;
        self.started = true;
        self.request_render()
    }
    fn stop(&mut self) -> io::Result<()> {
        if self.started {
            self.terminal.write("\x1b[?1003l\x1b[?1006l\x1b[?1049l")?;
            self.terminal.stop()?;
            self.started = false
        }
        Ok(())
    }
    fn handle_input(&mut self, data: &str) -> io::Result<()> {
        if let Some(focus) = &self.focus {
            focus.lock().handle_input(data)
        }
        self.request_render()
    }
    fn request_render(&mut self) -> io::Result<()> {
        let width = self.terminal.columns();
        let height = self.terminal.rows();
        let document = self
            .root
            .as_ref()
            .map_or_else(Vec::new, |root| root.lock().render(width));
        let max_scroll = document.len().saturating_sub(height);
        self.scroll = self.scroll.min(max_scroll);
        let mut viewport = document.into_iter().skip(self.scroll).take(height).collect::<Vec<_>>();
        viewport.resize(height, String::new());
        for overlay in &self.overlays {
            if overlay.hidden.load(Ordering::Relaxed) {
                continue;
            }
            let overlay_width = overlay
                .options
                .width
                .unwrap_or(width.saturating_sub(4))
                .min(width.saturating_sub(overlay.options.margin * 2));
            let lines = overlay.child.lock().render(overlay_width);
            let row = match overlay.options.anchor {
                OverlayAnchor::TopLeft | OverlayAnchor::TopCenter | OverlayAnchor::TopRight => overlay.options.margin,
                OverlayAnchor::BottomLeft | OverlayAnchor::BottomCenter | OverlayAnchor::BottomRight => {
                    height.saturating_sub(lines.len() + overlay.options.margin)
                }
                _ => height.saturating_sub(lines.len()) / 2,
            }
            .saturating_add_signed(overlay.options.offset_y)
            .min(height.saturating_sub(1));
            let col = match overlay.options.anchor {
                OverlayAnchor::TopLeft | OverlayAnchor::LeftCenter | OverlayAnchor::BottomLeft => {
                    overlay.options.margin
                }
                OverlayAnchor::TopRight | OverlayAnchor::RightCenter | OverlayAnchor::BottomRight => {
                    width.saturating_sub(overlay_width + overlay.options.margin)
                }
                _ => width.saturating_sub(overlay_width) / 2,
            }
            .saturating_add_signed(overlay.options.offset_x)
            .min(width.saturating_sub(1));
            for (offset, line) in lines
                .into_iter()
                .take(overlay.options.max_height.unwrap_or(height))
                .enumerate()
            {
                if row + offset >= height {
                    break;
                }
                let before = crate::slice_by_column(&viewport[row + offset], 0, col);
                let after = crate::slice_by_column(&viewport[row + offset], col + overlay_width, width);
                viewport[row + offset] = format!("{before}{}{}", crate::pad_to_width(&line, overlay_width), after);
            }
        }
        let mut output = String::from("\x1b[?2026h\x1b[H");
        for (row, line) in viewport.iter().enumerate() {
            if row > 0 {
                output.push_str("\r\n")
            }
            output.push_str(line);
            output.push_str("\x1b[K");
        }
        output.push_str("\x1b[?2026l");
        if viewport != self.previous {
            self.terminal.write(&output)?;
            self.previous = viewport
        }
        Ok(())
    }
    fn show_overlay(&mut self, child: SharedComponent, options: OverlayOptions) -> OverlayHandle {
        let hidden = Arc::new(AtomicBool::new(false));
        if !options.non_capturing {
            self.focus = Some(child.clone());
        }
        self.overlays.push(OverlayEntry {
            child,
            options,
            hidden: hidden.clone(),
        });
        OverlayHandle { hidden }
    }
    fn hide_overlay(&mut self) {
        if let Some(overlay) = self
            .overlays
            .iter()
            .rev()
            .find(|overlay| !overlay.hidden.load(Ordering::Relaxed))
        {
            overlay.hidden.store(true, Ordering::Relaxed);
        }
    }
    fn has_overlay(&self) -> bool {
        self.overlays
            .iter()
            .any(|overlay| !overlay.hidden.load(Ordering::Relaxed))
    }
}
impl<T: Terminal> Drop for TuiAltScreen<T> {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[derive(Default)]
pub struct VirtualTerminal {
    pub output: String,
    pub width: usize,
    pub height: usize,
    pub started: bool,
}
impl VirtualTerminal {
    #[must_use]
    pub fn with_size(width: usize, height: usize) -> Self {
        Self {
            output: String::new(),
            width,
            height,
            started: false,
        }
    }
}
impl Terminal for VirtualTerminal {
    fn start(&mut self) -> io::Result<()> {
        self.started = true;
        Ok(())
    }
    fn stop(&mut self) -> io::Result<()> {
        self.started = false;
        Ok(())
    }
    fn write(&mut self, data: &str) -> io::Result<()> {
        self.output.push_str(data);
        Ok(())
    }
    fn columns(&self) -> usize {
        self.width.max(1)
    }
    fn rows(&self) -> usize {
        self.height.max(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Text, shared};

    #[test]
    fn renders_and_hides_overlay() {
        let mut tui = TuiMainScreen::new(VirtualTerminal::with_size(40, 20));
        tui.add_child(shared(Text::new("base")));
        let handle = tui.show_overlay(shared(Text::new("dialog")), OverlayOptions::default());
        tui.start().unwrap();
        assert!(tui.terminal().output.contains("dialog"));
        handle.hide();
        tui.request_render().unwrap();
        assert!(handle.is_hidden());
    }
}
