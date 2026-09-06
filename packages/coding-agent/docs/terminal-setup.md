# Terminal Setup

Pi uses the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) for reliable modifier key detection. Most modern terminals support this protocol, but some require configuration.

## Capability Overrides

Pi auto-detects OSC 8 hyperlinks, inline image protocols, and truecolor. If detection fails behind a terminal proxy or multiplexer, use these advanced overrides:

| Capability | Environment variable | JSON setting |
|------------|----------------------|--------------|
| OSC 8 hyperlinks | `PI_HYPERLINKS=1\|0\|auto` | `terminal.hyperlinks: true\|false\|"auto"` |
| Inline images | `PI_IMAGE_PROTOCOL=kitty\|iterm2\|none\|auto` | `terminal.images: "kitty"\|"iterm2"\|false\|"auto"` |
| Truecolor | `PI_TRUE_COLOR=1\|0\|auto` | `terminal.trueColor: true\|false\|"auto"` |

Settings take precedence over environment variables; unset or `auto` preserves detection. Only force capabilities supported by the complete terminal path, since unsupported escape sequences can corrupt rendering.

## Kitty

Works out of the box.

## iTerm2

### Regular TUI mode

Works out of the box.

### Fullscreen TUI mode

Pi owns the viewport, so iTerm2 sends mouse-wheel reports instead of scrolling its native scrollback. With iTerm2's default fast-trackpad behavior, those reports can lose most of an accelerated wheel delta, making fullscreen scrolling much slower than regular scrolling.

If fast mouse-wheel gestures move only about one line at a time in fullscreen mode:

1. Open **iTerm2 → Settings → Advanced**.
2. Search for **Trackpad scrolls fast?** and set it to **No**.

This is an iTerm2-wide workaround and may also change native trackpad scrolling. The underlying behavior is tracked in [iTerm2 issue 9619](https://gitlab.com/gnachman/iterm2/-/work_items/9619).

## Apple Terminal

Pi enables enhanced key reporting when available. If Terminal.app still sends plain Return for `Shift+Enter`, pi uses a local macOS modifier fallback to treat that Return as `Shift+Enter`.

This fallback only works when pi runs on the same Mac as Terminal.app. It cannot detect the local keyboard over remote SSH.

## Ghostty

Add to your Ghostty config (`~/Library/Application Support/com.mitchellh.ghostty/config` on macOS, `~/.config/ghostty/config` on Linux):

```
keybind = alt+backspace=text:\x1b\x7f
```

Older Claude Code versions may have added this Ghostty mapping:

```
keybind = shift+enter=text:\n
```

That mapping sends a raw linefeed byte. Inside pi, that is indistinguishable from `Ctrl+J`, so tmux and pi no longer see a real `shift+enter` key event.

If Claude Code 2.x or newer is the only reason you added that mapping, you can remove it, unless you want to use Claude Code in tmux, where it still requires that Ghostty mapping.

Pi binds `Ctrl+J` as a default newline alias, so `Shift+Enter` keeps working in tmux via that remap without extra pi configuration.

### Fullscreen TUI mode

In fullscreen mode, links remain clickable, but Ghostty does not show its hover underline or lower-left URL preview while pi captures mouse input. Hold `Shift+Command` on macOS or `Shift+Ctrl` on Linux to use Ghostty's native link handling.

## WezTerm

WezTerm usually works out of the box for `Shift+Enter` via xterm modifyOtherKeys. To use the Kitty keyboard protocol explicitly, create `~/.wezterm.lua`:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

On macOS, WezTerm binds `Option+Enter` to fullscreen by default. To use `Option+Enter` for pi follow-up queueing, add this key override:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.keys = {
  {
    key = 'Enter',
    mods = 'ALT',
    action = wezterm.action.SendString('\x1b[13;3u'),
  },
}
return config
```

If you already have a `config.keys` table, add the entry to it.

On WSL, WezTerm may require a visible hardware cursor for IME candidate window positioning. If CJK IME candidates do not follow the text cursor, set `PI_HARDWARE_CURSOR=1` before running pi or set `showHardwareCursor` to `true` in settings.

## Alacritty

Alacritty usually works out of the box for `Shift+Enter`. On macOS, `Option+Enter` may arrive as plain `Enter`. To use `Option+Enter` for pi follow-up queueing, add to `~/.config/alacritty/alacritty.toml`:

```toml
[[keyboard.bindings]]
key = "Enter"
mods = "Alt"
chars = "\u001b[13;3u"
```

Restart Alacritty after changing the config.

## VS Code (Integrated Terminal)

VS Code 1.109.5 and newer enable Kitty keyboard protocol in the integrated terminal by default, so `Shift+Enter` should work out of the box.

VS Code versions older than 1.109.5 need an explicit terminal keybinding for `Shift+Enter`.

`keybindings.json` locations:
- macOS: `~/Library/Application Support/Code/User/keybindings.json`
- Linux: `~/.config/Code/User/keybindings.json`
- Windows: `%APPDATA%\\Code\\User\\keybindings.json`

Add to `keybindings.json`:

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

## Zed (Integrated Terminal)

Add these key bindings to your Zed `keymap.json`:

```json
{
  "context": "Terminal",
  "bindings": {
    "shift-enter": ["terminal::SendText", "\u001b[13;2u"],
    "ctrl--": ["terminal::SendText", "\u001b[45;5u"],
    "ctrl-alt-]": ["terminal::SendText", "\u001b[93;7u"]
  }
}
```

## Windows Terminal

Pi uses Windows-style keybindings when running natively on Windows or in WSL:

- `Alt+V` pastes an image or clipboard text.
- `Ctrl+F` searches the transcript in fullscreen mode, and `Ctrl+Up`/`Ctrl+Down` jump between marked messages.
- `Alt+P` cycles to the previous model.
- `Ctrl+Z` undoes editing on native Windows; WSL uses `Alt+Z` so `Ctrl+Z` can suspend pi.
- `Ctrl+Q` queues a follow-up message and `Alt+Q` restores queued messages.

Add to `settings.json` (Ctrl+Shift+, or Settings → Open JSON file) to forward `Shift+Enter` for inserting a new line:

```json
{
  "actions": [
    {
      "command": { "action": "sendInput", "input": "\u001b[13;2u" },
      "keys": "shift+enter"
    }
  ]
}
```

Windows Terminal binds `Alt+Enter` to fullscreen by default. To use it instead of pi's `Ctrl+Q` default for follow-up queueing, configure Windows Terminal to send the key and bind `app.message.followUp` to `alt+enter` in pi.

If you already have an `actions` array, add the object to it. Fully close and reopen Windows Terminal after changing its settings.

## xfce4-terminal, terminator

These terminals have limited escape sequence support. Modified Enter keys like `Ctrl+Enter` and `Shift+Enter` cannot be distinguished from plain `Enter`, preventing custom keybindings such as `submit: ["ctrl+enter"]` from working.

For the best experience, use a terminal that supports the Kitty keyboard protocol:
- [Kitty](https://sw.kovidgoyal.net/kitty/)
- [Ghostty](https://ghostty.org/)
- [WezTerm](https://wezfurlong.org/wezterm/)
- [iTerm2](https://iterm2.com/)
- [Alacritty](https://github.com/alacritty/alacritty) (requires compilation with Kitty protocol support)

## IntelliJ IDEA (Integrated Terminal)

The built-in terminal has limited escape sequence support. Shift+Enter cannot be distinguished from Enter in IntelliJ's terminal.

If you want the hardware cursor visible, set `PI_HARDWARE_CURSOR=1` before running pi (disabled by default for compatibility).

Consider using a dedicated terminal emulator for the best experience.
