# packages/coding-agent/src/core

## Purpose
Core business logic for the pi coding agent: session management, agent session orchestration, auth storage, model resolution, extension system, package management, resource loading, settings, skills, and system prompt generation.

## Technology
TypeScript, ESM modules. Heavy use of `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`.

## Contents
- `agent-session.ts` - `AgentSession`: main session class managing Agent lifecycle, model switching, context transforms, tool registration, extension hooks, compaction, and session persistence
- `auth-storage.ts` - `AuthStorage`: credential management with file-based and in-memory backends, supports API keys and OAuth tokens
- `sdk.ts` - `createAgentSession(options)`: factory function that wires together session manager, auth, models, extensions, tools, and settings
- `session-manager.ts` - `SessionManager`: JSONL-based conversation persistence with branching (tree structure), compaction entries, fork/merge operations
- `settings-manager.ts` - `SettingsManager`: layered settings (global + project) with typed accessors for all configuration
- `model-registry.ts` - `ModelRegistry`: discovers models from built-in catalog, custom `models.json`, and extension-registered providers
- `model-resolver.ts` - `resolveCliModel()`, `resolveModelScope()`: resolves CLI model patterns to concrete Model instances
- `resource-loader.ts` - `DefaultResourceLoader`: discovers and loads extensions, skills, prompt templates, and themes from package sources
- `package-manager.ts` - `DefaultPackageManager`: installs/removes/updates packages from npm, git, or local paths
- `messages.ts` - `convertToLlm()`: converts `AgentMessage[]` to LLM-compatible `Message[]` (filters custom message types)
- `system-prompt.ts` - System prompt generation with tool descriptions, project context, and extension contributions
- `skills.ts` - `loadSkills()`, `formatSkillsForPrompt()`: loads SKILL.md files with frontmatter, formats for system prompt
- `slash-commands.ts` - Slash command resolution and execution
- `prompt-templates.ts` - Prompt template loading and variable substitution
- `keybindings.ts` - `KeybindingsManager`: configurable keybindings for interactive mode
- `event-bus.ts` - `createEventBus()`: typed event bus for extension communication
- `exec.ts` - Shell command execution utilities
- `bash-executor.ts` - Bash command executor with sandboxing support
- `defaults.ts` - Default configuration values (thinking level, etc.)
- `diagnostics.ts` - Session diagnostics and health checks
- `footer-data-provider.ts` - Git branch and extension status data for footer display
- `resolve-config-value.ts` - Config value resolution with environment variable expansion
- `timings.ts` - Performance timing utilities
- `index.ts` - Barrel export
- `compaction/` - Context compaction and branch summarization
- `export-html/` - HTML export with ANSI-to-HTML conversion and templates
- `extensions/` - Extension system: loading, running, and type definitions
- `tools/` - Built-in tool implementations (bash, read, write, edit, grep, find, ls)

## Key Functions
- `createAgentSession(options)`: Creates fully-configured `AgentSession`. Returns `{ session, modelFallbackMessage }`
- `AgentSession.prompt(text, images?)`: Send user message
- `AgentSession.setModel(model)`: Switch active model
- `AgentSession.setThinkingLevel(level)`: Set reasoning level
- `SessionManager.create(cwd, dir?)`: Create new session file
- `SessionManager.open(path, dir?)`: Open existing session
- `SessionManager.continueRecent(cwd, dir?)`: Resume most recent session
- `SessionManager.list(cwd, dir?)`: List all sessions for a project
- `AuthStorage.create()`: Create file-based auth storage
- `ModelRegistry.find(provider, modelId)`: Find model by provider and ID
- `loadSkills(paths)`: Load and validate SKILL.md files
- `SettingsManager.create(cwd, agentDir)`: Create layered settings manager

## Data Types
- `AgentSession`: Main session class with model, thinking, tools, extension runtime
- `SessionEntry`: discriminated union (message, compaction, branchSummary, modelChange, thinkingLevelChange, sessionInfo, custom, customMessage, file)
- `SessionInfo`: `{ id, path, cwd, name?, lastActivity, messageCount }`
- `CompactionSettings`: `{ maxContextPercentage, targetContextPercentage, ... }`
- `Skill`: `{ name, description, content, path }`
- `SettingsManager`: layered global + project settings

## Logging
Console output via `chalk`. Debug logging to file via `getDebugLogPath()`.

## CRUD Entry Points
- **Create**: `createAgentSession()`, `SessionManager.create()`, `AuthStorage.create()`
- **Read**: `SessionManager.list()`, `AgentSession.model`, `SettingsManager.get*()`, `ModelRegistry.find()`
- **Update**: `AgentSession.setModel()`, `AgentSession.setThinkingLevel()`, settings file edits
- **Delete**: Session file deletion, `AuthStorage` credential removal

## Style Guide
- camelCase for functions/variables, PascalCase for classes/types
- Tab indentation, 120-char line width
- Factory functions (`create*`) for complex initialization
- JSONL format for session persistence
- Layered settings: global (~/.pi/agent/settings.json) + project (.pi/settings.json)

```typescript
const { session } = await createAgentSession({
	model: getModel("anthropic", "claude-sonnet-4-20250514"),
	thinkingLevel: "medium",
});
await session.prompt("Refactor this function");
```
