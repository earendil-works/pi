# The terminal

## Summary

pi runs inside whatever terminal emulator the user already has, and most of the experience is the same everywhere: the transcript, the editor, the footer, the slash commands. What differs by terminal is at the edges. Whether Shift+Enter, Ctrl+Enter, and Alt+Enter can be told apart from Enter depends on the keyboard protocol the terminal speaks. Whether an image the model reads is drawn as a picture or as a line of text depends on the terminal's graphics support. Whether a URL is clickable, whether the window title changes, whether a progress indicator shows in the tab, and how fast a lone Escape is recognised all depend on the terminal and on a few settings and environment variables. This document owns those differences; every other document assumes the reference platform (macOS or Linux, a terminal with the Kitty keyboard protocol) and links here for the rest.

Nothing here needs setup in the reference terminals. Kitty, Ghostty, WezTerm, iTerm2, Alacritty, recent VS Code, and Warp work as described elsewhere. Apple Terminal, Windows Terminal, tmux, xfce4-terminal, terminator, IntelliJ's terminal, and Termux each lose something, stated below.

## The simple case

The user opens Ghostty, runs `pi`, and types a two-line prompt: a line, Shift+Enter, another line, Enter. The newline is inserted and the prompt is sent. They ask the model to look at a screenshot; the `read` box shows the picture inline, 60 cells wide. The window title reads `pi - app` (the working directory's name). They press Escape once and the turn aborts at once. Nothing about the terminal was configured.

The same user in Apple Terminal gets the same except the image, which is shown as `[Image: ~/Desktop/shot.png [image/png] 1200x800]`. In an older xfce4-terminal, Shift+Enter sends the prompt instead of adding a line; they type `\` and Enter to get a newline instead.

## What differs by terminal

### Keys

On startup pi asks the terminal whether it speaks the Kitty keyboard protocol. Terminals that do answer, and from then on every modified key arrives unambiguously: Shift+Enter, Ctrl+Enter, Alt+Enter, Shift+Tab, Ctrl+letter with and without Alt, and so on. Terminals that do not answer fall back to xterm's older modified-key reporting (modifyOtherKeys), which also distinguishes the Enter variants in terminals that implement it (WezTerm, Windows Terminal with the mappings below, tmux with extended keys on). Terminals with neither send the same byte for Enter, Shift+Enter, and Ctrl+Enter, and pi cannot tell them apart: all three submit. Alt+Enter is the exception; nearly every terminal sends it as Escape followed by Enter, which pi reads as Alt+Enter without any protocol.

The consequences for the default keybindings:

| Key | Kitty protocol or modifyOtherKeys | Neither |
| --- | --- | --- |
| Shift+Enter | Newline. | Submits. Use Ctrl+J, or type `\` then Enter. |
| Ctrl+Enter | Unbound by default; can be bound (for example as submit). | Submits, as Enter; cannot be bound separately. |
| Alt+Enter | Queues a follow-up. | Queues a follow-up in most terminals; see the per-terminal notes for those that take it for themselves. |
| Ctrl+J | Newline. | Newline. |
| Shift+Tab | Cycles the thinking level. | Cycles the thinking level in most terminals (sent as its own sequence). |
| Shift+Space | A space. | Often nothing, or a space; depends on the terminal. |

There is no startup delay waiting for an answer: pi sends the protocol question together with a second, universally understood question, and whichever answer comes back first settles the mode. Keys typed during that instant are delivered normally.

> Technical note: the request asks for disambiguated escape codes, key-event reporting, and alternate-key reporting. A reply with non-zero flags turns the protocol on; a reply with zero flags, or the device-attributes answer arriving first, turns on modifyOtherKeys instead. With the protocol on, the legacy payloads `ESC CR` and a bare linefeed are interpreted as Shift+Enter, because they only arrive from terminal-side mappings such as Kitty's `map shift+enter send_text all \e\r` or Ghostty's `keybind = shift+enter=text:\n`; without it, `ESC CR` is Alt+Enter and a bare linefeed is Enter (and, in the editor, a newline). Key-release events are reported but dropped. Both protocols are switched off again when pi exits.

### Per-terminal notes

- **Kitty.** Everything works without configuration.
- **Ghostty.** Everything works. Alt+Backspace needs `keybind = alt+backspace=text:\x1b\x7f` in the Ghostty config to delete a word. An older `keybind = shift+enter=text:\n` mapping (added for other tools) still works because pi reads the linefeed as a newline.
- **WezTerm.** Shift+Enter works through modifyOtherKeys; the Kitty protocol can be turned on with `enable_kitty_keyboard = true`. On macOS, WezTerm binds Option+Enter to fullscreen, so Alt+Enter never reaches pi until the user overrides the key to send `\x1b[13;3u`.
- **Alacritty.** Shift+Enter works. On macOS, Option+Enter may arrive as plain Enter; a keyboard binding sending `\u001b[13;3u` fixes it.
- **iTerm2.** Everything works in regular mode. Images are drawn with iTerm2's own protocol.
- **Apple Terminal.** No Kitty protocol and no modifyOtherKeys. pi compensates for Shift+Enter alone: when a plain Return arrives and the Shift key is physically held, it is treated as Shift+Enter. This works only when pi runs on the same Mac as the terminal; over SSH into a Mac it does not, and Shift+Enter submits. Ctrl+Enter still submits. No inline images.
- **VS Code's integrated terminal.** From VS Code 1.109.5 the Kitty protocol is on by default and Shift+Enter works. Older versions need a `workbench.action.terminal.sendSequence` keybinding for `shift+enter` sending `\u001b[13;2u`. No inline images; links are clickable.
- **Windows Terminal.** Needs `sendInput` actions for `shift+enter` (`\u001b[13;2u`) and `alt+enter` (`\u001b[13;3u`) in its settings; without them Shift+Enter submits, and Alt+Enter toggles Windows Terminal's own fullscreen instead of reaching pi. If the fullscreen behaviour persists after editing, Windows Terminal has to be fully closed and reopened. No inline images.
- **xfce4-terminal, terminator.** No modified-Enter support at all: Shift+Enter and Ctrl+Enter are Enter. A custom `submit: ["ctrl+enter"]` binding cannot work.
- **IntelliJ's terminal.** Shift+Enter is Enter. The cursor is hidden unless `PI_HARDWARE_CURSOR=1` is set. No inline images, no clickable links.
- **Warp.** Treated like Kitty for images and links.
- **Unknown terminals.** Keys follow the negotiation above; images and clickable links are off; truecolor is used only if the terminal advertises it.

### tmux

tmux sits between pi and the real terminal and, by default, strips the modifier from Shift+Enter and Ctrl+Enter so that both arrive as Enter. pi asks tmux for extended keys automatically, but tmux only honours the request when `set -g extended-keys on` is in `~/.tmux.conf`; `set -g extended-keys-format csi-u` (tmux 3.5 or later) makes the forwarded keys match what pi prefers. tmux must be restarted fully (`tmux kill-server`) for the change to take.

At startup inside tmux, pi checks these two options and adds a warning to the transcript when they are not set: `Warning: tmux extended-keys is off. Modified Enter keys may not work. Add \`set -g extended-keys on\` to ~/.tmux.conf and restart tmux.` or `Warning: tmux extended-keys-format is xterm. Pi works best with csi-u. Add \`set -g extended-keys-format csi-u\` to ~/.tmux.conf and restart tmux.` If tmux cannot be queried within two seconds, no warning is shown. Inside tmux, inline images are always off, and clickable links are on only when tmux reports that it forwards them to the outer terminal. `screen` behaves like tmux without images or links.

### Images

When the model's `read` tool returns an image and `terminal.showImages` is on (the default), the picture is drawn inside the tool box in Kitty, Ghostty, WezTerm, Warp (Kitty graphics) and iTerm2 (iTerm2 graphics), scaled to at most `terminal.imageWidthCells` columns (60 by default; `/settings` offers 60, 80, or 120) with the aspect ratio kept. JPEG, GIF, and WebP images are converted to PNG in the background for the Kitty protocol, so the box first shows the placeholder and then the picture a moment later. Everywhere else, and always inside tmux, the box shows a placeholder line: `[Image: ~/path/to/file.png [image/png] 1200x800]`, with the path shortened to `~` and, where links work, clickable to open the file. The `Show images` row of `/settings` appears only in terminals that can draw images.

> Technical note: pi asks the terminal for its cell size in pixels at startup (only when images are possible) so that the image's row count matches its column count; the default assumption is 9×18 pixels per cell. Images are cropped row by row when they scroll partly out of the viewport, and deleted from the terminal when the transcript is rebuilt.

### Links

In Kitty, Ghostty, WezTerm, Warp, iTerm2, VS Code, Windows Terminal, and tmux-with-forwarding, URLs that pi itself emits are clickable: the changelog link in the update notice, the sign-in link in the login dialog, and the file path in an image placeholder. Elsewhere the same text is shown plain. Links inside the model's markdown are rendered as text by the markdown renderer, and whether they are clickable is the terminal's own URL detection.

### Prompt markers and the window title

Each user message and each assistant message that contains no tool calls is wrapped in shell-integration markers, so terminals that understand them (Kitty, WezTerm, iTerm2, Ghostty) can jump between messages with their "previous prompt" and "next prompt" shortcuts, the same way they jump between shell prompts.

The window title is set to `pi - <directory name>` at startup and to `pi - <session name> - <directory name>` once the session has a name, updating when the name changes or the session is switched. The title is not restored on exit; the shell or the terminal sets its next one.

### The progress indicator

With `terminal.showTerminalProgress` on (off by default; the `Terminal progress` row of `/settings`), pi asks the terminal to show an indeterminate progress state while the agent is working or compacting, and clears it when the turn settles. Windows Terminal shows it in the tab and taskbar; Ghostty and recent iTerm2 in the tab; other terminals ignore it. The state is re-sent every second while active so a terminal that times it out keeps showing it.

### Resize, width, and wrapping

pi redraws when the terminal reports a new size. A width change re-renders everything still on screen at the new width and clears the terminal's scrollback, so the transcript above the viewport is gone from scrollback after a horizontal resize; what is on screen is re-wrapped correctly. A height change does the same except on Termux, where the on-screen keyboard changes the height constantly and pi keeps what it has. Very long lines wrap by grapheme, so emoji and CJK text keep their width; wide characters are measured as two cells.

With `terminal.clearOnShrink` off (the default), when the bottom block gets shorter (the autocomplete popup closes, the status line empties) the rows it used are left blank rather than the screen being redrawn; two blank lines are held in the status slot while idle so the editor does not jump. With it on, every shrink triggers a full redraw that also clears scrollback. `PI_CLEAR_ON_SHRINK=1` sets the same thing from the environment.

> Technical note: pi's regular mode writes only the lines that changed since the last frame and never moves the cursor above the top of the screen, which is why anything that has scrolled into the terminal's history stays as it was drawn; a full redraw starts by clearing the screen and the scrollback. Terminal width falls back to `COLUMNS`/`LINES`, then 80×24, when the terminal does not report a size.

### Colour

The built-in themes are written in 24-bit colour. In terminals that advertise truecolor (`COLORTERM=truecolor` or `24bit`, or any of the terminals pi recognises by name, or any Windows console) colours are used as written. Otherwise each colour is mapped to the nearest of the 256-colour palette, so the thinking-level border ramp and the message backgrounds are slightly off but still distinct.

### Escape timing

A lone Escape byte is ambiguous: it may be the Escape key, or the start of an Alt chord or an arrow sequence whose rest is still in flight. pi waits 10 ms for the rest before treating it as Escape, 100 ms when running over SSH (`SSH_CONNECTION` or `SSH_TTY` set). `PI_TUI_ESC_TIMEOUT=<ms>` overrides either. Over a slow link, Alt+B typed as two separate bytes may arrive as Escape followed by `b`; raising the timeout fixes it at the cost of a slower Escape.

### The hardware cursor and IME

pi hides the terminal's own cursor and draws its own inside the editor, but it still moves the hidden hardware cursor to the editor's cursor position so that input-method candidate windows (CJK input, emoji pickers) appear next to the text. Some terminals (WezTerm on WSL, IntelliJ) only position the candidate window when the cursor is visible; the `showHardwareCursor` setting (`Show hardware cursor` in `/settings`, default off) or `PI_HARDWARE_CURSOR=1` makes it visible, in which case the user sees two cursors.

### Windows

pi on Windows needs Git Bash (`C:\Program Files\Git\bin\bash.exe`) or another `bash.exe` on `PATH` (Cygwin, MSYS2, WSL); the `shellPath` setting names a specific one. Without any, every `!` command and every `bash` tool call fails with `No bash shell found.` and the three options to fix it. Ctrl+Z is not bound; pressing it shows `Suspend to background is not supported on Windows`. The image-paste key is Alt+V, because Ctrl+V is the console's paste. Backspace sent as `\x08` by Windows Terminal is read as Ctrl+Backspace (delete word). SIGHUP does not exist; closing the window ends pi without the clean shutdown in [process lifecycle](process-lifecycle.md).

### Termux

On Android in Termux, clipboard copy goes through `termux-clipboard-set` (the Termux:API app must be installed); image paste is not available. Height changes from the software keyboard do not trigger full redraws. Everything else is as on Linux.

## Modifiers

| Modifier | Set before sending | Changed while working |
| --- | --- | --- |
| Model | No effect on terminal behaviour; a model that returns images needs a terminal that can draw them to show them inline. | No effect. |
| Thinking level | The border colour is exact in truecolor terminals and approximated in 256-colour ones. | Same. |
| Agent busy | Idle: no progress indicator. | Working: the progress indicator is shown when enabled; the window title is unchanged. |
| Attachments | Images pasted with Ctrl+V are a path in the editor in every terminal; whether a dropped file's path arrives quoted or escaped is the terminal's choice. | No effect. |
| Session kind | No effect. | No effect. |

## Cancel and interrupt

| Event | While idle | While working |
| --- | --- | --- |
| Escape (once; twice within 500 ms) | Recognised after 10 ms (100 ms over SSH); the double-press window is unaffected. | Same; the abort fires after the timeout. |
| Ctrl+C once / twice; Ctrl+D | Arrive as keys in every terminal; pi reads them itself, the terminal does not send a signal. | Same. |
| Another message submitted (Enter; Alt+Enter follow-up) | Alt+Enter behaves as Enter when idle in every terminal that delivers it. | Alt+Enter queues a follow-up only in terminals that deliver it (not WezTerm or Windows Terminal with their default fullscreen bindings). |
| A slash command or shortcut that opens an overlay or changes the session | No terminal dependence. | Same. |
| Model or thinking level changed | No effect. | No effect. |
| Provider error, rate limit, timeout, or network lost | No effect. | The progress indicator, when enabled, stays on through retries and clears when the turn settles. |
| Context window exhausted (auto-compaction) | No effect. | The progress indicator stays on during compaction. |
| Terminal resized; pi suspended (Ctrl+Z) and resumed | A width change redraws everything on screen and clears scrollback. Resume redraws the whole bottom block and re-negotiates the keyboard protocol. | Same; streamed text is re-wrapped. |
| Process ends: terminal closed (SIGHUP), SIGTERM, killed | The keyboard protocol and bracketed paste are switched off on a clean exit; after a kill the terminal may be left in raw mode (see [process lifecycle](process-lifecycle.md)). | Same. |
| Session or files changed from outside | No effect. | No effect. |
| Credentials lost, or logged out | No effect. | No effect. |

## Interactions with other systems

**Session persistence.** Nothing about the terminal is stored in the session; a session resumed in a different terminal renders images or placeholders according to the new terminal.

**Branching and history.** No interaction.

**Compaction.** No interaction.

**Context files and the system prompt.** No interaction.

**Settings and keybindings.** `terminal.showImages`, `terminal.imageWidthCells`, `terminal.clearOnShrink`, `terminal.showTerminalProgress`, `showHardwareCursor`, `shellPath`; the environment variables `PI_TUI_ESC_TIMEOUT`, `PI_HARDWARE_CURSOR`, `PI_CLEAR_ON_SHRINK`. Custom keybindings that use Shift+Enter or Ctrl+Enter only work in terminals that can deliver them.

**Tools and the working directory.** Images come only from the `read` tool. The shell the tools use is the same one the terminal section above describes for Windows.

**Terminal and rendering.** This document.

**Credentials and providers.** The sign-in link in the login dialog is clickable only where links work; the URL is always printed so it can be copied.

## Edge cases

- A terminal that answers the Kitty query late, after the user has started typing, switches modes mid-session; keys typed before the answer were read in legacy mode.
- Over SSH into a Mac from Apple Terminal, the Shift+Enter fallback is off because pi cannot see the local keyboard; the same user at the Mac's own keyboard gets it.
- With the Kitty protocol on, a terminal-side mapping that sends a bare linefeed for Shift+Enter is read as Shift+Enter, not as Ctrl+J; both insert a newline so the difference is invisible by default but matters for custom bindings.
- In tmux with `extended-keys on` but the format left at `xterm`, keys still work; the warning is advice, not an error.
- Right-click in regular mode is the terminal's own paste (a bracketed paste to the editor); pi does not see the mouse. See [clipboard](clipboard.md).
- A very narrow terminal truncates the footer's left side first, then drops the model name; nothing refuses to draw.
- The window title is set even when the terminal ignores it; there is no setting to turn it off.

## Open questions and verification

- Which terminals render the progress indicator, the prompt markers, and the `pi - name - dir` title was read from the escape sequences pi emits and from general terminal knowledge, not confirmed terminal by terminal.
- The claim that a width change clears the scrollback (full redraw with clear) was read from the renderer and not observed in each terminal; terminals differ in whether "clear scrollback" is honoured.
- The Shift+Space row of the key table (what a legacy terminal sends) was not tested.
- Whether a late Kitty answer really switches modes mid-session, and what happens to a key arriving exactly during the 150 ms split-reply buffer, was read from the negotiation code only.
- The hardware-cursor claim "two cursors" when `showHardwareCursor` is on was inferred from the editor drawing its own cursor and the terminal showing the real one; not observed.
- Whether links inside the model's markdown are ever emitted as OSC 8 links (as opposed to plain text) was not confirmed; the markdown renderer was not read.
- Warp's image support was read from the capability table and not tested.

Verified against pi-mono commit `a69bef789`.
