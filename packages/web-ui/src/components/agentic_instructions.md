# packages/web-ui/src/components

## Purpose
Core web UI components for the AI chat interface: agent interface container, message display and editing, input handling, attachments, provider configuration, streaming containers, and thinking blocks.

## Technology
TypeScript, Lit web components, `@mariozechner/mini-lit`.

## Contents
- `AgentInterface.ts` - `<agent-interface>`: main chat container with message list, input, model selector, thinking selector, attachment handling
- `MessageList.ts` - Message list with auto-scroll and streaming message display
- `Messages.ts` - `UserMessage`, `AssistantMessage`, `ToolMessage`, `AbortedMessage`, `ToolMessageDebugView`: message rendering components with artifact support
- `MessageEditor.ts` - In-place message editing component
- `Input.ts` - Chat input with file attachment, image paste, and keyboard shortcuts
- `AttachmentTile.ts` - File/image attachment preview tiles
- `ConsoleBlock.ts` - Console output rendering (for tool results)
- `CustomProviderCard.ts` - UI card for custom LLM provider configuration
- `ExpandableSection.ts` - Collapsible content section
- `ProviderKeyInput.ts` - API key input field with visibility toggle
- `SandboxedIframe.ts` - `<sandbox-iframe>`: sandboxed iframe for running user code artifacts
- `StreamingMessageContainer.ts` - Container for streaming assistant messages with partial rendering
- `ThinkingBlock.ts` - Expandable thinking/reasoning block display
- `message-renderer-registry.ts` - Registry for custom message renderers
- `sandbox/` - Sandbox runtime providers: artifacts, attachments, console, file downloads, message bridging

## Key Functions
- `AgentInterface`: manages full chat lifecycle -- prompt submission, streaming display, model/thinking selection
- `convertAttachments()`: Convert file attachments to LLM-compatible content
- `defaultConvertToLlm()`: Default message conversion for web UI context
- `registerMessageRenderer()`, `renderMessage()`: extensible message rendering

## Data Types
- `UserMessageWithAttachments`: User message with file/image attachments
- `ArtifactMessage`: Custom message type for displayable artifacts
- `MessageRenderer`: `{ canRender(message), render(message) }`
- `SandboxFile`: `{ name, content, type }`
- `SandboxResult`: `{ files, console, error? }`
- `SandboxUrlProvider`: `() => string`

## Logging
Browser console for development debugging.

## CRUD Entry Points
- **Create**: Instantiate Lit elements via `document.createElement()` or HTML tags
- **Read**: Component properties and state
- **Update**: Set properties, dispatch events
- **Delete**: Remove from DOM

## Style Guide
- Lit `@customElement` decorator with kebab-case tag names
- `@state()` for internal reactive state, `@property()` for public attributes
- Event-driven communication between components
- Tailwind utility classes for layout
