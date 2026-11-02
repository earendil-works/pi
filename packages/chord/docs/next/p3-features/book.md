---
title: p3: Feature Set and Work Packages (prep for the design meeting)
cover: p3 / Features
kicker: Meeting prep · p3 on Chord v2 · 2026-11-03
subtitle: What p2 does today (in pictures), what p3 should ship first, how hands, sync and the plugin API fit, and a first cut into work packages
stats:
  - 28 | feature areas in p2 today
  - 21 | model-facing tools in p2
  - 78 | coding-agent extension examples checked against the p3 plugin API
  - 12 | proposed work packages
note: |
  Written by the redesign session for the meeting on 2026-11-03, from three research passes over p2
  (`apps/p2` at `b7af55ace`), the coding agent's extension examples and p2's environments and Radius code
  (`/tmp/p3-prep/features.md`, `extensions.md`, `envs.md`), the owner's notes and Armin's summary of the 2026-11-02
  meeting. Chord v2's slices 1-13 are built (the app kit included); slice 11 (web and TUI) is building. Everything
  marked "proposed" is for the meeting to decide.
colophon: p3 Feature Set and Work Packages · meeting prep · 2026-11-03
---

# Before we begin {.preface}

p2 grew feature by feature on the phone: 33 plugins, about 65,000 lines, a web shell and a TUI. p3 is its rewrite on
Chord v2, with an app kit that already gives hosts, workers, HTTP with sessions and pairing, plugins with versioned
APIs, files and export. The meeting's job is to decide what p3 ships first, what waits, and how the work splits.

Some of it was settled yesterday (Armin's summary): sessions sync to R2 through Radius by commit log, the session index
is a replicated Chord table, every host kind loads plugins through registries, hands connect proactively. The owner
added: voice waits; environments turn around into hands; continuing a local session on Radius is core; subagents and
handoff are in, artifacts are questionable; the plugin API stays small enough to evolve.

## Ten things to know

:::findings
1. **Proposed base:** sessions (with delete), the agent and conversations, subagents, history and handoff, code mode,
   shell commands, models and login, prompt resources, workspace (read and review), file index, status and notices,
   search through the index, the web shell and the TUI, hands, session sync and continue-on-Radius.
2. **Proposed later:** voice, terminals (need channels and hands), artifacts, port forwards, chat mode and guest
   sharing, MCP and `tool_search`.
3. **Hands replace SSH-dialled daemons:** a long-lived daemon dials the server (or Radius), is enrolled once by a
   pairing code, and carries p2's existing daemon protocol over one multiplexed WebSocket.
4. **The sync handshake needs a driver identity.** Two machines writing one session both push "from Radius's last
   seq" and silently diverge; an epoch or lease per session (Chord's rule S7) closes it.
5. **The index has two writers** once a session continues on Radius; three options, one recommended (derive rows from
   session stores).
6. **Tools in base:** `read`, `write`, `edit`, `bash`, `codemode`, `subagent`, `team`, `agent`, `conversations`,
   `history_*`, location tools, `rename_session`, `send_file`; artifacts, ports and `reload_plugins` wait or change.
7. **One CLI, no environment variables:** `p3 serve`, `p3 tui`, `p3 hand`, `p3 owner-link`, `p3 install`; settings as
   arguments and files, per the app kit.
8. **The plugin API v1 is seven clusters,** almost all already existing: Durable's extension, a `Conversation`
   contract, input transforms, environments and models, questions, UI registries, objects for state.
9. **Litmus test:** all 78 coding-agent extension examples are expressible; Doom needs two small fixes (frame splitting
   in the TUI bridge, a path for large plugin assets); streaming frames from a worker and raw terminal ownership do
   not fit, by design.
10. **Twelve work packages,** with p3's skeleton on the app kit and the session/index/sync core first.
:::

## Words used throughout

A **hand** is a daemon on a machine that connects out to a p3 server or to Radius and offers execution (commands,
files, watching, terminals). A **driver** is the single host allowed to write a session's store at a time; a
**replica** follows its commits. An **epoch** numbers driver changes. The **index** is the table of session metadata
(title, status, idle state) the session list reads. The **app kit** is Chord's `startApp`/`startWorker` layer.

# p2 in Pictures {#pictures lede="What each feature area looks like today, on the web, the phone and in the terminal."}

All content is invented (a small shop project, the owner Dana, a guest), the models are a fake provider's, tools ran
for real on a demo repository. Stills are from the web on a desktop and a phone and from the TUI; the clips loop.

## Sessions

{{img:sessions-list-desktop.webp|The sidebar: sessions grouped by directory, subagent counts, footer buttons.}}
{{img:sessions-drawer-phone.webp|The drawer on the phone, a subagent expanded.}} {{img:sessions-create-phone.webp|A new session on the phone.}}
{{img:sessions-create-directory-picker.webp|The directory picker for a new session: environment, path, folders, recent.}}
{{img:sessions-options-sheet.webp|The session sheet: title, share, working directory, pin, archive.}}
{{img:tui-session-selector.webp|The TUI's session selector, subagents threaded under their session.}}

## Conversations and the agent

{{clip:clip-streaming.mp4|Sending a question: thinking, a read card, a table and code stream in.}}
{{img:conversation-thinking.webp|A turn with thinking expanded and read, write and edit cards.}}
{{img:conversation-edit-diff-card.webp|An edit card with its diff.}}
{{img:conversation-bash-card.webp|A bash card with its output, then the answer.}}
{{img:conversation-streaming.webp|While an answer streams: the busy dot, the Steer composer, the stop button.}}
{{img:conversation-transcript-phone.webp|The transcript on the phone.}} {{img:conversation-model-picker-phone.webp|The model sheet on the phone.}}
{{img:conversation-cost-sheet.webp|The cost sheet: totals, cost and cache hits per response.}}
{{img:tui-transcript-tools.webp|The same agent in the TUI: thinking, tools, the answer, editor and footer.}}

## Subagents, history and handoff, code mode

{{img:subagents-spawn-and-report.webp|A spawned subagent in the parent's transcript, and its report.}}
{{img:subagents-conversation.webp|The subagent's own conversation, selected in the sidebar.}}
{{img:history-handoff-card.webp|A handoff: the continuation text, then a new context.}}
{{img:history-search-card.webp|history_search with its hits.}}
{{img:codemode-card.webp|A code mode script with three nested tool calls.}}

## Shell commands and chat mode

{{img:shell-command-tui.webp|A shell command run from the TUI with its output (the web can only show it).}}
{{img:chatmode-two-people.webp|Chat mode: owner and guest talk, an @pi mention gets a digest and an answer.}}

## Sharing, devices, providers

{{img:sharing-sheet.webp|The share sheet: read-only and read/write links, a connected guest.}}
{{img:sharing-join-page.webp|Joining through a share link.}} {{img:sharing-guest-view-phone.webp|The session as the guest sees it.}}
{{img:devices-sheet.webp|The devices sheet (the one-time token masked).}}
{{img:providers-login.webp|A provider's login methods.}}

## Workspace, @ completion, terminals

{{clip:clip-workspace-review.mp4|Changes, a diff, a line comment, Send all; the agent answers the review.}}
{{img:workspace-files.webp|Files: tree, sizes, upload.}}
{{img:workspace-changes.webp|Changes: branch, uncommitted files, commits.}}
{{img:workspace-search.webp|Text search across the project.}}
{{clip:clip-at-completion.mp4|@ completion in the composer.}}
{{img:terminals-web.webp|A web terminal panel with tabs and a key row.}}
{{img:tui-slash-changes-diff.webp|The TUI's /changes diff (read-only).}}

## Environments, artifacts, attachments, search

{{img:environments-panel.webp|The environments sheet: SSH environments and the ports entry.}}
{{img:artifacts-preview.webp|An artifact in the sandboxed preview.}}
{{img:attachments-message.webp|A message with an image attachment.}}
{{img:search-results.webp|Sidebar search: message hits for "rounding".}}

## Status, notices, logs, voice, ports

{{img:status-footer-viewers.webp|The composer footer: model, viewers, cache hit rate, cost, context.}}
{{img:notices-owner-notice.webp|An owner notice after a worker was killed, with Show logs.}}
{{img:logs-sheet.webp|The logs sheet following the server's log.}}
{{img:voice-sheet.webp|The voice sheet (later in p3).}}
{{img:ports-panel.webp|The ports panel without Radius (later in p3).}}

## The web shell and the TUI

{{clip:clip-phone-sheets.mp4|The phone: drawer, switching sessions, the session sheet, the share sheet, Back.}}
{{img:webshell-phone-sheet-2-directory.webp|The sheet stack on the phone: a second sheet pushed on the first.}}
{{clip:clip-tui-palette.mp4|The TUI's F1 palette: filter, run a command, the model selector.}}
{{img:tui-slash-commands.webp|/ command completion in the TUI.}}
{{img:tui-theme-picker.webp|The TUI's theme picker with preview.}} {{img:tui-theme-light.webp|The light theme.}}

Not shown: clone and fork (TUI only, not run), SSH environments connected (no network in the capture), Radius and
public ports (off), voice in use (no microphone), dev mode reload pills, provider OAuth flows.

# p2 Today, and the Proposed Cut {#features lede="Every feature area, what it is, and where it goes in p3."}

Sizes are non-test lines in p2. "Base" means p3's first release; "later" means designed for, built after; "drop" means
not carried over.

| Area | What it does | p2 size | Proposed |
| --- | --- | ---: | --- |
| Sessions | list by machine and directory, create, rename, pin, archive, relocate, clone, fork, unread, automatic titles | 2,186 | **base**, plus delete and in-session branches (`/tree`); clone and fork in the web too |
| Conversations and agent | transcript, send, steer, follow-up, outbox, stop, model and thinking, cost, compaction | 3,682 + web 2,700 | **base** |
| Subagents, one-shot agents, cross-session messages | named background agents, `team`, `agent` from scripts, `conversations` | 2,182 | **base** (owner: "awesome") |
| History and handoff | re-read earlier entries after compaction, hand off with a continuation | 533 | **base** |
| Code mode | scripts calling tools as nested durable calls | 155 + Durable | **base** (small, Durable owns it) |
| Shell commands | `!cmd` and `!!cmd` in the conversation's environment | in chat | **base**, web too (TUI only today) |
| Chat mode | people talk without a turn, `@pi` mentions | 876 | later |
| Sharing and guests | share links, guest names, revocation | 1,047 | later (the app kit's users and invites cover the start) |
| Devices and owner login | owner links, device cookies | 684 | **base**, replaced by the app kit's sessions and pairing |
| Models, credentials, provider login | picker, scope, API keys, OAuth flows | 3,828 | **base** |
| Settings | `settings.json`, hot reload | 87 | **base** |
| Prompt resources | AGENTS.md, skills, templates, read in the session's environment | 958 | **base** |
| Workspace | files, git status, diffs, search, review comments | 2,655 + web 1,341 | **base** (read and review; uploads later) |
| File index and `@` | ranked file completion | 242 | **base** |
| Terminals | detached PTYs, ghostty-vt in the web | 3,518 | later (channels, hands) |
| Environments and locations | SSH environments, directory picker, agents moving themselves | 2,546 | **base, redesigned as hands** |
| Artifacts and files | attachments, `send_file`, versioned artifacts with previews | 1,713 | attachments and `send_file` base (app kit `Files`); artifacts later |
| Search | sidebar search over titles and messages (FTS5) | 775 | **base** over the index; message text search through the same sync mechanism later |
| Status and presence | busy, tasks, usage, viewers, worker failures | 566 | **base** (feeds the index) |
| Logs and notices | owner log viewer, notices | 487 | **base** |
| Voice | rooms, barge-in, speech service | 3,770 + Python | later (owner) |
| Radius relay and port forwards | brain WebSocket, up to 50 forwards | 2,000 | relay **base** (as the hands/sync link), forwards later |
| Web shell | PWA, sheets, navigation, reconnect | 9,252 | **base**, rebuilt on slice 11 ("look and feel great") |
| TUI | launcher, sandbox, 40 commands, themes, keybindings | 6,720 + launcher | **base** on slice 11 |
| Dev and reload | supervisor, dirty marks, reload tool | 468 + scripts | **base** as the app kit's "apply changes"; the supervisor goes |
| Fake provider, `PI_MOBILE_*` aliases, `P2_DEV_RESUME` | test and legacy leftovers | 218 | drop |
| `tool_search`, MCP | not installed in p2 | - | later |

Rough edges p3 should not inherit: features only in the TUI (shell commands, clone, fork, compact, new context), no
session delete, terminals and voice without a TUI side, docs that drifted from code (voice routes, TUI notes), the
plugin loader's module leak on reload (solved by Chord's plugin component).

# Hands {#hands lede="Environments turned around: the machine connects to the server, not the other way."}

## What p2 does

p2's server and workers start a daemon (`pi-env`) over SSH on demand, one connection per session and per use (four
connection pools: each worker, the directory picker, the connection test, the terminal host). The daemon is
stateless and kills its commands 30 seconds after its connection goes quiet. Its frame protocol (exec, files, watch,
file listing, PTYs) does not depend on SSH.

## What a hand is (proposed)

| | p2's daemon | hand |
| --- | --- | --- |
| who dials | the server, over SSH | the hand, over WSS, to the server or to Radius |
| needs | sshd, a key, a network path to the machine | outbound HTTPS only |
| lifetime | per connection | a service (systemd, launchd, Termux:Boot), reconnecting |
| install | deployed and verified at each start | installed once, signed updates |
| machine identity | SSH host key | a hand key pair, enrolled once |
| connections | one per session and use | one per hand and server, multiplexed |

- **Enrollment:** `p3 hand enroll <server>` shows a code; the owner approves it in the UI (the app kit's device
  pairing); the server pins the hand's public key; fingerprints shown on both sides. Revocation in a Hands panel.
- **Reachability:** a hand reaches the owner's own server directly (LAN, own tunnel) or through Radius, which relays
  hands to whichever host drives a session (the upsell: no tunnel to set up; Radius can also offer sandboxed machines
  and hands of its own).
- **Protocol:** p2's daemon protocol over the WebSocket, unchanged in shape; two changes: several sessions share one
  connection (cancellation, handles and backpressure per session), and a disconnect starts a grace period instead of
  killing everything (detached commands and PTYs reattach on reconnect; this moves the terminal host's job into the
  hand).
- **Binding:** a session's location becomes `{ hand, cwd }`; one server object holds the hand connections and the
  `HarnessEnvironments` entry resolves a hand id to an execution environment; workers reach hands through the server's
  links. An SSH machine stays possible as a hand kind the server dials.
- **Offline:** an operation needing an offline hand fails with a clear error the model sees; the hand's status shows
  in the session list.

# Session Sync and the Index {#sync lede="What was decided yesterday, and the three gaps it leaves."}

## Decided

The worker updates the session index from events and sends it to the server; sessions sync to R2 through Radius:
Radius reports per session its last sequence number, pi uploads the commit log from there; R2 holds the SQLite file
and the commit log, a SQLite Durable Object applies them; sessions have an owner id; the index is a Chord table
replicated like a session, its row updated only on metadata, session idle and subagent idle changes.

Chord v2 has the pieces: a versioned outbox written in each commit's transaction, export archives, batch apply that
refuses gaps and divergence, export and import per address (app kit). Missing (the sync layer): upload and trim,
epochs, pull-back after a power loss, the split, starting from an archive.

## Gap 1: who is the driver

Two machines both write session X (the laptop resumed it while Radius continued it). Both ask Radius for its last
seq, both upload from there; Radius applies whichever arrives first and refuses the other as "not following". The
copies have now diverged and nobody knows.

**Proposed:** a driver epoch per session, handed out by Radius. An upload names its epoch; an old epoch is refused;
the refused copy becomes a new session (Chord's rule S7: a split, never a rollback, because tools already ran).
"Continue on Radius" is an epoch change: the local driver waits for idle, uploads the tail and the session's files,
Radius bumps the epoch and starts the agent from its store, the local side becomes a replica or closes. Back is the
reverse.

## Gap 2: two writers of the index

When a session continues on Radius, Radius writes its index row, and so does the local server.

| Option | How | Cost |
| --- | --- | --- |
| a. one index per writer | each host keeps its own index, Radius merges per owner, newest epoch wins per row | a second merge rule |
| b. rows derived from session stores | every host computes a session's row from the session's own commits | no index sync at all; each host needs the session's commits |
| c. rows tagged `{ epoch, seq }` | Radius keeps the highest per row | rows must carry their source position |

**Recommended:** (b) where the session's commits are present (Radius has them all), with (c)'s tag on the rows a local
server writes for sessions it drives, so a list without the session store still sorts correctly.

## Gap 3: what else moves

Files outside the store (uploads, sent files, the app kit's `Files`) must sync as blobs before the batches naming
them, R2 as their home. Model access and secrets for a session continued on Radius: Radius's own models, or the
owner's provider keys stored on Radius (decide). Local prompt resources (the device's `AGENTS.md`, skills) must be read
through a hand or synced. Closed sessions have no worker: the server reads a session's outbox without starting it, or
starts it to sync.

## The sync example

`packages/chord/test/next/examples/60-session-sync/` (uncommitted, in `/home/badlogic/pi-sync-ex`) plays the decided
protocol with Chord's real store pieces (the outbox, `applyBatch`, export archives) and a small in-memory stand-in for
Radius. Its output, step by step:

```text
1. laptop s1: lastSeq 4 outbox floor 0
2. sync: uploaded 1..4, Radius at 4, trimmed through it
3. laptop s1: lastSeq 6 - sync: uploaded 5..6, Radius at 6, trimmed through it
4. laptop s2: lastSeq 3 outbox floor 3 - sync: archive uploaded (737 bytes), Radius imported it at 3
   laptop s2: lastSeq 4 - sync: uploaded 4..4
5. Radius takes over, epoch 2; Radius writes seq 7
   stale laptop: lastSeq 7 - push: refused for an old epoch: this copy is now s1~split@6
5b. no epoch check - stale push: refused: does not follow seq 7
   stale sync: nothing to send, Radius at 7 - outbox floor 7       (its own commit 7 trimmed)
   stale:  ... 5 assistant: (stale laptop) added a different test
   Radius: ... 5 assistant: (on Radius) added a test                (same seq, different data)
6. laptop takes epoch 3, pulls 7..7: same values: true; its next commit syncs at epoch 3
```

:::sequence animate | The decided handshake (steps 1-3), then continuing on Radius (5) and back (6).
actor laptop "laptop" "driver, epoch 1" accent
actor radius "Radius" "replica per session"
laptop -> radius: which sessions do you have?
radius --> laptop: s1 at seq 4, epoch 1
laptop => radius: commits 5..6 (epoch 1)
radius --> laptop: s1 at seq 6 (acknowledged: trim through 6)
divider "continue on Radius"
radius -> radius: epoch 2, Radius drives, writes seq 7
laptop -> radius: commit 7 (epoch 1)
radius --> laptop: refused: old epoch (the copy splits)
divider "back to the laptop"
laptop -> radius: take epoch 3
laptop => radius: pull 7..7, apply
:::

What it shows: the handshake works and only the tail moves; a session Radius lacks starts from an archive; without
epochs a second writer's commit is lost silently (5b), with them it splits; taking a session back is a pull plus an
epoch. One more finding: `applyBatch` refuses while a host holds the store open, so the sync layer stops the session's
worker, applies, restarts it (decided 2026-11-02: usually nothing runs at that moment). The example lists nine things
its stand-ins fake that the sync layer must build (authenticated handshake, persisted epochs, the batch wire format,
retries, streaming bootstrap with files, the DO and R2 side, the continue fence, the split's new id, pull-back after a
power loss).

# Branches and Subagent Context {#branches lede="pi's /tree, fork and clone, and subagents that start from the parent's context."}

pi branches three ways; p2 has two, in the TUI only:

| pi | What it does | p2 |
| --- | --- | --- |
| `/tree` | branch inside the session: pick an earlier message, edit and resubmit; the old branch stays; leaving a branch can summarize it into the one entered | missing |
| `/fork` | a new session from an earlier user message | TUI only, main conversation only |
| `/clone` | a copy of the active branch as a new session | TUI only |

Durable already has the building block: `conversation.fork(at)` creates a conversation in the same session store that
shares every entry up to `at`, without copying. Proposed for p3:

- **Base:** editing an earlier message forks the conversation there (an in-session branch); a branch list switches
  between them; fork and clone to a new session; all in the web and the TUI.
- **Later:** a full tree navigator and branch summaries.
- **Index and sync:** branches are conversations inside one session store, so sync carries them for free; the index
  marks the active branch and tells branches from subagents.

**Subagents with the parent's context** (owner, 2026-11-02): `subagent({ action: "spawn", ..., context: "inherit" })`
forks the parent conversation at the last entry before the assistant message holding the spawning call. The child
knows everything the parent knew; its model, tools and location may differ; with the same model the shared prefix is
usually a prompt-cache hit, otherwise it is paid in full (the tool's description says so). Base in p3.

# Tools Built In {#tools lede="p2's 21 model-facing tools, and which ship with p3."}

| Tool | p2 plugin | Proposed |
| --- | --- | --- |
| `read`, `write`, `edit`, `bash` | coding-tools (Durable) | base |
| `powershell` | powershell | base (deferred tool, Windows hands) |
| `codemode` | codemode | base |
| `agent` (from scripts) | agent | base |
| `subagent`, `team` | subagents | base |
| `conversations` | conversations | base |
| `history_search`, `history_read`, `history_handoff` | history | base |
| `location_envs`, `location_dirs`, `location_move` | locations | base, renamed around hands (`hands`, `hand_dirs`, `move`) |
| `rename_session` | sessions | base |
| `send_file` | send-file | base (on the app kit's `Files`) |
| `artifact` | artifacts | later (owner: maybe not as useful) |
| `ports` | ports | later (with forwards) |
| `reload_plugins` | dev-tools | base as an "apply changes" tool for the owner, not tied to a checkout |
| `tool_search` | Durable | later (with MCP) |

Every tool is a plugin in the app's own root, so any of them can be removed, replaced or added without touching base
code (the app kit's rule: base code is the API, bootstrap and a start-data facet).

# Running p3 {#running lede="Starting the server, the CLI, themes and keybindings."}

## The CLI (proposed)

One binary, `p3`, and no environment variables (app kit decision); settings are arguments or files in the data
directory.

| Command | Does |
| --- | --- |
| `p3 serve [--data-dir <dir>] [--host <addr>] [--port <n>]` | starts the server (`startServer`); prints the one-time owner link |
| `p3 owner-link` | prints a new owner link for a running server (through the owner token file) |
| `p3 tui [url] [--pair]` | the sandboxed TUI; on the same machine it uses the owner token file, elsewhere device pairing |
| `p3 hand enroll <url>`, `p3 hand run` | enrolls this machine as a hand, runs it (or installs a service) |
| `p3 radius login` | signs the server into Radius (device code) |
| `p3 install <git:...|npm:...>` | installs a plugin into the user's root |
| `p3 export <session> <file>`, `p3 import <file>` | the app kit's `exportData`/`importData` (a running session is not stopped) |

The data directory defaults to `~/.p3`. Its files: `settings.json`, `models.json`, `auth.json` (locked),
`AGENTS.md`, `skills/`, `prompts/`, `plugins/` (the user's root), the server store, a directory per session worker,
`owner-token`, `logs/`. Plugin-specific configuration moves into plugin objects (documents) instead of more files.

## Themes and keybindings

Themes follow the looks-and-themes proposal (decided 2026-11-02): design tokens as CSS variables on the web, roles in
the TUI, one `Themes` registry plugins contribute to, one dark and one light choice per user. Keybindings: commands are
registry entries with default keys (p2's `TuiCommands` with `when` conditions, 78 binding ids); the user's overrides
live in a preferences document (per user, synced like any data), not in files on each client; the web gets the same
command registry with its own key handling.

# The Plugin API {#api lede="The smallest surface that still expresses everything the coding agent's extensions do."}

## The rule

Offer few things, each stable: what an API offers, it must keep (versioned in the import path, `@p3/app/v1`). Every
cluster below is a registry or a contract that already exists in Chord, Durable or p2; p3 v1 publishes those and
nothing else. Legacy concepts of the old extension API are not carried: CLI flags, an event bus, RPC-mode UI, `hasUI`
checks, "destructive switch" gates, `pi.exec` running locally regardless of the environment.

## Seven clusters

| Cluster | Host | Mechanism | Covers |
| --- | --- | --- | --- |
| A. The agent's turn | worker | Durable's `Extension` in `HarnessExtensions`: tools, `beforeTool`/`afterTool`, `beforeRequest`, sections, wraps, `onYield`, `afterRun`, `beforeCompact` | 20 examples: hello, permission-gate, protected-paths, tool-override, plan-mode, todo, custom-compaction, ... |
| B. Conversation control | worker object | a `Conversation` contract: `submit`, `configure`, `append` (typed entries), `compact`, `fork`, `rename`; state: busy, agent, usage | send-user-message, file-trigger, session-name, preset, handoff, qna, ... |
| C. Input | worker | `InputTransforms` registry (rewrite or answer input before the model) | input-transform, inline-bash |
| D. Environments and models | worker, server | `HarnessEnvironments` (ssh, gondolin, hands as kinds), `HarnessModels` (providers, virtual models), `LoginProviders` | ssh, gondolin, custom providers, jev-router |
| E. Asking the user | server object, UI renderers | `Questions.ask` from worker code; `QuestionKinds` per UI kind | permission-gate, question, questionnaire, timed-confirm, project-trust |
| F. UI | tui, web | registries: `Commands` (slash, palette, keys), `ToolRenderers`, `EntryRenderers`, `Slots` (header, footer, status, widgets), overlays through the UI context, editor extension points | every UI-only example, the games |
| G. State and standing behaviour | any | `local` objects owning natives, documents for state | file-trigger's watcher, gondolin's VM, game saves |

```ts
// a plugin with a tool, a gate and a renderer: plugins/todo/
// worker.ts
self.contribute(HarnessExtensions, { name: "todo", tools: [todoTool], hooks: [hook(ToolTask, { beforeTool: guard })] });
// tui.ts
self.contribute(TuiToolRenderers, { todo: { call: (args) => todoCall(args), result: (r) => todoList(r.details) } });
self.contribute(TuiCommands, { "todo.show": { slash: { name: "todos" }, run: (ui) => ui.overlay("todos", new TodoView(ui)) } });
// web.tsx: the same registries with React components
```

## The litmus test

All 78 examples map onto the seven clusters (table in `/tmp/p3-prep/extensions.md`). The examples that mix agent and
UI split into a worker facet and a tui/web facet sharing a contract file: a tool that wants a dialog asks the
`Questions` object, which works from any client, several clients or none.

- **Snake, Space Invaders, tic-tac-toe:** a command plus an overlay in `tui.ts` and a canvas in `web.tsx`, engine in a
  shared file, saves in a user-keyed document. Fit today.
- **Doom:** fits with two fixes in the TUI: the sandbox bridge caps a frame at 64 KiB and a Doom frame is about 160 KB
  (split writes at escape boundaries), and the sandbox has no files or network, so large plugin assets (a 4 MB WAD)
  need a documented "asset of my plugin" path (chunked reads through the plugin's server facet).
- **Does not fit, by design:** streaming 35 FPS frames from a worker to clients (objects carry state; needs channels),
  engine state surviving an in-place reload (needs an explicit save), raw terminal ownership (`interactive-shell`
  becomes a terminal view; terminal notifications need a launcher action).

## What v1 leaves out

Editor replacement (extension points only), raw provider stream events and response headers, a fork hook, a
`turn_start` hook, an event bus. Each has one or two examples; add when a real plugin needs it.

# Work Packages {#packages lede="A first cut, in dependency order, for the meeting to rearrange."}

| # | Package | Contains | Depends on |
| --- | --- | --- | --- |
| 1 | p3 skeleton | `startServer` with p3's API v1 modules (shared, web, tui, worker), core plugins in the app's root, `p3` CLI | Chord slices 11-13 |
| 2 | Sessions and conversations | Durable on the Chord store, session lifecycle with delete, the conversation contract, subagents, history and handoff, code mode, shell commands | 1 |
| 3 | Session index | the index table, worker-to-server updates on metadata and idle changes, the session list, search over it | 2 |
| 4 | Session sync to Radius | outbox upload and trim, epochs, pull-back, split, files as blobs, continue on Radius and back | 2, 3, Radius side |
| 5 | Radius side | per-session SQLite DO, commit log and SQLite on R2, epochs, the sync handshake, hand relay | with 4 |
| 6 | Hands | daemon as an outbound service, enrollment by pairing, multiplexed protocol, reattach after disconnects, server hand pool, `HarnessEnvironments` kind, SSH as a hand kind | 1 |
| 7 | Web shell | p2's layout and flows rebuilt on slice 11 ("look and feel great"), themes | 1, slice 11 |
| 8 | TUI | p2's TUI on slice 11's sandbox, frame splitting, plugin assets path, keybindings and themes | 1, slice 11 |
| 9 | Models and settings | catalog, credentials, provider login flows, settings, prompt resources | 1 |
| 10 | Workspace | files, git, diffs, search, review comments, file index and `@`, through hands | 6 |
| 11 | Plugin API v1 and docs | the seven clusters published in `@p3/app/v1`, authoring guide, ported examples as the litmus (hello, permission-gate, todo, plan-mode, snake, doom) | 1, 2, 7, 8 |
| 12 | Access and status | owner, devices and pairing (app kit), notices, logs, status and presence | 1 |

Later: voice, terminals (channels and hands), artifacts, port forwards, chat mode and guest sharing, MCP and
`tool_search`.

# Open Questions {.epilogue lede="To decide in the meeting."}

1. The proposed cut: base versus later per area (first table).
2. Driver identity: epochs per session, handed out by Radius, with splits on conflict?
3. The index with two writers: derived rows plus `{ epoch, seq }` tags, or one of the other options?
4. Who syncs a closed session (the server reading its outbox, or starting its worker)?
5. Files outside the store as blobs on R2, uploaded before their batch?
6. Models and secrets for sessions continued on Radius: Radius's own models, or the owner's keys stored there?
7. Hands: through Radius as a relay to the driver, and may one hand serve the local server and Radius at once?
8. Do hands keep commands and terminals alive across disconnects (absorbing p2's terminal host)?
9. Hand install and updates: signed binary, service install, version negotiation.
10. Is SSH kept as a hand kind for machines without a service?
11. Plugin API v1: the seven clusters as listed, and what is explicitly left out?
12. Work package owners and order.

# Sources {.appendix}

| Source | What |
| --- | --- |
| `/tmp/p3-prep/features.md` | p2's feature areas with files, sizes, tools, rough edges; the CLI, environment variables and data files |
| `/tmp/p3-prep/extensions.md` | all 78 extension examples, the capability matrix, the clusters with sketches, the hard cases |
| `/tmp/p3-prep/envs.md` | p2's environments and Radius link, Chord's sync pieces, the sync and hands sketches, open questions |
| `apps/p2/docs/p3-functions/` | the functionality map (partly outdated) |
| `packages/chord/docs/next/` | design, decisions (2026-11-02 meeting summary), app kit and plugin model, theming |
