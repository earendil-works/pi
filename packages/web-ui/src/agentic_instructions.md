# packages/web-ui/src

## Purpose
Reusable web UI components for AI chat interfaces built with Lit web components and Tailwind CSS. Provides a complete chat panel with message rendering, model selection, session management, settings, and artifact display.

## Technology
TypeScript, Lit (web components), `@mariozechner/mini-lit`, Tailwind CSS, `@mariozechner/pi-ai` for LLM integration, `@mariozechner/pi-tui` for markdown rendering utilities.

## Contents
- `index.ts` - Barrel export of all components, dialogs, storage, tools, and utilities
- `ChatPanel.ts` - `<pi-chat-panel>` Lit element: main chat interface combining AgentInterface, ArtifactsPanel, model selector, and responsive layout (overlay vs side-by-side at 800px breakpoint)
- `app.css` - Root CSS importing Claude theme from mini-lit, Tailwind source directives, and global styles
- `components/` - Lit web components: message rendering, input, agent interface, sandbox iframe
- `dialogs/` - Modal dialogs: model selector, settings, session list, API key prompts, providers
- `prompts/` - System prompt templates
- `storage/` - App storage abstraction with IndexedDB backend and typed stores
- `tools/` - Tool execution and rendering: JavaScript REPL, artifact display, tool renderers
- `utils/` - Shared utilities: attachments, auth tokens, formatting, i18n, model discovery

## Key Functions
- `ChatPanel.setAgent(agent, config?)`: Configure chat panel with an `Agent` instance and optional callbacks (onApiKeyRequired, sandboxUrlProvider, toolsFactory)
- Registration of tool renderers for artifact display

## Data Types
- `ChatPanel`: Lit custom element `<pi-chat-panel>` with `agent`, `agentInterface`, `artifactsPanel` state
- Config callbacks: `onApiKeyRequired`, `onBeforeSend`, `onCostClick`, `sandboxUrlProvider`, `toolsFactory`

## Logging
N/A - browser-based UI.

## CRUD Entry Points
- **Create**: `document.createElement("pi-chat-panel")` or `<pi-chat-panel>` in HTML
- **Read**: Access agent state through `chatPanel.agent`
- **Update**: `chatPanel.setAgent()` to configure, agent events drive UI updates
- **Delete**: Remove element from DOM

## Style Guide
- Lit web components with `@customElement` decorator
- Tailwind CSS utility classes for styling
- `@state()` decorator for reactive properties
- `createRenderRoot() { return this; }` for light DOM (Tailwind compatibility)
