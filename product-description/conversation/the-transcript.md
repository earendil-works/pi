# The transcript

## Summary

The transcript is everything pi has drawn above the editor: each kind of message in its own style, status lines, warnings, errors, notices, and the collapsible boxes for tools, shell commands, and summaries. It grows into the terminal's scrollback and is rebuilt from the session when the active position changes. This document owns what each kind of thing looks like, what Ctrl+O expands, and how a response is copied. It has no interaction of its own beyond Ctrl+O, Ctrl+T, and copying; the events that add to the transcript are in the feature documents.

## The simple case

After one exchange the transcript shows, top to bottom: the header; a blank line; the user's prompt in a shaded box; a blank line; the assistant's answer as styled text with a code block indented two spaces and syntax-highlighted; a blank line; a one-line `read package.json` box with the success tint. Pressing Ctrl+O expands the box to show the file and prints `Tool output: expanded` as a dim status line; pressing it again collapses it. Ctrl+X copies the assistant's answer to the clipboard and prints `Copied last agent message to clipboard`.

## What each thing looks like

**User message.** A box in the user-message background colour, one column of padding (`outputPad`), the text rendered as markdown with the user-message text colour. Ordered-list numbers and backslash escapes are shown as typed. A prompt that invoked a skill is shown as a `[skill] <name> (Ctrl+O to expand)` box followed by the user's own text in a separate box.

**Assistant message.** Markdown rendered in place: headings bold and coloured, emphasis and strong, inline code, fenced code blocks indented by two spaces (`markdown.codeBlockIndent`) and syntax-highlighted by language, bullet and numbered lists, block quotes, tables, links (underlined; clickable in terminals that support hyperlinks), strikethrough, and LaTeX (`$…$`, `$$…$$`) rendered as Unicode. Mermaid code blocks are drawn as box-and-arrow diagrams in Unicode (`markdown.mermaid`: `streaming` draws as soon as the block parses, `final` only when the message is complete, `off` leaves the code). Thinking blocks come first, in italics in the thinking colour, or a single `Thinking...` line when hidden. A message that ended badly has a trailing line in the error colour: `Response was truncated before completion.`, `Operation aborted`, or `Error: <message>` (the last two only when the message has no tool calls; otherwise the tool boxes carry the error).

**Tool call box.** A tinted block: pending tint while the call is being described or is running, then success or error tint. The header names the tool and its main argument; the result is collapsed to a preview with `... (N more lines, Ctrl+O to expand)`. Details per tool are in [tool calls](tool-calls.md). Images in results are drawn inline where the terminal allows.

**Shell command box.** A green (or dim, for `!!`) bordered box with `$ <command>`, output, and a status; see [shell commands](shell-commands.md).

**Status line.** One dim line preceded by a blank line: `Model: claude-…`, `Thinking level: high`, `Tool output: expanded`, `Queued message for after compaction`, `Restored 2 queued messages to editor`. Consecutive status lines replace one another in place, so a burst of Shift+Tab presses leaves one line.

**Warning.** `Warning: <text>` in the warning colour, one column in. **Error.** `Error: <text>` in the error colour, `outputPad` columns in. Both are preceded by a blank line and are not replaced by later ones.

**Notice box.** A bordered box in the warning colour for `Update Available` (`New version 0.85.0 is available. Run pi update`, with a changelog link) and for package updates; the `What's New` changelog box after an upgrade.

**Compaction summary.** A `[compaction]` label with `Compacted from 150k tokens (Ctrl+O to expand)`; expanded, the summary as markdown in a shaded box. **Branch summary.** The same with `[branch]` and `Branch summary (Ctrl+O to expand)`.

**Cost notice.** With `showCacheMissNotices` on: `Compaction: 12k tokens billed (~$0.04)`, `Cache miss: 120k tokens re-billed (~$0.36)`, `Cache miss after model switch: …`, `Cache miss after 12m idle: …`; suppressed below 20,000 tokens and $0.10.

**Separators.** A blank line before every message and box. Nothing marks the start of a turn other than the user message.

## Ctrl+O, Ctrl+T, and copying

**Ctrl+O** toggles one global expanded state. Every tool box, shell command box, compaction and branch summary, skill box, and the startup header and loaded-resources block follow it, those already drawn and those drawn later; the status line says `Tool output: expanded` or `Tool output: collapsed`. Expanded tool boxes show their full (already truncated) result; `read` boxes show the file.

**Ctrl+T** hides or shows thinking; the whole transcript is rebuilt (status lines, warnings, and errors disappear in the rebuild) and the setting is saved. See [thinking](thinking.md).

**Copying.** Ctrl+X and `/copy` put the text of the last assistant message (its text blocks, not thinking or tool calls) on the system clipboard and print `Copied last agent message to clipboard`; with no assistant message yet, `Error: No agent messages to copy yet.` In `/tree`, Ctrl+X copies the selected entry instead. Text in the transcript can also be selected with the terminal's own selection.

> Technical note: the transcript is rendered into the terminal's normal screen, and lines that have scrolled above the visible area are the terminal's to keep. pi redraws only what is still on screen, so a theme change or a rebuild cannot restyle what has already scrolled off; the new rendering is appended below, and the terminal's scrollback keeps the old one. User and assistant messages carry invisible prompt markers (OSC 133) so terminals that support them can jump between prompts.

## Modifiers

| Modifier | Set before sending | Changed while working |
| --- | --- | --- |
| Model | No effect on rendering. | No effect. |
| Thinking level | More or less thinking text above answers. | Same, from the next call. |
| Agent busy | No effect. | The last assistant message and the pending tool boxes are the only things that change after being drawn. |
| Attachments | Images appear only inside `read` boxes. | No effect. |
| Session kind | No effect. | No effect. |

## Cancel and interrupt

| Event | Idle | While working |
| --- | --- | --- |
| Escape (once; twice within 500 ms) | No effect. | The streaming message gets its `Operation aborted` line; pending tool boxes turn to the error tint. |
| Ctrl+C once / twice; Ctrl+D | No effect; on quit the transcript is left on screen and the resume hint printed under it. | Same. |
| Another message submitted (Enter; Alt+Enter follow-up) | Adds a user message. | Adds a pending line, then a user message when delivered. |
| A slash command or shortcut that opens an overlay or changes the session | A session switch clears the screen below the header and redraws from the session; status lines and errors are gone. `/tree` rebuilds at the chosen branch. | Same, after aborting. |
| Model or thinking level changed | A status line. | A status line. |
| Provider error, rate limit, timeout, or network lost | Not applicable. | The status line counts down; an `Error:` line on final failure. |
| Context window exhausted (auto-compaction) | Not applicable. | A full rebuild with the `[compaction]` box in place of the summarised messages. |
| Terminal resized; pi suspended (Ctrl+Z) and resumed | On-screen lines re-wrap; scrolled-off lines do not. | Same. |
| Process ends: terminal closed (SIGHUP), SIGTERM, killed | The transcript stays in the terminal's scrollback as drawn. | Same. |
| Session or files changed from outside | No effect. | No effect. |
| Credentials lost, or logged out | No effect. | No effect. |

## Interactions with other systems

**Session persistence.** Messages, tool results, shell records, and summaries are redrawn from the session; status lines, warnings, errors, notices, and cost notices are not in the session and are lost on a rebuild or resume.

**Branching and history.** A rebuild shows the active branch only, with a `Session compacted N times` status when it applies.

**Compaction.** The rebuild after compaction and the `[compaction]` box.

**Context files and the system prompt.** The `[Context]` list under the header names the files found; `read resource <path>` boxes show when the model reads one.

**Settings and keybindings.** `outputPad`, `hideThinkingBlock`, `showCacheMissNotices`, `markdown.codeBlockIndent`, `markdown.mermaid`, `terminal.showImages`, `terminal.imageWidthCells`, `theme`; `app.tools.expand` (Ctrl+O), `app.thinking.toggle` (Ctrl+T), `app.message.copy` (Ctrl+X).

**Tools and the working directory.** Tool boxes; paths shown relative to the working directory where the tool makes them so.

**Terminal and rendering.** Colours from the theme; hyperlinks and prompt markers need terminal support; images need Kitty, Ghostty, or iTerm2; width decides wrapping. Syntax highlighting grammars load after startup, so the first code block may briefly be plain.

**Credentials and providers.** The `(sub)` marker in the footer, not the transcript.

## Edge cases

- Markdown in user messages is rendered too, so a prompt containing `*` or `_` may not look as typed; ordered lists keep their numbers.
- An unterminated code fence while streaming is rendered as an open code block that closes when the fence arrives.
- Tables wider than the terminal wrap cell text rather than scrolling.
- A mermaid diagram that fails to parse is shown as its source code.
- Errors and warnings use different indentation; with `outputPad` 0 they misalign.
- The `Tool output: expanded` status replaces a previous status line rather than stacking.
- Copying with the clipboard unavailable (no display, a remote shell without OSC 52) shows an error naming the failure.

## Open questions and verification

- Whether Ctrl+X copies thinking text along with the answer (read: text blocks only) was not confirmed by hand.
- Whether a rebuild after Ctrl+T preserves the expanded/collapsed state of boxes (read: yes, the global flag is reapplied) was not observed.
- The exact colour and weight of headings and links was not read from the markdown theme.
- Whether OSC 133 prompt markers are emitted for assistant messages that contain tool calls (read: no) changes nothing visible and was not checked.

Verified against pi-mono commit `a69bef789`.
