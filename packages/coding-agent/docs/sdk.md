> pi can help you use the SDK. Ask it to build an integration for your use case.

# SDK

The SDK provides programmatic access to pi's agent capabilities. Use it to embed pi in other applications, build custom interfaces, or integrate with automated workflows.

**Example use cases:**
- Build a custom UI (web, desktop, mobile)
- Integrate agent capabilities into existing applications
- Create automated pipelines with agent reasoning
- Build custom tools that spawn sub-agents
- Test agent behavior programmatically

See [examples/sdk/](../examples/sdk/) for working examples from minimal to full control.

## Quick Start

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@mariozechner/pi-coding-agent";

// Set up credential storage and model registry
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");
```

## Installation

```bash
npm install @mariozechner/pi-coding-agent
```

The SDK is included in the main package. No separate installation needed.

## Core Concepts

### createAgentSession()

The main factory function. Creates an `AgentSession` with configurable options.

`createAgentSession()` uses a `ResourceLoader` to supply extensions, skills, prompt templates, themes, and context files. If you do not provide one, it uses `DefaultResourceLoader` with standard discovery.

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";

// Minimal: defaults with DefaultResourceLoader
const { session } = await createAgentSession();

// Custom: override specific options
const { session } = await createAgentSession({
  model: myModel,
  tools: [readTool, bashTool],
  sessionManager: SessionManager.inMemory(),
});
```

### AgentSession

The session manages the agent lifecycle, message history, and event streaming.

```typescript
interface AgentSession {
  // Send a prompt and wait for completion
  // If streaming, requires streamingBehavior option to queue the message
  prompt(text: string, options?: PromptOptions): Promise<void>;
  
  // Queue messages during streaming
  steer(text: string): Promise<void>;    // Queue for delivery after the current assistant turn finishes its tool calls
  followUp(text: string): Promise<void>; // Wait: delivered only when agent finishes
  
  // Subscribe to events (returns unsubscribe function)
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  
  // Session info
  sessionFile: string | undefined;  // undefined for in-memory
  sessionId: string;
  
  // Model control
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;
  
  // State access
  agent: Agent;
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;
  
  // Session management
  newSession(options?: { parentSession?: string }): Promise<boolean>;  // Returns false if cancelled by hook
  switchSession(sessionPath: string): Promise<boolean>;
  
  // Forking
  fork(entryId: string): Promise<{ selectedText: string; cancelled: boolean }>;  // Creates new session file
  navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean }>;  // In-place navigation
  
  // Hook message injection
  sendHookMessage(message: HookMessage, triggerTurn?: boolean): Promise<void>;
  
  // Compaction
  compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;
  
  // Abort current operation
  abort(): Promise<void>;
  
  // Cleanup
  dispose(): void;
}
```

### Prompting and Message Queueing

The `prompt()` method handles prompt templates, extension commands, and message sending:

```typescript
// Basic prompt (when not streaming)
await session.prompt("What files are here?");

// With images
await session.prompt("What's in this image?", {
  images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } }]
});

// During streaming: must specify how to queue the message
await session.prompt("Stop and do this instead", { streamingBehavior: "steer" });
await session.prompt("After you're done, also check X", { streamingBehavior: "followUp" });
```

**Behavior:**
- **Extension commands** (e.g., `/mycommand`): Execute immediately, even during streaming. They manage their own LLM interaction via `pi.sendMessage()`.
- **File-based prompt templates** (from `.md` files): Expanded to their content before sending/queueing.
- **During streaming without `streamingBehavior`**: Throws an error. Use `steer()` or `followUp()` directly, or specify the option.

For explicit queueing during streaming:

```typescript
// Queue a steering message for delivery after the current assistant turn finishes its tool calls
await session.steer("New instruction");

// Wait for agent to finish (delivered only when agent stops)
await session.followUp("After you're done, also do this");
```

Both `steer()` and `followUp()` expand file-based prompt templates but error on extension commands (extension commands cannot be queued).

### Agent and AgentState

The `Agent` class (from `@mariozechner/pi-agent-core`) handles the core LLM interaction. Access it via `session.agent`.

```typescript
// Access current state
const state = session.agent.state;

// state.messages: AgentMessage[] - conversation history
// state.model: Model - current model
// state.thinkingLevel: ThinkingLevel - current thinking level
// state.systemPrompt: string - system prompt
// state.tools: Tool[] - available tools

// Replace messages (useful for branching, restoration)
session.agent.replaceMessages(messages);

// Wait for agent to finish processing
await session.agent.waitForIdle();
```

### Events

Subscribe to events to receive streaming output and lifecycle notifications.

```typescript
session.subscribe((event) => {
  switch (event.type) {
    // Streaming text from assistant
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      if (event.assistantMessageEvent.type === "thinking_delta") {
        // Thinking output (if thinking enabled)
      }
      break;
    
    // Tool execution
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_update":
      // Streaming tool output
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.isError ? "error" : "success"}`);
      break;
    
    // Message lifecycle
    case "message_start":
      // New message starting
      break;
    case "message_end":
      // Message complete
      break;
    
    // Agent lifecycle
    case "agent_start":
      // Agent started processing prompt
      break;
    case "agent_end":
      // Agent finished (event.messages contains new messages)
      break;
    
    // Turn lifecycle (one LLM response + tool calls)
    case "turn_start":
      break;
    case "turn_end":
      // event.message: assistant response
      // event.toolResults: tool results from this turn
      break;
    
    // Session events (queue, compaction, retry)
    case "queue_update":
      console.log(event.steering, event.followUp);
      break;
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
      break;
  }
});
```

## Options Reference

### Directories

```typescript
const { session } = await createAgentSession({
  // Working directory for DefaultResourceLoader discovery
  cwd: process.cwd(), // default
  
  // Global config directory
  agentDir: "~/.pi/agent", // default (expands ~)
});
```

`cwd` is used by `DefaultResourceLoader` for:
- Project extensions (`.pi/extensions/`)
- Project skills:
  - `.pi/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Project prompts (`.pi/prompts/`)
- Context files (`AGENTS.md` walking up from cwd)
- Session directory naming

`agentDir` is used by `DefaultResourceLoader` for:
- Global extensions (`extensions/`)
- Global skills:
  - `skills/` under `agentDir` (for example `~/.pi/agent/skills/`)
  - `~/.agents/skills/`
- Global prompts (`prompts/`)
- Global context file (`AGENTS.md`)
- Settings (`settings.json`)
- Custom models (`models.json`)
- Credentials (`auth.json`)
- Sessions (`sessions/`)

When you pass a custom `ResourceLoader`, `cwd` and `agentDir` no longer control resource discovery. They still influence session naming and tool path resolution.

### Model

```typescript
import { getModel } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Find specific built-in model (doesn't check if API key exists)
const opus = getModel("anthropic", "claude-opus-4-5");
if (!opus) throw new Error("Model not found");

// Find any model by provider/id, including custom models from models.json
// (doesn't check if API key exists)
const customModel = modelRegistry.find("my-provider", "my-model");

// Get only models that have valid API keys configured
const available = await modelRegistry.getAvailable();

const { session } = await createAgentSession({
  model: opus,
  thinkingLevel: "medium", // off, minimal, low, medium, high, xhigh
  
  // Models for cycling (Ctrl+P in interactive mode)
  scopedModels: [
    { model: opus, thinkingLevel: "high" },
    { model: haiku, thinkingLevel: "off" },
  ],
  
  authStorage,
  modelRegistry,
});
```

If no model is provided:
1. Tries to restore from session (if continuing)
2. Uses default from settings
3. Falls back to first available model

> See [examples/sdk/02-custom-model.ts](../examples/sdk/02-custom-model.ts)

### API Keys and OAuth

API key resolution priority (handled by AuthStorage):
1. Runtime overrides (via `setRuntimeApiKey`, not persisted)
2. Stored credentials in `auth.json` (API keys or OAuth tokens)
3. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
4. Fallback resolver (for custom provider keys from `models.json`)

```typescript
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

// Default: uses ~/.pi/agent/auth.json and ~/.pi/agent/models.json
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

// Runtime API key override (not persisted to disk)
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");

// Custom auth storage location
const customAuth = AuthStorage.create("/my/app/auth.json");
const customRegistry = ModelRegistry.create(customAuth, "/my/app/models.json");

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: customAuth,
  modelRegistry: customRegistry,
});

// No custom models.json (built-in models only)
const simpleRegistry = ModelRegistry.inMemory(authStorage);
```

> See [examples/sdk/09-api-keys-and-oauth.ts](../examples/sdk/09-api-keys-and-oauth.ts)

### System Prompt

Use a `ResourceLoader` to override the system prompt:

```typescript
import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";

const loader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are a helpful assistant.",
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/03-custom-prompt.ts](../examples/sdk/03-custom-prompt.ts)

### Tools

```typescript
import {
  codingTools,   // read, bash, edit, write (default)
  readOnlyTools, // read, grep, find, ls
  readTool, bashTool, editTool, writeTool,
  grepTool, findTool, lsTool,
} from "@mariozechner/pi-coding-agent";

// Use built-in tool set
const { session } = await createAgentSession({
  tools: readOnlyTools,
});

// Pick specific tools
const { session } = await createAgentSession({
  tools: [readTool, bashTool, grepTool],
});
```

#### Tools with Custom cwd

**Important:** The pre-built tool instances (`readTool`, `bashTool`, etc.) use `process.cwd()` for path resolution. When you specify a custom `cwd` AND provide explicit `tools`, you must use the tool factory functions to ensure paths resolve correctly:

```typescript
import {
  createCodingTools,    // Creates [read, bash, edit, write] for specific cwd
  createReadOnlyTools,  // Creates [read, grep, find, ls] for specific cwd
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";

const cwd = "/path/to/project";

// Use factory for tool sets
const { session } = await createAgentSession({
  cwd,
  tools: createCodingTools(cwd),  // Tools resolve paths relative to cwd
});

// Or pick specific tools
const { session } = await createAgentSession({
  cwd,
  tools: [createReadTool(cwd), createBashTool(cwd), createGrepTool(cwd)],
});
```

**When you don't need factories:**
- If you omit `tools`, pi automatically creates them with the correct `cwd`
- If you use `process.cwd()` as your `cwd`, the pre-built instances work fine

**When you must use factories:**
- When you specify both `cwd` (different from `process.cwd()`) AND `tools`

> See [examples/sdk/05-tools.ts](../examples/sdk/05-tools.ts)

### Custom Tools

```typescript
import { Type } from "@sinclair/typebox";
import { createAgentSession, type ToolDefinition } from "@mariozechner/pi-coding-agent";

// Inline custom tool
const myTool: ToolDefinition = {
  name: "my_tool",
  label: "My Tool",
  description: "Does something useful",
  parameters: Type.Object({
    input: Type.String({ description: "Input value" }),
  }),
  execute: async (toolCallId, params, onUpdate, ctx, signal) => ({
    content: [{ type: "text", text: `Result: ${params.input}` }],
    details: {},
  }),
};

// Pass custom tools directly
const { session } = await createAgentSession({
  customTools: [myTool],
});
```

Custom tools passed via `customTools` are combined with extension-registered tools. Extensions loaded by the ResourceLoader can also register tools via `pi.registerTool()`.

> See [examples/sdk/05-tools.ts](../examples/sdk/05-tools.ts)

### Extensions

Extensions are loaded by the `ResourceLoader`. `DefaultResourceLoader` discovers extensions from `~/.pi/agent/extensions/`, `.pi/extensions/`, and settings.json extension sources.

```typescript
import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";

const loader = new DefaultResourceLoader({
  additionalExtensionPaths: ["/path/to/my-extension.ts"],
  extensionFactories: [
    (pi) => {
      pi.on("agent_start", () => {
        console.log("[Inline Extension] Agent starting");
      });
    },
  ],
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

Extensions can register tools, subscribe to events, add commands, and more. See [extensions.md](extensions.md) for the full API.

**Event Bus:** Extensions can communicate via `pi.events`. Pass a shared `eventBus` to `DefaultResourceLoader` if you need to emit or listen from outside:

```typescript
import { createEventBus, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";

const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  eventBus,
});
await loader.reload();

eventBus.on("my-extension:status", (data) => console.log(data));
```

> See [examples/sdk/06-extensions.ts](../examples/sdk/06-extensions.ts) and [docs/extensions.md](extensions.md)

### Skills

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type Skill,
} from "@mariozechner/pi-coding-agent";

const customSkill: Skill = {
  name: "my-skill",
  description: "Custom instructions",
  filePath: "/path/to/SKILL.md",
  baseDir: "/path/to",
  source: "custom",
};

const loader = new DefaultResourceLoader({
  skillsOverride: (current) => ({
    skills: [...current.skills, customSkill],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/04-skills.ts](../examples/sdk/04-skills.ts)

### Context Files

```typescript
import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";

const loader = new DefaultResourceLoader({
  agentsFilesOverride: (current) => ({
    agentsFiles: [
      ...current.agentsFiles,
      { path: "/virtual/AGENTS.md", content: "# Guidelines\n\n- Be concise" },
    ],
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/07-context-files.ts](../examples/sdk/07-context-files.ts)

### Slash Commands

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  type PromptTemplate,
} from "@mariozechner/pi-coding-agent";

const customCommand: PromptTemplate = {
  name: "deploy",
  description: "Deploy the application",
  source: "(custom)",
  content: "# Deploy\n\n1. Build\n2. Test\n3. Deploy",
};

const loader = new DefaultResourceLoader({
  promptsOverride: (current) => ({
    prompts: [...current.prompts, customCommand],
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

> See [examples/sdk/08-prompt-templates.ts](../examples/sdk/08-prompt-templates.ts)

### Session Management

Sessions use a tree structure with `id`/`parentId` linking, enabling in-place branching.

```typescript
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";

// In-memory (no persistence)
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

// New persistent session
const { session } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

// Continue most recent
const { session, modelFallbackMessage } = await createAgentSession({
  sessionManager: SessionManager.continueRecent(process.cwd()),
});
if (modelFallbackMessage) {
  console.log("Note:", modelFallbackMessage);
}

// Open specific file
const { session } = await createAgentSession({
  sessionManager: SessionManager.open("/path/to/session.jsonl"),
});

// List available sessions (async with optional progress callback)
const sessions = await SessionManager.list(process.cwd());
for (const info of sessions) {
  console.log(`${info.id}: ${info.firstMessage} (${info.messageCount} messages, cwd: ${info.cwd})`);
}

// List all sessions across all projects
const allSessions = await SessionManager.listAll((loaded, total) => {
  console.log(`Loading ${loaded}/${total}...`);
});

// Custom session directory (no cwd encoding)
const customDir = "/path/to/my-sessions";
const { session } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd(), customDir),
});
```

**SessionManager tree API:**

```typescript
const sm = SessionManager.open("/path/to/session.jsonl");

// Tree traversal
const entries = sm.getEntries();        // All entries (excludes header)
const tree = sm.getTree();              // Full tree structure
const path = sm.getPath();              // Path from root to current leaf
const leaf = sm.getLeafEntry();         // Current leaf entry
const entry = sm.getEntry(id);          // Get entry by ID
const children = sm.getChildren(id);    // Direct children of entry

// Labels
const label = sm.getLabel(id);          // Get label for entry
sm.appendLabelChange(id, "checkpoint"); // Set label

// Branching
sm.branch(entryId);                     // Move leaf to earlier entry
sm.branchWithSummary(id, "Summary...");  // Branch with context summary
sm.createBranchedSession(leafId);       // Extract path to new file
```

> See [examples/sdk/11-sessions.ts](../examples/sdk/11-sessions.ts) and [docs/session.md](session.md)

### Settings Management

```typescript
import { createAgentSession, SettingsManager, SessionManager } from "@mariozechner/pi-coding-agent";

// Default: loads from files (global + project merged)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create(),
});

// With overrides
const settingsManager = SettingsManager.create();
settingsManager.applyOverrides({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 5 },
});
const { session } = await createAgentSession({ settingsManager });

// In-memory (no file I/O, for testing)
const { session } = await createAgentSession({
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  sessionManager: SessionManager.inMemory(),
});

// Custom directories
const { session } = await createAgentSession({
  settingsManager: SettingsManager.create("/custom/cwd", "/custom/agent"),
});
```

**Static factories:**
- `SettingsManager.create(cwd?, agentDir?)` - Load from files
- `SettingsManager.inMemory(settings?)` - No file I/O

**Project-specific settings:**

Settings load from two locations and merge:
1. Global: `~/.pi/agent/settings.json`
2. Project: `<cwd>/.pi/settings.json`

Project overrides global. Nested objects merge keys. Setters modify global settings by default.

**Persistence and error handling semantics:**

- Settings getters/setters are synchronous for in-memory state.
- Setters enqueue persistence writes asynchronously.
- Call `await settingsManager.flush()` when you need a durability boundary (for example, before process exit or before asserting file contents in tests).
- `SettingsManager` does not print settings I/O errors. Use `settingsManager.drainErrors()` and report them in your app layer.

> See [examples/sdk/10-settings.ts](../examples/sdk/10-settings.ts)

## ResourceLoader

Use `DefaultResourceLoader` to discover extensions, skills, prompts, themes, and context files.

```typescript
import {
  DefaultResourceLoader,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
});
await loader.reload();

const extensions = loader.getExtensions();
const skills = loader.getSkills();
const prompts = loader.getPrompts();
const themes = loader.getThemes();
const contextFiles = loader.getAgentsFiles().agentsFiles;
```

## Return Value

`createAgentSession()` returns:

```typescript
interface CreateAgentSessionResult {
  // The session
  session: AgentSession;
  
  // Extensions result (for runner setup)
  extensionsResult: LoadExtensionsResult;
  
  // Warning if session model couldn't be restored
  modelFallbackMessage?: string;
}

interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  runtime: ExtensionRuntime;
}
```

## Complete Example

```typescript
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  readTool,
  bashTool,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";

// Set up auth storage (custom location)
const authStorage = AuthStorage.create("/custom/agent/auth.json");

// Runtime API key override (not persisted)
if (process.env.MY_KEY) {
  authStorage.setRuntimeApiKey("anthropic", process.env.MY_KEY);
}

// Model registry (no custom models.json)
const modelRegistry = ModelRegistry.create(authStorage);

// Inline tool
const statusTool: ToolDefinition = {
  name: "status",
  label: "Status",
  description: "Get system status",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: `Uptime: ${process.uptime()}s` }],
    details: {},
  }),
};

const model = getModel("anthropic", "claude-opus-4-5");
if (!model) throw new Error("Model not found");

// In-memory settings with overrides
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
});

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: "/custom/agent",
  settingsManager,
  systemPromptOverride: () => "You are a minimal assistant. Be concise.",
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: process.cwd(),
  agentDir: "/custom/agent",

  model,
  thinkingLevel: "off",
  authStorage,
  modelRegistry,

  tools: [readTool, bashTool],
  customTools: [statusTool],
  resourceLoader: loader,

  sessionManager: SessionManager.inMemory(),
  settingsManager,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Get status and list files.");
```

## Run Modes

The SDK exports run mode utilities for building custom interfaces on top of `createAgentSession()`:

### InteractiveMode

Full TUI interactive mode with editor, chat history, and all built-in commands:

```typescript
import { createAgentSession, InteractiveMode } from "@mariozechner/pi-coding-agent";

const { session } = await createAgentSession({ /* ... */ });

const mode = new InteractiveMode(session, {
  // All optional
  migratedProviders: [],           // Show migration warnings
  modelFallbackMessage: undefined, // Show model restore warning
  initialMessage: "Hello",         // Send on startup
  initialImages: [],               // Images with initial message
  initialMessages: [],             // Additional startup prompts
});

await mode.run();  // Blocks until exit
```

### runPrintMode

Single-shot mode: send prompts, output result, exit:

```typescript
import { createAgentSession, runPrintMode } from "@mariozechner/pi-coding-agent";

const { session } = await createAgentSession({ /* ... */ });

await runPrintMode(session, {
  mode: "text",              // "text" for final response, "json" for all events
  initialMessage: "Hello",   // First message (can include @file content)
  initialImages: [],         // Images with initial message
  messages: ["Follow up"],   // Additional prompts
});
```

### runRpcMode

JSON-RPC mode for subprocess integration:

```typescript
import { createAgentSession, runRpcMode } from "@mariozechner/pi-coding-agent";

const { session } = await createAgentSession({ /* ... */ });

await runRpcMode(session);  // Reads JSON commands from stdin, writes to stdout
```

See [RPC documentation](rpc.md) for the JSON protocol.

## RPC Mode Alternative

For subprocess-based integration without building with the SDK, use the CLI directly:

```bash
pi --mode rpc --no-session
```

See [RPC documentation](rpc.md) for the JSON protocol.

The SDK is preferred when:
- You want type safety
- You're in the same Node.js process
- You need direct access to agent state
- You want to customize tools/extensions programmatically

RPC mode is preferred when:
- You're integrating from another language
- You want process isolation
- You're building a language-agnostic client

## Exports

The main entry point exports:

```typescript
// Factory
createAgentSession

// Auth and Models
AuthStorage
ModelRegistry

// Resource loading
DefaultResourceLoader
type ResourceLoader
createEventBus

// Helpers

// Session management
SessionManager
SettingsManager

// Built-in tools (use process.cwd())
codingTools
readOnlyTools
readTool, bashTool, editTool, writeTool
grepTool, findTool, lsTool

// Tool factories (for custom cwd)
createCodingTools
createReadOnlyTools
createReadTool, createBashTool, createEditTool, createWriteTool
createGrepTool, createFindTool, createLsTool

// Types
type CreateAgentSessionOptions
type CreateAgentSessionResult
type ExtensionFactory
type ExtensionAPI
type ToolDefinition
type Skill
type PromptTemplate
type Tool
```

For extension types, see [extensions.md](extensions.md) for the full API.
