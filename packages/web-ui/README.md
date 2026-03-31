# @mariozechner/pi-web-ui

Reusable web UI components for building AI chat interfaces powered by [@mariozechner/pi-ai](../ai) and [@mariozechner/pi-agent-core](../agent).

Built with [mini-lit](https://github.com/badlogic/mini-lit) web components and Tailwind CSS v4.

## Features

- **Chat UI**: Complete interface with message history, streaming, and tool execution
- **Tools**: JavaScript REPL, document extraction, and artifacts (HTML, SVG, Markdown, etc.)
- **Attachments**: PDF, DOCX, XLSX, PPTX, images with preview and text extraction
- **Artifacts**: Interactive HTML, SVG, Markdown with sandboxed execution
- **Storage**: IndexedDB-backed storage for sessions, API keys, and settings
- **CORS Proxy**: Automatic proxy handling for browser environments
- **Custom Providers**: Support for Ollama, LM Studio, vLLM, and OpenAI-compatible APIs

## Installation

```bash
npm install @mariozechner/pi-web-ui @mariozechner/pi-agent-core @mariozechner/pi-ai
```

## Quick Start

See the [example](./example) directory for a complete working application.

```typescript
import { Agent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import {
  ChatPanel,
  AppStorage,
  IndexedDBStorageBackend,
  ProviderKeysStore,
  SessionsStore,
  SettingsStore,
  setAppStorage,
  defaultConvertToLlm,
  ApiKeyPromptDialog,
} from '@mariozechner/pi-web-ui';
import '@mariozechner/pi-web-ui/app.css';

// Set up storage
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();

const backend = new IndexedDBStorageBackend({
  dbName: 'my-app',
  version: 1,
  stores: [
    settings.getConfig(),
    providerKeys.getConfig(),
    sessions.getConfig(),
    SessionsStore.getMetadataConfig(),
  ],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, undefined, backend);
setAppStorage(storage);

// Create agent
const agent = new Agent({
  initialState: {
    systemPrompt: 'You are a helpful assistant.',
    model: getModel('anthropic', 'claude-sonnet-4-5-20250929'),
    thinkingLevel: 'off',
    messages: [],
    tools: [],
  },
  convertToLlm: defaultConvertToLlm,
});

// Create chat panel
const chatPanel = new ChatPanel();
await chatPanel.setAgent(agent, {
  onApiKeyRequired: (provider) => ApiKeyPromptDialog.prompt(provider),
});

document.body.appendChild(chatPanel);
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    ChatPanel                        │
│  ┌─────────────────────┐  ┌─────────────────────┐   │
│  │   AgentInterface    │  │   ArtifactsPanel    │   │
│  │  (messages, input)  │  │  (HTML, SVG, MD)    │   │
│  └─────────────────────┘  └─────────────────────┘   │
└─────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────┐
│              Agent (from pi-agent-core)             │
│  - State management (messages, model, tools)        │
│  - Event emission (agent_start, message_update, ...)│
│  - Tool execution                                   │
└─────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────┐
│                   AppStorage                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐             │
│  │ Settings │ │ Provider │ │ Sessions │             │
│  │  Store   │ │Keys Store│ │  Store   │             │
│  └──────────┘ └──────────┘ └──────────┘             │
│                     │                               │
│              IndexedDBStorageBackend                │
└─────────────────────────────────────────────────────┘
```

## Components

### ChatPanel

High-level chat interface with built-in artifacts panel.

```typescript
const chatPanel = new ChatPanel();
await chatPanel.setAgent(agent, {
  // Prompt for API key when needed
  onApiKeyRequired: async (provider) => ApiKeyPromptDialog.prompt(provider),

  // Hook before sending messages
  onBeforeSend: async () => { /* save draft, etc. */ },

  // Handle cost display click
  onCostClick: () => { /* show cost breakdown */ },

  // Custom sandbox URL for browser extensions
  sandboxUrlProvider: () => chrome.runtime.getURL('sandbox.html'),

  // Add custom tools
  toolsFactory: (agent, agentInterface, artifactsPanel, runtimeProvidersFactory) => {
    const replTool = createJavaScriptReplTool();
    replTool.runtimeProvidersFactory = runtimeProvidersFactory;
    return [replTool];
  },
});
```

### AgentInterface

Lower-level chat interface for custom layouts.

```typescript
const chat = document.createElement('agent-interface') as AgentInterface;
chat.session = agent;
chat.enableAttachments = true;
chat.enableModelSelector = true;
chat.enableThinkingSelector = true;
chat.onApiKeyRequired = async (provider) => { /* ... */ };
chat.onBeforeSend = async () => { /* ... */ };
```

Properties:
- `session`: Agent instance
- `enableAttachments`: Show attachment button (default: true)
- `enableModelSelector`: Show model selector (default: true)
- `enableThinkingSelector`: Show thinking level selector (default: true)
- `showThemeToggle`: Show theme toggle (default: false)

### Agent (from pi-agent-core)

```typescript
import { Agent } from '@mariozechner/pi-agent-core';

const agent = new Agent({
  initialState: {
    model: getModel('anthropic', 'claude-sonnet-4-5-20250929'),
    systemPrompt: 'You are helpful.',
    thinkingLevel: 'off',
    messages: [],
    tools: [],
  },
  convertToLlm: defaultConvertToLlm,
});

// Events
agent.subscribe((event) => {
  switch (event.type) {
    case 'agent_start': // Agent loop started
    case 'agent_end':   // Agent loop finished
    case 'turn_start':  // LLM call started
    case 'turn_end':    // LLM call finished
    case 'message_start':
    case 'message_update': // Streaming update
    case 'message_end':
      break;
  }
});

// Send message
await agent.prompt('Hello!');
await agent.prompt({ role: 'user-with-attachments', content: 'Check this', attachments, timestamp: Date.now() });

// Control
agent.abort();
agent.state.model = newModel;
agent.state.thinkingLevel = 'medium';
agent.state.tools = [...];
agent.followUp(customMessage);
```

## Message Types

### UserMessageWithAttachments

User message with file attachments:

```typescript
const message: UserMessageWithAttachments = {
  role: 'user-with-attachments',
  content: 'Analyze this document',
  attachments: [pdfAttachment],
  timestamp: Date.now(),
};

// Type guard
if (isUserMessageWithAttachments(msg)) {
  console.log(msg.attachments);
}
```

### ArtifactMessage

For session persistence of artifacts:

```typescript
const artifact: ArtifactMessage = {
  role: 'artifact',
  action: 'create', // or 'update', 'delete'
  filename: 'chart.html',
  content: '<div>...</div>',
  timestamp: new Date().toISOString(),
};

// Type guard
if (isArtifactMessage(msg)) {
  console.log(msg.filename);
}
```

### Custom Message Types

Extend via declaration merging:

```typescript
interface SystemNotification {
  role: 'system-notification';
  message: string;
  level: 'info' | 'warning' | 'error';
  timestamp: string;
}

declare module '@mariozechner/pi-agent-core' {
  interface CustomAgentMessages {
    'system-notification': SystemNotification;
  }
}

// Register renderer
registerMessageRenderer('system-notification', {
  render: (msg) => html`<div class="alert">${msg.message}</div>`,
});

// Extend convertToLlm
function myConvertToLlm(messages: AgentMessage[]): Message[] {
  const processed = messages.map((m) => {
    if (m.role === 'system-notification') {
      return { role: 'user', content: `<system>${m.message}</system>`, timestamp: Date.now() };
    }
    return m;
  });
  return defaultConvertToLlm(processed);
}
```

## Message Transformer

`convertToLlm` transforms app messages to LLM-compatible format:

```typescript
import { defaultConvertToLlm, convertAttachments } from '@mariozechner/pi-web-ui';

// defaultConvertToLlm handles:
// - UserMessageWithAttachments → user message with image/text content blocks
// - ArtifactMessage → filtered out (UI-only)
// - Standard messages (user, assistant, toolResult) → passed through
```

## Tools

### JavaScript REPL

Execute JavaScript in a sandboxed browser environment:

```typescript
import { createJavaScriptReplTool } from '@mariozechner/pi-web-ui';

const replTool = createJavaScriptReplTool();

// Configure runtime providers for artifact/attachment access
replTool.runtimeProvidersFactory = () => [
  new AttachmentsRuntimeProvider(attachments),
  new ArtifactsRuntimeProvider(artifactsPanel, agent, true), // read-write
];

agent.state.tools = [replTool];
```

### Extract Document

Extract text from documents at URLs:

```typescript
import { createExtractDocumentTool } from '@mariozechner/pi-web-ui';

const extractTool = createExtractDocumentTool();
extractTool.corsProxyUrl = 'https://corsproxy.io/?';

agent.state.tools = [extractTool];
```

### Artifacts Tool

Built into ArtifactsPanel, supports: HTML, SVG, Markdown, text, JSON, images, PDF, DOCX, XLSX.

```typescript
const artifactsPanel = new ArtifactsPanel();
artifactsPanel.agent = agent;

// The tool is available as artifactsPanel.tool
agent.state.tools = [artifactsPanel.tool];
```

### Custom Tool Renderers

```typescript
import { registerToolRenderer, type ToolRenderer } from '@mariozechner/pi-web-ui';

const myRenderer: ToolRenderer = {
  render(params, result, isStreaming) {
    return {
      content: html`<div>...</div>`,
      isCustom: false, // true = no card wrapper
    };
  },
};

registerToolRenderer('my_tool', myRenderer);
```

## Storage

### Setup

```typescript
import {
  AppStorage,
  IndexedDBStorageBackend,
  SettingsStore,
  ProviderKeysStore,
  SessionsStore,
  CustomProvidersStore,
  setAppStorage,
  getAppStorage,
} from '@mariozechner/pi-web-ui';

// Create stores
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

// Create backend with all store configs
const backend = new IndexedDBStorageBackend({
  dbName: 'my-app',
  version: 1,
  stores: [
    settings.getConfig(),
    providerKeys.getConfig(),
    sessions.getConfig(),
    SessionsStore.getMetadataConfig(),
    customProviders.getConfig(),
  ],
});

// Wire stores to backend
settings.setBackend(backend);
providerKeys.setBackend(backend);
sessions.setBackend(backend);
customProviders.setBackend(backend);

// Create and set global storage
const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);
```

### SettingsStore

Key-value settings:

```typescript
await storage.settings.set('proxy.enabled', true);
await storage.settings.set('proxy.url', 'https://proxy.example.com');
const enabled = await storage.settings.get<boolean>('proxy.enabled');
```

### ProviderKeysStore

API keys by provider:

```typescript
await storage.providerKeys.set('anthropic', 'sk-ant-...');
const key = await storage.providerKeys.get('anthropic');
const providers = await storage.providerKeys.list();
```

### SessionsStore

Chat sessions with metadata:

```typescript
// Save session
await storage.sessions.save(sessionData, metadata);

// Load session
const data = await storage.sessions.get(sessionId);
const metadata = await storage.sessions.getMetadata(sessionId);

// List sessions (sorted by lastModified)
const allMetadata = await storage.sessions.getAllMetadata();

// Update title
await storage.sessions.updateTitle(sessionId, 'New Title');

// Delete
await storage.sessions.delete(sessionId);
```

### CustomProvidersStore

Custom LLM providers:

```typescript
const provider: CustomProvider = {
  id: crypto.randomUUID(),
  name: 'My Ollama',
  type: 'ollama',
  baseUrl: 'http://localhost:11434',
};

await storage.customProviders.set(provider);
const all = await storage.customProviders.getAll();
```

## Attachments

Load and process files:

```typescript
import { loadAttachment, type Attachment } from '@mariozechner/pi-web-ui';

// From File input
const file = inputElement.files[0];
const attachment = await loadAttachment(file);

// From URL
const attachment = await loadAttachment('https://example.com/doc.pdf');

// From ArrayBuffer
const attachment = await loadAttachment(arrayBuffer, 'document.pdf');

// Attachment structure
interface Attachment {
  id: string;
  type: 'image' | 'document';
  fileName: string;
  mimeType: string;
  size: number;
  content: string;        // base64 encoded
  extractedText?: string; // For documents
  preview?: string;       // base64 preview image
}
```

Supported formats: PDF, DOCX, XLSX, PPTX, images, text files.

## CORS Proxy

For browser environments with CORS restrictions:

```typescript
import { createStreamFn, shouldUseProxyForProvider, isCorsError } from '@mariozechner/pi-web-ui';

// AgentInterface auto-configures proxy from settings
// For manual setup:
agent.streamFn = createStreamFn(async () => {
  const enabled = await storage.settings.get<boolean>('proxy.enabled');
  return enabled ? await storage.settings.get<string>('proxy.url') : undefined;
});

// Providers requiring proxy:
// - zai: always
// - anthropic: only OAuth tokens (sk-ant-oat-*)
```

## Dialogs

### SettingsDialog

```typescript
import { SettingsDialog, ProvidersModelsTab, ProxyTab, ApiKeysTab } from '@mariozechner/pi-web-ui';

SettingsDialog.open([
  new ProvidersModelsTab(), // Custom providers + model list
  new ProxyTab(),           // CORS proxy settings
  new ApiKeysTab(),         // API keys per provider
]);
```

### SessionListDialog

```typescript
import { SessionListDialog } from '@mariozechner/pi-web-ui';

SessionListDialog.open(
  async (sessionId) => { /* load session */ },
  (deletedId) => { /* handle deletion */ },
);
```

### ApiKeyPromptDialog

```typescript
import { ApiKeyPromptDialog } from '@mariozechner/pi-web-ui';

const success = await ApiKeyPromptDialog.prompt('anthropic');
```

### ModelSelector

```typescript
import { ModelSelector } from '@mariozechner/pi-web-ui';

ModelSelector.open(currentModel, (selectedModel) => {
  agent.state.model = selectedModel;
});
```

## Styling

Import the pre-built CSS:

```typescript
import '@mariozechner/pi-web-ui/app.css';
```

Or use Tailwind with custom config:

```css
@import '@mariozechner/mini-lit/themes/claude.css';
@tailwind base;
@tailwind components;
@tailwind utilities;
```

## Internationalization

```typescript
import { i18n, setLanguage, translations } from '@mariozechner/pi-web-ui';

// Add translations
translations.de = {
  'Loading...': 'Laden...',
  'No sessions yet': 'Noch keine Sitzungen',
};

setLanguage('de');
console.log(i18n('Loading...')); // "Laden..."
```

## Examples

- [example/](./example) - Complete web app with sessions, artifacts, custom messages
- [sitegeist](https://sitegeist.ai) - Browser extension using pi-web-ui

## Known Issues

- **PersistentStorageDialog**: Currently broken

## License

MIT
