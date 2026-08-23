# Bug triage

A consolidated list of the defects and inconsistencies that the feature documents raised in their "Open questions and verification" sections and in their bodies. Each entry is read from the pi-mono source at commit `a69bef789` and its tests; the four that have been confirmed in the running product by the scripted driver pass of 2026-08-23 carry a **Status** line. The list exists so the product team can decide, item by item, whether to fix, to document as intended, or to leave.

## Summary

The thirty-one documents flagged 60 items as suspected defects (the "may be worth treating as a bug" and "suspected" lines, the contradictions between documents, and the documentation mismatches). Ten of those could not be pinned to a cause in the code, or turned out to be questions of intent rather than defects, and stay in their documents as open questions (they are listed at the end). The other 50 merge by root cause into 36 entries: 7 high, 22 medium, 7 low. The largest cluster is the submit handler in `interactive-mode.ts` and the session-replacement path behind it: the same flat `if` chain lets built-in commands run mid-stream, sends unknown `/` lines and a bare `!` to the model, and drops the message queue on every switch (B-01 to B-05, B-08). The second cluster is the three cancellable background operations (compaction, auto-compaction, branch summary) that do not know about each other (B-07, B-08, B-10). The high entries have one thing in common: they happen while the agent is working, when the user is least able to see what the command did to the turn in progress.

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

## Medium

### B-08: Messages queued during a branch summary that is then cancelled are stuck in the pending area

- **Where the user meets it:** The user chose a `/tree` entry with `Summarize branch?` answered yes, typed one or more messages while the summary ran (`Queued message for after compaction`), then pressed Escape.
- **What happens / what was expected:** `Branch summarization cancelled` and the tree reopens, but the queued messages stay in the pending area as `Steering: …` lines. Nothing sends them: they are released only by the next compaction or tree move that completes, and a session switch wipes them. Alt+Up pulls them back into the editor, which is the only way out. Expected: returned to the editor with the cancel, as Escape on a working turn does. (Note: the documents said the same of a cancelled compaction; that case is fine, because the compaction abort still emits `compaction_end`, which flushes the queue.)
- **Reproduce:** 1. `/tree`, pick an earlier entry, answer yes to `Summarize branch?`. 2. Type `hello`, Enter. 3. Press Escape. `Steering: hello` stays below the transcript.
- **Why (from the code):** Messages typed while `session.isCompacting` (which includes branch summarization, `packages/coding-agent/src/core/agent-session.ts:956-963`) go to `compactionQueuedMessages` via `queueCompactionMessage` at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4381-4387`. `flushCompactionQueue` (4399-4476) is called from `compaction_end` (3446) and from the tree-navigation success path (5282). In the tree handler at 5262-5283 the `result.aborted` branch (5263-5267) and the `result.cancelled` branch (5268-5271) return before 5282, and a branch summary emits no `compaction_end`, so nothing flushes. The extension `navigateTree` path at 1943-1953 has the same shape.
- **Severity:** `medium`. Recoverable with Alt+Up, but nothing says so and the messages look queued.
- **Decision needed:** `fix`. On `result.aborted` and `result.cancelled`, call `restoreQueuedMessagesToEditor()` for the holding queue (or flush it) before reopening the tree.
- **Raised by:** [the tree](sessions/the-tree.md#open-questions-and-verification), [compaction](sessions/compaction.md#open-questions-and-verification), [busy state](cross-cutting/busy-state.md#open-questions-and-verification).

### B-09: A bare `!` or `!!` is sent to the model as a prompt

- **Where the user meets it:** The user types `!` to enter bash mode (the border turns green), changes their mind, and presses Enter; or leaves `! ` with only spaces.
- **What happens / what was expected:** The line falls through to ordinary submission and the literal text `!` is sent to the model as a prompt, starting a turn (with no credential, the `No API key` error shows that the model path was taken). Expected: nothing happens, or the editor is cleared, as Escape does in bash mode.
- **Reproduce:** 1. Type `!`, Enter.
- **Why (from the code):** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3106-3121`: `if (text.startsWith("!"))` strips the prefix and trims; the body runs only `if (command)`, and there is no `return` for the empty case, so control continues to the prompt paths at 3123-3155. The editor's border colour is set separately at 2905-2911 from `text.trimStart().startsWith("!")`, which is why the editor looked like bash mode.
- **Severity:** `medium`. It starts a turn the user did not mean to start and records `!` as a user message; cheap to hit.
- **Decision needed:** `fix`. `return` after clearing the editor (and leaving bash mode) when `command` is empty.
- **Raised by:** [shell commands](conversation/shell-commands.md#open-questions-and-verification), [shell commands, Resolves at once](conversation/shell-commands.md#resolves-at-once), [shell commands, Edge cases](conversation/shell-commands.md#edge-cases).
- **Status:** Confirmed 2026-08-23 by the scripted driver pass against `a69bef789` (SHELL-06, and TURN-01's note): with no credential, a bare `!` produced `Error: No API key found for the selected model.`, the model path.

### B-10: A `!` command run during a branch summary is recorded on the branch being abandoned

- **Where the user meets it:** The user chose a `/tree` entry with a summary, and while `Summarizing branch…` runs, executes a `!` command.
- **What happens / what was expected:** The agent is not streaming, so the command's record is appended immediately, as a child of the current leaf, which is the branch the navigation is about to leave. When the summary finishes the active position moves elsewhere, and the record is stranded on the old branch: the model does not see it, and `/tree` shows it under the abandoned entry. Expected: the record follows the user to the new position, as it does during a streaming turn (where it is deferred to `agent_end`).
- **Reproduce:** 1. `/tree`, pick an entry, yes to summary. 2. `!echo hi` during the summary. 3. When the move completes, `/tree` with the `all` filter: `[bash]: echo hi` is under the old leaf.
- **Why (from the code):** `recordBashResult` at `packages/coding-agent/src/core/agent-session.ts:2951-2961` defers only `if (this.isStreaming)`; otherwise it pushes to `agent.state.messages` and calls `sessionManager.appendMessage` at once. `navigateTree` captures `oldLeafId` at 3038 and moves the leaf only after the summary, at 3186-3194, so during the summary the leaf is still the outgoing branch. The agent's message list is then rebuilt from the session context at 3201-3202, which drops the record.
- **Severity:** `medium`. Wrong in an uncommon path; the record is not lost, only misplaced.
- **Decision needed:** `fix`. Defer bash records while `isCompacting` as well as while streaming, and flush them when the navigation or compaction ends.
- **Raised by:** [busy state](cross-cutting/busy-state.md#open-questions-and-verification).

### B-11: Escape while the agent works does not reach a running `!` command

- **Where the user meets it:** A `!sleep 60` is running and the agent is also working (the command was started before the prompt, or during it). The user presses Escape to stop the command.
- **What happens / what was expected:** Escape aborts the agent's turn and leaves the command running; a second Escape is needed for the command. During a retry countdown or a compaction, Escape cancels that instead and the command cannot be reached at all. The box's own hint says `escape/ctrl+c to cancel` (B-31). Expected by most users: Escape cancels the thing that is visibly running; at least, the hint should say what Escape will do.
- **Reproduce:** 1. `!sleep 60`. 2. Send a prompt. 3. Press Escape once: the turn aborts, the spinner in the shell box keeps going.
- **Why (from the code):** The editor's Escape handler at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2855-2868` is a single `if / else if` chain: `isStreaming` (abort agent) before `isBashRunning` (abort bash). `compaction_start` (3391-3393) and `auto_retry_start` (3453-3456) replace `onEscape` wholesale with `abortCompaction` / `abortRetry`, so neither branch is reachable in those states.
- **Severity:** `medium`. Recoverable with a second press; surprising during retries and compaction.
- **Decision needed:** `product call`. Either Escape cancels both the turn and the command (simple, but a user who wanted only the turn loses the command), or the order stays and the shell box hint reads `escape to cancel (after the response)` while the command is running alongside a turn.
- **Raised by:** [shell commands](conversation/shell-commands.md#open-questions-and-verification), [shell commands, Cancel and interrupt](conversation/shell-commands.md#cancel-and-interrupt).

### B-12: A leftover queue after a turn that failed for good starts a fresh model call by itself

- **Where the user meets it:** Messages were queued (Enter or Alt+Enter) during a turn; the turn then fails after its retries, or the user cancels the retry countdown with Escape.
- **What happens / what was expected:** `Error: Retry failed after N attempts: …` is printed, and then, with no further action, a new model call starts with the queued messages as the prompt. The user expected either the queue returned to the editor (as an Escape abort does) or nothing until the next Enter.
- **Reproduce:** 1. Send a prompt with the network off. 2. Queue `second` with Enter. 3. Let the three retries fail (about 14 s). A new turn with `second` starts at once and fails the same way.
- **Why (from the code):** `_runAgentPrompt` at `packages/coding-agent/src/core/agent-session.ts:1074-1084` loops `while (await this._handlePostAgentRun()) await this.agent.continue()`. `_handlePostAgentRun` (1088-1116) ends with `return this.agent.hasQueuedMessages()` under a comment that says the loop drains the queues before `agent_end`, but the loop at `packages/agent/src/agent-loop.ts:196-200` returns at once on `stopReason === "error"` without draining. `agent.continue()` at `packages/agent/src/agent.ts:371-382` then drains the steering queue into `runPromptMessages`. The `agent_end` handler in the UI (`interactive-mode.ts:3367-3379`) neither clears nor restores the queue.
- **Severity:** `medium`. A turn starts that the user did not start, but it is visible and can be aborted.
- **Decision needed:** `product call`. Delivering the queue is defensible ("the user wanted these sent"); returning it to the editor matches Escape. Either way the comment in `_handlePostAgentRun` is wrong for the error path and the behaviour should be chosen rather than inherited.
- **Raised by:** [the message queue](conversation/the-message-queue.md#open-questions-and-verification), [errors and retries](cross-cutting/errors-and-retries.md#provider-errors-mid-turn), [busy state, Edge cases](cross-cutting/busy-state.md#edge-cases).

### B-13: Ctrl+P from a model outside the scope skips the scope's first model

- **Where the user meets it:** A model scope is set (`/scoped-models` or `enabledModels`), and the current model is not in it (picked from the all list with `/model`, or the scope was edited around it). The user presses Ctrl+P.
- **What happens / what was expected:** The second model of the scope is selected; the first is unreachable on that press (and Shift+Ctrl+P goes to the last). Expected: the first.
- **Reproduce:** 1. Scope two models A and B. 2. `/model C` from the all list. 3. Ctrl+P: B is selected, not A.
- **Why (from the code):** `_cycleScopedModel` at `packages/coding-agent/src/core/agent-session.ts:1648-1653`: `findIndex` returns `-1`, `if (currentIndex === -1) currentIndex = 0;`, then `nextIndex = (currentIndex + 1) % len`. The unscoped path `_cycleAvailableModel` at 1683-1688 has the same arithmetic (reachable only if the current model is not in the available list).
- **Severity:** `medium`. Wrong result in an uncommon path.
- **Decision needed:** `fix`. When the current model is not in the list, go to index `0` forward and `len - 1` backward.
- **Raised by:** [cycling models](models/cycling-models.md#open-questions-and-verification), [cycling models, Edge cases](models/cycling-models.md#edge-cases).

### B-14: The thinking level stays `off` for good after passing through a non-reasoning model

- **Where the user meets it:** No `defaultThinkingLevel` is saved. The user is at `medium`, cycles (Ctrl+P or `/model`) to a model that cannot reason, then on to one that can.
- **What happens / what was expected:** The footer shows `thinking off` on the reasoning model and stays there on every later switch until the user sets a level by hand. Expected: the level the user had before (`medium`) comes back, or the model's own default.
- **Reproduce:** 1. Ctrl+P to a non-reasoning model. 2. Ctrl+P to a reasoning model. Footer: `• thinking off`.
- **Why (from the code):** `_getThinkingLevelForModelSwitch` at `packages/coding-agent/src/core/agent-session.ts:1773-1785` falls back to `this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel ?? DEFAULT_THINKING_LEVEL`. `setThinkingLevel` at 1716-1724 clamps the level to the target model's range and writes the clamped value back into `agent.state.thinkingLevel`; `_clampThinkingLevel` (1786-1788) yields `off` for a model with no reasoning. After one non-reasoning hop, `this.thinkingLevel` is `off` and every later switch inherits it.
- **Severity:** `medium`. Silently changes what the next call does; easy to miss in the footer.
- **Decision needed:** `fix`. Remember the last level the user chose (`_requestedThinkingLevel`) separately from the clamped effective level, and fall back to that.
- **Raised by:** [cycling models](models/cycling-models.md#open-questions-and-verification).

### B-15: The model selector's highlight jumps back to the current model when the refresh finishes

- **Where the user meets it:** Ctrl+L, then Down a few times within the first second, then Enter.
- **What happens / what was expected:** If the background catalogue refresh completes between the Down presses and the Enter, the highlight snaps back to the current model and Enter re-selects it. Expected: the highlight stays where the user put it.
- **Reproduce:** 1. Ctrl+L. 2. Down, Down, quickly. 3. Watch the highlight when `Model catalogs refreshed.` appears.
- **Why (from the code):** `refreshModels` at `packages/coding-agent/src/modes/interactive/components/model-selector.ts:202-203` calls `loadModelsFromSnapshot()` then `filterModels(query)`. `loadModelsFromSnapshot` at 173-175 sets `selectedIndex` to the current model's index whenever it is found; `filterModels` at 295 keeps it when the query is empty.
- **Severity:** `medium`. Picks a different model from the one the user had highlighted, in the first second after opening.
- **Decision needed:** `fix`. On refresh, re-find the previously highlighted model in the rebuilt list and keep it; fall back to the current model only if it is gone.
- **Raised by:** [the model selector](models/the-model-selector.md#open-questions-and-verification), [the model selector, While open](models/the-model-selector.md#while-open).

### B-16: Escape in the login dialog prints `Error: Failed to login to <Name>: This operation was aborted`

- **Where the user meets it:** `/login`, choose a provider, then Escape (or Ctrl+C) while the dialog waits for the browser or for a key.
- **What happens / what was expected:** An error line in the error colour reporting a failed login, though the user cancelled. Expected: nothing, or a dim `Login cancelled`.
- **Reproduce:** 1. `/login`, `Sign in with an account`, pick a provider. 2. Press Escape while the URL is shown.
- **Why (from the code):** The `/login` handler at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5897-5905` suppresses the error only when `errorMsg === "Login cancelled"`. The dialog's own completion message (`login-dialog.ts:83-91` calls `onComplete(false, "Login cancelled")`) is discarded: the callback passed at `interactive-mode.ts:5878` is `(_success, _message) => {}` (and 5749-5755 for the API-key flow). The rejection the handler actually sees comes from the abort signal handed to the provider flow at 5863-5871: an in-flight `fetch` rejects with the DOMException text `This operation was aborted` (for example `packages/ai/src/auth/oauth/github-copilot.ts:273-288`), and `packages/ai/src/auth/helpers.ts:13-15` rethrows `signal.reason`. Only some providers translate it (`openrouter.ts:85`, `github-copilot.ts:440`).
- **Severity:** `medium`. Wrong message for a normal action; harmless otherwise.
- **Decision needed:** `fix`. Treat `dialog.signal.aborted` as a cancel in the handler regardless of the error text.
- **Raised by:** [login and logout](models/login-and-logout.md#open-questions-and-verification), [input](foundations/input.md#open-questions-and-verification).

### B-17: The API key is shown in plain text while it is typed

- **Where the user meets it:** `/login`, `Sign in with an API key`, pick a provider, paste or type the key.
- **What happens / what was expected:** The key is echoed character by character, and after Enter the dialog prints it again as `> sk-…`. A user sharing a screen or recording a session expected masking, as the provider's prompt type (`secret`) suggests.
- **Reproduce:** 1. `/login anthropic`, choose the API-key method. 2. Type anything.
- **Why (from the code):** `showPrompt` in `packages/coding-agent/src/modes/interactive/components/login-dialog.ts:154-176` uses the plain `Input` for every prompt type, including `{ type: "secret" }` (`packages/ai/src/auth/helpers.ts:14`); `packages/tui/src/components/input.ts:378-393` renders `this.value` verbatim, and `login-dialog.ts:77-81` echoes the submitted value.
- **Severity:** `medium`. A secret on screen; no data is lost and nothing else breaks.
- **Decision needed:** `product call`. Masking (`•`) hides typos in a long key; showing it is what many CLIs do. A middle path is to mask while typing and not echo after Enter.
- **Raised by:** [login and logout](models/login-and-logout.md#open-questions-and-verification).

### B-18: `/logout` of the current model's provider leaves that model selected

- **Where the user meets it:** The footer shows `anthropic/claude-…`; the user runs `/logout` and removes the Anthropic credential.
- **What happens / what was expected:** `Logged out of Anthropic`, the footer is unchanged, and the next prompt fails with `Error: No API key found for the selected model.` Expected: the footer switches to another available model (as `/login` selects one when none was selected), or reads `unknown`, or at least a status says the current model is now unusable.
- **Reproduce:** 1. With one credential, `/logout` it. 2. Send `hi`.
- **Why (from the code):** The logout success path at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5617-5625` calls `modelRuntime.logout`, `updateAvailableProviderCount()`, and `showStatus`; nothing touches `session.setModel`, the footer, or the availability of the selected model. The login path (`completeProviderAuthentication`, 5643-5700) does select a model when none is selected, so the two are asymmetric.
- **Severity:** `medium`. Recoverable at the next prompt's error; inconsistent with `/login`.
- **Decision needed:** `product call`. Either switch to the first still-available model with a `Model: …` status (the user may not want an implicit switch), or keep the model and warn `Current model's provider is no longer configured`.
- **Raised by:** [models and credentials](foundations/models-and-credentials.md#open-questions-and-verification), [login and logout](models/login-and-logout.md#open-questions-and-verification), [the screen](foundations/the-screen.md#cancel-and-interrupt).

### B-19: A session switch re-resolves the model and the scope from the startup options

- **Where the user meets it:** The user picked a model for this session with `/model` or Ctrl+P (without Ctrl+S), or edited the scope in `/scoped-models`, then runs `/new`, `/resume`, `/clone`, `/import`, or `/fork` from the first message of a session.
- **What happens / what was expected:** The new session starts on the saved default model (or the first available), not the one in the footer a moment ago, and the scope is rebuilt from the `--models` flag and `enabledModels` as they were at startup, discarding in-session scope edits (even after Ctrl+S in `/scoped-models`, whose save is read only at the next resolution). [Models and credentials](foundations/models-and-credentials.md) says `/new` keeps the current model and level; the code does not. Forking from the first message goes through the same plain new-session path, while forking from any later message restores the model recorded on the copied branch.
- **Reproduce:** 1. `/model` to a model that is not the saved default. 2. `/new`. Footer: the default model.
- **Why (from the code):** Every replacement calls the `createRuntime` factory built in `packages/coding-agent/src/main.ts:710-716`, which at 785-788 recomputes `scopedModels` from `parsed.models ?? settingsManager.getEnabledModels()` and at 813-826 passes `model: sessionOptions.model` (derived from the CLI arguments, not from the live session). `createAgentSession` at `packages/coding-agent/src/core/sdk.ts:194-226` then restores the model from the session file if it has one, else `findInitialModel`. `newSession` at `packages/coding-agent/src/core/agent-session-runtime.ts:226-250` builds an empty `SessionManager` and so has nothing to restore from; `fork` at 262-312 takes the same branch when `targetLeafId` is null (first message of a root). In-session scope edits only mutate the session (`interactive-mode.ts:5025-5032`).
- **Severity:** `medium`. Silently different model from the one shown; recoverable with one `/model`.
- **Decision needed:** `fix`. Pass the current session's model, thinking level, and scoped models into `createRuntime` for `/new` and the null-parent fork (the resume and later-fork paths already restore from the file). Then correct whichever document is wrong.
- **Raised by:** [new session](sessions/new-session.md#open-questions-and-verification), [cycling models](models/cycling-models.md#open-questions-and-verification), [fork and clone](sessions/fork-and-clone.md#open-questions-and-verification), [models and credentials](foundations/models-and-credentials.md#interactions-with-other-systems).

### B-20: The `Could not restore model …` warning is never shown for an in-session switch

- **Where the user meets it:** `/resume`, `/fork`, or `/clone` into a session whose recorded model is no longer available (credential removed, model withdrawn from the catalogue).
- **What happens / what was expected:** The session opens on a fallback model with no message; only the footer shows the change. At startup the same situation prints `Warning: Could not restore model <provider>/<id>. Using <provider>/<id>`.
- **Reproduce:** 1. Save a session on provider A. 2. `/logout` A. 3. `/resume` that session. No warning; the footer shows another model.
- **Why (from the code):** `createAgentSession` computes `modelFallbackMessage` at `packages/coding-agent/src/core/sdk.ts:195-225`; the runtime stores it at `packages/coding-agent/src/core/agent-session-runtime.ts:180-186` and exposes it at 113-115. The only reader is the startup path at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1127-1153`; `grep modelFallbackMessage` finds no use in the switch handlers.
- **Severity:** `medium`. Inconsistent between startup and in-session; the silent fallback can send the next prompt to a different model than expected.
- **Decision needed:** `fix`. After `runtimeHost.switchSession` / `fork`, read `runtimeHost.modelFallbackMessage` and `showWarning` it.
- **Raised by:** [resuming](sessions/resuming.md#open-questions-and-verification), [fork and clone](sessions/fork-and-clone.md#open-questions-and-verification), [errors and retries](cross-cutting/errors-and-retries.md#open-questions-and-verification).

### B-21: A `/tree` move without a summary is not remembered across quit and resume

- **Where the user meets it:** The user moves back to an earlier point with `/tree` and answers no to `Summarize branch?`, continues for a while without sending anything (or quits right away), and later resumes.
- **What happens / what was expected:** The resumed session is at the last entry in the file, not at the point chosen; the move is forgotten. A move with a summary sticks, because the summary entry is appended under the target. Users expect `/tree` to "stick".
- **Reproduce:** 1. In a session with several turns, `/tree`, choose the first assistant message, no summary. 2. `/quit`, `pi -c`. The transcript is the full session.
- **Why (from the code):** `navigateTree` at `packages/coding-agent/src/core/agent-session.ts:3186-3194` calls `sessionManager.branch(newLeafId)` (or `resetLeaf()`), which at `packages/coding-agent/src/core/session-manager.ts:1360-1374` only sets the in-memory `leafId`. Nothing is appended. On load, `_buildIndex` at `session-manager.ts:958-966` sets `leafId` to the last entry in file order. The file is append-only and has no "current position" entry.
- **Severity:** `medium`. The next prompt after resume goes to the wrong branch, but the user can move again.
- **Decision needed:** `product call`. Appending a position-marker entry makes moves stick at the cost of a new entry type every reader must skip; leaving the tree as a view is simpler but should be said in the `/tree` hint (`move is not saved until the next message`).
- **Raised by:** [the tree](sessions/the-tree.md#open-questions-and-verification), [the tree, Edge cases](sessions/the-tree.md#edge-cases).

### B-22: Shift+L and Shift+T in the tree steal capital letters from the search

- **Where the user meets it:** `/tree`, then typing a search that contains a capital `L` or `T` (`Tests`, `LLM`).
- **What happens / what was expected:** `T` toggles label timestamps and `L` opens the label editor on the highlighted entry; the letter never reaches the search. Lower-case letters search. Expected: typing searches; the bound keys should not swallow printable characters once a search has begun.
- **Reproduce:** 1. `/tree`. 2. Type `LLM`. The label editor opens.
- **Why (from the code):** `packages/coding-agent/src/modes/interactive/components/tree-selector.ts:1084-1100`: `app.tree.editLabel` (default `shift+l`) and `app.tree.toggleLabelTimestamp` (`shift+t`) are matched in the `else if` chain before the final `else` that appends printable input to `searchQuery`.
- **Severity:** `medium`. Inconsistent with every other search box; two common capitals cannot be typed.
- **Decision needed:** `fix`. Give the two actions non-printable defaults (Ctrl+L is taken; Alt+L / Alt+T, or F-keys), or only match them while `searchQuery` is empty.
- **Raised by:** [the tree](sessions/the-tree.md#open-questions-and-verification), [the tree, Edge cases](sessions/the-tree.md#edge-cases).

### B-23: Renaming the open session from the `/resume` picker does not reach the running session

- **Where the user meets it:** `/resume`, highlight the session pi is in, rename it with the picker's rename key.
- **What happens / what was expected:** The name is written to the file, but the footer and `/session` keep the old name until the session is resumed again, and the next `/name` or session-info entry pi writes from memory may sit after the picker's entry. Expected: the footer updates, as `/name` does.
- **Reproduce:** 1. `/name one`. 2. `/resume`, highlight the current session, rename to `two`, Escape. Footer still says `one`.
- **Why (from the code):** The picker's `renameSession` callback at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5341-5346` opens a second `SessionManager` on the path (`SessionManager.open(sessionFilePath)`) and appends the name there; it never compares the path with `this.session.sessionFile` or calls `this.session.setSessionName`.
- **Severity:** `medium`. Inconsistent between `/name` and the picker; recoverable.
- **Decision needed:** `fix`. If the renamed path is the current session's file, call `this.session.setSessionName(next)` instead of opening a second manager.
- **Raised by:** [resuming](sessions/resuming.md#open-questions-and-verification).

### B-24: `/share` without `gh` installed says `GitHub CLI is not logged in`

- **Where the user meets it:** `/share` on a machine without the GitHub CLI.
- **What happens / what was expected:** `Error: GitHub CLI is not logged in. Run 'gh auth login' first.`; following that advice fails with `command not found`. Expected: `GitHub CLI (gh) is not installed. Install it from https://cli.github.com/`, which is in the code but unreachable.
- **Reproduce:** 1. `PATH=/usr/bin pi` (no `gh`). 2. `/share`.
- **Why (from the code):** `packages/coding-agent/src/modes/interactive/interactive-mode.ts:6108-6117`: `spawnSync("gh", ["auth", "status"])` does not throw when the executable is missing; it returns a result with `status === null` and an `error` field. The `status !== 0` check catches that and prints the not-logged-in message; the `catch` with the not-installed message never runs.
- **Severity:** `medium`. Wrong diagnosis in an uncommon path.
- **Decision needed:** `fix`. Check `authResult.error?.code === "ENOENT"` first.
- **Raised by:** [export, import, and share](sessions/export-import-share.md#open-questions-and-verification).

### B-25: `/trust` demands a restart although `/reload` exists, and `/reload` keeps the run's trust

- **Where the user meets it:** An untrusted project; the user runs `/trust`, chooses `Trust`, and reads `Saved trust decision: trusted. Restart pi for this to take effect.` They try `/reload` instead.
- **What happens / what was expected:** `/reload` reloads extensions, skills, and settings for the trust state the run started with; the project's `.pi/` files stay ignored. The user expected `/reload` to pick up the decision they just saved, given that it re-reads everything else.
- **Reproduce:** 1. In an untrusted project with `.pi/settings.json`, `/trust`, `Trust`. 2. `/reload`. The project settings are still ignored.
- **Why (from the code):** The status text is at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4946-4951`. `/reload` calls `session.reload()` (5967) → `packages/coding-agent/src/core/agent-session.ts:2740-2743` → `resource-loader.ts:396-403`, which re-resolves trust only `if (options?.resolveProjectTrust)`, and that option is not passed; `settings-manager.ts:534` reloads project settings for the unchanged `projectTrusted`. `trust.json` is read only in the runtime factory at `packages/coding-agent/src/main.ts:719-730`.
- **Severity:** `medium`. Inconsistent between two features that should match; a restart works.
- **Decision needed:** `product call`. Either `/reload` re-resolves trust from `trust.json` (then `/trust` can say `then /reload`), or the split is deliberate (trust is a startup decision) and `/reload`'s status should say `project trust unchanged`.
- **Raised by:** [project trust](settings/project-trust.md#open-questions-and-verification), [reload and hotkeys](settings/reload-and-hotkeys.md#open-questions-and-verification).

### B-26: `/reload` saves `trusted` for the directory without asking when `.pi/` files appear mid-run

- **Where the user meets it:** A project with no `.pi/` directory at startup (so no trust question was asked). During the run, a tool call, a `git pull`, or a clone creates `.pi/extensions/…`. The user runs `/reload`.
- **What happens / what was expected:** The new extensions are loaded and `trust.json` gains `true` for the directory; the status ends with `; saved project trust`. The user never answered a trust question. The code treats this as the user's own creation; when a model wrote the files, it is the model trusting itself.
- **Reproduce:** 1. Start pi in a directory without `.pi/`. 2. `!mkdir -p .pi/extensions && echo 'export default () => {}' > .pi/extensions/x.ts`. 3. `/reload`.
- **Why (from the code):** `maybeSaveImplicitProjectTrustAfterReload` at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4910-4933`, key line 4925 `trustStore.set(cwd, true)`, called at 5983; eligibility is set at `packages/coding-agent/src/main.ts:699-702` (`autoTrustOnReloadCwd` when the cwd had no trust-requiring resources at startup).
- **Severity:** `medium`. A security-relevant decision taken implicitly; the user can undo it with `/trust`.
- **Decision needed:** `product call`. Either show the trust question on `/reload` when resources appeared (one prompt, once), or keep the implicit save but say `project trusted (files appeared during this run)` loudly rather than as a status suffix.
- **Raised by:** [project trust](settings/project-trust.md#open-questions-and-verification), [reload and hotkeys](settings/reload-and-hotkeys.md#sent).

### B-27: `pi --oops "Hello"` swallows the message as the value of an unknown flag

- **Where the user meets it:** A mistyped long option, or the removed `--ui-mode`, followed by a message.
- **What happens / what was expected:** pi starts idle; the message is gone and nothing is said. A single-dash unknown (`-x`) fails with `Unknown option: -x`. Expected: the same error for `--oops`, or at least the message kept.
- **Reproduce:** 1. `pi --oops "Hello"`. pi starts; no prompt is sent.
- **Why (from the code):** `packages/coding-agent/src/cli/args.ts:227-240`: any `--name` not matched earlier becomes an extension flag, and the next argument is taken as its value when it does not start with `-` or `@`. The error for single-dash unknowns is at 241-242. No diagnostic is raised for a double-dash flag that no extension later claims.
- **Severity:** `medium`. Silent loss of the first prompt in an uncommon case.
- **Decision needed:** `fix`. After extensions load, report unknown `--` flags no extension registered (`Unknown option: --oops`) and, if a value was consumed, put it back as a message; or only consume a value when the extension declared the flag as taking one.
- **Raised by:** [launching pi](startup/launching-pi.md#open-questions-and-verification), [launching pi, Edge cases](startup/launching-pi.md#edge-cases).

### B-28: Ctrl+V on Termux inserts nothing although the docs promise `termux-clipboard-get`

- **Where the user meets it:** pi on Termux; Ctrl+V to paste text.
- **What happens / what was expected:** Nothing is inserted. Ctrl+X does write the clipboard with `termux-clipboard-set`, and `docs/termux.md` says both directions use the Termux tools.
- **Reproduce:** 1. On Termux, copy text in another app. 2. Ctrl+V in pi.
- **Why (from the code):** `readClipboardText` at `packages/coding-agent/src/utils/clipboard.ts:52-71` tries `wl-paste` on Wayland, then the native binding, and returns `null`; the binding is not built for Termux. The write path at 114-121 has the `termux-clipboard-set` branch. `packages/coding-agent/docs/termux.md:31` claims `termux-clipboard-get`.
- **Severity:** `medium`. A feature missing on one platform that the docs say exists.
- **Decision needed:** `fix`. Add a `termux-clipboard-get` branch to `readClipboardText`, mirroring the write path.
- **Raised by:** [clipboard](cross-cutting/clipboard.md#open-questions-and-verification), [the terminal](cross-cutting/the-terminal.md#termux).

### B-29: Clipboard image temp files are never deleted

- **Where the user meets it:** Every Ctrl+V of an image writes `pi-clipboard-<uuid>.png` to the system temp directory; over weeks of use they accumulate, and an orderly quit does not remove them.
- **What happens / what was expected:** The files stay until the OS cleans the temp directory. Expected: removed when the session ends, or at least when the message that referenced them has been sent.
- **Reproduce:** 1. Ctrl+V an image, send. 2. `/quit`. 3. `ls $TMPDIR/pi-clipboard-*`.
- **Why (from the code):** `handleClipboardPaste` at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2934-2947` writes the file; `pi-clipboard-` appears nowhere else in the source, so nothing unlinks it. The WSL helper in `packages/coding-agent/src/utils/clipboard-image.ts:162-208` does clean up its own intermediate file.
- **Severity:** `medium`. A leak the user discovers late; nothing else breaks.
- **Decision needed:** `fix`. Track the paths for the run and delete them in `shutdown()`; or write under `~/.pi/agent/tmp` and prune on startup.
- **Raised by:** [clipboard](cross-cutting/clipboard.md#open-questions-and-verification), [process lifecycle](cross-cutting/process-lifecycle.md#open-questions-and-verification), [attachments](conversation/attachments.md#open-questions-and-verification).

## Low

### B-30: `/session` prints a `File:` path for a session whose file does not exist yet

- **Where the user meets it:** `/session` before the first assistant message (a fresh session, or one where every prompt failed).
- **What happens / what was expected:** `File: ~/.pi/agent/sessions/--…--/2026-…_<uuid>.jsonl` is printed, with no hint that the file has not been created; a user who copies the path finds nothing. Expected: `File: (not saved yet)` or the path with a `(not yet written)` note; `In-memory` is already used for `--no-session`.
- **Reproduce:** 1. Fresh home, `--no-env`. 2. `/session`. A path is printed; `ls` shows the directory empty.
- **Why (from the code):** `handleSessionCommand` at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:6330` prints `stats.sessionFile ?? "In-memory"`. The path is assigned when the session is created (`packages/coding-agent/src/core/session-manager.ts:951-955`), but `_persist` at `session-manager.ts:1015-1042` writes nothing until an assistant message exists, so the file does not exist yet.
- **Severity:** `low`. A copy slip with a small trap.
- **Decision needed:** `fix`. Print the path with `(not written yet)` when `!existsSync(stats.sessionFile)`.
- **Raised by:** [naming and info](sessions/naming-and-info.md#open-questions-and-verification), [sessions](foundations/sessions.md#the-session-model).
- **Status:** Confirmed 2026-08-23 by the scripted driver pass against `a69bef789` (fresh home, no credential, 100×40): `/session` printed a `File:` path (TURN-01's `/session` step) while the sessions directory was empty (SESS-01).

### B-31: The shell box hint says `escape/ctrl+c to cancel` but Ctrl+C does not cancel

- **Where the user meets it:** Any running `!` command: the spinner line reads `Running... (escape/ctrl+c to cancel)`.
- **What happens / what was expected:** Ctrl+C clears the editor (and, twice, quits pi); the command keeps running. Only Escape cancels it. Expected: the hint names the key that works.
- **Reproduce:** 1. `!sleep 30`. 2. Ctrl+C. The spinner continues; the editor is cleared.
- **Why (from the code):** `packages/coding-agent/src/modes/interactive/components/bash-execution.ts:59` builds the hint from `keyText("tui.select.cancel")`, the list selectors' cancel binding, whose default is `["escape", "ctrl+c"]` (`packages/tui/src/keybindings.ts:155-158`). The editor's Ctrl+C goes to `handleCtrlC` at `interactive-mode.ts:3904-3912` (clear or quit); the only `abortBash` call on a key is the Escape branch at 2858-2859.
- **Severity:** `low`. Copy; the wrong key is harmless (it clears the editor).
- **Decision needed:** `fix`. Use `keyText("app.interrupt")` (the Escape binding) in the hint, or a literal `escape to cancel`.
- **Raised by:** [shell commands](conversation/shell-commands.md#open-questions-and-verification), [shell commands, Sent](conversation/shell-commands.md#sent).
- **Status:** Confirmed 2026-08-23 by the scripted driver pass against `a69bef789`: the spinner read exactly `Running... (escape/ctrl+c to cancel)` (SHELL-03), and Ctrl+C cleared the editor without cancelling (INPUT-01, SHELL-04).

### B-32: The footer reads `unknown` when no provider has a credential

- **Where the user meets it:** A fresh install, or every credential removed: the footer's right side shows `unknown` and the context readout `0.0%/0 (auto)`.
- **What happens / what was expected:** A placeholder model is selected so the rest of the screen can be drawn. `unknown` is accurate in that no model is chosen, but it reads like a failure to identify something rather than an instruction; the warning above the transcript (`No models available. Use /login …`) scrolls away, and the footer is the only permanent reminder.
- **Reproduce:** 1. Fresh home, `--no-env`. Observe the footer.
- **Why (from the code):** When model resolution returns nothing (`packages/coding-agent/src/core/model-resolver.ts:780-781`), the agent keeps its built-in default model, `DEFAULT_MODEL` at `packages/agent/src/agent.ts:48-60`, whose `id`, `name`, `api`, and `provider` are all the literal string `unknown`. The footer prints `state.model?.id` unchanged at `packages/coding-agent/src/modes/interactive/components/footer.ts:169-187`; the interactive layer recognises the placeholder only in `isUnknownModel` at `interactive-mode.ts:246-248`, which the login flow uses to decide whether to select a model.
- **Severity:** `low`. Cosmetic; the first prompt's error explains the state.
- **Decision needed:** `product call`. Observed as described; it is not a defect in the code's terms, but `no model — /login` in the footer would carry the instruction the warning carries. Worth a copy decision rather than a fix.
- **Raised by:** [the screen](foundations/the-screen.md#the-parts-of-the-screen), [models and credentials](foundations/models-and-credentials.md#credentials), [launching pi](startup/launching-pi.md#done).
- **Status:** Confirmed 2026-08-23 by the scripted driver pass against `a69bef789`: with no credential the footer read `unknown` and `0.0%/0 (auto)` (SCREEN-04, MODEL-01). Recorded as observed; the decision above is whether it is a bug.

### B-33: The final retry error is shown twice

- **Where the user meets it:** A turn fails three times in a row (network off, provider down).
- **What happens / what was expected:** The failed assistant block ends with `Error: <message>`, and a separate line `Error: Retry failed after 3 attempts: <message>` follows, repeating the same provider text. Expected: one of the two.
- **Reproduce:** 1. Network off. 2. Send a prompt; wait about 14 s.
- **Why (from the code):** Path one: `message_end` at `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3280-3293` updates the streaming component, whose renderer at `packages/coding-agent/src/modes/interactive/components/assistant-message.ts:190-194` appends `Error: ${errorMsg}` for `stopReason === "error"`. Path two: `auto_retry_end` at `interactive-mode.ts:3464-3476` calls `showError("Retry failed after …")`, and `showError` (4246-4250) prepends another `Error: `.
- **Severity:** `low`. Duplicate copy.
- **Decision needed:** `fix`. Make the retry banner say only `Retry failed after 3 attempts` (the message is already above it), or suppress the per-message `Error:` line when a retry banner follows.
- **Raised by:** [errors and retries](cross-cutting/errors-and-retries.md#open-questions-and-verification).

### B-34: `Copied last agent message to clipboard` is reported over SSH whether or not OSC 52 was honoured

- **Where the user meets it:** Ctrl+X or `/copy` in a pi running over SSH, in a terminal that does not allow OSC 52 writes (iTerm2 with the option off, tmux without `set-clipboard`).
- **What happens / what was expected:** The success status is shown; the local clipboard is unchanged. pi cannot know the outcome, but the message claims one.
- **Reproduce:** 1. Over SSH in a terminal with OSC 52 disabled, Ctrl+X.
- **Why (from the code):** `copyToClipboard` at `packages/coding-agent/src/utils/clipboard.ts:97-100` and 167-174: when `isRemoteSession()`, the OSC 52 sequence is written and `emitOsc52` (26-33) returns `true` unless the payload is too long; the caller at `interactive-mode.ts:6271-6288` shows the success status whenever no error was thrown.
- **Severity:** `low`. Copy; an expert-only quirk of remote sessions.
- **Decision needed:** `product call`. Either `Sent to terminal clipboard (OSC 52)` over SSH, which is honest but longer, or keep the message and document it.
- **Raised by:** [clipboard](cross-cutting/clipboard.md#open-questions-and-verification), [clipboard, How the clipboard is written](cross-cutting/clipboard.md#how-the-clipboard-is-written).

### B-35: Page Up and Page Down do nothing in the autocomplete popup

- **Where the user meets it:** `/` or `@` opens the popup with more than five rows; the user presses Page Down.
- **What happens / what was expected:** Nothing moves in the popup (the key falls through to the editor). `tui.select.pageUp`/`pageDown` bindings exist and are listed, so the user expects them to page the list.
- **Reproduce:** 1. Type `/`. 2. Page Down.
- **Why (from the code):** Bindings are declared at `packages/tui/src/keybindings.ts:149-153`; the list's `handleInput` at `packages/tui/src/components/select-list.ts:112-136` handles only up, down, confirm, and cancel; the editor forwards only up and down at `packages/tui/src/components/editor.ts:671-674`.
- **Severity:** `low`. A quirk of a five-row popup.
- **Decision needed:** `fix`. Forward `pageUp`/`pageDown` to the list and move by the visible row count; or remove the two bindings from the hotkeys table.
- **Raised by:** [autocomplete](conversation/autocomplete.md#open-questions-and-verification).

### B-36: Small copy and rendering slips

- **Where the user meets it:** Scattered; each is a line of text or a colour.
- **What happens / what was expected:**
  - A `!!` command's header `$ cmd` is dim until the first output or completion, then turns bash-mode green while the borders stay dim. `packages/coding-agent/src/modes/interactive/components/bash-execution.ts:36-52` draws it with `colorKey` (`dim` for `!!`); `updateDisplay()` at 134-139 rebuilds it with a literal `"bashMode"` and `excludeFromContext` is not stored on the instance. Fix: keep the colour key. Raised by [shell commands](conversation/shell-commands.md#open-questions-and-verification).
  - `pi --help` says `--provider <name>  Provider name (default: google)` (`packages/coding-agent/src/cli/args.ts:278`). `--provider` is only read together with `--model` (`packages/coding-agent/src/main.ts:461-467`, `packages/coding-agent/src/core/model-resolver.ts:645-659`) and the fallback chain has no Google default. Fix: `Provider name (used with --model)`. Raised by [models and credentials](foundations/models-and-credentials.md#open-questions-and-verification), [launching pi](startup/launching-pi.md#open-questions-and-verification).
  - `docs/settings.md:175` lists `websocketConnectTimeoutMs` with a default of `15000`. The setting itself has no default (`packages/coding-agent/src/core/settings-manager.ts:907-909` returns `undefined`); the 15000 is the OpenAI Codex Responses transport's own constant (`packages/ai/src/api/openai-codex-responses.ts:50`), the only consumer. The number a user sees is right; the doc's "for providers that support WebSocket transports" over-promises. Fix: say it applies to the Codex WebSocket transport and that the provider default is 15000. Raised by [configuration](foundations/configuration.md#open-questions-and-verification).
  - `terminal.showTerminalProgress` (`Terminal progress` in `/settings`, `settings-selector.ts:800-808`, `settings-manager.ts:44`) is absent from `docs/settings.md`, whose terminal table at 179-183 lists only `showImages`, `imageWidthCells`, `clearOnShrink`. Fix: add the row. Raised by [the settings panel](settings/the-settings-panel.md#open-questions-and-verification).
  - `/changelog` prints oldest first (`interactive-mode.ts:6381-6386` applies `.reverse()` to a newest-first file) while the startup `What's New` box prints newest first (1281). Product call: newest nearest the editor is defensible, but the two should agree or the command's description should say. Raised by [reload and hotkeys](settings/reload-and-hotkeys.md#open-questions-and-verification).
  - The startup header's shortcut strip shows a rebound key's old name after `/reload`: the strings are resolved once at 962-1007 and captured by the `ExpandableText` getters (1002-1007); `/reload` (5967-5972) reloads the bindings and only re-applies the expansion state. Fix: resolve the strip inside the getters. Raised by [reload and hotkeys](settings/reload-and-hotkeys.md#open-questions-and-verification).
  - `Auto-compaction failed: …` and `Context overflow recovery failed: …` are drawn without the `Error:` prefix every other error has (`interactive-mode.ts:3437-3444` prints `event.errorMessage` raw for non-manual reasons, text built at `agent-session.ts:2324-2334`); the manual path goes through `showError`. Fix: use `showError` for both. Raised by [errors and retries](cross-cutting/errors-and-retries.md#open-questions-and-verification).
  - In the model selector, once a refresh error has been shown the `Model Name:` line never returns: `model-selector.ts:342-355` draws the error, else no-results, else the name, and `errorMessage` is never cleared. Fix: draw the name whenever a row is highlighted, and the error below it. Raised by [the model selector](models/the-model-selector.md#open-questions-and-verification).
  - The `[compaction]` box is drawn below the kept messages right after a compaction (`interactive-mode.ts:3420-3425`, on purpose: "append it below at its chronological position") and above them on every rebuild (resume, `/tree`, Ctrl+T). Product call: pick one placement; the documents describe only the second. Raised by [compaction](sessions/compaction.md#open-questions-and-verification).
  - `Nothing to clone yet` (`interactive-mode.ts:5159-5162`, when there is no leaf) cannot be reached in the default configuration, because a new session records a model and a thinking-level entry at creation (`packages/coding-agent/src/core/sdk.ts:379-384`); an unsaved session gets `This session has not been saved yet…` from the fork path instead. Fix: drop the branch or make the unsaved check come first with the same text. Raised by [fork and clone](sessions/fork-and-clone.md#open-questions-and-verification).
- **Severity:** `low`. Copy and cosmetic.
- **Decision needed:** `fix`, except the two marked product call.
- **Raised by:** listed per item.

## Unconfirmed

Items the documents flagged that the code could not settle, or whose cause is in a path that was not followed to the end. They stay in their documents' open questions; they are listed here so the verification pass knows they were not dropped.

- In an ephemeral (`--no-session`) session, `/fork` and `/clone` copy the in-memory session before the turn in progress is aborted, so an aborted assistant message may land in the new session rather than the old. Read from the order of operations in `agent-session-runtime.ts` `fork`; not observed. [Fork and clone](sessions/fork-and-clone.md#open-questions-and-verification).
- A SIGINT sent to the process directly (`kill -INT`) while running: no `SIGINT` handler is installed except while suspended (`interactive-mode.ts:4072-4093`; the signal list at 4017-4020 is SIGTERM and SIGHUP), so Node's default handler would end the process without the shutdown path. Not tried. [Process lifecycle](cross-cutting/process-lifecycle.md#open-questions-and-verification).
- `/tree` chosen during automatic compaction appears to wait for the compaction to finish rather than cancel it; whether it should cancel is a product question. [Busy state](cross-cutting/busy-state.md#open-questions-and-verification).
- `navigateTree` restores only the messages, not the model or thinking level recorded on the chosen branch (`agent-session.ts:3201-3202`); [thinking](conversation/thinking.md) says the branch's level is restored. The code supports [the tree](sessions/the-tree.md#open-questions-and-verification); whether a tree move should restore them is a product question, not a defect.
- Whether a failed attempt's `Error:` line stays on screen (as [errors and retries](cross-cutting/errors-and-retries.md#open-questions-and-verification) reads from `assistant-message.ts:190-194`) or not (as [sending a prompt](conversation/sending-a-prompt.md#cancel-and-interrupt) says) needs a real provider error; the code favours the former, and the second document needs correcting.
- Built-in slash commands are not added to prompt history (the submit handler returns before the history step), which [the editor](conversation/the-editor.md) describes as applying to every submission. A document correction, not a defect, unless the product wants `/new` recallable with Up. [New session](sessions/new-session.md#open-questions-and-verification).
- `/session`'s `Total:` counts shell records and other non-model messages, so it is not `User + Assistant + results`. Intent not determined. [Naming and info](sessions/naming-and-info.md#open-questions-and-verification).
- `showHardwareCursor` and `clearOnShrink` in settings beat `PI_HARDWARE_CURSOR` / `PI_CLEAR_ON_SHRINK` (`settings-manager.ts:1163`, `1283`), the reverse of every other environment variable. Intent not determined. [Configuration](foundations/configuration.md#open-questions-and-verification).
- `COLORFGBG` is treated as a high-confidence theme detection and written to the settings file, pinning a wrong theme in a terminal that sets it wrongly. Intent not determined. [Themes](settings/themes.md#open-questions-and-verification).
- In the `/resume` picker, Enter on a blank rename field does nothing and leaves the field open (`interactive-mode.ts:5341-5346` returns on an empty name without closing); and the picker's `onExit` callback (`session-selector.ts:301`, `800-802`) is wired to shut pi down but was not found bound to any key. Both read from the code; neither tried. [Resuming](sessions/resuming.md#open-questions-and-verification).
