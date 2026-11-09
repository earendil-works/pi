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

## License

MIT
