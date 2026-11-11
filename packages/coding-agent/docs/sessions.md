# Sessions and Context

Pi saves a conversation as a session. The active branch of that session supplies conversation history for the next model request. Use session commands to continue work, explore another branch, or reduce the amount of history sent to the model.

## Continue or switch sessions

Pi saves sessions automatically unless you start it with `--no-session`.

```bash
pi --continue
pi --resume
```

`--continue` opens the most recent session for the current directory. `--resume` opens the session picker. In interactive mode, `/resume` opens the same picker and `/new` starts a new session.

Each session records the working directory it was created in and never changes it. Pi runs a session in its working directory, so tools, `@path` references, project configuration, and context files resolve from there.

| Entry point | Working directory |
|---|---|
| `--continue` | The current directory |
| `--resume`, `/resume`, `--session`, `/import` | The session's working directory, which can differ from the current directory |
| `--fork`, or a `--session` ID from another directory that you choose to fork | The current directory, in a new session |

If a session's working directory no longer exists, interactive mode offers to run the session in the current directory instead. Pi does not store that choice, so it asks again the next time you open the session. Other modes exit with an error.

Use `/name` or `--name` to assign a recognizable session name. Run `/session` to verify the current session file, ID, message count, token usage, and cost.

The session picker lets you search, rename, and delete sessions. It can also show paths, change sorting, and limit results to named sessions. See [Keybindings](keybindings.md#sessions) for its shortcuts.

## Pause and recover work

Run `/pause` to hold the main agent and its native sub-agents. The menu shows **Pausing** while the current response and already-started tools finish; it then shows **Paused**. New model requests and tool calls wait at execution boundaries. Nested calls belonging to an already-running tool can finish. A synchronous delegation or child-wait tool must finish before the group can pause, so a long child task can delay that boundary.

Press **Enter** on Continue to continue the same live run, without submitting another prompt or repeating completed tools. **Escape** closes the menu but keeps work paused; reopen it with `/pause`. `/resume` still opens the session picker. Independently supervised background jobs keep running, including when a job view is closed.

After a crash, or after exiting while paused, reopen the saved session with `--continue`, `--resume`, or `--session`. Pi offers recovery before starting work. Choose Continue saved work, Keep paused, or Discard pending work. Discard preserves conversation history and completed evidence; it does not undo filesystem or external side effects.

Completed parallel tool results are saved before their ordinary ordered chat entries, so recovery can restore them even if another tool was still running. A main tool interrupted during execution is marked **outcome unknown** and requires an additional confirmation. Its original call is not replayed automatically; the continuing agent is told to inspect actual state and obtain approval before repeating an uncertain operation. Queued inputs retain their identities so an input already committed to history is not delivered twice.

Each sub-agent continues in its own child JSONL and recovery namespace, with the same completed-result restoration and unknown-outcome warnings in its own history. The parent keeps only child IDs, bounded results, and status—not the child's conversation. Existing role approval and current tool restrictions still apply when recovering children.

Recovery files live under `~/.pi/agent/recovery/<owner-hash>/state.json`, or the corresponding `PI_CODING_AGENT_DIR`. The owner hash binds the canonical session file path and its header timestamp. These private files contain execution metadata, pending inputs, and temporary completed-tool receipts; receipts are removed after their normal chat entry is saved. Back up the recovery directory with the main and child session files. JSONL exports, imports, or moving session files do not carry an execution checkpoint to a different path. `--no-session` recovery is memory-only and cannot survive exit.

An execution lease prevents two Pi instances using the same agent directory from recovering or running the same saved session concurrently. After a hard crash, a stale lease may briefly delay recovery; wait and retry rather than deleting a live instance's lock.

SDK hosts can use `session.recovery.pause()`, `resume()`, `recover()`, `discard()`, and `info()`. Recovery is explicit in print/JSON/RPC hosts; they do not silently restart interrupted work. Interactive SDK hosts can register `createRecoveryExtension()` for the menu. Drain the session lifecycle before disposal, as `AgentSessionRuntime` does.

## Automatic names

The CLI gives unnamed chats a short generated title in the background after the first completed answer. It attempts this once per session, not on every turn. `/name`, `--name`, session-picker renames, and explicit name clears take precedence, including while a naming request is in flight. Session IDs and conversation messages do not change.

Unnamed background jobs use the same naming policy when submitted or restarted. An explicit `bash.name` or manual job rename is preserved; restarting an automatically named job requests a fresh name for its new command. Job IDs stay stable during renaming, and open job views—including minimized Rex pane labels—update when the name arrives. Sub-agent task labels follow the same policy using the child's selected model and role instructions.

Naming requests receive the effective, already-loaded system instructions, including Markdown context files such as `AGENTS.md`. Add ordinary naming guidance there; no separate naming file is needed:

```markdown
## Naming
Use short imperative names for chats, jobs, and delegated tasks.
Prefer 3–5 words, sentence case, and concrete technical terms.
Avoid emoji, generic labels, and copied command lines.
```

Each generated name uses one additional model request, with no tools or retries, a 30-second deadline, and an 80-character display limit. Chats and jobs use the active model; sub-agents use their selected child model. Delivered usage contributes to the owning session's totals; child-label usage stays in child history. Naming prompts and raw replies never become conversation messages. Failures keep the existing fallback display rather than interrupting the work.

Interactive shutdown, reload, and session replacement cancel pending naming. Print/JSON modes deliver the answer first, then finish bounded naming work before exit. Temporary `/btw` conversations remain unsaved and retain their temporary-view header.

SDK hosts opt in with `createAutoNameExtension()` and `createJobsExtension()` through their resource loader, and drain the `session_shutdown` lifecycle before disposal. `AgentSessionRuntime` handles that lifecycle.

## Choose how to branch

Pi stores entries as a tree, so returning to an earlier point does not erase the branch you leave.

| Action | Result | Use it when |
|---|---|---|
| `/tree` | Moves within the current session file | Related alternatives should stay together |
| `/fork` | Creates a new session from an earlier user message | The alternative should become separate work |
| `/clone` | Copies the active branch into a new session | You want a separate copy of the current state |

In `/tree`, select a user message to put its text back in the editor. Edit and submit it to create another branch. Selecting an assistant response or another entry continues after that entry with an empty editor.

When you leave a branch, Pi can summarize it and attach that summary to the branch you enter. This preserves relevant work from the abandoned path without including every message from it.

For the persisted tree and entry types, see [Session Format](session-format.md).

## Manage conversation context

The model receives the active branch, not every branch in the session file. Pi combines that history with the system prompt, discovered context files, available tools, and loaded skill descriptions. [How Pi Works](how-pi-works.md#context) describes how those inputs are assembled.

The footer shows current context usage. By default Pi prepares a summary in the background at 75%, then waits for and applies it at 85%, before the next model request. The summary replaces completed history; every message added after the frozen boundary stays verbatim. Original session entries are not deleted.

Run `/compact` to compact manually. You can add instructions when the summary should preserve a particular topic or decision. Configure automatic compaction and retained history through [Settings](settings.md#compaction).

Compaction can fail if the provider is unavailable or cannot accept the summarization request. Correct the provider problem and run `/compact` again. Disabling automatic compaction does not disable the manual command.

Each compaction records an original-history checkpoint. If the summary misses a needed detail, the agent can use `recall_context(checkpoint_id, query)` to recover it with original message citations. This uses additional calls to the current model through a read-only helper, not current filesystem searches. Saved checkpoints remain usable after resume; ephemeral ones disappear on exit.

See [Compaction Reference](compaction.md) for thresholds, retained boundaries, branch-summary behavior, and extension hooks.

## Control session storage

By default, Pi stores sessions under `~/.pi/agent/sessions/`, grouped by working directory. Use `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting to choose another location. The CLI option has highest precedence.

Use `--no-session` for an ephemeral run. An ephemeral session cannot be resumed after Pi exits.

## Export or share a session

Use `/export` to write the current session as HTML or JSONL. Use `/share` to upload it and get a viewer link. By default, Pi uses a Radius artifact when Radius authentication is configured; otherwise, it uses a private GitHub gist. Set [`sessionShareDestination`](settings.md#sessions-and-context) to `gist` or `radius` to force one destination.

Review exported or shared sessions first. They can contain prompts, model responses, tool arguments, command output, file contents, and extension messages.

## Report a bug

Run `/bug [description]` to prepare a private report for the Pi developers. You can include the session transcript, omit it, or ask the current model to summarize the problem. Review any transcript or generated summary because it can contain sensitive conversation data.

The report includes environment and provider configuration without credential values, plus recorded error diagnostics. Upload it through `radius.pi.dev` or export the same report as a zip to inspect and share yourself. Uploads do not require a login; Radius authentication attributes the report to your account so the developers can follow up. If an upload fails, Pi offers to export the zip.
