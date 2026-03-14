# mu

A radically simple and opinionated coding agent with multi-model support (including mid-session switching), a simple yet powerful CLI for headless coding tasks, and many creature comforts you might be used to from other coding agents.

Works on Linux, macOS, and Windows (barely tested, needs Git Bash running in the "modern" Windows Terminal).

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Keys](#api-keys)
- [OAuth Authentication (Optional)](#oauth-authentication-optional)
- [Custom Models and Providers](#custom-models-and-providers)
- [Themes](#themes)
- [Slash Commands](#slash-commands)
- [Editor Features](#editor-features)
- [Project Context Files](#project-context-files)
- [Image Support](#image-support)
- [Session Management](#session-management)
- [CLI Options](#cli-options)
- [Tools](#tools)
- [Usage](#usage)
- [Security (YOLO by default)](#security-yolo-by-default)
- [Sub-Agents](#sub-agents)
- [Background Bash](#background-bash)
- [Planned Features](#planned-features)
- [License](#license)
- [See Also](#see-also)

## Installation

```bash
npm install -g @kennyfrc/mu-coding-agent
```

## Quick Start

```bash
# Set your API key (see API Keys section)
export ANTHROPIC_API_KEY=sk-ant-...

# Start the interactive CLI
mu
```

Once in the CLI, you can chat with the AI:

```
You: Create a simple Express server in src/server.ts
```

The agent will use its tools to read, write, and edit files as needed, and execute commands via Bash.

## API Keys

The CLI supports multiple LLM providers. Set the appropriate environment variable for your chosen provider:

```bash
# Anthropic (Claude)
export ANTHROPIC_API_KEY=sk-ant-...
# Or use OAuth token (retrieved via: claude setup-token)
export ANTHROPIC_OAUTH_TOKEN=...

# OpenAI (GPT)
export OPENAI_API_KEY=sk-...

# Google (Gemini)
export GEMINI_API_KEY=...

# Groq
export GROQ_API_KEY=gsk_...

# Cerebras
export CEREBRAS_API_KEY=csk-...

# xAI (Grok)
export XAI_API_KEY=xai-...

# OpenRouter
export OPENROUTER_API_KEY=sk-or-...

# Moonshot (Kimi)
export MOONSHOT_API_KEY=sk-...

# ZAI
export ZAI_API_KEY=...
```

If no API key is set, the CLI will prompt you to configure one on first run.

**Note:** The `/model` command only shows models for which API keys are configured in your environment. If you don't see a model you expect, check that you've set the corresponding environment variable.

## OAuth Authentication (Optional)

If you have a Claude Pro/Max subscription, you can use OAuth instead of API keys:

```bash
mu
# In the interactive session:
/login
# Select "Anthropic (Claude Pro/Max)"
# Authorize in browser
# Paste authorization code
```

This gives you:
- Free access to Claude models (included in your subscription)
- No need to manage API keys
- Automatic token refresh

To logout:
```
/logout
```

**Note:** OAuth tokens are stored in `~/.mu/agent/oauth.json` with restricted permissions (0600).

## Custom Models and Providers

You can add custom models and providers (like Ollama, vLLM, LM Studio, or any custom API endpoint) via `~/.mu/agent/models.json`. Supports OpenAI-compatible APIs (`openai-completions`, `openai-responses`), Anthropic Messages API (`anthropic-messages`), and Google Generative AI API (`google-generative-ai`). This file is loaded fresh every time you open the `/model` selector, allowing live updates without restarting.

### Configuration File Structure

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "OLLAMA_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "llama-3.1-8b",
          "name": "Llama 3.1 8B (Local)",
          "reasoning": false,
          "input": ["text"],
          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
          "contextWindow": 128000,
          "maxTokens": 32000
        }
      ]
    },
    "vllm": {
      "baseUrl": "http://your-server:8000/v1",
      "apiKey": "VLLM_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "custom-model",
          "name": "Custom Fine-tuned Model",
          "reasoning": false,
          "input": ["text", "image"],
          "cost": {"input": 0.5, "output": 1.0, "cacheRead": 0, "cacheWrite": 0},
          "contextWindow": 32768,
          "maxTokens": 8192
        }
      ]
    },
    "mixed-api-provider": {
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "CUSTOM_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "legacy-model",
          "name": "Legacy Model",
          "reasoning": false,
          "input": ["text"],
          "cost": {"input": 1.0, "output": 2.0, "cacheRead": 0, "cacheWrite": 0},
          "contextWindow": 8192,
          "maxTokens": 4096
        },
        {
          "id": "new-model",
          "name": "New Model",
          "api": "openai-responses",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": {"input": 0.5, "output": 1.0, "cacheRead": 0.1, "cacheWrite": 0.2},
          "contextWindow": 128000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

### API Key Resolution

The `apiKey` field can be either an environment variable name or a literal API key:

1. First, `mu` checks if an environment variable with that name exists
2. If found, uses the environment variable's value
3. Otherwise, treats it as a literal API key

Examples:
- `"apiKey": "OLLAMA_API_KEY"` → checks `$OLLAMA_API_KEY`, then treats as literal "OLLAMA_API_KEY"
- `"apiKey": "sk-1234..."` → checks `$sk-1234...` (unlikely to exist), then uses literal value

This allows both secure env var usage and literal keys for local servers.

### API Override

- **Provider-level `api`**: Sets the default API for all models in that provider
- **Model-level `api`**: Overrides the provider default for specific models
- Supported APIs: `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`

This is useful when a provider supports multiple API standards through the same base URL.

### Custom Headers

You can add custom HTTP headers to bypass Cloudflare bot detection, add authentication tokens, or meet other proxy requirements:

```json
{
  "providers": {
    "custom-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "apiKey": "YOUR_API_KEY",
      "api": "anthropic-messages",
      "headers": {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "X-Custom-Auth": "bearer-token-here"
      },
      "models": [
        {
          "id": "claude-sonnet-4",
          "name": "Claude Sonnet 4 (Proxied)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": {"input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75},
          "contextWindow": 200000,
          "maxTokens": 8192,
          "headers": {
            "X-Model-Specific-Header": "value"
          }
        }
      ]
    }
  }
}
```

- **Provider-level `headers`**: Applied to all requests for models in that provider
- **Model-level `headers`**: Additional headers for specific models (merged with provider headers)
- Model headers override provider headers when keys conflict

### Model Selection Priority

When starting `mu`, models are selected in this order:

1. **CLI args**: `--provider` and `--model` flags
2. **First from `--models` scope**: If `--models` is provided (skipped when using `--continue` or `--resume`)
3. **Restored from session**: If using `--continue` or `--resume`
4. **Saved default**: From `~/.mu/agent/settings.json` (set when you select a model with `/model`)
5. **First available**: First model with a valid API key
6. **None**: Allowed in interactive mode (shows error on message submission)

### Provider Defaults

When multiple providers are available, mu prefers sensible defaults before falling back to "first available":

| Provider   | Default Model            |
|------------|--------------------------|
| anthropic  | claude-sonnet-4-5        |
| openai     | gpt-5.1-codex            |
| google     | gemini-2.5-pro           |
| openrouter | openai/gpt-5.1-codex     |
| xai        | grok-4-fast-non-reasoning|
| groq       | openai/gpt-oss-120b      |
| cerebras   | zai-glm-4.6              |
| zai        | glm-4.6                  |

### Live Reload & Errors

The models.json file is reloaded every time you open the `/model` selector. This means:

- Edit models.json during a session
- Or have the agent write/update it for you
- Use `/model` to see changes immediately
- No restart needed!

If the file contains errors (JSON syntax, schema violations, missing fields), the selector shows the exact validation error and file path in red so you can fix it immediately.

### Example: Adding Ollama Models

See the configuration structure above. Create `~/.mu/agent/models.json` with your Ollama setup, then use `/model` to select your local models. The agent can also help you write this file if you point it to this README.

## Themes

Mu supports customizable color themes for the TUI. Three built-in themes are available: `nerv` (default), `dark`, and `light`.

- `nerv` — the default Evangelion-inspired NERV console palette with true black backgrounds, phosphor green data, cyan structure lines, and orange institutional labels
- `dark` — the existing saturated dark theme
- `light` — a light-background variant

### Selecting a Theme

Use the `/theme` command to interactively select a theme, or edit your settings file:

```bash
# Interactive selector
mu
/theme

# Or edit ~/.mu/agent/settings.json
{
  "theme": "nerv"  # or "dark" / "light"
}
```

On first run, Mu defaults to `nerv` unless you explicitly choose another theme.

### Custom Themes

Create custom themes in `~/.mu/agent/themes/*.json`. Custom themes support **live editing** - when you select a custom theme, Pi watches the file and automatically reloads when you save changes.

**Workflow for creating themes:**
1. Copy a built-in theme as a starting point:
   ```bash
   mkdir -p ~/.mu/agent/themes
   # Copy dark theme
   cp $(npm root -g)/@kennyfrc/mu-coding-agent/dist/theme/dark.json ~/.mu/agent/themes/my-theme.json
   # Or copy light theme
   cp $(npm root -g)/@kennyfrc/mu-coding-agent/dist/theme/light.json ~/.mu/agent/themes/my-theme.json
   ```
2. Use `/theme` to select "my-theme"
3. Edit `~/.mu/agent/themes/my-theme.json` - changes apply immediately on save
4. Iterate until satisfied (no need to re-select the theme)

See [Theme Documentation](docs/theme.md) for:
- Complete list of 44 color tokens
- Theme format and examples
- Color value formats (hex, RGB, terminal default)

Example custom theme:

```json
{
  "$schema": "https://raw.githubusercontent.com/badlogic/mu-mono/main/packages/coding-agent/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "accent": "#00aaff",
    "muted": "#6c6c6c"
  },
  "colors": {
    "accent": "accent",
    "muted": "muted",
    ...
  }
}
```

### VS Code Terminal Color Issue

**Important:** VS Code's integrated terminal has a known issue with rendering truecolor (24-bit RGB) values. By default, it applies a "minimum contrast ratio" adjustment that can make colors look washed out or identical.

To fix this, set the contrast ratio to 1 in VS Code settings:

1. Open Settings (Cmd/Ctrl + ,)
2. Search for: `terminal.integrated.minimumContrastRatio`
3. Set to: `1`

This ensures VS Code renders the exact RGB colors defined in your theme.

## Slash Commands

The CLI supports several commands to control its behavior:

### /model

Switch models mid-session. Opens an interactive selector where you can type to search (by provider or model name), use arrow keys to navigate, Enter to select, or Escape to cancel.

The selector only displays models for which API keys are configured in your environment (see API Keys section).

### /thinking

Adjust thinking/reasoning level for supported models (Claude Sonnet 4, GPT-5, Gemini 2.5). Opens an interactive selector where you can use arrow keys to navigate, Enter to select, or Escape to cancel.

### /queue

Select message queue mode. Opens an interactive selector where you can choose between:
- **one-at-a-time** (default): Process queued messages one by one. When you submit messages while the agent is processing, they're queued and sent individually after each agent response completes.
- **all**: Process all queued messages at once. All queued messages are injected into the context together before the next agent response.

The queue mode setting is saved and persists across sessions.

### /steer <message>

Send a **steering message** immediately:

```
/steer use ripgrep instead of grep
```

If the agent is currently doing tool calls, the message is injected *between* tool results and the model’s continuation response (mid-flight steering without aborting). Otherwise, it becomes the next queued message processed after the current run completes.

### /export [filename]

Export the current session to a self-contained HTML file:

```
/export                          # Auto-generates filename
/export my-session.html          # Custom filename
```

The HTML file includes the full conversation with syntax highlighting and is viewable in any browser.

### /session

Show session information and statistics:

```
/session
```

Displays:
- Session file path and ID
- Message counts (user, assistant, total)
- Token usage (input, output, cache read/write, total)
- Total cost (if available)

### /changelog

Display the full changelog with all version history (newest last):

```
/changelog
```

### /branch

Create a new conversation branch from a previous message. Opens an interactive selector showing all your user messages in chronological order. Select a message to:
1. Create a new session with all messages before the selected one
2. Place the selected message in the editor for modification or resubmission

This allows you to explore alternative conversation paths without losing your current session.

```
/branch
```

### /login

Login with OAuth to use subscription-based models (Claude Pro/Max):

```
/login
```

Opens an interactive selector to choose provider, then guides you through the OAuth flow in your browser.

### /logout

Logout from OAuth providers:

```
/logout
```

Shows a list of logged-in providers to logout from.

### /clear

Clear the conversation context and start a fresh session:

```
/clear
```

Aborts any in-flight agent work, clears all messages, and creates a new session file.

### /autohandoff

Toggle automatic session handoff when context usage is high.

```
/autohandoff          # toggle on/off
/autohandoff on       # enable auto-handoff
/autohandoff off      # disable auto-handoff (default)
/autohandoff toggle   # toggle on/off
/autohandoff status   # show current status
```

Auto-handoff is stored in `~/.mu/agent/settings.json` and defaults to `off`.

## Editor Features

The interactive input editor includes several productivity features:

### File Reference (`@`)

Type **`@`** to fuzzy-search for files and folders in your project:
- `@editor` → finds files/folders with "editor" in the name
- `@readme` → finds README files anywhere in the project
- `@src` → finds folders like `src/`, `resources/`, etc.
- Directories are prioritized and shown with trailing `/`
- Autocomplete triggers immediately when you type `@`
- Use **Up/Down arrows** to navigate, **Tab**/**Enter** to select

Respects `.gitignore` files and skips hidden files/directories.

### Path Completion

Press **Tab** to autocomplete file and directory paths:
- Works with relative paths: `./src/` + Tab → complete files in src/
- Works with parent directories: `../../` + Tab → navigate up and complete
- Works with home directory: `~/Des` + Tab → `~/Desktop/`
- Use **Up/Down arrows** to navigate completion suggestions
- Press **Enter** to select a completion
- Shows matching files and directories as you type

### File Drag & Drop

Drag files from your OS file explorer (Finder on macOS, Explorer on Windows) directly onto the terminal. The file path will be automatically inserted into the editor. Works great with screenshots from macOS screenshot tool.

### Multi-line Paste

Paste multiple lines of text (e.g., code snippets, logs) and they'll be automatically coalesced into a compact `[paste #123 <N> lines]` reference in the editor. The full content is still sent to the model.

### Message Queuing

You can submit multiple messages while the agent is processing without waiting for responses. Messages are queued and processed based on your queue mode setting:

**One-at-a-time mode (default):**
- Each queued message is processed sequentially with its own response
- Example: Queue "task 1", "task 2", "task 3" → agent completes task 1 → processes task 2 → completes task 2 → processes task 3
- Recommended for most use cases

**All mode:**
- All queued messages are sent to the model at once in a single context
- Example: Queue "task 1", "task 2", "task 3" → agent receives all three together → responds considering all tasks
- Useful when tasks should be considered together

**Visual feedback:**
- Queued messages appear below the chat with "Queued: <message text>"
- Messages disappear from the queue as they're processed

**Abort and restore:**
- Press **Escape** while streaming to abort the current operation
- All queued messages (plus any text in the editor) are restored to the editor
- Allows you to modify or remove queued messages before resubmitting

Change queue mode with `/queue` command. Setting is saved in `~/.mu/agent/settings.json`.

### Keyboard Shortcuts

- **Ctrl+W**: Delete word backwards (stops at whitespace or punctuation)
- **Option+Backspace** (Ghostty): Delete word backwards (same as Ctrl+W)
- **Ctrl+U**: Delete to start of line (at line start: merge with previous line)
- **Cmd+Backspace** (Ghostty): Delete to start of line (same as Ctrl+U)
- **Ctrl+K**: Delete to end of line (at line end: merge with next line)
- **Ctrl+C**: Clear editor (first press) / Exit mu (second press)
- **Tab**: Path completion (when autocomplete active) / Cycle thinking level off → low → medium → high → xhigh (for reasoning-capable models)
- **Shift+Tab** (Ghostty): Cycle thinking level xhigh → high → medium → low → off
- **Ctrl+P**: Cycle models (use `--models` to scope)
- **Ctrl+O**: Toggle tool output expansion (collapsed ↔ full output)
- **Enter**: Send message
- **Shift+Enter**: Insert new line (multi-line input)
- **Backspace**: Delete character backwards
- **Delete** (or **Fn+Backspace**): Delete character forwards
- **Arrow keys**: Move cursor (Up/Down/Left/Right)
- **Ctrl+A** / **Home** / **Cmd+Left** (macOS): Jump to start of line
- **Ctrl+E** / **End** / **Cmd+Right** (macOS): Jump to end of line
- **Escape**: Cancel autocomplete (when autocomplete is active)

## Project Context Files

The agent automatically loads context from `AGENTS.md` or `CLAUDE.md` files at startup. These files are loaded in hierarchical order to support both global preferences and monorepo structures.

### File Locations

Context files are loaded in this order:

1. **Global context**: `~/.mu/agent/AGENTS.md` or `CLAUDE.md`
   - Applies to all your coding sessions
   - Great for personal coding preferences and workflows

2. **Parent directories** (top-most first down to current directory)
   - Walks up from current directory to filesystem root
   - Each directory can have its own `AGENTS.md` or `CLAUDE.md`
   - Perfect for monorepos with shared context at higher levels

3. **Current directory**: Your project's `AGENTS.md` or `CLAUDE.md`
   - Most specific context, loaded last
   - Overwrites or extends parent/global context

**File preference**: In each directory, `AGENTS.md` is preferred over `CLAUDE.md` if both exist.

### What to Include

Context files are useful for:
- Project-specific instructions and guidelines
- Common bash commands and workflows
- Architecture documentation
- Coding conventions and style guides
- Dependencies and setup information
- Testing instructions
- Repository etiquette (branch naming, merge vs. rebase, etc.)

### Example

```markdown
# Common Commands
- npm run build: Build the project
- npm test: Run tests

# Code Style
- Use TypeScript strict mode
- Prefer async/await over promises

# Workflow
- Always run tests before committing
- Update CHANGELOG.md for user-facing changes
```

All context files are automatically included in the system prompt at session start, along with the current date/time and working directory. This ensures the AI has complete project context from the very first message.

## Image Support

Send images to vision-capable models by providing file paths:

```
You: What is in this screenshot? /path/to/image.png
```

Supported formats: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`

The image will be automatically encoded and sent with your message. JPEG and PNG are supported across all vision models. Other formats may only be supported by some models.

## Session Management

Sessions are automatically saved in `~/.mu/agent/sessions/` organized by working directory. Each session is stored as a JSONL file with a unique timestamp-based ID.

To continue the most recent session:

```bash
mu --continue
# or
mu -c
```

To browse and select from past sessions:

```bash
mu --resume
# or
mu -r
```

This opens an interactive session selector where you can:
- Type to search through session messages
- Use arrow keys to navigate the list
- Press Enter to resume a session
- Press Escape to cancel

Sessions include all conversation messages, tool calls and results, model switches, and thinking level changes.

To run without saving a session (ephemeral mode):

```bash
mu --no-session
```

To use a specific session file instead of auto-generating one:

```bash
mu --session /path/to/my-session.jsonl
```

## CLI Options

```bash
mu [options] [@files...] [messages...]
```

### File Arguments (`@file`)

You can include files directly in your initial message using the `@` prefix:

```bash
# Include a text file in your prompt
mu @prompt.md "Answer the question"

# Include multiple files
mu @requirements.md @context.txt "Summarize these"

# Include images (vision-capable models only)
mu @screenshot.png "What's in this image?"

# Mix text and images
mu @prompt.md @diagram.png "Explain based on the diagram"

# Files without additional text
mu @task.md
```

**How it works:**
- All `@file` arguments are combined into the first user message
- Text files are wrapped in `<file name="path">content</file>` tags
- Images (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`) are attached as base64-encoded attachments
- Paths support `~` for home directory and relative/absolute paths
- Empty files are skipped
- Non-existent files cause an immediate error

**Examples:**
```bash
# All files go into first message, regardless of position
mu @file1.md @file2.txt "prompt" @file3.md

# This sends:
# Message 1: file1 + file2 + file3 + "prompt"
# (Any additional plain text arguments become separate messages)

# Home directory expansion works
mu @~/Documents/notes.md "Summarize"

# Combine with other options
mu --print @requirements.md "List the main points"
```

**Limitations:**
- Not supported in `--mode rpc` (will error)
- Images require vision-capable models (e.g., Claude, GPT-4o, Gemini)

### Options

**--provider <name>**
Provider name. Available: `anthropic`, `openai`, `google`, `xai`, `groq`, `cerebras`, `openrouter`, `zai`, plus any custom providers defined in `~/.mu/agent/models.json`.

**--model <id>**
Model ID. If not specified, uses: (1) saved default from settings, (2) first available model with valid API key, or (3) none (interactive mode only).

**--api-key <key>**
API key (overrides environment variables)

**--system-prompt <text|file>**
Custom system prompt. Can be:
- Inline text: `--system-prompt "You are a helpful assistant"`
- File path: `--system-prompt ./my-prompt.txt`

If the argument is a valid file path, the file contents will be used as the system prompt. Otherwise, the text is used directly. Project context files and datetime are automatically appended.

**--mode <mode>**
Output mode for non-interactive usage (implies `--print`). Options:
- `text` (default): Output only the final assistant message text
- `json`: Stream all agent events as JSON (one event per line). Events are emitted by `@kennyfrc/mu-agent` and include message updates, tool executions, and completions
- `rpc`: JSON mode plus stdin listener for headless operation. Send JSON commands on stdin: `{"type":"prompt","message":"..."}` or `{"type":"abort"}`. See [test/rpc-example.ts](test/rpc-example.ts) for a complete example

**--print, -p**
Non-interactive mode: process the prompt(s) and exit. Without this flag, passing a prompt starts interactive mode with the prompt pre-submitted. Similar to Claude's `-p` flag and Codex's `exec` command.

**--no-session**
Don't save session (ephemeral mode)

**--session <path>**
Use specific session file path instead of auto-generating one

**--continue, -c**
Continue the most recent session

**--resume, -r**
Select a session to resume (opens interactive selector)

**--models <patterns>**
Comma-separated model patterns for quick cycling with `Ctrl+P`. Matching priority:
1. `provider/modelId` exact match (e.g., `openrouter/openai/gpt-5.1-codex`)
2. Exact model ID match (e.g., `gpt-5.1-codex`)
3. Partial match against model IDs and names (case-insensitive)

When multiple partial matches exist, prefers aliases over dated versions (e.g., `claude-sonnet-4-5` over `claude-sonnet-4-5-20250929`). Without this flag, `Ctrl+P` cycles through all available models.

Each pattern can optionally include a thinking level suffix: `pattern:level` where level is one of `off`, `minimal`, `low`, `medium`, or `high`. When cycling models, the associated thinking level is automatically applied. The first model in the list is used as the initial model when starting a new session.

Examples:
- `--models openrouter/openai/gpt-5.1-codex` - Exact provider/model match
- `--models gpt-5.1-codex` - Exact ID match (not `openai/gpt-5.1-codex-mini`)
- `--models sonnet:high,haiku:low` - Sonnet with high thinking, Haiku with low thinking
- `--models sonnet,haiku` - Partial match for any model containing "sonnet" or "haiku"

**--tools <tools>**
Comma-separated list of tools to enable. By default, mu uses `read,bash,edit,write,list_threads,read_thread,read_image,handoff`. This flag allows restricting or changing the available tools.

Available tools:
- `read` - Read file contents
- `bash` - Execute bash commands
- `edit` - Edit files with find/replace
- `apply_patch` - Apply patch edits
- `write` - Create or overwrite files
- `list_threads` - List past conversation threads
- `read_thread` - Read a specific thread's conversation history
- `read_image` - Analyze images and extract information
- `todo_write` - Persist todo list to disk and emit a reminder to continue
- `handoff` - Hand off to a new session with file context
- `grep` - Search file contents (off by default)
- `glob` - Find files by glob pattern or list directory contents (off by default)
- `exec_command` - Execute shell commands (Codex-style, off by default)

Examples:
- `--tools read,grep,glob` - Read-only mode for code review/exploration
- `--tools read,bash` - Only allow reading and bash commands
- `--tools read,bash,apply_patch,write` - Enable patch-based editing (instead of `edit`)

**--thinking <level>**
Set thinking level for reasoning-capable models. Valid values: `off`, `minimal`, `low`, `medium`, `high`. Takes highest priority over all other thinking level sources (saved settings, `--models` pattern levels, session restore).

Examples:
- `--thinking high` - Start with high thinking level
- `--thinking off` - Disable thinking even if saved setting was different

**--export <file>**
Export a session file to a self-contained HTML file and exit. Auto-detects format (session manager format or streaming event format). Optionally provide an output filename as the second argument.

**Note:** When exporting streaming event logs (e.g., `pi-output.jsonl` from `--mode json`), the system prompt and tool definitions are not available since they are not recorded in the event stream. The exported HTML will include a notice about this.

Examples:
- `--export session.jsonl` - Export to `pi-session-session.html`
- `--export session.jsonl output.html` - Export to custom filename

**--help, -h**
Show help message

### Examples

```bash
# Start interactive mode
mu

# Interactive mode with initial prompt (stays running after completion)
mu "List all .ts files in src/"

# Include files in your prompt
mu @requirements.md @design.png "Implement this feature"

# Non-interactive mode (process prompt and exit)
mu -p "List all .ts files in src/"

# Non-interactive with files
mu -p @code.ts "Review this code for bugs"

# JSON mode - stream all agent events (non-interactive)
mu --mode json "List all .ts files in src/"

# RPC mode - headless operation (see test/rpc-example.ts)
mu --mode rpc --no-session
# Then send JSON on stdin:
# {"type":"prompt","message":"List all .ts files"}
# {"type":"abort"}

# Continue previous session
mu -c "What did we discuss?"

# Use different model
mu --provider openai --model gpt-4o "Help me refactor this code"

# Limit model cycling to specific models
mu --models claude-sonnet,claude-haiku,gpt-4o
# Now Ctrl+P cycles only through those models

# Model cycling with thinking levels
mu --models sonnet:high,haiku:low
# Starts with sonnet at high thinking, Ctrl+P switches to haiku at low thinking

# Start with specific thinking level
mu --thinking high "Solve this complex algorithm problem"

# Read-only mode (no file modifications possible)
mu --tools read,grep,glob -p "Review the architecture in src/"

# Oracle-style subagent (bash for git/gh, no file modifications)
mu --tools read,bash,grep,glob \
   --no-session \
   -p "Use bash only for read-only operations. Read issue #74 with gh, then review the implementation"

# Export a session file to HTML
mu --export ~/.mu/agent/sessions/--myproject--/session.jsonl
mu --export session.jsonl my-export.html
```

## Tools

### Default Tools

By default, the agent has access to four core tools:

**read**
Read file contents. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, defaults to first 2000 lines. Use offset/limit parameters for large files. Lines longer than 2000 characters are truncated.

**write**
Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.

**edit**
Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits. Returns an error if the text appears multiple times or isn't found.

**bash**
Execute a bash command in the current working directory. Returns stdout and stderr for foreground commands. You can pass `background: true` for long-running work, or inspect an existing background job with `job` + `action`. If a foreground command exceeds its timeout, mu may move it to a background job instead of killing it so in-progress work is preserved. A background-job result means the command is still running, not finished.

### Search Tools

**grep**
Search file contents for a pattern (regex or literal). Returns matching lines with file paths and line numbers. Respects `.gitignore`. Has a 30-second timeout to prevent hanging on slow patterns. Parameters: `pattern` (required), `path`, `glob`, `ignoreCase`, `literal`, `context`, `limit`.

**glob**
Find files by glob pattern (e.g., `**/*.ts`) OR list directory contents. When pattern is provided, searches for matching files. When pattern is omitted, lists directory contents with `/` suffix for directories. Respects `.gitignore`. Has a 30-second timeout to prevent hanging on slow searches. Parameters: `pattern` (optional), `path`, `limit`.

### MCP & Adding Your Own Tools

**pi does and will not support MCP.** Instead, it relies on the four built-in tools above and assumes the agent can invoke pre-existing CLI tools or write them on the fly as needed.

**Here's the gist:**

1. Create a simple CLI tool (any language, any executable)
2. Write a concise README.md describing what it does and how to use it
3. Tell the agent to read that README

**Minimal example:**

`~/agent-tools/screenshot/README.md`:
```markdown
# Screenshot Tool

Takes a screenshot of your main display.

## Usage
```bash
screenshot.sh
```

Returns the path to the saved PNG file.
```

`~/agent-tools/screenshot/screenshot.sh`:
```bash
#!/bin/bash
screencapture -x /tmp/screenshot-$(date +%s).png
ls -t /tmp/screenshot-*.png | head -1
```

**In your session:**
```
You: Read ~/agent-tools/screenshot/README.md and use that tool to take a screenshot
```

The agent will read the README, understand the tool, and invoke it via bash as needed. If you need a new tool, ask the agent to write it for you.

You can also reference tool READMEs in your `AGENTS.md` files to make them automatically available:
- Global: `~/.mu/agent/AGENTS.md` - available in all sessions
- Project-specific: `./AGENTS.md` - available in this project

**Real-world example:**

The [exa-search](https://github.com/badlogic/exa-search) tools provide web search capabilities via the Exa API. Built by the agent itself in ~2 minutes. Far from perfect, but functional. Just tell your agent: "Read ~/agent-tools/exa-search/README.md and search for X".

For a detailed walkthrough with more examples, and the reasons for and benefits of this decision, see: https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/

## Security (YOLO by default)

This agent runs in full YOLO mode and assumes you know what you're doing. It has unrestricted access to your filesystem and can execute any command without permission checks or safety rails.

**What this means:**
- No permission prompts for file operations or commands
- No pre-checking of bash commands for malicious content
- Full filesystem access - can read, write, or delete anything
- Can execute any command with your user privileges

**Why:**
- Permission systems add massive friction while being easily circumvented
- Pre-checking tools for "dangerous" patterns introduces latency, false positives, and is ineffective

**Prompt injection risks:**
- By default, mu has no web search or fetch tool
- However, it can use `curl` or read files from disk
- Both provide ample surface area for prompt injection attacks
- Malicious content in files or command outputs can influence behavior

**Mitigations:**
- Run mu inside a container if you're uncomfortable with full access
- Use a different tool if you need guardrails
- Don't use mu on systems with sensitive data you can't afford to lose
- Fork mu and add all of the above

This is how I want it to work and I'm not likely to change my stance on this.

Use at your own risk.

## Sub-Agents

**pi does not and will not support sub-agents as a built-in feature.** If the agent needs to delegate work, it can:

1. Spawn another instance of itself via the `mu` CLI command
2. Write a custom tool with a README.md that describes how to invoke mu for specific tasks

**Why no built-in sub-agents:**

Context transfer between agents is generally poor. Information gets lost, compressed, or misrepresented when passed through agent boundaries. Direct execution with full context is more effective than delegation with summarized context.

If you need parallel work on independent tasks, manually run multiple `mu` sessions in different terminal tabs. You're the orchestrator.

## Background Bash

`bash` supports tracked background jobs for long-running commands.

- `{"command":"long task","background":true}` starts a job immediately and returns a job id.
- If a foreground command exceeds its timeout, mu may move it to a background job instead of killing it. This preserves progress for imports, indexing, downloads, builds, and similar long-running work.
- A background-job result means the command is still running. It is not a completed result and not evidence of success.
- If the task depends on that command finishing, use `{"job":"<id>","action":"wait","timeout":30}` before concluding.
- Use `status` for a quick progress check. Use `wait` when you need the final outcome.

The agent can follow up on a returned job id with:

- `{"job":"<id>","action":"status"}` to inspect current state and recent output
- `{"job":"<id>","action":"wait","timeout":30}` to wait for completion
- `{"job":"<id>","action":"kill"}` to stop the job

## Planned Features

Things that might happen eventually:

- **Auto-compaction**: Currently, watch the context percentage at the bottom. When it approaches 80%, either:
  - Ask the agent to write a summary .md file you can load in a new session
  - Switch to a model with bigger context (e.g., Gemini) using `/model` and either continue with that model, or let it summarize the session to a .md file to be loaded in a new session
- **Better RPC mode docs**: It works, you'll figure it out (see `test/rpc-example.ts`)

### Debug Command

The `/debug` command is a hidden development feature (not shown in autocomplete) that writes all currently rendered lines with their visible widths and ANSI escape sequences to `~/.mu/agent/pi-debug.log`. This is useful for debugging TUI rendering issues, especially when lines don't extend to the terminal edge or contain unexpected invisible characters.

```
/debug
```

The debug log includes:
- Terminal width at time of capture
- Total number of rendered lines
- Each line with its index, visible width, and JSON-escaped content showing all ANSI codes

## License

MIT

## See Also

- [@kennyfrc/mu-ai](https://www.npmjs.com/package/@kennyfrc/mu-ai): Core LLM toolkit with multi-provider support
- [@kennyfrc/mu-agent](https://www.npmjs.com/package/@kennyfrc/mu-agent): Agent framework with tool execution
- [Agent loop internals](docs/agent-loop.md): How mu runs turns, executes tools, emits events, and supports queue modes
