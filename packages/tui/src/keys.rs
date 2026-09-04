use std::sync::atomic::{AtomicBool, Ordering};

static KITTY_PROTOCOL: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyEvent {
    pub key: String,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub event_type: KeyEventType,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum KeyEventType {
    #[default]
    Press,
    Repeat,
    Release,
}

pub struct Key;
impl Key {
    pub const ENTER: &'static str = "enter";
    pub const ESCAPE: &'static str = "escape";
    pub const TAB: &'static str = "tab";
    pub const BACKSPACE: &'static str = "backspace";
    pub const DELETE: &'static str = "delete";
    pub const UP: &'static str = "up";
    pub const DOWN: &'static str = "down";
    pub const LEFT: &'static str = "left";
    pub const RIGHT: &'static str = "right";
    pub const HOME: &'static str = "home";
    pub const END: &'static str = "end";
    pub const SPACE: &'static str = "space";
    #[must_use]
    pub fn ctrl(key: &str) -> String {
        format!("ctrl+{key}")
    }
    #[must_use]
    pub fn alt(key: &str) -> String {
        format!("alt+{key}")
    }
    #[must_use]
    pub fn shift(key: &str) -> String {
        format!("shift+{key}")
    }
    #[must_use]
    pub fn ctrl_shift(key: &str) -> String {
        format!("ctrl+shift+{key}")
    }
}

pub fn set_kitty_protocol_active(active: bool) {
    KITTY_PROTOCOL.store(active, Ordering::Relaxed)
}
#[must_use]
pub fn is_kitty_protocol_active() -> bool {
    KITTY_PROTOCOL.load(Ordering::Relaxed)
}

#[must_use]
pub fn parse_key(data: &str) -> Option<KeyEvent> {
    let event = match data {
        "\r" | "\n" => simple("enter"),
        "\x1b" => simple("escape"),
        "\t" => simple("tab"),
        "\x7f" | "\x08" => simple("backspace"),
        "\x1b[A" => simple("up"),
        "\x1b[B" => simple("down"),
        "\x1b[C" => simple("right"),
        "\x1b[D" => simple("left"),
        "\x1b[H" | "\x1b[1~" => simple("home"),
        "\x1b[F" | "\x1b[4~" => simple("end"),
        "\x1b[3~" => simple("delete"),
        "\x1b[Z" => KeyEvent {
            key: "tab".into(),
            shift: true,
            ..simple("tab")
        },
        _ => {
            if let Some(rest) = data.strip_prefix("\x1b[").and_then(|value| value.strip_suffix('u')) {
                return parse_kitty(rest);
            }
            if let Some(rest) = data.strip_prefix('\x1b')
                && rest.chars().count() == 1
            {
                return Some(KeyEvent {
                    key: rest.into(),
                    alt: true,
                    ..simple(rest)
                });
            }
            if data.len() == 1 {
                let byte = data.as_bytes()[0];
                if (1..=26).contains(&byte) {
                    KeyEvent {
                        key: char::from(b'a' + byte - 1).to_string(),
                        ctrl: true,
                        ..simple("")
                    }
                } else {
                    simple(data)
                }
            } else {
                return None;
            }
        }
    };
    Some(event)
}

fn simple(key: &str) -> KeyEvent {
    KeyEvent {
        key: key.into(),
        ctrl: false,
        alt: false,
        shift: false,
        event_type: KeyEventType::Press,
    }
}

fn parse_kitty(value: &str) -> Option<KeyEvent> {
    let mut pieces = value.split(';');
    let code = pieces.next()?.split(':').next()?.parse::<u32>().ok()?;
    let modifier_and_event = pieces.next().unwrap_or("1");
    let mut me = modifier_and_event.split(':');
    let modifiers = me.next()?.parse::<u8>().ok()?.saturating_sub(1);
    let event_type = match me.next() {
        Some("2") => KeyEventType::Repeat,
        Some("3") => KeyEventType::Release,
        _ => KeyEventType::Press,
    };
    let key = match code {
        13 => "enter".into(),
        27 => "escape".into(),
        9 => "tab".into(),
        127 => "backspace".into(),
        57358 => "up".into(),
        57359 => "down".into(),
        57360 => "left".into(),
        57361 => "right".into(),
        _ => char::from_u32(code)?.to_string(),
    };
    Some(KeyEvent {
        key,
        shift: modifiers & 1 != 0,
        alt: modifiers & 2 != 0,
        ctrl: modifiers & 4 != 0,
        event_type,
    })
}

#[must_use]
pub fn matches_key(data: &str, expected: &str) -> bool {
    let Some(event) = parse_key(data) else { return false };
    if event.event_type == KeyEventType::Release {
        return false;
    }
    let mut parts = expected
        .to_ascii_lowercase()
        .split('+')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let key = parts.pop().unwrap_or_default();
    event.key.eq_ignore_ascii_case(&key)
        && event.ctrl == parts.iter().any(|x| x == "ctrl")
        && event.alt == parts.iter().any(|x| x == "alt")
        && event.shift == parts.iter().any(|x| x == "shift")
}

#[must_use]
pub fn is_key_release(data: &str) -> bool {
    parse_key(data).is_some_and(|event| event.event_type == KeyEventType::Release)
}
#[must_use]
pub fn is_key_repeat(data: &str) -> bool {
    parse_key(data).is_some_and(|event| event.event_type == KeyEventType::Repeat)
}
#[must_use]
pub fn decode_kitty_printable(data: &str) -> Option<char> {
    parse_key(data)?.key.chars().next()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_legacy_keys() {
        assert!(matches_key("\x03", "ctrl+c"));
        assert!(matches_key("\x1b[A", "up"));
        assert!(matches_key("\x1bx", "alt+x"));
    }
    #[test]
    fn parses_kitty() {
        assert_eq!(
            parse_key("\x1b[97;5u").unwrap(),
            KeyEvent {
                key: "a".into(),
                ctrl: true,
                alt: false,
                shift: false,
                event_type: KeyEventType::Press
            }
        );
    }
}
