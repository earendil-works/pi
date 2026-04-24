# Mom Redesign: Multi-Platform Chat Support

## Goals

1. Support multiple chat platforms (Slack, Discord, WhatsApp, Telegram, etc.)
2. Unified storage layer for all platforms
3. Platform-agnostic agent that doesn't care where messages come from
4. Adapters that are independently testable
5. Agent that is independently testable

## Current Architecture Problems

The current architecture tightly couples Slack-specific code throughout:

```
main.ts → SlackBot → handler.handleEvent() → agent.run(SlackContext)
                                                    ↓
                                              SlackContext.respond()
                                              SlackContext.replaceMessage()
                                              SlackContext.respondInThread()
                                              etc.
```

Problems:
- `SlackContext` interface leaks Slack concepts (threads, typing indicators)
- Agent code references Slack-specific formatting (mrkdwn, `<@user>` mentions)
- Storage uses Slack timestamps (`ts`) as message IDs
- Message logging assumes Slack's event structure
- The PR's Discord implementation duplicated most of this logic in a separate package

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLI / Entry Point                          │
│  mom ./data                                                             │
│  (reads config.json, starts all configured adapters)                    │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Platform Adapter                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ SlackAdapter │  │DiscordAdapter│  │  CLIAdapter  │  (for testing)   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                  │
│         │                 │                 │                           │
│         └────────────────┬┴─────────────────┘                           │
│                          │                                              │
│                          ▼                                              │
│              ┌───────────────────────┐                                  │
│              │  PlatformAdapter      │  (common interface)              │
│              │  - onMessage()        │                                  │
│              │  - onStop()           │                                  │
│              │  - sendMessage()      │                                  │
│              │  - updateMessage()    │                                  │
│              │  - deleteMessage()    │                                  │
│              │  - uploadFile()       │                                  │
│              │  - getChannelInfo()   │                                  │
│              │  - getUserInfo()      │                                  │
│              └───────────┬───────────┘                                  │
└──────────────────────────┼──────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              MomAgent                                   │
│  - Platform agnostic                                                    │
│  - Receives messages via handleMessage(message, context, onEvent)       │
│  - Forwards AgentSessionEvent to adapter via callback                   │
│  - Provides: abort(), isRunning()                                       │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           ChannelStore                                  │
│  - Unified storage schema for all platforms                             │
│  - log.jsonl: channel history (messages only)                           │
│  - context.jsonl: LLM context (messages + tool results)                 │
│  - attachments/: downloaded files                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Interfaces

### 1. ChannelMessage (Unified Message Format)

```typescript
interface ChannelMessage {
  /** Unique ID within the channel (platform-specific format preserved) */
  id: string;
  
  /** Channel/conversation ID */
  channelId: string;
  
  /** Timestamp (ISO 8601) */
  timestamp: string;
  
  /** Sender info */
  sender: {
    id: string;
    username: string;
    displayName?: string;
    isBot: boolean;
  };
  
  /** Message content (as received from platform) */
  text: string;
  
  /** Optional: original platform-specific text (for debugging) */
  rawText?: string;
  
  /** Attachments */
  attachments: ChannelAttachment[];
  
  /** Is this a direct mention/trigger of the bot? */
  isMention: boolean;
  
  /** Optional: reply-to message ID (for threaded conversations) */
  replyTo?: string;
  
  /** Platform-specific metadata (for platform-specific features) */
  metadata?: Record<string, unknown>;
}

interface ChannelAttachment {
  /** Original filename */
  filename: string;
  
  /** Local path (relative to channel dir) */
  localPath: string;
  
  /** MIME type if known */
  mimeType?: string;
  
  /** File size in bytes */
  size?: number;
}
```

### 2. PlatformAdapter

Adapters handle platform connection and UI. They receive events from MomAgent and render however they want.

```typescript
interface PlatformAdapter {
  /** Adapter name (used in channel paths, e.g., "slack-acme") */
  name: string;
  
  /** Start the adapter (connect to platform) */
  start(): Promise<void>;
  
  /** Stop the adapter */
  stop(): Promise<void>;
  
  /** Get all known channels */
  getChannels(): ChannelInfo[];
  
  /** Get all known users */
  getUsers(): UserInfo[];
}

interface ChannelInfo {
  id: string;
  name: string;
  type: 'channel' | 'dm' | 'group';
}

interface UserInfo {
  id: string;
  username: string;
  displayName?: string;
}
```

### 3. MomAgent

MomAgent wraps `AgentSession` from coding-agent. Agent is platform-agnostic; it just forwards events to the adapter.

```typescript
import { type AgentSessionEvent } from "@mariozechner/pi-coding-agent";

interface MomAgent {
  /**
   * Handle an incoming message.
   * Adapter receives events via callback and renders however it wants.
   */
  handleMessage(
    message: ChannelMessage,
    context: ChannelContext,
    onEvent: (event: AgentSessionEvent) => Promise<void>
  ): Promise<{ stopReason: string; errorMessage?: string }>;
  
  /** Abort the current run for a channel */
  abort(channelId: string): void;
  
  /** Check if a channel is currently running */
  isRunning(channelId: string): boolean;
}

interface ChannelContext {
  /** Adapter name (for channel path: channels/<adapter>/<channelId>/) */
  adapter: string;
  users: UserInfo[];
  channels: ChannelInfo[];
}
```

## Event Handling

Adapter receives `AgentSessionEvent` and renders however it wants:

```typescript
// Slack adapter example
async function handleEvent(event: AgentSessionEvent, ctx: SlackContext) {
  switch (event.type) {
    case 'tool_execution_start': {
      const label = (event.args as any).label || event.toolName;
      await ctx.updateMain(`_→ ${label}_`);
      break;
    }
    
    case 'tool_execution_end': {
      // Format tool result for thread
      const result = extractText(event.result);
      const formatted = `**${event.toolName}** (${event.durationMs}ms)\n\`\`\`\n${result}\n\`\`\``;
      await ctx.appendThread(this.toSlackFormat(formatted));
      break;
    }
    
    case 'message_end': {
      if (event.message.role === 'assistant') {
        const text = extractAssistantText(event.message);
        await ctx.replaceMain(this.toSlackFormat(text));
        await ctx.appendThread(this.toSlackFormat(text));
        
        // Usage from AssistantMessage
        if (event.message.usage) {
          await ctx.appendThread(formatUsage(event.message.usage));
        }
      }
      break;
    }
    
    case 'auto_compaction_start':
      await ctx.updateMain('_Compacting context..._');
      break;
  }
}
```

Each adapter decides:
- Message formatting (markdown → mrkdwn, embeds, etc.)
- Message splitting for platform limits
- What goes in main message vs thread
- How to show tool results, usage, errors

## Storage Format

### log.jsonl (Channel History)

Messages stored as received from platform:

```jsonl
{"id":"1734567890.123456","ts":"2024-12-20T10:00:00.000Z","sender":{"id":"U123","username":"mario","displayName":"Mario Z","isBot":false},"text":"<@U789> what's the weather?","attachments":[],"isMention":true}
{"id":"1734567890.234567","ts":"2024-12-20T10:00:05.000Z","sender":{"id":"bot","username":"mom","isBot":true},"text":"The weather is sunny!","attachments":[]}
```

### context.jsonl (LLM Context)

Same format as current (coding-agent compatible):

```jsonl
{"type":"session","id":"uuid","timestamp":"...","provider":"anthropic","modelId":"claude-sonnet-4-5"}
{"type":"message","timestamp":"...","message":{"role":"user","content":"[mario]: what's the weather?"}}
{"type":"message","timestamp":"...","message":{"role":"assistant","content":[{"type":"text","text":"The weather is sunny!"}]}}
```

## Directory Structure

```
data/
├── config.json                    # Host only - tokens, adapters, access control
└── workspace/                     # Mounted as /workspace in Docker
    ├── MEMORY.md
    ├── skills/
    ├── tools/
    ├── events/
    └── channels/
        ├── slack-acme/
        │   └── C0A34FL8PMH/
        │       ├── MEMORY.md
        │       ├── log.jsonl
        │       ├── context.jsonl
        │       ├── attachments/
        │       ├── skills/
        │       └── scratch/
        └── discord-mybot/
            └── 1234567890123456789/
                └── ...
```

**config.json** (not mounted, stays on host):

```json
{
  "adapters": {
    "slack-acme": {
      "type": "slack",
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "admins": ["U123", "U456"],
      "dm": "everyone"
    },
    "discord-mybot": {
      "type": "discord",
      "botToken": "...",
      "admins": ["123456789"],
      "dm": "none"
    }
  }
}
```

**Access control:**
- `admins`: User IDs with admin privileges. Can always DM.
- `dm`: Who else can DM. `"everyone"`, `"none"`, or `["U789", "U012"]`

**Channels** are namespaced by adapter name: `channels/<adapter>/<channelId>/`

**Events** use qualified channelId: `{"channelId": "slack-acme/C123", ...}`

**Security note:** Mom has bash access to all channel logs in the workspace. If mom is in a private channel, anyone who can talk to mom could potentially access that channel's history. For true isolation, run separate mom instances with separate data directories.

### Channel Isolation via Bubblewrap (Linux/Docker)

In Linux-based execution environments (Docker), we can use [bubblewrap](https://github.com/containers/bubblewrap) to enforce per-user channel access at the OS level.

**How it works:**
1. Adapter knows which channels the requesting user has access to
2. Before executing bash, wrap command with bwrap
3. Mount entire filesystem, then overlay denied channels with empty tmpfs
4. Sandboxed process can't see files in denied channels

```typescript
function wrapWithBwrap(command: string, deniedChannels: string[]): string {
  const args = [
    '--bind / /',                              // Mount everything
    ...deniedChannels.map(ch => 
      `--tmpfs /workspace/channels/${ch}`      // Hide denied channels
    ),
    '--dev /dev',
    '--proc /proc',
    '--die-with-parent',
  ];
  return `bwrap ${args.join(' ')} -- ${command}`;
}

// Usage
const userChannels = adapter.getUserChannels(userId);  // ["public", "team-a"]
const allChannels = await fs.readdir('/workspace/channels/');
const denied = allChannels.filter(ch => !userChannels.includes(ch));

const sandboxedCmd = wrapWithBwrap('cat /workspace/channels/private/log.jsonl', denied);
// Results in: "No such file or directory" - private channel hidden
```

**Requirements:**
- Docker container needs `--cap-add=SYS_ADMIN` for bwrap to create namespaces
- Install in Dockerfile: `apk add bubblewrap`

**Limitations:**
- Linux only (not macOS host mode)
- Requires SYS_ADMIN capability in Docker
- Per-execution overhead (though minimal)

## System Prompt Changes

The system prompt is platform-agnostic. Agent outputs standard markdown, adapter converts.

```typescript
function buildSystemPrompt(
  workspacePath: string,
  channelId: string,
  memory: string,
  sandbox: SandboxConfig,
  context: ChannelContext,
  skills: Skill[]
): string {
  return `You are mom, a chat bot assistant. Be concise. No emojis.

## Text Formatting
Use standard markdown: **bold**, *italic*, \`code\`, \`\`\`block\`\`\`, [text](url)
For mentions, use @username format.

## Users
${context.users.map(u => `@${u.username}\t${u.displayName || ''}`).join('\n')}

## Channels
${context.channels.map(c => `#${c.name}`).join('\n')}

... rest of prompt ...
`;
}
```

The adapter converts markdown to platform format internally:

```typescript
// Inside SlackAdapter
private formatForSlack(markdown: string): string {
  let text = markdown;
  
  // Bold: **text** → *text*
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  
  // Links: [text](url) → <url|text>
  text = text.replace(/\[(.+?)\]\((.+?)\)/g, '<$2|$1>');
  
  // Mentions: @username → <@U123>
  text = text.replace(/@(\w+)/g, (match, username) => {
    const user = this.users.find(u => u.username === username);
    return user ? `<@${user.id}>` : match;
  });
  
  return text;
}
```
```

## Testing Strategy

### 1. Agent Tests (with temp Docker container)

```typescript
// test/agent.test.ts
import { MomAgent } from '../src/agent.js';
import { createTestContainer, destroyTestContainer } from './docker-utils.js';

describe('MomAgent', () => {
  let containerName: string;
  
  beforeAll(async () => {
    containerName = await createTestContainer();
  });
  
  afterAll(async () => {
    await destroyTestContainer(containerName);
  });

  it('responds to user message', async () => {
    const agent = new MomAgent({
      workDir: tmpDir,
      sandbox: { type: 'docker', container: containerName }
    });
    
    const events: AgentSessionEvent[] = [];
    
    await agent.handleMessage(
      {
        id: '1',
        channelId: 'test-channel',
        timestamp: new Date().toISOString(),
        sender: { id: 'u1', username: 'testuser', isBot: false },
        text: 'hello',
        attachments: [],
        isMention: true,
      },
      { adapter: 'test', users: [], channels: [] },
      async (event) => { events.push(event); }
    );
    
    const messageEnds = events.filter(e => e.type === 'message_end');
    expect(messageEnds.length).toBeGreaterThan(0);
  });
});
```

### 2. Adapter Tests (no agent)

```typescript
// test/adapters/slack.test.ts
describe('SlackAdapter', () => {
  it('converts Slack event to ChannelMessage', () => {
    const slackEvent = {
      type: 'message',
      text: 'Hello <@U123>',
      user: 'U456',
      channel: 'C789',
      ts: '1234567890.123456',
    };
    
    const message = SlackAdapter.parseEvent(slackEvent, userCache);
    
    expect(message.text).toBe('Hello @someuser');
    expect(message.channelId).toBe('C789');
    expect(message.sender.id).toBe('U456');
  });
  
  it('converts markdown to Slack format', () => {
    const slack = SlackAdapter.toSlackFormat('**bold** and [link](http://example.com)');
    expect(slack).toBe('*bold* and <http://example.com|link>');
  });
  
  it('handles message_end event', async () => {
    const mockClient = new MockSlackClient();
    const adapter = new SlackAdapter({ client: mockClient });
    
    await adapter.handleEvent({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '**Hello**' }] }
    }, channelContext);
    
    // Verify Slack formatting applied
    expect(mockClient.postMessage).toHaveBeenCalledWith('C123', '*Hello*');
  });
});
```

### 3. Integration Tests

```typescript
// test/integration.test.ts
describe('Mom Integration', () => {
  let containerName: string;
  
  beforeAll(async () => {
    containerName = await createTestContainer();
  });
  
  afterAll(async () => {
    await destroyTestContainer(containerName);
  });

  it('end-to-end with CLI adapter', async () => {
    const agent = new MomAgent({
      workDir: tmpDir,
      sandbox: { type: 'docker', container: containerName }
    });
    const adapter = new CLIAdapter({ agent, input: mockStdin, output: mockStdout });
    
    await adapter.start();
    mockStdin.emit('data', 'Hello mom\n');
    
    await waitFor(() => mockStdout.data.length > 0);
    expect(mockStdout.data).toContain('Hello');
  });
});
```

## Migration Path

1. **Phase 1: Refactor storage** (non-breaking)
   - Unify log.jsonl schema (ChannelMessage format)
   - Add migration for existing Slack-format logs

2. **Phase 2: Extract adapter interface** (non-breaking)
   - Create SlackAdapter wrapping current SlackBot
   - Agent emits events, adapter handles UI

3. **Phase 3: Decouple agent** (non-breaking)
   - Remove Slack-specific code from agent.ts
   - Agent becomes fully platform-agnostic

4. **Phase 4: Add Discord** (new feature)
   - Implement DiscordAdapter
   - Share all storage and agent code

## Decisions

1. **Channel ID collision**: Prefix with adapter name (`channels/slack-acme/C123/`).

2. **Threads**: Adapter decides. Slack uses threads, Discord can use threads or embeds.

3. **Mentions**: Store as-is from platform. Agent outputs `@username`, adapter converts.

4. **Rate limiting**: Each adapter handles its own.

5. **Config**: Single `config.json` with all adapter configs and tokens.

## File Structure

```
packages/mom/src/
├── main.ts                    # CLI entry point
├── agent.ts                   # MomAgent
├── store.ts                   # ChannelStore
├── context.ts                 # Session management
├── sandbox.ts                 # Sandbox execution
├── events.ts                  # Scheduled events
├── log.ts                     # Console logging
│
├── adapters/
│   ├── types.ts              # PlatformAdapter, ChannelMessage interfaces
│   ├── slack.ts              # SlackAdapter
│   ├── discord.ts            # DiscordAdapter
│   └── cli.ts                # CLIAdapter (for testing)
│
└── tools/
    ├── index.ts
    ├── bash.ts
    ├── read.ts
    ├── write.ts
    ├── edit.ts
    └── attach.ts
```

## Custom Tools (Host-Side Execution)

Mom runs bash commands inside a sandbox (Docker container), but sometimes you need tools that run on the host machine (e.g., accessing host APIs, credentials, or services that can't run in the container).

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Host Machine                               │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                        Mom Process (Node.js)                       │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐│  │
│  │  │ CustomTool  │  │ CustomTool  │  │ invoke_tool (AgentTool)     ││  │
│  │  │ gmail       │  │ calendar    │  │ - receives tool name + args ││  │
│  │  │ (loaded via │  │ (loaded via │  │ - dispatches to custom tool ││  │
│  │  │  jiti)      │  │  jiti)      │  │ - returns result to agent   ││  │
│  │  └─────────────┘  └─────────────┘  └─────────────────────────────┘│  │
│  │                          ▲                      │                   │  │
│  │                          │ execute()            │ invoke_tool()     │  │
│  │                          │                      ▼                   │  │
│  │  ┌───────────────────────────────────────────────────────────────┐│  │
│  │  │                     MomAgent                                   ││  │
│  │  │  - System prompt describes all custom tools                    ││  │
│  │  │  - Has invoke_tool as one of its tools                         ││  │
│  │  │  - Mom calls invoke_tool("gmail", {action: "search", ...})     ││  │
│  │  └───────────────────────────────────────────────────────────────┘│  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                    │                                     │
│                                    │ bash tool (Docker exec)             │
│                                    ▼                                     │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                     Docker Container (Sandbox)                     │  │
│  │  - Mom's bash commands run here                                    │  │
│  │  - Isolated from host (except mounted workspace)                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Custom Tool Interface

```typescript
// data/tools/gmail/index.ts
import type { MomCustomTool, ToolAPI } from "@mariozechner/pi-mom";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const tool: MomCustomTool = {
  name: "gmail",
  description: "Search, read, and send emails via Gmail",
  parameters: Type.Object({
    action: StringEnum(["search", "read", "send"]),
    query: Type.Optional(Type.String({ description: "Search query" })),
    messageId: Type.Optional(Type.String({ description: "Message ID to read" })),
    to: Type.Optional(Type.String({ description: "Recipient email" })),
    subject: Type.Optional(Type.String({ description: "Email subject" })),
    body: Type.Optional(Type.String({ description: "Email body" })),
  }),
  
  async execute(toolCallId, params, signal) {
    switch (params.action) {
      case "search":
        const results = await searchEmails(params.query);
        return {
          content: [{ type: "text", text: formatSearchResults(results) }],
          details: { count: results.length },
        };
      case "read":
        const email = await readEmail(params.messageId);
        return {
          content: [{ type: "text", text: email.body }],
          details: { from: email.from, subject: email.subject },
        };
      case "send":
        await sendEmail(params.to, params.subject, params.body);
        return {
          content: [{ type: "text", text: `Email sent to ${params.to}` }],
          details: { sent: true },
        };
    }
  },
};

export default tool;
```

### MomCustomTool Type

```typescript
import type { TSchema, Static } from "typebox";

export interface MomToolResult<TDetails = any> {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details?: TDetails;
}

export interface MomCustomTool<TParams extends TSchema = TSchema, TDetails = any> {
  /** Tool name (must be unique) */
  name: string;
  
  /** Human-readable description for system prompt */
  description: string;
  
  /** TypeBox schema for parameters */
  parameters: TParams;
  
  /** Execute the tool */
  execute: (
    toolCallId: string,
    params: Static<TParams>,
    signal?: AbortSignal,
  ) => Promise<MomToolResult<TDetails>>;
  
  /** Optional: called when mom starts (for initialization) */
  onStart?: () => Promise<void>;
  
  /** Optional: called when mom stops (for cleanup) */
  onStop?: () => Promise<void>;
}

/** Factory function for tools that need async initialization */
export type MomCustomToolFactory = (api: ToolAPI) => MomCustomTool | Promise<MomCustomTool>;

export interface ToolAPI {
  /** Path to mom's data directory */
  dataDir: string;
  
  /** Execute a command on the host (not in sandbox) */
  exec: (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
  
  /** Read a file from the data directory */
  readFile: (path: string) => Promise<string>;
  
  /** Write a file to the data directory */
  writeFile: (path: string, content: string) => Promise<void>;
}
```

### Tool Discovery and Loading

Tools are discovered from:
1. `data/tools/**/index.ts` (workspace-local, recursive)
2. `~/.pi/mom/tools/**/index.ts` (global, recursive)

```typescript
// loader.ts
import { createJiti } from "jiti";

interface LoadedTool {
  path: string;
  tool: MomCustomTool;
}

async function loadCustomTools(dataDir: string): Promise<LoadedTool[]> {
  const tools: LoadedTool[] = [];
  const jiti = createJiti(import.meta.url, { alias: getAliases() });
  
  // Discover tool directories
  const toolDirs = [
    path.join(dataDir, "tools"),
    path.join(os.homedir(), ".pi", "mom", "tools"),
  ];
  
  for (const dir of toolDirs) {
    if (!fs.existsSync(dir)) continue;
    
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      
      const indexPath = path.join(dir, entry.name, "index.ts");
      if (!fs.existsSync(indexPath)) continue;
      
      try {
        const module = await jiti.import(indexPath, { default: true });
        const toolOrFactory = module as MomCustomTool | MomCustomToolFactory;
        
        const tool = typeof toolOrFactory === "function"
          ? await toolOrFactory(createToolAPI(dataDir))
          : toolOrFactory;
        
        tools.push({ path: indexPath, tool });
      } catch (err) {
        console.error(`Failed to load tool from ${indexPath}:`, err);
      }
    }
  }
  
  return tools;
}
```

### The invoke_tool Agent Tool

Mom has a single `invoke_tool` tool that dispatches to custom tools:

```typescript
import { Type } from "typebox";

function createInvokeToolTool(loadedTools: LoadedTool[]): AgentTool {
  const toolMap = new Map(loadedTools.map(t => [t.tool.name, t.tool]));
  
  return {
    name: "invoke_tool",
    label: "Invoke Tool",
    description: "Invoke a custom tool running on the host machine",
    parameters: Type.Object({
      tool: Type.String({ description: "Name of the tool to invoke" }),
      args: Type.Any({ description: "Arguments to pass to the tool (tool-specific)" }),
    }),
    
    async execute(toolCallId, params, signal) {
      const tool = toolMap.get(params.tool);
      if (!tool) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${params.tool}` }],
          details: { error: true },
          isError: true,
        };
      }
      
      try {
        // Validate args against tool's schema
        // (TypeBox validation here)
        
        const result = await tool.execute(toolCallId, params.args, signal);
        return {
          content: result.content,
          details: { tool: params.tool, ...result.details },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Tool error: ${err.message}` }],
          details: { error: true, tool: params.tool },
          isError: true,
        };
      }
    },
  };
}
```

### System Prompt Integration

Custom tools are described in the system prompt so mom knows what's available:

```typescript
function formatCustomToolsForPrompt(tools: LoadedTool[]): string {
  if (tools.length === 0) return "";
  
  let section = `\n## Custom Tools (Host-Side)

These tools run on the host machine (not in your sandbox). Use the \`invoke_tool\` tool to call them.

`;

  for (const { tool } of tools) {
    section += `### ${tool.name}
${tool.description}

**Parameters:**
\`\`\`json
${JSON.stringify(schemaToSimpleJson(tool.parameters), null, 2)}
\`\`\`

**Example:**
\`\`\`
invoke_tool(tool: "${tool.name}", args: { ... })
\`\`\`

`;
  }
  
  return section;
}

// Convert TypeBox schema to simple JSON for display
function schemaToSimpleJson(schema: TSchema): object {
  // Simplified schema representation for the LLM
  // ...
}
```

### Example: Gmail Tool

```typescript
// data/tools/gmail/index.ts
import type { MomCustomTool, ToolAPI } from "@mariozechner/pi-mom";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import Imap from "imap";
import nodemailer from "nodemailer";

export default async function(api: ToolAPI): Promise<MomCustomTool> {
  // Load credentials from data directory
  const credsPath = path.join(api.dataDir, "tools", "gmail", "credentials.json");
  const creds = JSON.parse(await api.readFile(credsPath));
  
  return {
    name: "gmail",
    description: "Search, read, and send emails via Gmail. Requires credentials.json in the tool directory.",
    parameters: Type.Object({
      action: StringEnum(["search", "read", "send", "list"]),
      // ... other params
    }),
    
    async execute(toolCallId, params, signal) {
      // Implementation using imap/nodemailer
    },
  };
}
```

### Security Considerations

1. **Tools run on host**: Custom tools have full host access. Only install trusted tools.
2. **Credential storage**: Tools should store credentials in the data directory, not in code.
3. **Sandbox separation**: The sandbox (Docker) can't access host tools directly. Only mom's invoke_tool can call them.

### Loading

Tools are loaded via jiti. They can import any 3rd party dependencies (install in the tool directory). Imports of `@mariozechner/pi-ai` and `@mariozechner/pi-mom` are aliased to the running mom bundle.

**Live reload**: In dev mode, tools are watched and reloaded on change. No restart needed.

## Events System

Scheduled wake-ups via JSON files in `workspace/events/`.

### Format

```json
{"type": "one-shot", "channelId": "slack-acme/C123ABC", "text": "Reminder", "at": "2025-12-15T09:00:00+01:00"}
```

Channel ID is qualified with adapter name so the event watcher knows which adapter to use.

### Running

```bash
mom ./data
```

Reads `config.json`, starts all adapters defined there.

The shared workspace allows:
- Shared MEMORY.md (global knowledge)
- Shared skills
- Events can target any platform
- Per-channel data is still isolated by channel ID

## Summary

The key insight is **separation of concerns**:

1. **Storage**: Unified schema, messages stored as-is from platform
2. **Agent**: Doesn't know about Slack/Discord, just processes messages and emits events
3. **Adapters**: Handle platform-specific connection, formatting, and message splitting
4. **Progress Rendering**: Each adapter decides how to display tool progress and results

This allows:
- Testing agent without any platform
- Testing adapters without agent
- Adding new platforms by implementing `PlatformAdapter`
- Sharing all storage, context management, and agent logic
- Rich UI on platforms that support it (embeds, buttons)
- Graceful degradation on simpler platforms (plain text)
