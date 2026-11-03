# p3 functionality map

What the app must do, independent of p2's plugin layout. Step 1 of deriving p3's objects (`../redesign-decisions.md`).
The detailed tables per area are in this directory: `conversations.md`, `sessions-access.md`,
`environments-workspace.md`, `models-prompt-shells.md`, `core.md`. This page condenses them.

## Domains

| # | Domain | Main functions |
|---|---|---|
| 1 | Sessions | create (local or remote, directory check, defaults); live list (pinned, grouped by machine and directory) that never starts a worker; rename, automatic title, agent rename; pin; archive and restore (stop worker, end guest access, close forwards); relocate (idle only, fenced, followers move, cross-machine refusal); clone; fork at a user message; delete (new); unread marks |
| 2 | Session workers | start on demand; one worker per store; idle stop after 5 min without viewers, calls or tasks; sticky start failure with retry; generation fence on reports; crash reports; shutdown |
| 3 | Conversations and agent | live view window; history paging and retained pages; jump to an entry; context, cache and cost; working indicator; tool cards and nested calls; send, steer, queue, dedupe per author request id; input gate until prompt resources load; structured attribution; stop and dequeue with restored drafts; model and thinking (owner); compact and reset; read-only conversations; model error entries; resume interrupted work |
| 4 | Shell commands | `!cmd` / `!!cmd` in the conversation's cwd and environment; one at a time; live tail; spill file; result entry placed at the next boundary; cancel; dedupe |
| 5 | Chat mode | per-conversation switch; chat messages without a turn; `@pi` mention with a digest; reply quotes |
| 6 | Agents | named subagents (spawn, steer, configure, archive, report answers once, own cwd); one-shot agents for scripts (read-only, JSON result); messages between sessions (agent tool, attributed, idempotent) |
| 7 | Code mode | scripts calling tools as nested durable calls; replay after restart; switch on and off |
| 8 | Session files | attachments (≤25 MiB, copied to remote environments); sent-file snapshots; versioned artifacts with sandboxed preview; shell spill files; previews; ranged downloads; copy on clone; delete with the session |
| 9 | Environments and execution | environment config (validation, keys, host keys, test); directory browsing local and remote; connection pools; daemon deployment; execution environment per session and per conversation cwd; reopen after a move; OS probe (PowerShell) |
| 10 | Workspace | list, read, search, git status, diff, log, commits; file index and `@` completion; change notifications; uploads into the project; downloads; review comments sent as a message; confinement and git hardening |
| 11 | Terminals | detached host process owning PTYs; attach with a screen snapshot; several viewers; flow control; single-use channel tokens; host version notice |
| 12 | Access | owner on loopback, device cookies, sign-in tokens, sign out and rotate; share links per mode, join, unique guest names, grant revision, remove, reset; origin checks; proxy trust; revocation of live access |
| 13 | Models, credentials, settings | model catalog (custom providers, cache); credentials (locked, never to clients); API key and OAuth login with prompts and notices; default model and scope; run settings; code mode switch; owner name; hot reload with last valid state |
| 14 | Prompt resources | AGENTS.md, skills, templates read in the session's environment; watched; expansion before send |
| 15 | Status and presence | per-session status (busy, tasks, usage, error); viewer counts; connected guests; keep-alive inputs |
| 16 | Search | message index per session with catch-up cursors; title and text search; open a hit |
| 17 | Remote access and forwards | Radius relay link; relayed owner treated as remote; forwards (≤50, public toggle, agent tool, closed on archive) |
| 18 | Logs and notices | capture and redact; bounded rings; detached process snapshots; owner notices; dismiss |
| 19 | Dev and reload | dirty tracking; plugin reload; supervised restart; bundle publication; client update detection; `reload_plugins` tool |
| 20 | Web shell | layout, navigation stack, composer state, theme, reconnect, installable app |
| 21 | TUI shell | launcher sandbox; consent actions (copy, upload, download, open URL, editor); preferences; commands; snapshot swap; terminal safety |
| 22 | Transport | frames and limits; reconnect and resubscribe; protocol refresh |

## Cross-cutting needs

| Need | Where |
|---|---|
| One session file store (caps, immutable ids, ranges, previews; copied and deleted with the session) | attachments, sent files, artifacts, spill files, workspace downloads |
| Per-session data lifecycle across hosts (archive, clone, delete) | store, files, links, guests, index rows, read marks, children, forwards |
| Reading without starting a worker | session list, status, children, unread, artifact list, logs, cost sheet |
| Worker-to-server reports with a generation fence | status, children, index feed |
| Catch-up after commits (cursor plus wake) | search indexer, subagent reporter |
| Work that outlives its caller, with cancel, dedupe and an outcome | shell, relocate, clone, fork, login, peer send, scripts |
| Idempotency per author request id | send, write, shell, peer send |
| Cancellation chains | script → nested calls → child conversation; stop; login abandon |
| Keep-alive versus presence | viewers, lingering tabs, active calls, tasks |
| Execution environment that follows the session; file watching in it with poll fallback and last valid state; connection pools | workspace, file index, prompt, PowerShell, terminals, browsing |
| Single writer for configuration files; central redaction; credentials never to clients | settings, models, auth, radius, envs |
| Attribution of input (structured author, peer, owner-initiated checks) | send, shell, peer messages, privileged tools |
| One permission matrix (owner, guest read, guest write, worker; terminals owner only; workspace not for guest read) | every function |
| Revocation of live access | guests, devices |
| Chunked byte transfer with ranges | uploads, downloads, attachment copies |
| One notice channel | logs, dev, model errors, grants, failures |
| UI state that survives navigation, reload and reconnect | drafts, pending sends, reading positions, review drafts |
| TUI consent for local side effects | copy, upload, download, open URL, editor, sign out |

## Duplicated today (one function, several implementations)

Input gate loop (4); latest answer text (3); download snapshot writers (2); upload handling (2 routes, 2 caps, 2 layouts);
size and id validation (3); environment config parsing and SSH options (3); SSH connections to an environment (4);
confinement and private-directory denial (3); full file listing (2); path resolution (4); "archived?" checks (5);
presence leases (3); generation-fenced report stores (2); commit catch-up loops (2); revocation fan-out (3); thinking
clamp and model lookup (4); watch plus last valid state (5); secret registration for redaction (5); notice channels (5);
staleness checks (3); reconnect backoff (3); drafts (3); following the session location (5); "offer the tool only
when" switches (3); themes and transcript renderers (web and TUI).

## Candidates to drop

Legacy speaker and attribution parsing; peer attribution as a text prefix; shell abort after 30 s without a viewer;
catalog and cookie migrations; guest last-seen; the subagents copy of conversation config; warming every environment
connection when the folder picker opens; duplicate environment test state; the worker's unused environment watcher; old
relay protocol versions; the proxy-marker object; unused snapshot methods; the fake provider in product code; polling
log snapshot files; "removed mid-script"; `P2_DEV_RESUME`; old TUI snapshot formats; legacy default-model environment
aliases.
