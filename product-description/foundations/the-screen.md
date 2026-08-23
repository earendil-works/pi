# The screen

## Summary

pi draws one screen: a transcript that grows downward into the terminal's scrollback, and a fixed block at the bottom made of the pending area, the status line, the editor, and the footer. Overlays take the editor's place. This document owns the names of those parts and what each shows when; feature documents say what changes in them and link here for the rest. Everything here is the regular TUI mode; fullscreen mode, where the transcript scrolls inside a pane pi owns, is out of scope.

There is no mouse interaction in regular mode. The terminal's own scrollback, selection, and copy work on the transcript as on any other output.

## The simple case

On a fresh start the user sees, top to bottom: the header (`pi v0.84.2` with a one-line shortcut strip and two dim hint lines), a blank line, the editor with its coloured border and a blinking cursor inside, and the two dim footer lines. As the conversation proceeds, user messages, assistant messages, and tool boxes are appended above the editor and the whole thing scrolls up into the terminal's history. While the agent works a spinner line sits directly above the editor; when the user queues a message a dim `Steering: …` line appears above that.

## The parts of the screen

From the top:

**Header.** Shown once, at the top of a new session (not when resuming). Collapsed it is the logo line `pi v<version>`, one line of shortcut hints (`Escape interrupt · Ctrl+C/Ctrl+D clear/exit · / commands · ! bash · Ctrl+O more`), `Press Ctrl+O to show full startup help and loaded resources.`, and `Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.` Ctrl+O expands it to the full list of about twenty hints, and expands the loaded-resources block under it. The `quietStartup` setting replaces the whole header with nothing. In the default configuration the loaded-resources block lists `[Context]` files found (`AGENTS.md` and the like) and nothing else; with none found, nothing is listed.

**Transcript.** Every message in order. What each kind looks like is in [the transcript](../conversation/the-transcript.md); the short version: user messages in the user-message background, assistant text as rendered markdown, thinking in italics, tool calls as boxes whose background shows pending, success, or error, shell commands as bordered boxes, status messages as single dim lines, warnings and errors in their colours, compaction and branch summaries as collapsible boxes. A blank line separates messages. The transcript is rebuilt from the session whenever the active position changes (`/tree`, `/fork`, `/resume`, `/new`) or when Ctrl+T hides or shows thinking; a rebuild discards status messages, warnings, and errors, which are not in the session.

**Pending area.** Empty when nothing is queued. Otherwise a blank line, one dim `Steering: <text>` line per steering message, one dim `Follow-up: <text>` per follow-up, each truncated to the width, then `↳ Alt+Up to edit all queued messages`. Shell-command boxes started while the agent is working also live here until the next prompt moves them into the transcript (with the caveat in [shell commands](../conversation/shell-commands.md#open-questions-and-verification)).

**Status line.** One line, a spinner in the accent colour and a message in the muted colour: `Working... (escape to interrupt)` during a turn; `Retrying (2/3) in 4s... (escape to cancel)` counting down, with the spinner in the warning colour; `Compacting context... (escape to cancel)` or `Auto-compacting... (escape to cancel)` or `Context overflow detected, Auto-compacting... (escape to cancel)`; `Summarizing branch... (escape to cancel)`. Empty when idle. Only one status is shown at a time; a retry replaces working, and working replaces retry when the attempt begins.

**Editor.** The bordered box the user types in; see [the editor](../conversation/the-editor.md). It is at least three lines tall (border, one text line, border) and grows with its content up to 30% of the terminal height, minimum five lines, after which it scrolls internally. The border colour is the thinking level's colour (`off` dark grey, then a ramp through blue and purple to magenta for `max`) or green when the text starts with `!`. The autocomplete popup is drawn directly below the editor, inside the bottom block, pushing the footer down.

**Footer.** Two dim lines, recomputed on every redraw:

- Line 1: the working directory with the home directory shown as `~`; then ` (branch)` when the directory is in a git repository; then ` • name` when the session has a name. Truncated with `...` at the width.
- Line 2, left side, each part only when non-zero: `↑12k` input tokens, `↓1.2k` output tokens, `R45k` tokens read from the provider's cache, `W12k` written to it, `CH85.3%` the latest call's cache-hit rate (only when any caching happened), `$0.123` the session's cost so far with ` (sub)` appended when the provider is subscription-billed, and `42.0%/200k (auto)`: context used as a share of the model's window, with ` (auto)` when auto-compaction is on. The percentage is in the warning colour above 70% and the error colour above 90%, and is `?` from a compaction until the next response. Totals cover the whole session, including messages before a compaction and the compaction's own cost.
- Line 2, right side: the model id, preceded by `(provider) ` when more than one provider is available and the line has room, and followed by ` • medium` (the thinking level) or ` • thinking off` for models that can reason. `unknown` when no provider has a credential (a placeholder model is selected); the context readout then shows `0.0%/0 (auto)`. When both sides do not fit, the right side is truncated first.
- Line 3 exists only when an extension publishes a status; never in the default configuration.

Tokens are shown as `950`, `1.2k`, `12k`, or `1.2M`.

**Overlays.** A selector or dialog replaces the editor in its slot; the footer stays below it, the transcript above. Only one is open at a time; opening another closes the first. The editor's text is preserved and comes back when the overlay closes. Each overlay's own keys are in its document; Escape always closes.

**Terminal title.** pi sets the terminal window title to reflect the session; see "Open questions".

> Technical note: pi redraws by diffing the previous frame against the new one and rewriting only changed lines, so a large transcript does not flicker. Lines above the current viewport that have scrolled into the terminal's history are never rewritten; that is why the transcript, once it has scrolled off, cannot be retroactively re-rendered (a theme change or a width change affects only what is still on screen and anything drawn afterwards).

## Modifiers

| Modifier | Set before sending | Changed while working |
| --- | --- | --- |
| Model | Footer right side; `(provider)` prefix when more than one provider is available. | Footer updates at once; the transcript does not mark the switch. |
| Thinking level | Editor border colour and the footer's ` • level` suffix. | Both update at once. |
| Agent busy | Idle: empty status line. | Working: the status line shows the spinner; the pending area may fill. |
| Attachments | An image path pasted into the editor is shown as its path; images are rendered in the transcript only after sending (and only in terminals that can show them). | No effect. |
| Session kind | Saved: line 1 of the footer may show a name. Ephemeral: identical. | No effect. |

## Cancel and interrupt

| Event | While idle | While working |
| --- | --- | --- |
| Escape (once; twice within 500 ms) | Closes an overlay; otherwise see [input](input.md#escape). Twice: the tree overlay replaces the editor. | The status line clears; the partial message gets its `Operation aborted` line. |
| Ctrl+C once / twice; Ctrl+D | The editor empties; twice, the screen is left as it was, pi's bottom block is removed, and the resume hint is printed below the transcript. | Same. |
| Another message submitted (Enter; Alt+Enter follow-up) | The editor empties, the message is added to the transcript. | The editor empties, the pending area gains a line. |
| A slash command or shortcut that opens an overlay or changes the session | The overlay replaces the editor. A session switch clears the transcript and redraws it from the new session (or shows the header for a new one). | Same; the status line stays while the turn continues behind an overlay. |
| Model or thinking level changed | Footer and border update. | Same. |
| Provider error, rate limit, timeout, or network lost | No effect. | The status line switches to the retry countdown, or clears and an `Error:` line is added. |
| Context window exhausted (auto-compaction) | No effect. | The status line shows compaction; when it ends the transcript is rebuilt with the `[compaction]` box in place. |
| Terminal resized; pi suspended (Ctrl+Z) and resumed | Everything still on screen re-wraps to the new width; scrolled-off lines do not. Suspend restores the terminal's normal screen; `fg` redraws pi's bottom block. | Same. |
| Process ends: terminal closed (SIGHUP), SIGTERM, killed | The terminal is restored to its normal mode; on a kill it may be left in raw mode with a hidden cursor (`reset` fixes it). | Same. |
| Session or files changed from outside | No effect. | No effect. |
| Credentials lost, or logged out | The footer may lose its `(provider)` prefix; with no credential left it shows `unknown`. | Same. |

## Interactions with other systems

**Session persistence.** Status messages, warnings, errors, and notices are screen-only; everything else on the transcript comes from the session and is redrawn from it.

**Branching and history.** A rebuild shows the active branch only; other branches are reachable through `/tree`.

**Compaction.** After a compaction the transcript is rebuilt so that the summary box sits where the summarised messages were, followed by the kept messages; the footer's context figure shows `?` until the next response.

**Context files and the system prompt.** Listed under `[Context]` in the loaded-resources block at startup, with paths relative to the working directory.

**Settings and keybindings.** `quietStartup`, `outputPad` (0 or 1 columns of padding for messages), `editorPaddingX`, `autocompleteMaxVisible`, `hideThinkingBlock`, `showCacheMissNotices`, `theme`, `terminal.showImages`, `terminal.imageWidthCells`, `terminal.clearOnShrink` (draws two blank lines in the status slot so the block does not jump), `terminal.showTerminalProgress` (an OSC progress indicator in terminals that support one).

**Tools and the working directory.** Tool boxes are the only part of the transcript that can change after being drawn: their background colour and content update as the tool runs and finishes.

**Terminal and rendering.** Width, colour depth, image support, and the terminal's scrollback behaviour are the terminal's; see [the terminal](../cross-cutting/the-terminal.md).

**Credentials and providers.** The `(provider)` prefix and the `(sub)` cost marker in the footer.

## Edge cases

- With `outputPad` 0, errors sit flush left while warnings and status messages keep one column of indentation; they use different padding rules.
- Consecutive status messages replace one another in place rather than stacking, so `Model: a` followed by `Model: b` leaves one line.
- A terminal narrower than the footer's left side truncates the left side and drops the model name entirely.
- The footer's `(provider)` prefix appears and disappears with the available-provider count, which changes after `/login` and `/logout`.
- The `?` context figure after compaction stays until a response arrives, even across a resume.
- A very tall editor (many lines pasted) is capped at 30% of the terminal height and scrolls; the footer never leaves the bottom.

## Open questions and verification

- The terminal title format was not read; pi sets one and updates it on session-name changes, but the exact text is unconfirmed.
- The exact thinking-level colour ramp was read from the dark theme (`darkGray`, `#6e6e6e`, `#5f87af`, `#81a2be`, `#b294bb`, `#d183e8`, `#ff5fff`); the light theme's values were not read.
- Whether the header is shown when resuming a session with `-c` (it is skipped for the changelog; the header itself may still be drawn) was not confirmed by hand.
- The claim that scrolled-off lines are not re-rendered on theme or width change was read from the renderer's design and not observed.

Verified against pi-mono commit `a69bef789`.
