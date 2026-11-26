# Configure your terminal

Most modern terminals work with Pi without additional setup. Use this page when modified keys, scrolling, links, images, colors, or input-method editor (IME) positioning do not behave as expected.

Pi uses extended-key protocols so terminals can distinguish combinations such as `Shift+Enter` and `Alt+Enter` from plain `Enter`. Terminal proxies, multiplexers, and built-in IDE terminals can change or discard that information.

## Troubleshooting

| Symptom | Start here |
|---|---|
| `Shift+Enter` submits instead of inserting a line | Your terminal's section below; for tmux, see [Run Pi in tmux](tmux.md) |
| `Alt+Enter` does not queue a follow-up | [WezTerm](#wezterm), [Alacritty](#alacritty), or [Windows Terminal](#windows-terminal) |
| Fullscreen scrolling is unusually slow | [iTerm2](#iterm2) |
| Links work but show no hover preview | [Ghostty](#ghostty) |
| Inline images or colors are not detected | [Override detected capabilities](#override-detected-capabilities) |
| An IME candidate window appears in the wrong place | [WezTerm](#wezterm) or [IntelliJ IDEA](#intellij-idea-integrated-terminal) |
| Modified keys fail only inside tmux | [Run Pi in tmux](tmux.md) |
| After Pi exits, moving the mouse or typing puts text such as `[<35;12;5M` or `[;;;129:3u` into the shell prompt | [Recover the terminal after Pi was killed](#recover-the-terminal-after-pi-was-killed) |

Use `/hotkeys` to inspect Pi's active shortcuts. See [Keybindings](keybindings.md) to change them.

## Kitty

Kitty supports the required keyboard protocol without additional configuration.

## iTerm2

Regular terminal mode works without additional configuration.

### Fix slow fullscreen scrolling

In fullscreen mode, Pi owns the viewport, so iTerm2 sends mouse-wheel reports instead of scrolling native terminal history. Fast trackpad gestures can then move only about one line at a time.

To change this behavior:

1. Open **iTerm2 > Settings > Advanced**.
2. Search for **Trackpad scrolls fast?**.
3. Set it to **No**.

This is an iTerm2-wide setting and can also change native trackpad scrolling. The underlying behavior is tracked in [iTerm2 issue 9619](https://gitlab.com/gnachman/iterm2/-/work_items/9619).

## Apple Terminal

Pi enables enhanced key reporting when available. If Terminal.app still sends plain Return or `ESC` + Return for `Shift+Enter`, Pi uses a local macOS modifier fallback and treats it as `Shift+Enter`. `ESC` + Return without Shift held remains `Alt+Enter`.

The fallback works only when Pi runs on the same Mac as Terminal.app. It cannot inspect the local modifier state when Pi runs on another machine over SSH.

## Ghostty

Add this mapping to Ghostty's configuration if `Alt+Backspace` does not work:

```text
keybind = alt+backspace=text:\x1b\x7f
```

The configuration file is `~/Library/Application Support/com.mitchellh.ghostty/config` on macOS and `~/.config/ghostty/config` on Linux.

Older Claude Code configurations may contain:

```text
keybind = shift+enter=text:\n
```

This sends a raw linefeed, which Pi cannot distinguish from `Ctrl+J`. Remove the mapping if an older Claude Code installation is the only reason you added it. Pi already binds `Ctrl+J` as a newline alternative, so the mapping may appear to work while still preventing Pi and tmux from receiving a real `Shift+Enter` event.

### Open links in fullscreen mode

Links remain clickable in fullscreen mode, but Ghostty does not show its normal hover underline or URL preview while Pi captures mouse input. Hold `Shift+Command` on macOS or `Shift+Ctrl` on Linux to use Ghostty's native link handling.

## WezTerm

WezTerm normally reports `Shift+Enter` through xterm extended keys. To enable the Kitty keyboard protocol explicitly, create `~/.wezterm.lua`:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

### Forward Alt+Enter on macOS

WezTerm binds `Option+Enter` to fullscreen by default on macOS. To use it for Pi's follow-up queue, add this entry to your `config.keys` table:

```lua
{
  key = 'Enter',
  mods = 'ALT',
  action = wezterm.action.SendString('\x1b[13;3u'),
}
```

A complete minimal configuration is:

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

### Position an IME candidate window in WSL

If CJK IME candidates do not follow Pi's text cursor in WSL, show the hardware cursor:

```bash
export PI_HARDWARE_CURSOR=1
pi
```

You can instead set `showHardwareCursor` to `true` in Pi settings.

## Alacritty

Alacritty normally reports `Shift+Enter`. On macOS, `Option+Enter` can arrive as plain `Enter`. Add this to `~/.config/alacritty/alacritty.toml` to forward it to Pi:

```toml
[[keyboard.bindings]]
key = "Enter"
mods = "Alt"
chars = "\u001b[13;3u"
```

Restart Alacritty after changing the file.

## VS Code integrated terminal

VS Code 1.109.5 and newer enable the Kitty keyboard protocol in the integrated terminal by default.

For an older version, add a `Shift+Enter` terminal binding to `keybindings.json`:

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

The user `keybindings.json` file is normally located at:

- macOS: `~/Library/Application Support/Code/User/keybindings.json`
- Linux: `~/.config/Code/User/keybindings.json`
- Windows: `%APPDATA%\\Code\\User\\keybindings.json`

## Zed integrated terminal

Add these bindings to Zed's `keymap.json`:

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

Windows Terminal uses Pi's Windows and WSL shortcut defaults. See [Keybindings](keybindings.md) for the complete list.

### Forward Shift+Enter

When Pi runs natively on Windows, it checks the local Shift key state and treats plain Return or `ESC` + Return as `Shift+Enter` while Shift is held. This fallback does not work in WSL or over SSH. If `Shift+Enter` still submits, forward it explicitly.

Open Windows Terminal's `settings.json` with `Ctrl+Shift+,` or **Settings > Open JSON file**. Add this object to its `actions` array:

```json
{
  "command": { "action": "sendInput", "input": "\u001b[13;2u" },
  "keys": "shift+enter"
}
```

Fully close and reopen Windows Terminal, then verify that `Shift+Enter` inserts a new line in Pi.

### Use Alt+Enter for follow-ups

Windows Terminal binds `Alt+Enter` to fullscreen by default. Pi therefore uses `Ctrl+Q` for follow-ups on Windows and WSL.

To use `Alt+Enter` instead, configure Windows Terminal to forward the key and bind `app.message.followUp` to `alt+enter` in Pi's `keybindings.json`. See [Keybindings](keybindings.md#assign-keybindings).

## xfce4-terminal and Terminator

These terminals cannot reliably distinguish modified Enter keys from plain `Enter`. Custom bindings such as `Ctrl+Enter` or `Shift+Enter` therefore may not work.

Use a terminal with modern extended-key support when you need those shortcuts, such as Kitty, Ghostty, WezTerm, iTerm2, Windows Terminal, or a compatible Alacritty build.

## IntelliJ IDEA integrated terminal

IntelliJ IDEA's built-in terminal cannot reliably distinguish `Shift+Enter` from plain `Enter`. Use `Ctrl+J` for a newline or run Pi in a terminal with modern extended-key support.

If an IME candidate window does not follow the text cursor, show the hardware cursor:

```bash
export PI_HARDWARE_CURSOR=1
pi
```

## Override detected capabilities

Pi automatically detects OSC 8 hyperlinks, inline image protocols, and truecolor support. A terminal proxy or multiplexer can make that detection inaccurate.

| Capability | Environment variable | Setting |
|---|---|---|
| Hyperlinks | `PI_HYPERLINKS=1\|0\|auto` | `terminal.hyperlinks: true\|false\|"auto"` |
| Inline images | `PI_IMAGE_PROTOCOL=kitty\|iterm2\|none\|auto` | `terminal.images: "kitty"\|"iterm2"\|false\|"auto"` |
| Truecolor | `PI_TRUE_COLOR=1\|0\|auto` | `terminal.trueColor: true\|false\|"auto"` |

Settings take precedence over environment variables. An unset value or `auto` preserves automatic detection.

Only force a capability supported by the complete terminal path. Unsupported escape sequences can corrupt rendering. See [Environment Variables](environment-variables.md#pi-process-configuration) and [Settings](settings.md) for the canonical value definitions.

## Recover the terminal after Pi was killed

Pi turns on key, mouse, and paste reporting while it runs, and the alternate screen in fullscreen mode. It turns them off when it exits. If Pi is killed (`kill -9`, Task Manager, out of memory), they stay on and the shell types the reports into the prompt.

The real fix is to find what kills Pi and stop it. Look for `JavaScript heap out of memory` in the terminal, or a script or IDE that ends the process, and [open an issue](https://github.com/earendil-works/pi/issues) with what you find.

To reset the terminal, run this in the affected pane. Starting and quitting Pi again is not enough.

bash or zsh:

```bash
printf '\e[<16u\e[=0;1u\e[>4;0m\e[?2004;1000;1002;1003;1004;1006l\e[?7;25h'
```

PowerShell:

```powershell
$e = [char]27; [Console]::Write("$e[<16u$e[=0;1u$e[>4;0m$e[?2004;1000;1002;1003;1004;1006l$e[?7;25h")
```

If the prompt still shows Pi's last screen, also run `printf '\e[?1049l'` or `[Console]::Write("$([char]27)[?1049l")`. Only in that case: otherwise it confuses the shell's line editor.

If you cannot type in the pane, start Pi in another tab and ask it: "Reset my other terminal tab with the reset sequence from Pi's terminal-setup docs." Then press `Ctrl+C` in the fixed tab to clear the line.

## Program status

Pi reports its state with the [Program Status Protocol (OSC 7501)](https://www.superlogical.com/rex/docs/build/program-status), so terminals and agent dashboards can show whether it is working, waiting for you, done, or failed:

| State | When |
|---|---|
| `working` | An agent run or compaction is in progress. The message is the session name. |
| `blocked` | An extension dialog or login waits for you. The message is the dialog title. |
| `done` | A run finished. The message is the session name. |
| `error` | A run ended with an error that is not retried. The message is the first line of the error. |
| `idle` | Pi started, or you cancelled the run. |

Reports never contain prompts or model output. Pi sends them only after the terminal answers the protocol's support query; tmux and screen do not forward them. Set `PI_PROGRAM_STATUS=1` to send reports without asking, or `PI_PROGRAM_STATUS=0` to turn them off.

## Program resume

Pi tells the terminal how to bring the session back after the terminal restarts, with the [Program Resume Protocol (OSC 7577)](https://www.superlogical.com/rex/docs/build/program-resume). Terminals that support it set `OSC7577_TOKEN` in the environment; Pi reports only when it is set.

The command is the one Pi prints when you quit, such as `pi --session <id>`, to run in the session's directory. A terminal starts it without the environment Pi was started in, so the command carries what the environment chose: `--agent-dir` when `PI_CODING_AGENT_DIR` names a directory other than `~/.pi/agent`, and `--session-dir` when sessions are not in the default location. A terminal rule that trusts `pi --session <id>` does not match these longer commands; trust them separately. Pi updates it when you start, resume, or fork a session, and once a new session has its first message. A new session without messages has nothing to resume, so Pi removes the command until then. Quitting with `Ctrl+D`, `Ctrl+C` twice, or `/quit` removes it too; when the terminal itself closes or restarts, Pi keeps it.

Pi also repeats the restriction and resource flags it was started with, as typed and in the order typed, after `--session <id>`: `--tools`, `--exclude-tools`, `--no-tools`, `--no-builtin-tools`, `--extension`, `--skill`, `--prompt-template`, `--theme` and their `--no-*` forms, `--no-mcp`, `--no-context-files`, `--system-prompt`, `--append-system-prompt`, `--approve`, `--no-approve`, and `--models`. Without them a resumed session would have other tools or instructions than the one that ran, possibly more access. Other flags are not repeated: the session keeps its model, thinking level, and name, and a terminal must not store `--api-key`. When the session's directory differs from the one Pi was started in, Pi removes the command instead, because relative paths in the flags would point elsewhere.

A terminal resumes only commands a rule trusts, so a rule for `pi --session <id>` does not bring back a Pi started with flags; its pane comes back as a plain shell. Trust each combination you use, with the flags in the order you type them. For Rex:

```lua
rex.set("resume.trust.pi_readonly", {
	command = { "pi", "--session", rex.match.uuid, "-t", "read,grep,find,ls" },
})
```

Rex rules with a `flags` table, which accept any combination, cannot verify Pi's flags yet: Rex compares them with the process's command line, which Node overwrites when Pi sets its process name.

Pi removes `OSC7577_TOKEN` from its own environment at startup, so shells, editors, and extension processes it starts cannot replace its command or register commands of their own. Whether and when the terminal resumes a command is up to the terminal.
