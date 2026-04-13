# tmux Setup

Pi works inside tmux, but tmux strips modifier information from certain keys by default. Without configuration, `Shift+Enter` and `Ctrl+Enter` are usually indistinguishable from plain `Enter`.

## Recommended Configuration

Add to `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

Then restart tmux fully:

```bash
tmux kill-server
tmux
```

Pi requests extended key reporting automatically when Kitty keyboard protocol is not available. With `extended-keys-format csi-u`, tmux forwards modified keys in CSI-u format, which is the most reliable configuration.

## Why `csi-u` Is Recommended

With only:

```tmux
set -g extended-keys on
```

tmux defaults to `extended-keys-format xterm`. When an application requests extended key reporting, modified keys are forwarded in xterm `modifyOtherKeys` format such as:

- `Ctrl+C` → `\x1b[27;5;99~`
- `Ctrl+D` → `\x1b[27;5;100~`
- `Ctrl+Enter` → `\x1b[27;5;13~`

With `extended-keys-format csi-u`, the same keys are forwarded as:

- `Ctrl+C` → `\x1b[99;5u`
- `Ctrl+D` → `\x1b[100;5u`
- `Ctrl+Enter` → `\x1b[13;5u`

Pi supports both formats, but `csi-u` is the recommended tmux setup.

## What This Fixes

Without tmux extended keys, modified Enter keys collapse to legacy sequences:

| Key | Without extkeys | With `csi-u` |
|-----|-----------------|--------------|
| Enter | `\r` | `\r` |
| Shift+Enter | `\r` | `\x1b[13;2u` |
| Ctrl+Enter | `\r` | `\x1b[13;5u` |
| Alt/Option+Enter | `\x1b\r` | `\x1b[13;3u` |

This affects the default keybindings (`Enter` to submit, `Shift+Enter` for newline) and any custom keybindings using modified Enter.

## Suppressing the Warning

If you intentionally run tmux without extended keys and want to suppress the startup warning, set the `PI_SKIP_TMUX_WARNING` environment variable:

```bash
export PI_SKIP_TMUX_WARNING=1
```

This skips the tmux keyboard check entirely. Modified Enter keys (Shift+Enter, Ctrl+Enter, etc.) may still not work as expected.

## Requirements

- tmux 3.2 or later (run `tmux -V` to check)
- A terminal emulator that supports extended keys (Ghostty, Kitty, iTerm2, WezTerm, Windows Terminal)
