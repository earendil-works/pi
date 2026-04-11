<p align="center">
  <a href="https://www.npmjs.com/package/@tculpepp/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@tculpepp/pi-coding-agent?style=flat-square" /></a>
  <a href="https://github.com/tculpepp/secure-pi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/tculpepp/secure-pi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>

> **Fork notice:** This is a security-hardened fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/badlogic), maintained for deployment in closed networks. See the original project for the upstream community release.

Spi is a minimal terminal coding harness. Adapt spi to your workflows, not the other way around, without having to fork and modify spi internals. Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes). Put your extensions, skills, prompt templates, and themes in [Spi Packages](#pi-packages) and share them with others via npm or git.

Spi ships with powerful defaults but skips features like sub agents and plan mode. Instead, you can ask spi to build what you want or install a third party spi package that matches your workflow.

Spi runs in four modes: interactive, print or JSON, RPC for process integration, and an SDK for embedding in your own apps. See [openclaw/openclaw](https://github.com/openclaw/openclaw) for a real-world SDK integration.

## Table of Contents

- [Quick Start](#quick-start)
- [Closed-Network Mode](#closed-network-mode)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Pi Packages](#pi-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

```bash
npm install -g @tculpepp/pi-coding-agent
```

This build runs in **closed-network mode** by default. Configure a self-hosted model endpoint before first launch (see [Closed-Network Mode](#closed-network-mode)):

```bash
spi
```

Then just talk to pi. By default, pi gives the model four tools: `read`, `write`, `edit`, and `bash`. The model uses these to fulfill your requests. Add capabilities via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [pi packages](#pi-packages).

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Closed-Network Mode

This fork is configured for deployment in closed networks that cannot reach commercial LLM cloud endpoints. Two behavioral changes are always active:

1. **secureMode enforcement** — enabled by default. Only providers that have an explicit `baseUrl` configured in `models.json` are visible in the model list. Built-in providers (Anthropic, OpenAI, Google, etc.) are hidden unless redirected to internal infrastructure. The protocol implementations (OpenAI-compat, Anthropic-compat, Google-compat) remain intact so self-hosted models can use them.

2. **Outbound calls disabled** — version checks and package update checks are permanently suppressed. The `/share` command is also unavailable.

### Configuring a Self-Hosted Model

Create `~/.spi/agent/models.json` with your internal inference endpoint. Spi reuses the same wire protocol as the commercial providers, so any OpenAI-compatible server works with `api: "openai-completions"`.

**vLLM / llama.cpp / LM Studio** (standard OpenAI-compat, `/v1` path):

```json
{
  "providers": {
    "internal-llm": {
      "baseUrl": "http://inference.internal:8000/v1",
      "api": "openai-completions",
      "apiKey": "INTERNAL_API_KEY",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gemma-3-27b-it",
          "name": "Gemma 3 27B (Internal)",
          "input": ["text", "image"],
          "contextWindow": 131072,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

**Open WebUI** (uses `/api/chat/completions`, not `/api/v1/chat/completions` — set `baseUrl` to `.../api`):

```json
{
  "providers": {
    "open-webui": {
      "baseUrl": "http://openwebui.internal:3000/api",
      "api": "openai-completions",
      "apiKey": "OPENWEBUI_API_KEY",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false,
        "supportsStore": false,
        "supportsStrictMode": false,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "gemma3:27b",
          "name": "Gemma 3 27B",
          "input": ["text", "image"],
          "contextWindow": 131072,
          "maxTokens": 16384
        },
        {
          "id": "mistral:7b",
          "name": "Mistral 7B",
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

Generate an Open WebUI API key from Settings → Account. Model IDs use Ollama's `name:tag` format — check your Open WebUI model list for the exact strings.

Then start spi and the model is immediately available:

```bash
spi --model gemma3:27b
```

#### Protocol selection

| Your server speaks | Use `api` |
|--------------------|-----------|
| OpenAI Chat Completions | `openai-completions` |
| OpenAI Responses | `openai-responses` |
| Anthropic Messages | `anthropic-messages` |
| Google Generative AI | `google-generative-ai` |

#### Redirecting a built-in provider through an internal proxy

If your infrastructure proxies traffic for a specific commercial API (e.g., an Anthropic-compatible gateway), point the existing provider at it. The model list is preserved; only the endpoint changes:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://llm-gateway.internal/anthropic",
      "apiKey": "INTERNAL_GATEWAY_KEY"
    }
  }
}
```

In `secureMode` this provider entry (with its explicit `baseUrl`) makes all built-in Anthropic models available again, routed through your gateway.

#### API key resolution

The `apiKey` field supports three formats:

- **Environment variable name** — `"INTERNAL_API_KEY"` reads `$INTERNAL_API_KEY` at runtime
- **Shell command** — `"!command"` runs the command and uses stdout (e.g., `"!vault kv get -field=token secret/llm"`)
- **Literal value** — the string is used as-is (not recommended for secrets)

See [docs/models.md](docs/models.md) for the full configuration reference.

---

## Providers & Models

Spi ships with protocol implementations for 10 LLM APIs. In this closed-network build, **all built-in commercial cloud endpoints are hidden when `secureMode: true`**. Providers only appear in the model list after the user configures an explicit `baseUrl` in `models.json`.

The protocol implementations themselves remain intact, so any self-hosted model that speaks a supported wire format works without code changes.

**Supported protocols:**
- `openai-completions` — OpenAI Chat Completions and compatibles (vLLM, Ollama, LM Studio, llama.cpp, SGLang)
- `openai-responses` — OpenAI Responses API
- `anthropic-messages` — Anthropic Messages API and compatibles
- `google-generative-ai` — Google Generative AI REST API
- `google-vertex` — Google Vertex AI
- `azure-openai-responses` — Azure OpenAI Responses
- `bedrock-converse-stream` — Amazon Bedrock Converse
- `mistral-conversations` — Mistral Conversations API

**Add self-hosted providers:** Configure via `~/.spi/agent/models.json`. See [Closed-Network Mode](#closed-network-mode) for a quick-start and [docs/models.md](docs/models.md) for the full reference.

**Custom APIs or OAuth:** Use extensions. See [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, session name, total token/cache usage, cost, context usage, current model

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| Images | Ctrl+V to paste (Alt+V on Windows), or drag onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | OAuth authentication |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (path, tokens, cost) |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from the current branch |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML file |
| `/share` | Upload as private GitHub gist with shareable HTML link (unavailable in closed-network mode) |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files (themes hot-reload automatically) |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit spi |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.spi/agent/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so spi can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session.md](docs/session.md) for file format.

### Management

Sessions auto-save to `~/.spi/agent/sessions/` organized by working directory.

```bash
spi -c                  # Continue most recent session
spi -r                  # Browse and select from past sessions
spi --no-session        # Ephemeral mode (don't save)
spi --session <path>    # Use specific session file or ID
spi --fork <path>       # Fork specific session file or ID into a new session
```

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press Shift+L to label entries as bookmarks and Shift+T to toggle label timestamps

**`/fork`** - Create a new session file from the current branch. Opens a selector, copies history up to the selected point, and places that message in the editor for modification.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history remains in the JSONL file; use `/tree` to revisit. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.spi/agent/settings.json` | Global (all projects) |
| `.spi/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

---

## Context Files

Spi loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.spi/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

Use for project instructions, conventions, common commands. All matching files are concatenated.

### System Prompt

Replace the default system prompt with `.spi/SYSTEM.md` (project) or `~/.spi/agent/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.spi/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.spi/agent/prompts/`, `.spi/prompts/`, or a [pi package](#pi-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name` or let the agent load them automatically.

```markdown
<!-- ~/.spi/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `~/.spi/agent/skills/`, `~/.agents/skills/`, `.spi/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [pi package](#pi-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend spi with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make spi look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `~/.spi/agent/extensions/`, `.spi/extensions/`, or a [pi package](#pi-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and spi immediately applies changes.

Place in `~/.spi/agent/themes/`, `.spi/themes/`, or a [pi package](#pi-packages) to share with others. See [docs/themes.md](docs/themes.md).

### Pi Packages

Bundle and share extensions, skills, prompts, and themes via npm or git. Find packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) or [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** Pi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
spi install npm:@foo/pi-tools
spi install npm:@foo/pi-tools@1.2.3      # pinned version
spi install git:github.com/user/repo
spi install git:github.com/user/repo@v1  # tag or commit
spi install git:git@github.com:user/repo
spi install git:git@github.com:user/repo@v1  # tag or commit
spi install https://github.com/user/repo
spi install https://github.com/user/repo@v1      # tag or commit
spi install ssh://git@github.com/user/repo
spi install ssh://git@github.com/user/repo@v1    # tag or commit
spi remove npm:@foo/pi-tools
spi uninstall npm:@foo/pi-tools          # alias for remove
spi list
spi update                               # skips pinned packages
spi config                               # enable/disable extensions, skills, prompts, themes
```

Packages install to `~/.spi/agent/git/` (git) or global npm. Use `-l` for project-local installs (`.spi/git/`, `.spi/npm/`). If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `spi` key to `package.json`:

```json
{
  "name": "my-spi-package",
  "keywords": ["spi-package"],
  "spi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `spi` manifest, spi auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@tculpepp/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
spi --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Philosophy

Pi is aggressively extensible so it doesn't have to dictate your workflow. Features that other tools bake in can be built with [extensions](#extensions), [skills](#skills), or installed from third-party [pi packages](#pi-packages). This keeps the core minimal while letting you shape pi to fit how you work.

**No MCP.** Build CLI tools with READMEs (see [Skills](#skills)), or build an extension that adds MCP support. [Why?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or build your own with [extensions](#extensions), or install a package that does it your way.

**No permission popups.** Run in a container, or build your own confirmation flow with [extensions](#extensions) inline with your environment and security requirements.

**No plan mode.** Write plans to files, or build it with [extensions](#extensions), or install a package.

**No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with [extensions](#extensions).

**No background bash.** Use tmux. Full observability, direct interaction.

Read the [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) for the full rationale.

---

## CLI Reference

```bash
spi [options] [@files...] [messages...]
```

### Package Commands

```bash
spi install <source> [-l]     # Install package, -l for project-local
spi remove <source> [-l]      # Remove package
spi uninstall <source> [-l]   # Alias for remove
spi update [source]           # Update packages (skips pinned)
spi list                      # List installed packages
spi config                    # Enable/disable package resources
```

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, spi also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | spi -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path>` | Use specific session file or partial UUID |
| `--fork <path>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>` | Enable specific built-in tools (default: `read,bash,edit,write`) |
| `--no-tools` | Disable all built-in tools (extension tools still work) |

Available built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
spi @prompt.md "Answer this"
spi -p @screenshot.png "What's in this image?"
spi @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
spi "List all .ts files in src/"

# Non-interactive
spi -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | spi -p "Summarize this text"

# Different model
spi --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
spi --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
spi --model sonnet:high "Solve this complex problem"

# Limit model cycling
spi --models "claude-*,gpt-4o"

# Read-only mode
spi --tools read,grep,find,ls -p "Review the code"

# High thinking level
spi --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SPI_CODING_AGENT_DIR` | Override config directory (default: `~/.spi/agent`) |
| `SPI_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `SPI_SKIP_VERSION_CHECK` | Skip version check at startup |
| `SPI_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

---

## Contributing & Development

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines and [docs/development.md](docs/development.md) for setup, forking, and debugging.

---

## License

MIT

## See Also

- [@tculpepp/pi-ai](https://www.npmjs.com/package/@tculpepp/pi-ai): Core LLM toolkit
- [@tculpepp/pi-agent-core](https://www.npmjs.com/package/@tculpepp/pi-agent-core): Agent framework
- [@tculpepp/pi-tui](https://www.npmjs.com/package/@tculpepp/pi-tui): Terminal UI components
