# Invocation Context and Telemetry Design Notes

> **Status:** Design input, not a normative contract. The context primitives and required trailing `Context` parameters have landed across the harness, sessions, execution capabilities, and hosted-harness adapters. Local propagation is scaffolding rather than proof of complete telemetry semantics: most runtime spans and cross-process trace propagation remain design or implementation work. Drive ownership is now harness-owned and request-ID RPC cancellation is implemented; neither supplies distributed trace parentage. Fold accepted final behavior into `harness.md`. `telemetry-schema.md` remains the generated reference for span names and attributes.

## Goal

`Session`, `Branch`, `AgentLane`, and `AgentHarness` receive invocation-scoped control data explicitly through a required trailing `Context` parameter. The same receiver may serve concurrent local callers or RPC clients, so it cannot retain a mutable or default caller context.

The invocation context must solve two related problems without `AsyncLocalStorage`:

1. preserve correct telemetry parentage through concurrent asynchronous work;
2. carry an `AbortSignal`, when one exists, that an RPC adapter can map to request cancellation.

This work must reuse `@earendil-works/pi-telemetry`. It must not introduce another span abstraction.

## Context model

The implemented public types are:

```ts
interface ContextKey<T> {
	readonly token: symbol;
	readonly valueType?: (value: T) => T;
}

interface Context {
	readonly abortSignal: AbortSignal | undefined;
	readonly telemetryContext: TelemetryContext;
	value<T>(key: ContextKey<T>): T | undefined;
	toString(): string;
}
```

`valueType` is a type-only marker. Runtime lookup uses the key's symbol token. `createContextKey<T>(description)` creates and freezes a key with a unique token.

A context is immutable. Derivation creates a parent-linked, copy-on-write layer. Helper arguments put the value first and parent context last:

```ts
const requestContext = withAbortSignal(requestSignal, parentContext);
const spanContext = withTelemetryContext(span, requestContext);
const tenantContext = withContextValue(tenantKey, tenantId, spanContext);
```

The implemented behavior is:

- `BACKGROUND_CONTEXT` and `TODO_CONTEXT` are distinct empty roots whose `abortSignal` is `undefined`;
- `telemetryContext` is always available and falls back to `NOOP_TELEMETRY_CONTEXT` when no telemetry value has been installed;
- `withAbortSignal(signal, context)` preserves the supplied signal when the parent has none and otherwise combines it with the parent signal using `AbortSignal.any()`;
- `withCancel(context)` returns an independently cancellable child context and a `cancel(reason?)` function; parent cancellation still reaches the child;
- typed values use symbol identity and immutable copy-on-write layers, and a newer value for the same key shadows its parent value;
- the built-in abort-signal and telemetry keys are private; callers use the named properties instead of retrieving those values by key;
- `toString()` is diagnostic and records the root plus each layered key description.

Context values are cross-cutting request metadata, not business dependencies. Suitable typed values include request IDs, authenticated principals, tenant IDs, and diagnostic metadata. Storage, models, tools, durable state, and business payloads do not belong in the context. Contexts, signals, telemetry objects, and backend-native span objects are never durable data.

## Receiver ownership

Shared receivers retain identity and durable/process state, not invocation context:

```text
AgentHarness receiver  ── no caller context
AgentLane receiver     ── no caller context
Session receiver       ── no caller context
Branch receiver        ── no caller context
```

Every invocation supplies its own context. This prevents concurrent callers from overwriting each other's telemetry parent or cancellation signal.

A process-local object representing one ongoing invocation may retain its derived context. Examples are an active drive task or an event subscription. This is different from storing a default context on the shared harness or session receiver.

`AgentHarnessOptions.telemetryContext` has been removed. A harness-level default cannot represent two concurrent callers with different parents.

## Existing typed telemetry remains authoritative

The design retains:

- `TelemetryContext` and `TelemetrySpan`;
- callback-owned span lifetime;
- `AI_TELEMETRY_SCHEMA` and `HARNESS_TELEMETRY_SCHEMA`;
- typed span names, start attributes, completion attributes, and events;
- `startAiSpan()`, `startHarnessSpan()`, and `createTypedSpanStarter()`;
- adapter conformance behavior.

`startAiSpan()` and `startHarnessSpan()` package span derivation by giving their callbacks both the typed span and a derived invocation context:

```ts
return startHarnessSpan(
	"pi.harness.run",
	attributes,
	async (span, runContext) => {
		return runDrive(runContext);
	},
	context,
);
```

The helpers delegate to `context.telemetryContext.startSpan()` and install the callback-owned span in a child context with `withTelemetryContext(span, context)`. Lower work must receive that child context rather than the parent invocation context.

Do not mutate a context to install an active span. Do not use a process-global or receiver-global current span.

## Concurrent parentage

Explicit propagation supports concurrent sibling calls:

```ts
await parent.telemetryContext.startSpan({ name: "caller" }, async (callerSpan) => {
	const callerContext = withTelemetryContext(callerSpan, parent);
	await Promise.all([
		laneA.drive(optionsA, callerContext),
		laneB.drive(optionsB, callerContext),
	]);
});
```

Each invocation derives its own child context. Nested work receives the child belonging to that invocation. Correct parentage does not depend on promise scheduling or ambient state.

Tests must cross concurrent branches deliberately so accidental receiver-level context is visible. A sequential parent/child test is insufficient.

## Callbacks, hooks, and events

Host-local callbacks invoked as part of an operation receive the current invocation context in their declared trailing position:

```ts
handler(event, context);
tool.execute(toolCallId, params, onUpdate, toolContext, invocation, context);
mutation(mutator, context);
```

Current propagation preserves context through callbacks and gives `before_tool` and `after_tool` handlers a child context derived from `pi.harness.hook`. Extending that span behavior to every hook type remains work; handlers without an installed hook span currently receive the operation context directly.

Within the harness process, events preserve the context that caused each event, and buffered event watchers store `{ event, context }` rather than only `event`. Starting `pi.harness.event_handler` from that event context and passing its child context to each listener remains work. Event registration itself is host-local configuration and has no operation parent.

Session mutation callbacks and commits receive the same explicit invocation context. Starting `pi.session.write` from the committing invocation and passing its child context through the storage commit remains work.

## Drive execution and joiners

Several callers may call `drive()` for the same durable operation. Arbitration decides which call installs process-local execution and which calls join it. This is a core runtime concern, not an RPC concern; concurrent local callers have the same issue.

One active execution has one telemetry parent. It cannot be reparented when another caller joins.

```text
installer caller
└─ drive.execute
   └─ provider/tool work

joiner caller
└─ drive.join
```

A joiner span describes that caller's wait. It carries at least lane name, durable operation ID, and a process-local execution ID. It ends with an outcome such as `settled`, `caller_cancelled`, `execution_stopped`, or `harness_closed`.

The joiner must not overwrite the active execution context. Correlate the two spans using operation/execution attributes. Telemetry span links would model this relationship better, but the current telemetry contract has no links. Adding links is an optional telemetry-package design question, not a reason to invent multiple parents.

Distributed traces permit an execution span to outlive the installer RPC span. Parent and child spans may overlap or settle in either order once the child has started.

## Invocation cancellation versus durable cancellation

An aborted invocation signal is process-local control. It does not mean that durable cancellation was requested.

```text
context.abortSignal is present and aborts
→ stop only that caller's observation; an installed lane-owned Drive continues
→ do not write cancel_requested
→ preserve the same durable operation state
```

An undefined `abortSignal`, as exposed by both empty roots, means that the invocation has no cancellation signal.

Only `requestAbort()`/`abort()` writes durable `cancel_requested` and permits durable aborted settlement.

The runtime must track the stop cause instead of interpreting every aborted provider response as durable cancellation:

```ts
type ExecutionStopCause =
	| "no_drive_waiters"
	| "invocation_cancelled"
	| "harness_closed"
	| "durable_cancel_requested";
```

Only `durable_cancel_requested` may normalize and commit a durable aborted outcome. An invocation/disconnect abort must not produce an assistant `stopReason: "aborted"` settlement while durable control remains `running`; that path would violate the durable state machine.

Drive ownership is resolved as **harness-owned**: once installed, execution survives caller cancellation/disconnect until durable settlement or wait, explicit durable cancellation, close, fault, or process loss. Joiner signals control only their own observations. Signals from unrelated joiners must never be combined with `AbortSignal.any()` and attached directly to shared execution. One canceled joiner cannot cancel every other caller.

## RPC trace propagation

Client and server spans can belong to one distributed trace:

```text
caller
└─ rpc.client
   └─ rpc.server
      └─ harness/session operation
```

The client does not serialize `TelemetryContext`. It injects a backend-neutral trace carrier from the `rpc.client` span. The server extracts that carrier into a fresh local `TelemetryContext` and starts `rpc.server` from it.

A transport-facing adapter boundary is required:

```ts
interface TelemetryPropagation {
	inject(context: TelemetryContext): JsonValue | undefined;
	extract(carrier: JsonValue | undefined): TelemetryContext;
}
```

A production implementation may use W3C `traceparent`/`tracestate`. The current telemetry package has no carrier injection/extraction API, so the accepted design must decide whether this adapter belongs in the telemetry package, RPC infrastructure, or a backend integration package. It must still reuse the existing `TelemetryContext` span contract.

RPC cancellation and telemetry propagation are independent control-plane channels:

- trace metadata reconstructs telemetry parentage;
- request ID plus cancel/disconnect messages controls the server request signal;
- neither channel appears in serialized method arguments.

## Interface migration scaffolding

Receiver methods now use a required trailing `Context`. Concrete implementations, calls, callback adapters, and object-literal façades have been migrated rather than relying only on interface assignability.

`TODO_CONTEXT` remains a temporary migration marker, not a semantic root. Current uses cluster at unresolved transport and worker boundaries that cannot yet reconstruct a caller context, notably Pi protocol request ingress and worker RPC ingress. `BACKGROUND_CONTEXT` means intentionally start without a caller.

Continue to inventory `TODO_CONTEXT` separately. Replace each transport-boundary use only when the boundary can construct a request-local cancellation context and telemetry parent; substituting `BACKGROUND_CONTEXT` would hide unfinished propagation. Compilation still does not prove telemetry or cancellation correctness.

## Required tests for the later handoff

Current tests cover immutable typed-value layering and shadowing, distinct empty roots, parent/child abort composition, sibling cancellation isolation, and tool-hook child parentage. Remaining handoff coverage includes:

- crossed concurrent telemetry branches on one shared receiver;
- every hook type, tools, event handlers, and session writes receive the intended child context;
- buffered events retain their emitting context under delayed delivery;
- no receiver-level telemetry default;
- pre-aborted invocation starts no external effect;
- installer and joiner cancellation isolation under lane-owned execution;
- invocation abort leaves the installed Drive and durable state unchanged;
- durable abort commits the durable aborted outcome;
- close and disconnect do not masquerade as durable cancellation;
- client → server trace reconstruction;
- event delivery reconstructs source trace metadata;
- missing/malformed trace carriers degrade to no-op/root telemetry without affecting business behavior.

## Resolved migration decisions

- Receiver methods use one required trailing `Context`.
- Shared Harness, AgentLane, Session, and Branch receivers retain no default invocation context.
- `Context`, `AbortSignal`, and `TelemetryContext` objects are never serialized across RPC boundaries.

## Open decisions before the telemetry handoff

- whether telemetry links are required for joiners;
- trace-carrier adapter ownership and shape;
- which context values, if any, may cross an RPC boundary;
- exact span names/outcome attributes for RPC calls and drive join waits.
