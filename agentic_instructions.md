# pi-mono

## Purpose
Monorepo for the **pi** ecosystem -- an AI-powered coding agent with a unified LLM API, terminal UI, web UI, Slack bot, and GPU pod management. All packages share lockstep versioning and are published under the `@mariozechner` npm scope.

## Technology
TypeScript monorepo (npm workspaces, ESM modules). Build: `tsgo` (native TypeScript compiler). Lint/format: Biome. Test: Vitest. CI: GitHub Actions. Pre-commit: Husky. Node.js >= 20.

## Repository Structure

### Packages

| Package | npm Name | Purpose |
|---------|----------|---------|
| `packages/ai` | `@mariozechner/pi-ai` | Unified LLM API with 20+ providers (Anthropic, OpenAI, Google, Bedrock, Mistral, etc.), lazy-loaded modules, and OAuth flows |
| `packages/agent` | `@mariozechner/pi-agent-core` | General-purpose agent framework with transport abstraction and event-driven state |
| `packages/coding-agent` | `@mariozechner/pi-coding-agent` | Full coding agent CLI (`pi`) with tools, sessions, extensions, and interactive TUI |
| `packages/tui` | `@mariozechner/pi-tui` | Terminal UI library with differential rendering, components, and Kitty protocol |
| `packages/web-ui` | `@mariozechner/pi-web-ui` | Web chat UI components (Lit + Tailwind) with artifacts and sandbox |
| `packages/mom` | `@mariozechner/pi-mom` | Slack bot delegating messages to the coding agent |
| `packages/pods` | `@mariozechner/pi` | CLI for managing vLLM deployments on remote GPU pods |

### Infrastructure
- `.github/` -- CI workflows, issue templates, contributor approval
- `.husky/` -- Pre-commit hooks (biome + tsgo type checking)
- `.pi/` -- Project-local pi extensions, prompts, and configuration
- `scripts/` -- Release automation, version sync, cost analysis

## Key Abstractions

### Domain: LLM Integration (`packages/ai`)
| Abstraction | Type | Location | Relationships | CRUD Routing |
|-------------|------|----------|---------------|-------------|
| Model | interface | `packages/ai/src/types.ts` | Referenced by Agent, providers | Read: `getModel()`, `getModels()` in `packages/ai/src/models.ts` |
| Message | type union | `packages/ai/src/types.ts` | UserMessage, AssistantMessage, ToolResultMessage | Create: via Agent.prompt() |
| Context | interface | `packages/ai/src/types.ts` | Contains systemPrompt, messages, tools | Create: assembled by agent-loop |
| ApiProvider | interface | `packages/ai/src/api-registry.ts` | Implements stream/streamSimple for an API (lazy-loaded via `createLazyStream()`) | Create: `registerApiProvider()` in `packages/ai/src/api-registry.ts` |
| EventStream | class | `packages/ai/src/utils/event-stream.ts` | Used by all streaming functions | Create: instantiated per stream call |
| Tool | interface | `packages/ai/src/types.ts` | TypeBox schema parameters | Create: defined in `packages/coding-agent/src/core/tools/` |

### Domain: Agent Runtime (`packages/agent`)
| Abstraction | Type | Location | Relationships | CRUD Routing |
|-------------|------|----------|---------------|-------------|
| Agent | class | `packages/agent/src/agent.ts` | Uses AgentLoopConfig, AgentTool, AgentState | Create: `new Agent(options)` |
| AgentState | interface | `packages/agent/src/types.ts` | Contains model, messages, tools, streaming state | Read/Update: `agent.state`, setter methods |
| AgentTool | interface | `packages/agent/src/types.ts` | Extends Tool with execute function | Create: tool factories in coding-agent |
| AgentEvent | type union | `packages/agent/src/types.ts` | Emitted by agent loop | Read: `agent.subscribe()` |
| AgentLoopConfig | interface | `packages/agent/src/types.ts` | Configures LLM interaction per turn | Create: assembled by Agent._runLoop() |

### Domain: Coding Agent (`packages/coding-agent`)
| Abstraction | Type | Location | Relationships | CRUD Routing |
|-------------|------|----------|---------------|-------------|
| AgentSession | class | `packages/coding-agent/src/core/agent-session.ts` | Wraps Agent with session, extensions, settings | Create: `createAgentSession()` in `packages/coding-agent/src/core/sdk.ts` |
| SessionManager | class | `packages/coding-agent/src/core/session-manager.ts` | JSONL persistence with branching | Create: `SessionManager.create()`, `.open()`, `.continueRecent()` |
| Extension | interface | `packages/coding-agent/src/core/extensions/index.ts` | Registers tools, commands, handlers | Create: extension files in `.pi/extensions/` or packages |
| ExtensionAPI | interface | `packages/coding-agent/src/core/extensions/index.ts` | Passed to extension factories | Read: provided by ExtensionRunner |
| SettingsManager | class | `packages/coding-agent/src/core/settings-manager.ts` | Layered global + project settings | Create: `SettingsManager.create()` |
| ModelRegistry | class | `packages/coding-agent/src/core/model-registry.ts` | Discovers models from catalog + custom | Create: `new ModelRegistry()` |
| ResourceLoader | class | `packages/coding-agent/src/core/resource-loader.ts` | Loads extensions, skills, themes, prompts | Create: `new DefaultResourceLoader()` |
| Skill | interface | `packages/coding-agent/src/core/skills.ts` | SKILL.md files with frontmatter | Create: add SKILL.md files to skills directories |

### Domain: Terminal UI (`packages/tui`)
| Abstraction | Type | Location | Relationships | CRUD Routing |
|-------------|------|----------|---------------|-------------|
| TUI | class | `packages/tui/src/tui.ts` | Manages Component tree, rendering, overlays | Create: `new TUI(terminal)` |
| Component | interface | `packages/tui/src/tui.ts` | render(), handleInput(), invalidate() | Create: implement interface or use built-in components |
| Terminal | interface | `packages/tui/src/terminal.ts` | Abstracts stdin/stdout | Create: `new ProcessTerminal()` |
| Editor | class | `packages/tui/src/components/editor.ts` | Full text editor component | Create: `new Editor(options)` |
| SelectList | class | `packages/tui/src/components/select-list.ts` | Filterable selection list | Create: `new SelectList(items, rows, theme)` |

### Domain: Web UI (`packages/web-ui`)
| Abstraction | Type | Location | Relationships | CRUD Routing |
|-------------|------|----------|---------------|-------------|
| ChatPanel | Lit element | `packages/web-ui/src/ChatPanel.ts` | Contains AgentInterface + ArtifactsPanel | Create: `<pi-chat-panel>` element |
| AgentInterface | Lit element | `packages/web-ui/src/components/AgentInterface.ts` | Message list + input + selectors | Create: `<agent-interface>` element |
| AppStorage | class | `packages/web-ui/src/storage/app-storage.ts` | Coordinates all stores | Create: `getAppStorage()` singleton |
| ToolRenderer | interface | `packages/web-ui/src/tools/types.ts` | Renders tool results to HTML | Create: `registerToolRenderer()` |
| Artifact | interface | `packages/web-ui/src/tools/artifacts/artifacts.ts` | Rich content artifact | Create: AI agent via tool calls |

### Domain: Slack Bot (`packages/mom`)
| Abstraction | Type | Location | Relationships | CRUD Routing |
|-------------|------|----------|---------------|-------------|
| SlackBot | class | `packages/mom/src/slack.ts` | Socket Mode + Web API | Create: `new SlackBot(handler, config)` |
| AgentRunner | class | `packages/mom/src/agent.ts` | Wraps coding agent per channel | Create: `getOrCreateRunner()` |
| ChannelStore | class | `packages/mom/src/store.ts` | Per-channel persistence | Create: per channel state initialization |

### Domain: GPU Pods (`packages/pods`)
| Abstraction | Type | Location | Relationships | CRUD Routing |
|-------------|------|----------|---------------|-------------|
| Pod | interface | `packages/pods/src/types.ts` | SSH connection, GPUs, models | Create: `pi pods setup` |
| Config | interface | `packages/pods/src/types.ts` | Pod registry | Read/Write: `loadConfig()`, `saveConfig()` in `packages/pods/src/config.ts` |

## Dependency Graph
```
coding-agent --> agent --> ai
coding-agent --> tui
mom --> coding-agent, agent, ai
web-ui --> ai, tui
pods --> agent
```

## Build Order
`tui` -> `ai` -> `agent` -> `coding-agent` -> `mom`, `web-ui`, `pods`

## Commands
- `npm run build` -- Build all packages in dependency order
- `npm run dev` -- Watch mode for all packages
- `npm run check` -- Biome lint/format + tsgo type check (MUST pass before commit)
- `npm test` -- Run all package tests (Vitest)
- `npm run release:patch` / `release:minor` -- Automated release with changelog finalization
- NEVER run: `npm run dev`, `npm run build`, `npm test` (per AGENTS.md, use specific package commands)

## Style Guide
- TypeScript strict mode, ESM modules, no `any` unless necessary
- Tab indentation, 120-char line width (Biome)
- camelCase for variables/functions, PascalCase for types/classes
- No inline imports -- always top-level
- All keybindings must be configurable (never hardcoded)
- Lockstep versioning across all packages
