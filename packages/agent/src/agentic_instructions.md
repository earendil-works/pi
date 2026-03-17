# packages/agent/src

## Purpose
General-purpose AI agent framework with transport abstraction, state management, event-driven architecture, and proxy streaming support. This is the core agent runtime that `coding-agent` builds upon.

## Technology
TypeScript, ESM modules. Depends on `@mariozechner/pi-ai` for LLM streaming and message types.

## Contents
- `index.ts` - Re-exports all public APIs from agent, agent-loop, proxy, and types
- `agent.ts` - `Agent` class: stateful agent with prompt/continue/steer/followUp lifecycle, event subscription, abort support
- `agent-loop.ts` - `agentLoop()` / `agentLoopContinue()`: async generator-based loop that streams LLM responses, executes tool calls sequentially, handles steering interrupts and follow-up messages
- `proxy.ts` - `streamProxy()`: proxy stream function that routes LLM calls through a server, reconstructs partial messages client-side from bandwidth-optimized SSE events
- `types.ts` - Core type definitions: `AgentState`, `AgentLoopConfig`, `AgentTool`, `AgentEvent`, `AgentMessage`, `ThinkingLevel`, `CustomAgentMessages` (extensible via declaration merging)

## Key Functions
- `Agent.prompt(input, images?)`: Start a new agent turn with user input. Returns Promise<void>
- `Agent.continue()`: Resume from current context (retries, queued messages). Returns Promise<void>
- `Agent.steer(message)`: Queue a steering message to interrupt mid-run
- `Agent.followUp(message)`: Queue a follow-up message for after agent finishes
- `Agent.subscribe(fn)`: Subscribe to `AgentEvent` stream. Returns unsubscribe function
- `Agent.abort()`: Cancel current operation via AbortController
- `agentLoop(prompts, context, config, signal?, streamFn?)`: Start agent loop. Returns `EventStream<AgentEvent>`
- `agentLoopContinue(context, config, signal?, streamFn?)`: Continue from existing context
- `streamProxy(model, context, options)`: Proxy LLM calls through a server. Returns `ProxyMessageEventStream`

## Data Types
- `AgentState`: `{ systemPrompt, model, thinkingLevel, tools, messages, isStreaming, streamMessage, pendingToolCalls, error? }`
- `AgentLoopConfig`: extends `SimpleStreamOptions` with `model`, `convertToLlm`, `transformContext?`, `getApiKey?`, `getSteeringMessages?`, `getFollowUpMessages?`
- `AgentTool<TParameters, TDetails>`: extends `Tool` with `label`, `execute(toolCallId, params, signal?, onUpdate?)`
- `AgentToolResult<T>`: `{ content: (TextContent | ImageContent)[], details: T }`
- `AgentEvent`: discriminated union of `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `AgentMessage`: `Message | CustomAgentMessages[keyof CustomAgentMessages]`
- `ThinkingLevel`: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`
- `ProxyStreamOptions`: extends `SimpleStreamOptions` with `authToken`, `proxyUrl`
- `ProxyAssistantMessageEvent`: bandwidth-optimized event types without `partial` field

## Logging
No direct logging. Errors propagated via `AgentEvent` of type `agent_end` with error messages.

## CRUD Entry Points
- **Create**: Instantiate `new Agent(options)` to create an agent
- **Read**: `agent.state` for current state, `agent.subscribe()` for event stream
- **Update**: `agent.setModel()`, `agent.setSystemPrompt()`, `agent.setThinkingLevel()`, `agent.setTools()`, `agent.replaceMessages()`
- **Delete**: `agent.reset()` to clear all state, `agent.abort()` to cancel operations

## Style Guide
- camelCase for functions and variables, PascalCase for types and classes
- Tab indentation, 120-char line width
- Standard top-level imports only (no dynamic imports)
- Error handling via try/catch with typed error messages
- Event-driven architecture using `EventStream` and subscriber pattern

```typescript
const agent = new Agent({
	convertToLlm: (messages) =>
		messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
	streamFn: streamSimple,
});
agent.setModel(getModel("anthropic", "claude-sonnet-4-20250514"));
agent.setSystemPrompt("You are a helpful assistant.");
agent.subscribe((event) => {
	if (event.type === "message_update") {
		console.log(event.message);
	}
});
await agent.prompt("Hello!");
```
