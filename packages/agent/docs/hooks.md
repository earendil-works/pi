# AgentHarness hooks design

<!-- Synced from jot 3utlzkxy. Edit this file in-repo going forward. -->

Final design.

## Core model

Events carry their result type as a type-only phantom:

```ts
declare const HookResult: unique symbol;

interface HookEvent<TType extends string, TResult = void> {
	type: TType;
	readonly [HookResult]?: TResult;
}

type ResultOf<E> = E extends { readonly [HookResult]?: infer R } ? R : void;

type HookHandler<E, Ctx> = (
	event: E,
	ctx: Ctx,
	signal?: AbortSignal,
) => ResultOf<E> | void | Promise<ResultOf<E> | void>;

type HookObserver<E, Ctx> = (
	event: E,
	ctx: Ctx,
	signal?: AbortSignal,
) => void | Promise<void>;
```

Example:

```ts
interface ContextEvent extends HookEvent<"context", { messages?: AgentMessage[] }> {
	type: "context";
	messages: AgentMessage[];
}

interface ToolCallEvent extends HookEvent<"tool_call", { block?: boolean; reason?: string }> {
	type: "tool_call";
	toolName: string;
	input: Record<string, unknown>;
}

interface MessageEndEvent extends HookEvent<"message_end", { message?: AgentMessage }> {
	type: "message_end";
	message: AgentMessage;
}
```

No result map. No spec table. The event type defines its own result.

## Hooks interface

```ts
interface AgentHarnessHooks<E extends HookEvent<string, unknown>, Ctx> {
	context: Ctx;

	setContext(ctx: Ctx): void;

	observe(handler: HookObserver<E, Ctx>): () => void;

	on<TType extends E["type"]>(
		type: TType,
		handler: HookHandler<Extract<E, { type: TType }>, Ctx>,
	): () => void;

	emit<TEvent extends E>(
		event: TEvent,
		signal?: AbortSignal,
	): Promise<ResultOf<TEvent> | undefined>;

	addCleanup(cleanup: () => void | Promise<void>): () => void;

	clear(): Promise<void>;
	dispose(): Promise<void>;
}
```

Important split:

- `observe()` sees all events, read-only, return ignored.
- `on(type, handler)` participates in that event’s semantics.
- `emit(event)` is the only thing `AgentHarness` calls.
- `clear()` removes observers/handlers and runs cleanups.

## Default implementation internals

```ts
class DefaultAgentHarnessHooks<E extends HookEvent<string, unknown>, Ctx>
	implements AgentHarnessHooks<E, Ctx> {
	context: Ctx;

	private observers = new Set<HookObserver<E, Ctx>>();
	private handlers = new Map<string, Set<HookHandler<any, Ctx>>>();
	private cleanups = new Set<() => void | Promise<void>>();

	constructor(ctx: Ctx) {
		this.context = ctx;
	}

	setContext(ctx: Ctx): void {
		this.context = ctx;
	}

	observe(handler: HookObserver<E, Ctx>): () => void {
		this.observers.add(handler);
		return () => this.observers.delete(handler);
	}

	on(type, handler): () => void {
		let handlers = this.handlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(type, handlers);
		}
		handlers.add(handler);
		return () => handlers.delete(handler);
	}

	async emit(event, signal?) {
		for (const observer of this.observers) {
			await observer(event, this.context, signal);
		}

		switch (event.type) {
			case "context":
				return this.emitContext(event, signal);
			case "before_provider_request":
				return this.emitBeforeProviderRequest(event, signal);
			case "before_provider_payload":
				return this.emitBeforeProviderPayload(event, signal);
			case "before_agent_start":
				return this.emitBeforeAgentStart(event, signal);
			case "tool_call":
				return this.emitToolCall(event, signal);
			case "tool_result":
				return this.emitToolResult(event, signal);
			case "message_end":
				return this.emitMessageEnd(event, signal);
			case "session_before_compact":
			case "session_before_tree":
				return this.emitFirstCancelOrLast(event, signal);
			default:
				await this.emitObservationHandlers(event, signal);
				return undefined;
		}
	}
}
```

Internal casts are acceptable inside the implementation because `Map<string, ...>` loses specificity. Public API remains typed.

## Mutation semantics

### Observation

```ts
await hooks.emit({ type: "after_provider_response", status, headers }, signal);
```

Observers run. `after_provider_response` handlers run. Return ignored because the event defines no result type.

### Context transform

Handlers run in order. Each sees current messages.

```ts
let current = event;

for (const handler of handlers("context")) {
	const result = await handler(current, ctx, signal);
	if (result?.messages) {
		current = { ...current, messages: result.messages };
	}
}

return current.messages === event.messages ? undefined : { messages: current.messages };
```

### Provider request / payload

Sequential transform. Each handler sees previous output.

```ts
let current = event;

for (const handler of handlers("before_provider_payload")) {
	const result = await handler(current, ctx, signal);
	if (result !== undefined) {
		current = { ...current, payload: result.payload };
	}
}

return changed ? { payload: current.payload } : undefined;
```

### Before agent start

Collect injected messages, chain system prompt.

```ts
let systemPrompt = event.systemPrompt;
const messages = [];

for (const handler of handlers("before_agent_start")) {
	const result = await handler({ ...event, systemPrompt }, ctx, signal);
	if (result?.messages) messages.push(...result.messages);
	if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
}

return messages.length || systemPrompt !== event.systemPrompt
	? { messages, systemPrompt }
	: undefined;
```

### Tool call

Sequential, early exit on block.

```ts
for (const handler of handlers("tool_call")) {
	const result = await handler(event, ctx, signal);
	if (result?.block) return result;
}
```

### Tool result

Sequential patch accumulation. Each handler sees current patched result.

```ts
let current = event;
let modified = false;

for (const handler of handlers("tool_result")) {
	const result = await handler(current, ctx, signal);
	if (!result) continue;

	current = {
		...current,
		content: result.content ?? current.content,
		details: result.details ?? current.details,
		isError: result.isError ?? current.isError,
	};

	modified = true;
}

return modified
	? { content: current.content, details: current.details, isError: current.isError }
	: undefined;
```

### Message end

Sequential transform before persistence. Each handler sees the previous replacement. Replacements must keep the original message role and get missing/`null` content normalized; invalid replacements throw and nothing is persisted. Implemented in the current harness as `emitMessageEnd()`.

```ts
let current = event;

for (const handler of handlers("message_end")) {
	const result = await handler(current, ctx, signal);
	if (result?.message !== undefined) {
		current = { ...current, message: normalizeReplacement(current.message, result.message) };
	}
}

return current.message === event.message ? undefined : { message: current.message };
```

### Session-before events

Sequential, early exit on cancel.

```ts
let last;

for (const handler of handlers(event.type)) {
	const result = await handler(event, ctx, signal);
	if (!result) continue;
	last = result;
	if (result.cancel) return result;
}

return last;
```

## Harness usage

Harness only does this:

```ts
await this.hooks.emit(event, signal);
```

or:

```ts
const result = await this.hooks.emit({ type: "context", messages }, signal);
return result?.messages ?? messages;
```

Harness does not store handlers, chain listeners, or know extension policy.

## Context

Context is a normal object, not rebuilt per emit.

```ts
const hooks = new CodingAgentHooks({
	harness: harnessFacade,
	session: sessionFacade,
	ui: noUiFacade,
});
```

Later:

```ts
hooks.setContext({
	...hooks.context,
	ui: tuiFacade,
});
```

For dynamic state, prefer stable facades/methods over getter maze:

```ts
interface CodingAgentHookContext {
	harness: HarnessFacade;
	session: SessionFacade;
	ui: UiFacade;
	models: ModelFacade;
}
```

Per-run `signal` is passed as the third handler arg.

## Extension loading later

Extension loading can live next to harness and construct hooks:

```ts
const hooks = await loadExtensions({
	paths,
	context,
	hooks: new CodingAgentHooks(context),
});
const harness = new AgentHarness({ ..., hooks });
```

The loader registers into hooks:

```ts
hooks.on("context", handler);
hooks.on("tool_call", handler);
hooks.addCleanup(cleanup);
```

For reload:

```ts
await hooks.clear();
const nextHooks = await loadExtensions(...);
harness.setHooks(nextHooks); // idle-only if supported
```

## Poking holes

### 1. Error policy must be explicit

Existing coding-agent catches extension errors, reports them, and continues. New hooks need the same policy, likely:

```ts
errorMode: "continue" | "throw"
onError(error)
```

For coding-agent, default should be `"continue"`.

### 2. Source metadata matters

Existing runner knows which extension produced an error/resource/tool. Plain `on()` loses that unless we add registration metadata or scopes.

Probably needed:

```ts
const scope = hooks.createScope({ sourceInfo });
scope.on("context", handler);
scope.addCleanup(...);
```

Or `on(type, handler, { sourceInfo })`.

### 3. Some extension capabilities are registries, not hooks

These are not covered by `emit()` and should stay as registries on `CodingAgentHooks` or an extension host:

- tools
- commands
- shortcuts
- flags
- message renderers
- provider registrations
- OAuth providers
- custom model providers

That is fine. They do not belong in `AgentHarness`.

### 4. Existing coding-agent events can be represented

No blocker for:

- `context`
- `before_provider_request`
- `after_provider_response`
- `before_agent_start`
- `message_end`
- `tool_call`
- `tool_result`
- `input`
- `user_bash`
- `resources_discover`
- `session_before_*`
- `session_*`
- model/thinking selection events
- agent/turn/message/tool lifecycle events

They become additional event types handled by `CodingAgentHooks`.

### 5. Need to preserve exact old semantics

When porting coding-agent, special cases must be copied:

- `input`: transform chain, `handled` short-circuits.
- `user_bash`: first meaningful result wins.
- `message_end`: replacement must keep same role.
- `before_agent_start`: `ctx.getSystemPrompt()` must reflect current chained prompt.
- `resources_discover`: aggregate paths and keep extension source.
- `tool_call`: argument mutation remains visible to later handlers.
- `tool_result`: later handlers see prior patches.

The design allows all of that, but the default/coding hooks implementation must encode it.

### 6. `emit()` switch can miss custom mutation events

If a subclass adds a result-producing event but forgets to override `emit()`, it will behave observationally. Tests should catch this. Could add a protected strategy registry later if this becomes error-prone, but not initially.

### 7. Observer semantics are intentionally limited

Observers see the original emitted event once. They do not see every intermediate mutation. If something needs final transformed state, emit a separate final event or use an event-specific handler.

## Verdict

This design can implement a new coding-agent. It is simpler than the current runner, keeps harness clean, and preserves the important extension capabilities as long as `CodingAgentHooks` adds source-aware scopes, registries, cleanup, and the exact old event semantics.

--- Comments ---

Thread hn2xk0tzhj on "addCleanup(cleanup"
  [tmluyaub9v] Owner (2026-05-14T12:55:45.500Z): cleanup should be passed along optionally to on/observe
