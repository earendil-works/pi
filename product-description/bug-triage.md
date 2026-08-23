# Bug triage

A consolidated list of the defects and inconsistencies that the feature documents raised in their "Open questions and verification" sections and in their bodies. Each entry is read from the pi-mono source at commit `a69bef789` and its tests; the four that have been confirmed in the running product by the scripted driver pass of 2026-08-23 carry a **Status** line. The list exists so the product team can decide, item by item, whether to fix, to document as intended, or to leave.

## Summary

The thirty-one documents flagged 58 items as suspected defects (the "may be worth treating as a bug" and "suspected" lines, the contradictions between documents, and the documentation mismatches). Seventeen of those were either shown by the code to be intended, were restatements of another document's item, or could not be pinned to a cause and stay in their documents as open questions (the last group is listed at the end). The remaining 41 merge by root cause into 36 entries: 7 high, 22 medium, 7 low. The largest cluster is the submit handler in `interactive-mode.ts` and the session-replacement path behind it: the same flat `if` chain lets built-in commands run mid-stream, sends unknown `/` lines and a bare `!` to the model, and drops the message queue on every switch (B-01 to B-05, B-08). The second cluster is the three cancellable background operations (compaction, auto-compaction, branch summary) that do not know about each other (B-07, B-08, B-10). The high entries have one thing in common: they happen while the agent is working, when the user is least able to see what the command did to the turn in progress.

| ID | Title | Severity | Area | Decision needed | Issue |
| --- | --- | --- | --- | --- | --- |
| B-01 | A `!` command started while the agent works disappears from the screen at the next queue change | high | conversation | fix | — |
| B-02 | A session switch drops queued messages without returning them to the editor | high | conversation | fix | — |
| B-03 | `/new`, `/clone`, `/compact`, `/resume`, `/import`, and `/quit` run mid-response with no confirmation | high | cross-cutting | product call | — |
| B-04 | A `/` line pi does not recognise is sent to the model as a prompt | high | cross-cutting | product call | — |
| B-05 | `/import` of a bad file, or a `/resume` that fails to open, exits pi with status 1 | high | sessions | fix | — |
| B-06 | Quitting mid-turn exits before the aborted message is written | high | sessions | fix | — |
| B-07 | `/compact` during a compaction or branch summary starts a second one; Escape cancels only the newer | high | sessions | fix | — |
| B-08 | Messages queued during a branch summary that is then cancelled are stuck in the pending area | medium | conversation | fix | — |
| B-09 | A bare `!` or `!!` is sent to the model as a prompt | medium | conversation | fix | — |
| B-10 | A `!` command run during a branch summary is recorded on the branch being abandoned | medium | conversation | fix | — |
| B-11 | Escape while the agent works does not reach a running `!` command | medium | conversation | product call | — |
| B-12 | A leftover queue after a turn that failed for good starts a fresh model call by itself | medium | conversation | product call | — |
| B-13 | Ctrl+P from a model outside the scope skips the scope's first model | medium | models | fix | — |
| B-14 | The thinking level stays `off` for good after passing through a non-reasoning model | medium | models | fix | — |
| B-15 | The model selector's highlight jumps back to the current model when the refresh finishes | medium | models | fix | — |
| B-16 | Escape in the login dialog prints `Error: Failed to login to <Name>: This operation was aborted` | medium | models | fix | — |
| B-17 | The API key is shown in plain text while it is typed | medium | models | product call | — |
| B-18 | `/logout` of the current model's provider leaves that model selected | medium | models | product call | — |
| B-19 | A session switch re-resolves the model and the scope from the startup options | medium | sessions | fix | — |
| B-20 | The `Could not restore model …` warning is never shown for an in-session switch | medium | sessions | fix | — |
| B-21 | A `/tree` move without a summary is not remembered across quit and resume | medium | sessions | product call | — |
| B-22 | Shift+L and Shift+T in the tree steal capital letters from the search | medium | sessions | fix | — |
| B-23 | Renaming the open session from the `/resume` picker does not reach the running session | medium | sessions | fix | — |
| B-24 | `/share` without `gh` installed says `GitHub CLI is not logged in` | medium | sessions | fix | — |
| B-25 | `/trust` demands a restart although `/reload` exists, and `/reload` keeps the run's trust | medium | settings | product call | — |
| B-26 | `/reload` saves `trusted` for the directory without asking when `.pi/` files appear mid-run | medium | settings | product call | — |
| B-27 | `pi --oops "Hello"` swallows the message as the value of an unknown flag | medium | startup | fix | — |
| B-28 | Ctrl+V on Termux inserts nothing although the docs promise `termux-clipboard-get` | medium | clipboard | fix | — |
| B-29 | Clipboard image temp files are never deleted | medium | clipboard | fix | — |
| B-30 | `/session` prints a `File:` path for a session whose file does not exist yet | low | sessions | fix | — |
| B-31 | The shell box hint says `escape/ctrl+c to cancel` but Ctrl+C does not cancel | low | conversation | fix | — |
| B-32 | The footer reads `unknown` when no provider has a credential | low | foundations | product call | — |
| B-33 | The final retry error is shown twice | low | cross-cutting | fix | — |
| B-34 | `Copied last agent message to clipboard` is reported over SSH whether or not OSC 52 was honoured | low | clipboard | product call | — |
| B-35 | Page Up and Page Down do nothing in the autocomplete popup | low | conversation | fix | — |
| B-36 | Small copy and rendering slips | low | various | fix | — |

## High

### B-01: A `!` command started while the agent works disappears from the screen at the next queue change

- **Where the user meets it:** The agent is working; the user runs `!git status` (or any shell command) to check something meanwhile, then queues a message with Enter, or a queued message is delivered.
- **What happens / what was expected:** The command's box is drawn in the pending area between the transcript and the editor. The first time the queue changes after that (a message queued, dequeued, or delivered), the pending area is cleared and rebuilt from the queue alone, and the box vanishes with whatever output it had. It comes back only when the user later submits a plain prompt with the agent idle, or when the transcript is rebuilt (resume, `/tree`, Ctrl+T). The record is in the session, so nothing is lost on disk; what is lost is the output the user ran the command to see. Expected: the box stays where it is and moves into the transcript when the turn ends.
- **Reproduce:** 1. Send a prompt that takes a while. 2. `!sleep 2; echo hi`. 3. Before the turn ends, type `x` and press Enter. The `$ sleep 2; echo hi` box is gone; it is absent until the next plain submit while idle.
- **Why (from the code):** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:6643-6651` adds the `BashExecutionComponent` to `pendingMessagesContainer` and to `pendingBashComponents` when `session.isStreaming`. `updatePendingMessagesDisplay()` at `interactive-mode.ts:4341-4358` starts with `this.pendingMessagesContainer.clear()` and re-adds only the steering and follow-up lines from `getAllQueuedMessages()`; it is called from the submit path (3141), from `message_start` for queued messages (3199), from dequeue (4120), and from the holding-queue path (4385). `flushPendingBashComponents()` at `interactive-mode.ts:4478-4485` is called only from the idle plain-submit path (3148), and `agent_end` (3367-3379) never touches `pendingBashComponents`. `renderCurrentSessionState` (2046-2055) clears the container on a session switch without resetting `pendingBashComponents`, so a stale box can later be flushed into another session's transcript.
- **Severity:** `high`. The output of a command the user ran on purpose is hidden with no hint, during the state in which the user most wants to see it.
- **Decision needed:** `fix`. Rebuild the pending area with the bash components kept (re-add `pendingBashComponents` after the queue lines), and move them into the transcript on `agent_end` as well as on the next submit.
- **Raised by:** [shell commands](conversation/shell-commands.md#open-questions-and-verification), [shell commands, Modifiers](conversation/shell-commands.md#modifiers), [busy state](cross-cutting/busy-state.md#the-matrix).

### B-02: A session switch drops queued messages without returning them to the editor

- **Where the user meets it:** Messages are queued behind a working turn (Enter or Alt+Enter); the user then runs `/new`, `/resume`, `/fork`, `/clone`, `/import`, or moves in `/tree`, or `/compact`.
- **What happens / what was expected:** The turn is aborted and the queued messages are gone: not sent, not in the editor, not in the session, and no status says so. Escape in the same situation aborts the turn and puts every queued message back into the editor, so the user expects the same from a switch. The holding queue behind a compaction is dropped the same way.
- **Reproduce:** 1. Send a long prompt. 2. Press Enter on `second`. 3. `/new`. `second` is nowhere.
- **Why (from the code):** Every switch goes through `AgentSessionRuntime.teardownCurrent` at `packages/coding-agent/src/core/agent-session-runtime.ts:166-177`, which calls `await this.session.abort()` then `this.session.dispose()`. `AgentSession.abort()` at `packages/coding-agent/src/core/agent-session.ts:1561-1565` only aborts the retry and the agent and waits for idle; the steering and follow-up queues die with the disposed session. The UI then runs `renderCurrentSessionState` at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2046-2055`, which clears `pendingMessagesContainer` and sets `compactionQueuedMessages = []`. The Escape path, by contrast, calls `restoreQueuedMessagesToEditor` at `interactive-mode.ts:4360-4379`, which reads the queues into the editor before aborting. None of the switch handlers (`handleClearCommand` 6529-6541, `handleResumeSession` 5357-5391, `/fork` 5129-5146, `handleCloneCommand` 5157-5176, `handleImportCommand` 6050-6092, `handleCompactCommand` 6688-6696) call it; tree navigation at 5238-5242 does, but only for the agent's queues while streaming, not the holding queue.
- **Severity:** `high`. Typed work is lost silently.
- **Decision needed:** `fix`. Call `restoreQueuedMessagesToEditor()` (and return the holding queue) before `teardownCurrent` in every switch handler, or show `Restored N queued messages to editor` as the dequeue path does.
- **Raised by:** [the message queue](conversation/the-message-queue.md#open-questions-and-verification), [new session](sessions/new-session.md#open-questions-and-verification), [compaction](sessions/compaction.md#open-questions-and-verification), [busy state](cross-cutting/busy-state.md#open-questions-and-verification), [the turn](foundations/the-turn.md#cancel-and-interrupt).

### B-03: `/new`, `/clone`, `/compact`, `/resume`, `/import`, and `/quit` run mid-response with no confirmation

- **Where the user meets it:** The agent is streaming a long answer or running tools; the user types one of the session-changing built-ins, or recalls one with Up from history and presses Enter.
- **What happens / what was expected:** The command runs at once. The turn is aborted, the partial message is kept in the old session, the queue is dropped (B-02), and the new session or the compaction begins, with nothing saying a turn was in progress. `/quit` exits at once. A user who expected the command to be queued as a follow-up (as every ordinary line is while working) or to be asked first finds the response gone. Only `/reload` refuses while streaming.
- **Reproduce:** 1. Send a prompt that takes a while. 2. Type `/new` and press Enter. The response stops and `✓ New session started` appears.
- **Why (from the code):** The submit handler at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2963-3155` is a flat `if` chain matched before the `isStreaming` branch at 3136: `/new` (3061-3065), `/clone` (3036-3040), `/compact` (3066-3071), `/resume` (3091-3095), `/quit` (3096-3102), `/import` (2997-3001; it confirms the import itself at 6058 but never mentions the turn). None check `this.session.isStreaming`. `/reload` alone guards at 5914-5921 (`Wait for the current response to finish before reloading.`).
- **Severity:** `high`. One common action (Enter on a command) both aborts a turn and switches sessions, silently.
- **Decision needed:** `product call`. Either (a) confirm when a turn is in progress (`A response is in progress. Abort it and start a new session?`), which costs one prompt in the rare case; or (b) refuse like `/reload` does, which makes the user press Escape first; or (c) keep the current behaviour and document it, in which case B-02 still needs fixing so the queue is not lost.
- **Raised by:** [busy state](cross-cutting/busy-state.md#open-questions-and-verification), [busy state, Edge cases](cross-cutting/busy-state.md#edge-cases), [quitting](sessions/quitting.md#cancel-and-interrupt), [new session](sessions/new-session.md#cancel-and-interrupt).

### B-04: A `/` line pi does not recognise is sent to the model as a prompt

- **Where the user meets it:** A typo (`/compcat`, `/quit now`), a command from another tool (`/exit`, `/clear`, `/help` is fine but `/h` is not), or a slash command with a trailing argument the built-in does not take.
- **What happens / what was expected:** Idle, the line starts a turn with that text; working, it is queued and delivered to the model as literal text. The model answers a line such as `/exit`, tokens are spent, and the user message is in the session. Expected: `Unknown command: /exit` and the text left in the editor, as other CLIs do.
- **Reproduce:** 1. Type `/exit`, Enter (with a credential). A user message `/exit` appears and the model answers.
- **Why (from the code):** The command chain in `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2963-3121` has no final "unknown command" branch. A `/` line that matches nothing reaches 3123-3155: the compaction holding-queue check, then `session.prompt(text, { streamingBehavior: "steer" })` while streaming, then the plain-submit path. Extension and template commands are resolved inside `session.prompt`, so the interactive layer cannot refuse a line there without first asking the session whether any command claims it.
- **Severity:** `high`. It affects every command (one typo away), spends a model call, and records the typo as a user message.
- **Decision needed:** `product call`. Refusing unknown `/` lines is the obvious behaviour, but any refusal has to leave room for prompts that legitimately begin with `/` (a path such as `/etc/hosts is wrong`). The fix would be to refuse when the first word matches `^/[a-z][a-z0-9-]*$` and no built-in, extension, prompt template, or skill claims it, and otherwise send; the alternative is to document that `/` is not reserved.
- **Raised by:** [busy state](cross-cutting/busy-state.md#open-questions-and-verification), [quitting](sessions/quitting.md#open-questions-and-verification), [busy state, Edge cases](cross-cutting/busy-state.md#edge-cases).

### B-05: `/import` of a bad file, or a `/resume` that fails to open, exits pi with status 1

- **Where the user meets it:** `/import ~/notes.txt` (a path that exists but is not a pi session), `/import` from a `--no-session` run, or a `/resume` pick whose file has become unreadable.
- **What happens / what was expected:** pi prints `Error: Failed to import session: Session file is not a valid pi session: …` (or a file-system error) and exits with code 1. The running session is left as it was on disk, but the screen, the queue, and anything unsaved are gone. Expected: the error line and the editor back, as for a missing file.
- **Reproduce:** 1. `echo hello > /tmp/x.jsonl`. 2. In pi, `/import /tmp/x.jsonl`, confirm. pi exits.
- **Why (from the code):** `handleImportCommand` at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:6086-6091` returns to the editor only for `SessionImportFileNotFoundError`; every other error goes to `handleFatalRuntimeError`, which at 2038-2044 prints the error, stops the TUI, and calls `process.exit(1)`. The invalid-file error is thrown in `SessionManager` at `packages/coding-agent/src/core/session-manager.ts:902-906`. `handleResumeSession` does the same at `interactive-mode.ts:5390` for anything other than a missing directory. In a `--no-session` run the session directory is `""` (`session-manager.ts:1569-1571`), so the import's `mkdirSync("")` at `packages/coding-agent/src/core/agent-session-runtime.ts:367-370` throws and takes the same fatal path.
- **Severity:** `high`. A typo in a path ends the session.
- **Decision needed:** `fix`. Treat import and resume errors like the not-found case: `showError` and return. The fatal path belongs to `/new` (no session can be created at all), not to a bad argument.
- **Raised by:** [export, import, and share](sessions/export-import-share.md#open-questions-and-verification), [resuming](sessions/resuming.md#open-questions-and-verification), [errors and retries](cross-cutting/errors-and-retries.md#crashes).

### B-06: Quitting mid-turn exits before the aborted message is written

- **Where the user meets it:** The agent is streaming or running a tool; the user presses Ctrl+C twice, Ctrl+D, or `/quit`, or the terminal sends SIGTERM or SIGHUP.
- **What happens / what was expected:** The quit signals an abort and exits without waiting for the turn to settle. The partial assistant message and the `Operation aborted` tool results, which the documents say are written, may never reach the session file; the file then ends on the user's prompt with no answer. The session-switch path, by contrast, waits for the abort to settle before replacing the session.
- **Reproduce:** 1. Send a prompt that streams a long answer. 2. Press Ctrl+C twice. 3. `pi -c` and check whether the aborted message is in the transcript.
- **Why (from the code):** `shutdown()` at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3926-3965` calls `this.stop()` and `await this.runtimeHost.dispose()` then `process.exit(0)`. `AgentSessionRuntime.dispose()` at `packages/coding-agent/src/core/agent-session-runtime.ts:398-405` awaits only the extension `session_shutdown` event and then calls `this.session.dispose()`, which at `packages/coding-agent/src/core/agent-session.ts:850-858` fires `this.agent.abort()` synchronously and returns. The message is persisted only when the stream settles and `message_end` reaches `sessionManager.appendMessage` at `agent-session.ts:650-668`, which is asynchronous. Compare `teardownCurrent` at `agent-session-runtime.ts:166-177`, whose comment says "Settle any active response first so the aborted turn (including tool results) is persisted" and which does `await this.session.abort()`.
- **Severity:** `high`. It loses the end of a turn, and two documents describe it as written.
- **Decision needed:** `fix`. `await this.session.abort()` (with a short cap) in `shutdown()` before `dispose()`, on both the interactive and the signal path. If the on-disk outcome turns out to be fine in practice, correct [the turn](foundations/the-turn.md) and [input](foundations/input.md) instead.
- **Raised by:** [quitting](sessions/quitting.md#open-questions-and-verification), [the turn](foundations/the-turn.md#open-questions-and-verification), [process lifecycle](cross-cutting/process-lifecycle.md#open-questions-and-verification).

### B-07: `/compact` during a compaction or branch summary starts a second one; Escape cancels only the newer

- **Where the user meets it:** A `/compact` is running (or a `/tree` move with `Summarize branch?` answered yes) and the user types `/compact` again, or chooses another `/tree` entry with a summary.
- **What happens / what was expected:** A second summary call starts alongside the first. Both run to the end and both append entries, in whichever order they finish; Escape aborts only the one started last, because its cancel handle replaced the first. Expected: `Error: Compaction already in progress`, or the second request queued behind the first.
- **Reproduce:** 1. In a long session, `/compact`. 2. While `Compacting…` shows, `/compact` again. 3. Press Escape. One `Compaction cancelled`; the other finishes and a `[compaction]` box appears.
- **Why (from the code):** `handleCompactCommand` at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:6688-6696` has no state check, and its dispatch at 3066-3071 sits above the `isCompacting` holding-queue branch at 3124, so it is never queued. `AgentSession.compact()` at `packages/coding-agent/src/core/agent-session.ts:1864-1867` does `await this.abort()` (which aborts only the agent) and then `this._compactionAbortController = new AbortController()`, orphaning the first controller; `abortCompaction()` at 2017-2020 aborts only the current one. `navigateTree` at `agent-session.ts:3034-3036` checks only `isStreaming` and at 3079 assigns `_branchSummaryAbortController` the same way. `isCompacting` (956-963) is the OR of the three controllers but neither method consults it.
- **Severity:** `high`. Two summaries are appended and one cannot be cancelled; the context after that is not what either summary described.
- **Decision needed:** `fix`. Refuse `compact()` and `navigateTree({summarize})` while `isCompacting` (`Compaction already in progress`), or abort the running one first and say so.
- **Raised by:** [compaction](sessions/compaction.md#open-questions-and-verification), [the tree](sessions/the-tree.md#open-questions-and-verification), [busy state](cross-cutting/busy-state.md#open-questions-and-verification).
