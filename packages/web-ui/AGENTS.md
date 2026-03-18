# web-ui — Lit Web Components for AI Chat

Web Components library (Lit + mini-lit, NOT React) for AI chat interfaces. Styled with Tailwind CSS v4. Depends on pi-ai for LLM types, pi-agent-core for Agent.

## Structure
```
src/
  components/
    AgentInterface.ts      # Main chat interface component
    Messages.ts            # Message list rendering
    Input.ts               # User input with attachments
    ThinkingBlock.ts       # Extended thinking display
    StreamingMessageContainer.ts  # Streaming response rendering
    sandbox/               # Sandboxed iframe for code execution
    message-renderer-registry.ts  # Custom message type renderers
  tools/
    artifacts/             # Artifact tool (HTML/code preview in sandbox)
    renderers/             # Tool-specific UI renderers
    renderer-registry.ts   # Tool renderer registration
    javascript-repl.ts     # JS REPL tool
  dialogs/                 # Modal dialogs (settings, provider config)
  utils/                   # Attachment handling, formatting helpers
```

## Where to Look
| Task | Location |
|------|----------|
| Chat UI behavior | `src/components/AgentInterface.ts` |
| Message rendering | `src/components/Messages.ts` |
| Tool result display | `src/tools/renderers/` |
| Artifact sandboxing | `src/tools/artifacts/` + `src/components/sandbox/` |

## Conventions
- All components render to light DOM (`createRenderRoot() { return this; }`) — Tailwind classes work globally
- Two extensible registries: tool renderer (`renderer-registry.ts`) and message renderer (`message-renderer-registry.ts`)
- `SandboxRuntimeProvider` functions are `.toString()`-ified and injected into iframes — never use closures
- Artifact DOM elements are intentionally NOT torn down — kept for restoration on remount
- `ChatPanel` is the top-level composite; accepts `Agent` via `setAgent()`
- Storage layer uses pluggable `StorageBackend` (only IndexedDB provided)
