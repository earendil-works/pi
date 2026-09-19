# Sessions

Pi saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## Session Storage

Sessions auto-save to `~/.pi/agent/sessions/`, organized by working directory. Each session is a JSONL file with a tree structure.

```bash
pi -c                  # Continue most recent session
pi -r                  # Browse and select from past sessions
pi --no-session        # Ephemeral mode; do not save
pi --name "my task"    # Set session display name at startup
pi --session <path|id> # Use a specific session file or partial session ID
pi --fork <path|id>    # Fork a session file or partial session ID into a new session
```

Use `/session` in interactive mode to see the current session file, session ID, message count, tokens, and cost.

For the JSONL file format and SessionManager API, see [Session Format](session-format.md).

## Session Commands

| Command | Description |
|---------|-------------|
| `/resume` | Browse and select previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set the current session display name |
| `/session` | Show session info |
| `/tree` | Navigate the current session tree |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Summarize older context; see [Compaction](compaction.md) |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/bug [description]` | Report a bug to the Pi developers; see [Reporting Bugs](#reporting-bugs) |

## Resuming and Deleting Sessions

`/resume` opens an interactive session picker for the current project. `pi -r` opens the same picker at startup.

In the picker you can:

- search by typing
- toggle path display with Ctrl+P
- toggle sort mode with Ctrl+S
- filter to named sessions with Ctrl+N
- rename with Ctrl+R
- delete with Ctrl+D, then confirm

When available, pi uses the `trash` CLI for deletion instead of permanently removing files.

## Naming Sessions

Use `/name <name>` to set a human-readable session name:

```text
/name Refactor auth module
```

Set the name at startup with `--name` or `-n`:

```bash
pi --name "Refactor auth module"
pi --name "CI audit" -p "Review this build failure"
```

Named sessions are easier to find in `/resume` and `pi -r`.

## Branching with `/tree`

Sessions are stored as trees. Every entry has an `id` and `parentId`, and the current position is the active leaf. `/tree` lets you jump to any previous point and continue from there without creating a new file.

<p align="center"><img src="images/tree-view.png" alt="Tree View" width="600"></p>

Example shape:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Tree Controls

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate visible entries |
| ←/→ | Page up/down |
| Ctrl+←/Ctrl+→ or Alt+←/Alt+→ | Fold/unfold or jump between branch segments |
| Shift+L | Set or clear a label on the selected entry |
| Shift+T | Toggle label timestamps |
| Enter | Select entry |
| Escape/Ctrl+C | Cancel |
| Ctrl+O | Cycle filter mode |

Filter modes are: default, no-tools, user-only, labeled-only, and all. Configure the default with `treeFilterMode` in [Settings](settings.md).

### Selection Behavior

Selecting a user or custom message:

1. Moves the leaf to the selected message's parent.
2. Places the selected message text in the editor.
3. Lets you edit and resubmit, creating a new branch.

Selecting an assistant, tool, compaction, or other non-user entry:

1. Moves the leaf to that entry.
2. Leaves the editor empty.
3. Lets you continue from that point.

Selecting the root user message resets the leaf to an empty conversation and places the original prompt in the editor.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| Output | Same session file | New session file | New session file |
| View | Full tree | User-message selector | Current active branch |
| Typical use | Explore alternatives in place | Start a new session from an earlier prompt | Duplicate current work before continuing |
| Summary | Optional branch summary | None | None |

Use `/tree` when you want to keep alternatives together. Use `/fork` or `/clone` when you want a separate session file.

## Branch Summaries

When `/tree` switches away from one branch to another, pi can summarize the abandoned branch and attach that summary at the new position. This preserves important context from the path you left without replaying the whole branch.

When prompted, choose one of:

1. no summary
2. summarize with the default prompt
3. summarize with custom focus instructions

See [Compaction](compaction.md) for branch summarization internals and extension hooks.

## Reporting Bugs

`/bug [description]` collects a bug report for the Pi developers. The report is not shared publicly. The dialog asks for an optional description and whether to include the session transcript. If you decline the transcript, pi offers to have the current model write a summary of what went wrong instead; the transcript is sent to your provider with your credentials, and only the summary is attached.

The last step chooses where the report goes:

- **Upload Report** sends it to the Pi developers through `radius.pi.dev`. No login is required; if you are logged into Radius, the report is attributed to your account so the developers can follow up. If the upload fails, pi offers to export the zip instead.
- **Export as Zip** writes a zip archive to the current directory. Attach it to an issue or send it to the developers yourself.

Both contain the same files:

| File | Content |
|------|---------|
| `report.json` | pi version, runtime, OS, terminal, current model and provider configuration, loaded extensions, and settings. API keys, header values, URL credentials, and the analytics tracking id are never included. |
| `diagnostics.json` | Provider and runtime error diagnostics attached to assistant messages across the whole session (failed or aborted turns, retries, error messages), plus any recorded crashes. Always included; message content is not. |
| `session.jsonl` | The current branch of the session, only when you chose to include it. It contains file contents and command output read during the session. |
| `summary.md` | The model-written summary, only when you chose to generate one. |

Each report has a UUID. pi shows it after upload or export and records it in the session as a `pi.bug-report` entry so you can refer to it later.

Set `PI_RADIUS_GATEWAY` to upload to a different Radius deployment.

### Crashes

When pi exits because of an uncaught exception or a fatal runtime error, it stores the error message and stack trace in `~/.pi/agent/crashes.json` (the newest five). The next interactive start shows a warning once; running `/bug` attaches the stored crashes to `diagnostics.json` and removes the file after the report is uploaded or exported. Resume the crashed session with `pi -r` first if you want the transcript in the report.

## Session Format

Session files are JSONL and contain message entries, model changes, thinking-level changes, labels, compactions, branch summaries, and extension entries.

For parsers, extensions, SDK usage, and the full SessionManager API, see [Session Format](session-format.md).
