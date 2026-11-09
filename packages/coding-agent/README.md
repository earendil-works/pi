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

Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that does it your way.

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

## Native search

`grep` searches file contents; `find` searches paths with globs. Both are enabled by default and use an in-process Rust addon, not `rg`/`fd` subprocesses. The default system prompt directs the model to prefer these tools over shell searches. Explicit tool selections and resumed sessions' recorded tool selections still take precedence.

- Both accept semicolon-delimited scopes and `!` exclusions, such as `src;test;!*.generated.ts`. Directory exclusions also apply to explicitly selected directory roots and their excluded ancestors. Explicitly named files remain searchable even when ignored or excluded from directory walks. Set `gitignore: false` to include ignored entries.
- `grep` supports lookaround/backreferences through automatic PCRE2 fallback, `\n` multiline patterns, and file line selectors such as `src/app.ts:50-100`. It returns 20 files per page, with up to 20 matches per file; use `skip: 20` for the next file page. A single-file search returns up to 200 matches. `limit` overrides the total match budget. Context defaults to one line before and three after; `context: 0` disables it. Long lines show the first match's window and original character column.
- PCRE2 uses JIT when supported, with each JIT stack capped at 10 MiB. Multiline searches validate UTF-8 subjects once and reuse compiled match state for JIT or interpreter calls. Malformed subjects and restarts inside a multibyte character retain the existing matcher's checked path.
- Grep's `glob` filter also accepts negation: `glob: "!*.test.ts"` excludes matching files, and `glob: "!generated"` prunes matching directory subtrees. These filters are relative to each search root.
- `find` keeps its optional `pattern` filter and also accepts globs directly in `path`. Bare `*.ts` searches recursively; `src/*.ts` matches direct children. Shallow scopes and positive filters bound traversal to their matching depth; missing fixed directory prefixes are reported without scanning broader ancestors. Results are newest-modified first, with a default limit of 200. `hidden: false` excludes dotfiles. Directory discovery lists symlinks, including dangling links, without traversing them; explicitly selected dangling link paths are also accepted. Grep does not follow symlinks discovered during a directory scan.
- Both retain the 50 KiB output cap and support cancellation. Grep includes its notices within that cap. Native scans have a 30-second deadline. Directory traversal failures fail the search; missing scopes and individual grep files that cannot be searched are reported with notices rather than presented as complete coverage.
- Grep input buffering is limited to 64 MiB, with a separately bounded pending-context window for streaming searches. Ordinary short-line searches stream larger files, but multiline searches buffer the full decoded file and very long lines require buffering. Multiline matching preserves the complete subject for lookbehind. Both paths retain BOM-marked UTF-8/UTF-16 decoding, including final replacement characters at buffer boundaries. Exceeding the budget fails an explicitly selected file; directory scans skip the file with a notice. Line selectors limit matches and context, not multiline input buffering.
- The [SSH extension example](examples/extensions/ssh.ts) disables and guards local `grep`/`find` in SSH mode. Use its remote `bash` tool for content and filename searches.
- The [Gondolin example](examples/extensions/gondolin/index.ts) keeps its guest backend: one guest path, JavaScript line-based grep, and Node glob file discovery in traversal order. It does not expose native PCRE2, multiline search, line ranges, multi-scope paths, pagination, or `.gitignore` options. Find returns basenames for file roots and root-relative paths for directory searches. Its `hidden: false` prunes hidden entries; Node glob dotfile rules still apply, so dotfile names require explicit dot patterns. Use guest bash for unsupported searches.

## Background jobs

Ask the agent to start persistent work with `bash` using `async: true` and an optional `name`. Bash remains synchronous unless requested otherwise. A launch acknowledgment is not completion: the `jobs` tool lists, inspects, reads logs, stops, renames, restarts, and deletes jobs.

Jobs have independent supervisors and survive pi exit/restart. Their private records and complete combined stdout/stderr logs live under the agent directory's `jobs/` folder, until explicitly deleted. Commands and output are retained; avoid putting secrets in them. Environment variables are inherited by the worker but are not copied into its metadata. Restart creates a new job ID with the current environment and keeps the old job's records. Stop a job before deleting it.

Use `/jobs` for the current project's list or `/jobs <full-id>` for live output and controls. Enter opens details; Escape returns to the list, then closes the view. Default controls: Ctrl+S stop, Ctrl+R restart, Ctrl+N rename, Ctrl+E replace the command and restart, Ctrl+D delete, and Alt+M minimize. Bindings are configurable through `app.jobs.*` and `app.pane.minimize`. PageUp/PageDown scroll the bounded log tail; its full file remains available. These are log/control views, not interactive job terminals.

A job can report real progress by atomically publishing JSON such as `{"percent":42,"message":"Indexing"}` to the path in `PI_JOB_PROGRESS_FILE` (temporary file, then rename; maximum 16 KiB). `PI_JOB_ID` identifies it. Without a valid report, views show activity and elapsed time, not an invented percentage. `timeout` on async bash bounds the job's execution, not just its launch.

Local async bash does not replace custom remote execution adapters or PowerShell. Those backends reject async mode instead of silently launching the command locally.

## Rex and shared views

`/jobs` and `/btw` use [Rex](https://www.superlogical.com/rex/docs/automate/cli) when pi inherits a Rex session and block, otherwise a pi overlay. `/settings` controls their defaults:

| Setting | JSON key | Default | Behavior |
| --- | --- | --- | --- |
| Rex views | `rex.enabled` | on | Use Rex for new shared views; off uses pi overlays. This does not disable the agent's general `rex` tool. |
| Rex mode | `rex.mode` | `floating` | Open manual views as floating windows or regular side-by-side `split` panes. |
| Minimized Rex jobs | `rex.minimizedJobs` | on | Give each newly submitted background job its own minimized floating pane, without moving focus. Off creates no automatic view. |

Automatic job views cover async bash and restarts through the `jobs` tool or job controls. They always use floating panes, independently of the manual-view mode. They require Rex views to be enabled and an inherited Rex context; missing/unavailable Rex never opens an automatic fallback overlay or changes job execution. Foreground bash is unchanged. Job labels include their short ID and name.

Choose explicitly with `--tui` or `--rex`, choose Rex placement with `--split` or `--floating`, and start minimized floating views with `--minimized`. Flags override the stored defaults; `--minimized` implies floating placement unless a conflicting `--split` is supplied. A manually requested unavailable Rex backend falls back to the overlay. Existing views are not moved or closed by settings changes. Run the same command again to restore an existing view. Closing a job view does not stop the job.

The agent's `rex` tool exposes the installed CLI, including sessions, windows, splits, floating layers, minimization, captures, input, and connected apps. It passes an argument array directly, without shell interpolation. Its prompt guidance directs the agent to read the installed Rex guide and discover version-specific APIs before use. A timed-out CLI mutation may still have succeeded; inspect state before retrying.

The SDK exports `JobManager`, `createJobsToolDefinition`, `createJobsExtension`, `createRexExtension`, `createBtwExtension`, `createSideSession`, and the reusable `openPane` host with `PaneView`/`PaneHandle` types. CLI built-ins load by default; SDK hosts opt into extension factories through their resource loader. Existing selectors and other overlays are unchanged. Sub-agent presentation is not included.

Custom UI hosts implement `getRexSettings()` using their active session's settings manager; it returns the read-only `RexViewSettings`. `PaneHandle.placement` reports `floating`/`split` for Rex and `undefined` for TUI views. Rex-only `openPane` callers can combine `backend: "rex"` with `fallback: "none"` when a background presentation must not open an overlay.

## Temporary side conversations

Use `/btw [question]` for a fresh, in-memory conversation seeded from the current main branch. An unfinished main tool round is omitted rather than supplied with fabricated results. The side agent uses the selected model and thinking level, but only the built-in `read`, `grep`, `find`, and `ls` tools—not bash, writes, jobs, Rex, or extension tools.

Follow-ups stay in that view, including questions queued while it answers. Escape cancels an active answer; when idle, Escape or `/close` discards the side conversation. `/btw` restores an existing side view. Side turns do not become main-history entries or saved pi sessions; closing the view aborts its work and clears its conversation. Rex terminal capture/scrollback is controlled by Rex, not by pi's session storage.

The header uses the shared chat icon: Nerd Font `U+F075` when Icons is `nerd`, with a plain question-mark fallback for the Unicode preset.

## License

MIT
