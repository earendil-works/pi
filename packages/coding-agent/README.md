<p align="center">
  <a href="https://pi.dev">
    <img alt="Pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square&logo=npm&logoColor=white" /></a>
</p>

> New issues and PRs from new contributors are closed automatically. Maintainers review closed submissions daily. See [CONTRIBUTING.md](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md).

# Pi

Pi is a minimal, extensible agent harness that you can make your own.

Adapt Pi to your workflows, not the other way around. Customize Pi with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Pi packages](docs/packages.md) and share via npm or git.

This fork includes native search, document and web reading, persistent background jobs, context compaction, configurable sub-agents, and retrievable output artifacts. Extensions remain available for other workflows.

Use Pi [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Pi TypeScript SDK](docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install the command-line interface:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

On Windows:

```shell
powershell -c "irm https://pi.dev/install.ps1 | iex"
```

The installer pins all dependencies and updates Pi with `pi update`. Alternatively, install directly with npm, which does not pin transitive dependencies:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi requires Node.js 22.19 or newer. The macOS, Linux, and Windows installers can install it if needed. Pi does not require dependency lifecycle scripts for a normal npm installation.

On macOS and Linux, Nix users can install the latest release with `nix profile add github:earendil-works/pi/stable`. See the [quickstart](docs/quickstart.md#1-install-pi) for updating and pinning releases.

Start Pi in the directory where you want it to work:

```bash
cd /path/to/project
pi
```

For a built-in AI provider, run `/login` inside Pi to connect a subscription or API key. Then give Pi a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Share your OSS coding agent sessions

If you use Pi for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf) using a Hugging Face account and the Hugging Face CLI.

- [Demo video](https://x.com/badlogicgames/status/2041151967695634619) on how to publish Pi sessions
- Published Pi development sessions: [`badlogicgames/pi-mono` on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono).

## Development

Clone the repository, install its dependencies, and run Pi from source:

```bash
git clone https://github.com/earendil-works/pi
cd pi
npm install --ignore-scripts
npm run build:native:search
./pi-test.sh
```

`pi-test.sh` can be called from any directory and preserves the caller's working directory.

Source builds of `grep` and `find` require Rust and a C compiler. `npm run build` also builds their shared Node-API addon; published packages include native prebuilds and need no Rust toolchain or install-time scripts.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [CONTRIBUTING.md](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md) before opening an issue or pull request. It defines the contribution gate, issue quality bar, and required checks. Read [AGENTS.md](https://github.com/earendil-works/pi/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## Document and web reading

The built-in `read` tool also handles PDFs, HTTP(S) URLs, and local SQLite databases. Its normal file, image, and artifact arguments remain available; the default system prompt includes the new capabilities.

| Read | Arguments |
| --- | --- |
| PDF text, selected pages | `{"path":"report.pdf","pages":"3-5,8","format":"text"}` |
| PDF page images | `{"path":"report.pdf","pages":"3-4","format":"images"}` |
| Clean web Markdown | `{"path":"https://example.com/article"}` |
| Explicit JavaScript rendering | `{"path":"https://example.com/article","strategy":"browser"}` |
| SQLite schema | `{"path":"app.db"}` |
| Table rows | `{"path":"app.db","table":"events","rowOffset":0,"rowLimit":100}` |
| Parameterized read-only SQL | `{"path":"app.db","query":"SELECT * FROM events WHERE kind = ? ORDER BY id","params":["error"]}` |

PDF text has page markers; empty/scanned pages are identified rather than claimed as extracted. No OCR is performed. Text defaults to all pages (maximum 1000 per call); images default to page 1 (maximum 10 selected pages, rendered at up to 1600 pixels per side). Local PDFs are capped at 64 MiB. Password-protected or malformed PDFs return errors.

Web reads negotiate Markdown/plain text first, otherwise use Readability with a semantic DOM fallback. Links, code blocks, and tables survive conversion. `format:"text"` requests plain HTML text. Login pages and JavaScript shells are reported as partial/unreadable, not silently presented as complete. HTTP reads follow at most five HTTP(S) redirects, reject URL credentials, and bound downloaded bodies to 16 MiB (64 MiB for PDF MIME responses). Fetches, redirects, and retries share a 20-second network deadline. A 403 gets one retry with a browser User-Agent; a 429 gets one retry with the same User-Agent after `Retry-After` (one second if absent/invalid), only if the delay fits both the remaining deadline and a 10-second retry budget. Recognized challenge pages, including HTTP 200 interstitials, are reported as blocked/unreadable rather than document content. Errors report attempted retries and suggest explicit browser rendering where appropriate; no browser starts automatically.

`strategy:"browser"` is never selected automatically. It uses installed Chrome/Chromium with sandboxing enabled and a **persistent Pi-owned profile per project working directory**, never your personal browser profile or its login. Pi processes using the same canonical working directory and agent directory share that browser, cookies, and site storage; different projects have separate profiles. Each read gets its own tab, closed on completion or cancellation. A local broker starts on first browser use and closes Chromium after the last owning Pi process disconnects. It never downloads a browser or uses a third-party extraction service. Set [`read.browserExecutablePath`](docs/settings.md#document-reading) to override executable discovery; close Pi processes using the project before changing its browser or proxy settings. Browser rendering executes the site's JavaScript; use it only for sites you intend to visit.

Profiles live under `<agent-dir>/browser/<project-hash>/` (normally `~/.pi/agent/browser/`) and survive browser/Pi restarts. They can contain sensitive cookies, login state acquired inside Pi, cache, and local storage, with no automatic expiry. New profile directories are owner-only on POSIX; Windows inherits directory ACLs. To reset a profile, first close every Pi process using it, then remove that project's profile directory. The broker authenticates its control connections; Chromium's separate loopback debugging endpoint is still accessible to local programs, so treat access to this machine as access to the Pi-owned browser. No personal browser is attached, no stealth scripts are injected, and persistence does not guarantee bypassing bot protection.

SQLite opens an engine-enforced read-only snapshot per call. SQL must fit a single SELECT/WITH subquery; writes, attachments, extension loading, and trailing statements are rejected. Rows default to 100, maximum 1000; follow `nextRowOffset`. Table pages use primary-key ordering when available; supply `ORDER BY` in custom queries for predictable pagination. Pages are separate database snapshots, so concurrent writers can change later pages. Unsafe integers remain decimal strings and blobs are tagged base64. Result bodies are bounded to 4 MiB before formatting.

Document extraction runs in cancellable helper processes with a 30-second deadline, including browser startup and tab acquisition. Cancelling a browser read closes only its leased tab; other reads and Pi processes keep their shared browser. Extracted text is capped at 8 MiB with explicit errors rather than silent omission. In sessions, oversized results use the shared artifact budget. Supplying text-line `offset`/`limit` saves the full extracted snapshot and returns a stable artifact continuation: follow that URI instead of fetching or parsing again. These snapshots have the same sensitive-data retention policy as other artifacts.

Custom filesystem adapters can supply PDF bytes for `.pdf` paths. They do not implicitly grant host network/browser access or host SQLite access: URL and SQLite reads fail unless the adapter explicitly routes them. The SSH/Gondolin examples preserve that boundary.

## Output artifacts

Oversized tool text is retained outside chat JSONL. The model receives a bounded preview and an `artifact://...` reference; `read` retrieves selected lines with `offset`/`limit`, or continues a long line with the returned `byteOffset`. Built-ins, extension tools, and MCP results share an adaptive inline budget. Images stay attached, and nested programmatic callers keep their structured results.

Shell output starts spilling while the command runs rather than waiting for completion. Persistent-session artifacts survive restart and compaction, with separate main/child namespaces; temporary sessions use process-owned temporary storage. Captures can contain sensitive data and are not automatically expired. See [Output artifact settings](docs/settings.md#output-artifacts) and [storage and retention](docs/session-format.md#output-artifacts).

## Native search

`grep` searches file contents; `find` searches paths with globs. Both are enabled by default and use an in-process Rust addon, not `rg`/`fd` subprocesses. The default system prompt directs the model to prefer these tools over shell searches. Explicit tool selections and resumed sessions' recorded tool selections still take precedence.

- Both accept semicolon-delimited scopes and `!` exclusions, such as `src;test;!*.generated.ts`. Directory exclusions also apply to explicitly selected directory roots and their excluded ancestors. Explicitly named files remain searchable even when ignored or excluded from directory walks. Set `gitignore: false` to include ignored entries.
- `grep` supports lookaround/backreferences through automatic PCRE2 fallback, `\n` multiline patterns, and file line selectors such as `src/app.ts:50-100`. It returns 20 files per page, with up to 20 matches per file; use `skip: 20` for the next file page. A single-file search returns up to 200 matches. `limit` overrides the total match budget. Context defaults to one line before and three after; `context: 0` disables it. Long lines show the first match's window and original character column.
- PCRE2 uses JIT when supported, with each JIT stack capped at 10 MiB. Multiline searches validate UTF-8 subjects once and reuse compiled match state for JIT or interpreter calls. Malformed subjects and restarts inside a multibyte character retain the existing matcher's checked path.
- Grep's `glob` filter also accepts negation: `glob: "!*.test.ts"` excludes matching files, and `glob: "!generated"` prunes matching directory subtrees. These filters are relative to each search root.
- `find` keeps its optional `pattern` filter and also accepts globs directly in `path`. Bare `*.ts` searches recursively; `src/*.ts` matches direct children. Shallow scopes and positive filters bound traversal to their matching depth; missing fixed directory prefixes are reported without scanning broader ancestors. Results are newest-modified first, with a default limit of 200. `hidden: false` excludes dotfiles. Directory discovery lists symlinks, including dangling links, without traversing them; explicitly selected dangling link paths are also accepted. Grep does not follow symlinks discovered during a directory scan.
- Selected search-page text uses the shared artifact budget in sessions; standalone factories retain a 50 KiB display cap. Both tools support cancellation. Native scans have a 30-second deadline. Directory traversal failures fail the search; missing scopes and individual grep files that cannot be searched are reported with notices rather than presented as complete coverage.
- Grep input buffering is limited to 64 MiB, with a separately bounded pending-context window for streaming searches. Ordinary short-line searches stream larger files, but multiline searches buffer the full decoded file and very long lines require buffering. Multiline matching preserves the complete subject for lookbehind. Both paths retain BOM-marked UTF-8/UTF-16 decoding, including final replacement characters at buffer boundaries. Exceeding the budget fails an explicitly selected file; directory scans skip the file with a notice. Line selectors limit matches and context, not multiline input buffering.
- The [SSH extension example](examples/extensions/ssh.ts) disables and guards local `grep`/`find` in SSH mode. Use its remote `bash` tool for content and filename searches.
- The [Gondolin example](examples/extensions/gondolin/index.ts) keeps its guest backend: one guest path, JavaScript line-based grep, and Node glob file discovery in traversal order. It does not expose native PCRE2, multiline search, line ranges, multi-scope paths, pagination, or `.gitignore` options. Find returns basenames for file roots and root-relative paths for directory searches. Its `hidden: false` prunes hidden entries; Node glob dotfile rules still apply, so dotfile names require explicit dot patterns. Use guest bash for unsupported searches.

## Background jobs

Ask the agent to start persistent work with `bash` using `async: true` and an optional `name`. Bash remains synchronous unless requested otherwise. A launch acknowledgment is not completion: the `jobs` tool lists, inspects, reads logs, stops, renames, restarts, and deletes jobs.

Unnamed submissions receive a short background-generated name using the active model and loaded [Markdown naming instructions](docs/sessions.md#automatic-names). Explicit names and manual renames win. The ID does not change; open views and minimized Rex pane labels update when the name arrives. Automatically named restarts get a fresh name for their command.

Jobs have independent supervisors and survive pi exit/restart. Their private records and complete combined stdout/stderr logs live under the agent directory's `jobs/` folder, until explicitly deleted. Commands and output are retained; avoid putting secrets in them. Environment variables are inherited by the worker but are not copied into its metadata. Restart creates a new job ID with the current environment and keeps the old job's records. Stop a job before deleting it.

Use `/jobs` for the current project's list or `/jobs <full-id>` for live output and controls. Enter opens details; Escape returns to the list, then closes the view. Default controls: Ctrl+S stop, Ctrl+R restart, Ctrl+N rename, Ctrl+E replace the command and restart, Ctrl+D delete, and Alt+M minimize. Bindings are configurable through `app.jobs.*` and `app.pane.minimize`. PageUp/PageDown scroll the bounded log tail; its full file remains available. These are log/control views, not interactive job terminals.

A job can report real progress by atomically publishing JSON such as `{"percent":42,"message":"Indexing"}` to the path in `PI_JOB_PROGRESS_FILE` (temporary file, then rename; maximum 16 KiB). `PI_JOB_ID` identifies it. Without a valid report, views show activity and elapsed time, not an invented percentage. `timeout` on async bash bounds the job's execution, not just its launch.

Local async bash does not replace custom remote execution adapters or PowerShell. Those backends reject async mode instead of silently launching the command locally.

## Native sub-agents

The default `subagent` tool discovers roles and starts, lists, inspects, messages, resumes, waits for, cancels, and deletes children. `start` is synchronous unless `async: true`; async returns an acknowledgment, then automatically displays a bounded completion result. It does not start an extra parent-model request while idle. Use `wait` when the parent must consume a child's result before finishing.

Each child owns a separate session log, not a branch of the main conversation. Only bounded results and metadata return automatically; full tool traces remain in child history. `history` pages visible text, tool calls/results, and failure diagnostics; follow `nextOffset`. Role/run lists return `nextSkip` when more entries remain. Child usage is reported separately from the parent's own model usage.

Use `/agents [full-id]` to choose a role, start a task, or inspect its history. Ctrl+N starts, Ctrl+E steers, Ctrl+R resumes, Ctrl+S stops, and Ctrl+D deletes a finished child's history. Enter opens details; Escape returns to the list and then closes the view. Closing the view does not stop its children. Bindings use `app.agents.*`.

The view shows role-specific icons (Nerd Font glyphs with the `nerd` icon preset) and small `•` status dots: blue working, green completed, red failed/interrupted, yellow queued, and gray stopped. Short task labels replace response previews; costs are not displayed.

Each task, including a resumed or manually submitted task, makes one separate background request to the child's model to generate its label. A task-derived placeholder appears immediately. Agent work starts alongside the request; final completion waits for it to settle, with a 30-second deadline and shared cancellation. Title usage is charged to the child, while title prompts and raw replies are not appended as conversation messages. If generation fails, the task continues with its placeholder and details show the label error.

Task labels follow the parent's loaded Markdown naming instructions as well as the role's instructions. [Automatic names](docs/sessions.md#automatic-names) explains the shared policy for chats, jobs, and delegated tasks.

Built-in roles are `worker`, `scout`, `reviewer`, and `planner`. The last three allow only read-only local tools, without bash. User roles live in `~/.pi/agent/agents/*.md`; the nearest ancestor `.pi/agents/*.md` overrides user/built-in roles by name. For example:

```markdown
---
name: security-reviewer
description: Review authentication boundaries without modifying files
tools: read, grep, find, ls
---
Report concrete defects, affected paths, and verification limits. Do not change files.
```

`model` and `thinkingLevel` optionally override the current selection. Omitted `tools` inherits the parent's active local built-ins; configured tools are intersected with that selection. Parent extension tools and remote/guest adapters are not inherited. Project roles require trust or interactive approval; malformed role files disable new launches rather than silently falling back to broader permissions.

Fresh conversation context is the default, while normal repository instructions still apply. `context` supplies explicit background; `contextMode: "snapshot"` quotes the active parent conversation and its original image attachments in the child's own log. Subsequent parent messages are not inherited. Children cannot recursively invoke native delegation.

Children share the working tree, so assign non-overlapping file ownership. Up to four run concurrently by default; set `subagents.maxConcurrent` to a positive safe integer to change this. Excess tasks queue. Pi shutdown/reload/session replacement stops and drains owned children; saved children can be resumed through their original parent's controls. They are not detached workers like background jobs. With `--no-session`, their histories stay in memory.

SDK hosts can own a `SubagentManager` directly and must await `close()` before disposing its parent/runtime. Alternatively, register `createSubagentExtension()` through the resource loader and await the canonical `session_shutdown` lifecycle event before parent disposal. `AgentSessionRuntime` handles that lifecycle; bare `dispose()` is not an asynchronous drain. See [Session storage](docs/session-format.md#native-sub-agent-history) for ownership and retention.

Direct manager hosts supply `SubagentManagerOptions.getSystemPrompt()` with the parent's effective loaded instructions for label generation.


## Rex and shared views

`/jobs`, `/agents`, and `/btw` use [Rex](https://www.superlogical.com/rex/docs/automate/cli) when pi inherits a Rex session and block, otherwise a pi overlay. `/settings` controls their defaults:

| Setting | JSON key | Default | Behavior |
| --- | --- | --- | --- |
| Rex views | `rex.enabled` | on | Use Rex for new shared views; off uses pi overlays. This does not disable the agent's general `rex` tool. |
| Rex mode | `rex.mode` | `floating` | Open manual views as floating windows or regular side-by-side `split` panes. |
| Minimized Rex jobs | `rex.minimizedJobs` | on | Give each newly submitted background job its own minimized floating pane, without moving focus. Off creates no automatic view. |

Automatic job views cover async bash and restarts through the `jobs` tool or job controls. They always use floating panes, independently of the manual-view mode. They require Rex views to be enabled and an inherited Rex context; missing/unavailable Rex never opens an automatic fallback overlay or changes job execution. Foreground bash is unchanged. Job labels include their short ID and name.

Choose explicitly with `--tui` or `--rex`, choose Rex placement with `--split` or `--floating`, and start minimized floating views with `--minimized`. Flags override the stored defaults; `--minimized` implies floating placement unless a conflicting `--split` is supplied. A manually requested unavailable Rex backend falls back to the overlay. Existing views are not moved or closed by settings changes. Run the same command again to restore an existing view. Closing a job view does not stop the job.

The agent's `rex` tool exposes the installed CLI, including sessions, windows, splits, floating layers, minimization, captures, input, and connected apps. It passes an argument array directly, without shell interpolation. Its prompt guidance directs the agent to read the installed Rex guide and discover version-specific APIs before use. A timed-out CLI mutation may still have succeeded; inspect state before retrying.

The SDK exports `JobManager`, `createJobsToolDefinition`, `createJobsExtension`, `createRexExtension`, `createBtwExtension`, `createSideSession`, and the reusable `openPane` host with `PaneView`/`PaneHandle` types. CLI built-ins load by default; SDK hosts opt into extension factories through their resource loader. Existing selectors and other overlays are unchanged.

`createAutoNameExtension()` gives unnamed chats a generated title once after their first completed answer. Explicit session names are protected. Naming calls are separate from chat history, and their delivered usage is recorded.

Custom UI hosts implement `getRexSettings()` using their active session's settings manager; it returns the read-only `RexViewSettings`. `PaneHandle.placement` reports `floating`/`split` for Rex and `undefined` for TUI views. Rex-only `openPane` callers can combine `backend: "rex"` with `fallback: "none"` when a background presentation must not open an overlay.

## Temporary side conversations

Use `/btw [question]` for a fresh, in-memory conversation seeded from the current main branch. An unfinished main tool round is omitted rather than supplied with fabricated results. The side agent uses the selected model and thinking level, but only the built-in `read`, `grep`, `find`, and `ls` tools—not bash, writes, jobs, Rex, or extension tools.

Follow-ups stay in that view, including questions queued while it answers. Escape cancels an active answer; when idle, Escape or `/close` discards the side conversation. `/btw` restores an existing side view. Side turns do not become main-history entries or saved pi sessions; closing the view aborts its work and clears its conversation. Rex terminal capture/scrollback is controlled by Rex, not by pi's session storage.

The header uses the shared chat icon: Nerd Font `U+F075` when Icons is `nerd`, with a plain question-mark fallback for the Unicode preset.

## Context compaction

Pi prepares a summary in the background at 75% context usage and applies it at 85%, waiting before the next model request if necessary. All messages after the frozen boundary stay verbatim; old tool outputs leave active context only when covered by compaction. Original session history is retained.

The default `recall_context(checkpoint_id, query)` tool uses a read-only helper to recover missing details from that history, with original message citations and additional model-call costs. Percentages and the 8000-token summary cap are configurable. `/compact` and extension hooks remain available. See [Compaction](docs/compaction.md) for settings, checkpoints, recall, and migration from `compaction.reserveTokens`.

## License

MIT
