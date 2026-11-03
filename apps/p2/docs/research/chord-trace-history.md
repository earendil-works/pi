# Chord trace/context history

## Finding

**I found an implemented explicit Context/cancellation system, and a written design for distributed tracing, but no implementation that propagated trace identity across Chord links.** The distinction matters:

- Old Chord passed the caller's **actual Context object** through local service calls and its in-process loopback transport. Application values, including a pi-telemetry parent, could survive that path.
- Its real remote transport forwarded **cancellation only**, using request IDs and cancel messages. It discarded arbitrary Context values. The receiving server and worker constructed new contexts rooted at `TODO_CONTEXT` or `BACKGROUND_CONTEXT`, not an extracted trace parent.
- The August RPC/telemetry documents describe exactly the remembered client → server trace propagation, but explicitly call it design input and say carrier injection/extraction was missing.
- Today's main Chord runtime and `src` both propagate cancellation across relays. Neither call-frame schema defines trace IDs, span IDs, W3C headers, baggage, or an invocation deadline.

This is a finding about the fetched, reachable repository history and the additional worktree/source copies inspected, not proof about unavailable/deleted remote refs or unpublished code elsewhere.

## Scope and reproducibility

Research baseline: `private` at `e5864dd82` (2026-10-17). `git fetch --all` completed for `origin` (`pi-private`) and `upstream` (`pi`); it updated only `upstream/feat/durable-timer`. `git log --all` covered 7,657 reachable commits and 95 remote-tracking refs. No branch was checked out, no source was changed, and no tests were run. Only this report was written.

The working tree already contained unrelated Chord v2/playground edits. Current-source citations below use **committed `e5864dd82`**, unless explicitly stated. The uncommitted cancellation paths inspected agree with the descriptions; one additional implementation detail is noted below.

Commands/searches included:

```sh
git fetch --all
git log --all --oneline -- '*chord*'
git log --all -S'traceparent' -- packages apps
git log --all -S'trace' -- 'packages/chord*' 'apps/p2/src/chord*'
git log --all -S'span' -- 'packages/chord*' 'apps/p2/src/chord*'
git log --all -S'telemetry' -- '*chord*' 'apps/*'
git log --all -S'TelemetryPropagation' -- packages apps
git log --all -G'[Tt]race|[Tt]elemetry|[Ss]pan' -- \
  'packages/chord/**' 'apps/p2/src/chord2/**' \
  'packages/protocol/src/**' 'packages/server/src/**' 'packages/client/src/**'
git log --all --diff-filter=D --name-only -- '*chord*'
```

Also searched commit messages for Chord, RPC, wire, link, trace, span, telemetry, context, propagation and cancellation; followed context/service moves; inspected deleted service files, old protocol/client/server implementations, and experimental coding-agent worker transport. Searches of predecessor paths included `packages/agent/src/plugins/services`, `packages/agent/src/harness`, `packages/coding-agent/src/experimental`, and `apps/mobile` history. Bare `span` matches in UI JSX and delta documentation were not treated as tracing.

Additional locations checked:

- `/home/badlogic/chord-handover`: `chord-handover`, `d7629429f`.
- `/home/badlogic/p2-live`: detached `72f6b0a5c`.
- `/home/badlogic/p2-verify`: detached `7e7893b2e`.
- `/home/badlogic/research/chord-wt` and `chord-patched`: source snapshots, not independent Git repositories; no trace/telemetry carrier implementation in their Chord sources.
- `/home/badlogic/research/experiments/chord-{retire-order,leaks,leaks-patched}.ts`: experiment locations inventoried; the adjacent Chord copies concern lifecycle work, not a separate historical tracing runtime.
- Other Git repositories under `~/research` are Cordis, OpenCode, and DeepSeek Harness, not additional pi/Chord history. They were not mistaken for branches of this repository.

## Timeline and where to recover it

Dates below are Git author dates, as displayed by `git log --date=short`.

| Commit | Date | Relevant change and paths |
| --- | --- | --- |
| `6b461b75b` | 2026-08-05 | Extracted `packages/telemetry`. |
| `35f5c265d` | 2026-08-06 | Added telemetry reference adapter and span composition: `packages/telemetry/src/memory.ts`, `src/index.ts`. |
| `68a9341ae` | 2026-08-17 | Added invocation Context primitives to `packages/agent/src/harness/context.ts`. |
| `397673eb2` | 2026-08-17 | Added **design-only** `packages/agent/docs/rpc.md` and `telemetry.md`, including trace injection/extraction and `rpc.client`/`rpc.server`. |
| `fb33e0db2`, `f8a6e670d`, `8222adee8` | 2026-08-18–20 | Remote-session and routed-service predecessors under `packages/agent` and the experimental coding-agent stack. |
| `28b49a6b3` | 2026-08-28 | Chord foundation: `packages/chord/src/context.ts`, `PLANNING.md`; agent Context became a Chord adapter with a local pi-telemetry key. |
| `34dc9d055` | 2026-08-29 | Moved services/facets into Chord. Predecessors included `packages/agent/src/plugins/services/{namespace,provider}.ts` and `packages/coding-agent/src/experimental/facets.ts`; destinations included `packages/chord/src/services/{consumer,provider}.ts` and `facets/host.ts`. |
| `e6dc574d1` | 2026-08-29 | Isolated the Context API under `packages/chord/src/context/index.ts`. |
| `45d0174ee` | 2026-08-30 | Added/hardened service lifecycle and `services/loopback.ts`, retaining Context directly in process. |
| `1a7bc80e7` | 2026-09-01 | Moved service wire grammar into `packages/chord/src/services/wire.ts`; outer routing/framing remained in `packages/protocol`, client and server. |
| `fa5036836` | 2026-09-01 | Consolidated the remote adapter into `createClientServiceTransport()` in `packages/client/src/client.ts`; still forwarded only `context.abortSignal`. |
| `7fd478a2e`, `48dd1e2f0` | 2026-10-01 | Removed old agent harness/telemetry schemas and ported experimental client/server to Durable. `pi-telemetry` itself remained. |
| `a0c602f36` | 2026-10-09 | Added private p2's object-based Chord2 in `apps/p2/src/chord2`, with its own links and cancellation. |
| `7472cda0d` | 2026-10-12 | Deleted `packages/{client,protocol,server}` and most experimental coding-agent stack. Last complete old transport snapshot: `7472cda0d^`. |
| `0104fef1e` | 2026-10-12 | Replaced old Chord facets/services with p2's Chord2 host runtime. Last old Chord snapshot: `0104fef1e^`. |
| `67634271c` | 2026-10-17 | Added hosts/routed links/session policies to `packages/chord/src`, including its cancel-frame path. |

The old foundation and replacement commits are reachable from both `origin/private` and `upstream/main`/`upstream/stable`, as well as local `private` and `chord-handover` and several other fetched branches. The private p2 prototype commit is in origin/private's history. Git containment establishes current reachability, not the original branch on which a commit was authored. `src` is on the private development line at this baseline.

## 1. What old Chord actually propagated

### Context values were explicit, immutable, and process-local

At `28b49a6b3:packages/chord/src/context.ts`, Context was:

```ts
export interface Context {
  readonly abortSignal: AbortSignal | undefined;
  value<T>(key: ContextKey<T>): T | undefined;
  toString(): string;
}
```

A key was an object containing a unique symbol. `withContextValue()` created a parent-linked layer; lookup compared symbol identity and delegated to the parent. `withAbortSignal()` layered a signal, combining it with the parent's signal using `AbortSignal.any()`. `withCancel()` created a child controller. `awaitWithContext()` canceled only the waiter, not the underlying promise.

The pi adapter deliberately lived outside Chord. From `28b49a6b3:packages/agent/src/harness/context.ts` (also present after the service move):

```ts
const TELEMETRY_CONTEXT_KEY = createContextKey<TelemetryContext>("pi.telemetryContext");

export function getTelemetryContext(context: Context): TelemetryContext {
  return context.value(TELEMETRY_CONTEXT_KEY) ?? NOOP_TELEMETRY_CONTEXT;
}

export function withTelemetryContext(telemetryContext: TelemetryContext, context: Context): Context {
  return withContextValue(TELEMETRY_CONTEXT_KEY, telemetryContext, context);
}
```

Thus old Chord could carry a **pi-telemetry object locally**, without importing or understanding pi-telemetry. This was not trace-ID serialization.

### Service calls removed Context from business arguments, then supplied it out of band

At `0104fef1e^:packages/chord/src/services/consumer.ts:120–138`, the facade required a trailing Context:

```ts
const context = args.at(-1);
if (!isContext(context)) {
  // Reject: requires a trailing Context.
}
const businessArgs = args.slice(0, -1) as JsonValue[];
return this.#invoke(businessArgs, context);
```

`ServiceFacade.#slot()` passed `{ serviceId, instance?, member, args }` and `context` as separate transport parameters. The loopback transport passed that same context directly (`0104fef1e^:packages/chord/src/services/loopback.ts`):

```ts
invoke: (call, context) => provider.invoke(call, context),
```

The provider appended it when dispatching (`0104fef1e^:packages/chord/src/services/provider.ts:235`):

```ts
const result: unknown = await Reflect.apply(
  member.method, instance.implementation, [...call.args, context],
);
```

Concrete consequence: local caller → facade → loopback → provider preserved the caller's key/value layers, telemetry parent object and AbortSignal. An application-supplied transport could choose to preserve/reconstruct metadata, but that extension point is not evidence that a shipped remote adapter did so.

Local state delivery also retained Context. The provider buffered `{ update, context: deliveryContext }` (`provider.ts`, `#emit`, lines 445 onward), including through snapshot-overflow resets. This preserved the source of local state updates; it did not place a Context or trace carrier in a wire update.

### Local spans reused pi-telemetry

At `34dc9d055:packages/agent/src/harness/telemetry.ts`, `startHarnessSpan()` delegated to the parent and derived the context supplied to lower work:

```ts
return getTelemetryContext(context).startSpan({ name, attributes }, (span: TelemetrySpan) =>
  callback(span as HarnessTelemetrySpan<Name>, withTelemetryContext(span, context)),
);
```

That implementation used domain names such as `pi.harness.run`, `pi.harness.turn`, `pi.harness.hook` and `pi.session.write` (see the same file's schemas). It did not define or emit Chord RPC/relay spans. Chord itself had no built-in telemetry spans.

## 2. The actual remote boundary lost trace/context values

The most conclusive code is the final shared client adapter, introduced by `fa5036836`, still present at `7472cda0d^:packages/client/src/client.ts`, `createClientServiceTransport()`:

```ts
invoke: async (call, context) => client.request(target(), call, context.abortSignal),
```

Subscription updates similarly reconstructed a root delivery context:

```ts
(update) => listener(update, BACKGROUND_CONTEXT),
```

Before consolidation, the same projection was in `1a7bc80e7:packages/coding-agent/src/experimental/services/connection.ts`, `createRemoteServiceTransport()`. There was no inject hook in either implementation.

At `7472cda0d^:packages/protocol/src/protocol.ts`, protocol version 8 used strict outer envelopes:

```ts
const RequestEnvelopeSchema = StrictObject({
  type: Type.Literal("request"),
  id: IdSchema,
  target: RpcTargetSchema,
  call: OpaqueJsonValueSchema,
});
const CancelEnvelopeSchema = StrictObject({
  type: Type.Literal("cancel"),
  id: IdSchema,
  target: RpcTargetSchema,
});
```

The Chord call grammar (`0104fef1e^:packages/chord/src/services/wire.ts`, `parseServiceCall()`) allowed only `serviceId`, `member`, `args`, and optional `instance`. The outer protocol's service update carried only `subscriptionId` and `update`. There was **no trace carrier in either layer**.

The server did not extract a parent. At `7472cda0d^:packages/server/src/server.ts`, `handleRequest()`:

```ts
const controller = new AbortController();
const active = { controller, target: envelope.target };
state.activeRequests.set(envelope.id, active);
const context = withAbortSignal(controller.signal, TODO_CONTEXT);
```

It passed this fresh context through `sessions.executeServiceCall()` or `serverServices.invokeService()` to provider dispatch. `TODO_CONTEXT` has no caller telemetry value. The same behavior is visible at `1a7bc80e7`; `48dd1e2f0` changed imports from the agent adapter to `@earendil-works/chord/context`, not trace semantics.

### Cancellation did cross the old remote boundaries

The client (`packages/client/src/client.ts`, `#request`) checked pre-aborted signals and, on abort, rejected the local waiter and sent `{ type: "cancel", id, target }`. The server's `handleCancel()` matched the active request **and target**, then aborted its controller. Disconnect aborted all active request controllers.

For the extra server → session-worker hop, inspect `7472cda0d^:packages/coding-agent/src/experimental/session-worker-manager.ts`, `#invoke()`:

```ts
const signal = context.abortSignal;
// In the signal's abort listener:
void this.#coordinator.send(worker.peerId, { type: "operation_cancel", requestId, scope }).catch(() => {});
// Ordinary request:
this.#coordinator.send(worker.peerId, { type: "operation", requestId, scope, call });
```

The worker (`session-worker.ts`, `handleOperation` and `onOperationCancel`) rebuilt another fresh root:

```ts
const cancellable = withCancel(BACKGROUND_CONTEXT);
activeRequests.set(request.requestId, { scope: request.scope, cancel: cancellable.cancel });
const result = await services.invoke(request.call, request.scope, cancellable.context);
// Matching operation_cancel:
active.cancel(new DOMException("Service operation cancelled", "AbortError"));
```

So the complete implemented path was:

```text
caller Context.abortSignal
→ client cancel(request id, target)
→ server request controller / fresh Context
→ worker operation_cancel(worker request id, scope)
→ worker controller / fresh Context
→ provider method's trailing Context.abortSignal
```

Request IDs were remapped at the worker hop; scope/target fenced cancellation to the matching invocation. A signal abort is cooperative cancellation, not forced termination of JavaScript and not automatic reversal of admitted business work.

### What traveled, and what did not

| Item | Old shipped remote stack | Current main Chord | Chord `next` |
| --- | --- | --- | --- |
| Call correlation | Request `id`, routed `target`; worker `requestId` and `scope` | Link-local call `id`, `hold` | Link-local call `id`, `hold` |
| Cancellation | Separate `cancel` / `operation_cancel` | `{ t: "cancel", id }` | `{ kind: "cancel", id }` |
| Trace ID / span ID | None | None | None |
| `traceparent` / `tracestate` | None | None | None |
| Baggage / arbitrary Context values | Not serialized | Not serialized | Not serialized; values can survive local calls |
| Invocation deadline | No deadline field | No invocation deadline field | No invocation deadline field |
| Other control context | Server/session/attachment routing | Optional `root: { rootId, codeVersion }`; principal/origin on holds | Principal actor/origin on holds; peer incarnation |

Main Chord's `rootId` is **not a telemetry trace ID**: it coordinates call-tree leases and code-generation handover. Wire reload options `gateDeadline`/`retireDeadline`, and local ready/park timeouts, are also not distributed invocation deadlines. A caller-created timeout can abort a signal, causing the ordinary cancel path, but the deadline itself is not sent.

## 3. The trace-propagation design that matches the memory

`397673eb2:packages/agent/docs/rpc.md` and `telemetry.md` are the strongest match. Both start with:

> Status: Design input, not a normative contract or implementation handoff.

`rpc.md` describes this precise intended lineage:

```text
client caller
└─ rpc.client
   └─ rpc.server
      └─ harness/session span
```

Its conceptual request includes `trace?: JsonValue`, and its conceptual event frame also includes `trace?: JsonValue`. The client should strip InvocationContext, start `rpc.client`, inject the client span's carrier, then send it. The server should extract the carrier, construct a fresh local invocation context, start `rpc.server`, derive the method context from that span, and independently attach request cancellation.

`telemetry.md` proposes:

```ts
interface TelemetryPropagation {
  inject(context: TelemetryContext): JsonValue | undefined;
  extract(carrier: JsonValue | undefined): TelemetryContext;
}
```

It explicitly says a production adapter **may** use W3C `traceparent`/`tracestate`, and that the telemetry package **has no carrier injection/extraction API**. These are proposals, not implemented interfaces. The documents specify no actual trace-ID/span-ID layout, baggage format, or deadline carrier.

The RPC document also states that the then-existing `packages/protocol/src/rpc.ts` had no client invocation-context/cancellation/trace integration. Inspection confirms its dispatcher merely accepted an already-local generic `TContext` and invoked `[context, ...call.args]`; it had no trace extraction.

Old Chord's final `PLANNING.md` reinforces the implementation boundary:

- Header: symmetric RPC remained planned.
- §4: no built-in telemetry; applications could attach it through typed local keys.
- §4: an optional opaque strict-JSON metadata carrier and fresh receiver context were the intended RPC design.
- §9: optional context metadata hooks were on the generic RPC plan.
- Final open decisions still included whether context metadata propagation would be in the first RPC envelope.

There is no implemented relay span naming/parenting policy to recover. The design specifies `rpc.client` → `rpc.server`, not additional relay spans; events should inherit the emitting operation rather than subscription establishment. Its joiner discussion says concurrent joiners must retain their own trace and correlate with an existing execution through operation/execution attributes, not reparent it. Span links were explicitly an optional future addition.

## 4. Today's main Chord cancel-frame path

Sources at `e5864dd82`:

1. `packages/chord/src/old/remote.ts`, `RemoteBinding.call()`: forwards `ctx.signal` and `{ rootId, codeVersion }` to the connection.
2. `src/connection.ts:700–730`, `Connection.call()`: registers the caller's abort listener and sends the call. Abort removes the pending call, sends `{ t: "cancel", id }`, and rejects locally with `ChordError("aborted", ...)`.
3. `src/wire.ts:106–123`: declares `call` and `cancel`; no trace fields.
4. `src/connection.ts:774–775`: receiving cancel aborts `incoming.get(frame.id)`.
5. `src/connection.ts:1098–1150`, `#onCall()`: creates/stores that controller and starts/joins a host root with `signal: controller.signal`.
6. `src/host.ts:625–668`, `joinRoot()`: creates `CtxImpl`, linking request cancellation with code-version retirement.
7. `src/object.ts:465–475`, `CtxImpl.child()`: links the root signal with the target object's `callAbort.signal`. `ObjectImpl.call()` (`1555–1614`) supplies that child to `fn(input, child)` or `fn(child)`.

The essential receiving code is:

```ts
case "cancel":
  this.incoming.get(frame.id)?.abort(new ChordError("aborted", "cancelled by caller"));
  return;
```

### Across a relay

`Connection.#onCall()` runs `relayCall()` with `ctx.signal`. `relayCall()` (`connection.ts:1270–1300`) allocates a downstream call ID, forwards the root and arguments, and installs:

```ts
onCancel = () => call.cancel(abortError(), true);
signal.addEventListener("abort", onCancel, { once: true });
```

`RelayCall.cancel()` (`302–305`) sends `{ t: "cancel", id: this.downId }` and settles/removes both mappings. A relay disconnect/release also closes its relayed holds/calls; connection close aborts incoming controllers (`#closed()`). Thus cancellation follows the call after ID remapping. It does not require a shared AbortSignal object across processes.

Evidence already in tests: `packages/chord/test/old/links-review.test.ts`, “#7 a browser disconnect cancels its call downstream”; `test/cluster.test.ts`, “forced retirement cancels a browser call relayed to a worker before the server closes the old code's resources.” These were inspected, not rerun.

Main Chord's method implementation must observe/forward its signal to stop actual work. `ObjectImpl.call()` awaits the invocation; aborting a controller cannot forcibly stop a method that ignores it.

## 5. Chord v2 (`src`) cancel-frame path

Sources at committed `e5864dd82`; routed cancellation was introduced by `67634271c`.

- `src/remote.ts`, `RemoteBinding.call()`: passes `ctx.signal` to `phase.connection.call(...)`.
- `src/connection.ts`, `Connection.call()` (around line 254): rejects pre-aborted calls, registers a pending call, and sends tagged optional arguments. Its abort listener is:

```ts
const cancel = (): void => {
  this.#calls.delete(id);
  signal.removeEventListener("abort", cancel);
  this.#safe({ kind: "cancel", id });
  reject(new ChordError("aborted", "call cancelled", { cause: signal.reason }));
};
```

- `src/wire.ts:103–104` declares:

```ts
Type.Object({ kind: Type.Literal("call"), id: Id, hold: Id, member: Name, args: ArgSchema }),
Type.Object({ kind: Type.Literal("cancel"), id: Id }),
```

- `Connection.#dispatch()` handles `cancel` by aborting `#incoming.get(frame.id)?.controller`.
- `Connection.#call()` (`982–1030`) creates `{ controller, hold }` and starts `host.root(..., { signal: controller.signal })`.
- A local hold runs `ref.invoke(..., ctx, true)`. A relayed hold runs:

```ts
return current.down.call(
  current.downId,
  frame.member,
  frame.args.kind === "none" ? undefined : frame.args.value,
  ctx.signal,
);
```

The downstream `call()` creates its own ID and abort listener. Therefore inbound cancellation aborts the relay root, which sends the downstream cancel, which aborts the provider root. Unlike main Chord, `next` does not send root IDs/code versions.

`src/host.ts:365–382` constructs `CallScope`/`RemoteCallScope`; `src/object.ts:513–580` creates a child with caller/object/activation signals, invokes the method with that child, and races waiting against caller cancellation. The method still must cooperate to stop its external effects. Pending execution remains tracked until it actually settles.

`Connection.#drop()` also aborts incoming calls for a released hold; `#closed()` aborts all incoming calls and rejects outgoing ones. `packages/chord/test/network.test.ts`, “cancels a relayed method on caller abort or origin disconnect,” exercises both paths. Not rerun.

### Context values are already reusable locally in v2

`src/ctx.ts:189–218` wraps a parent Context:

```ts
parent: Context = BACKGROUND_CONTEXT,
// ...
this.#context = withAbortSignal(this.signal, parent);
// ...
value<T>(key: ContextKey<T>): T | undefined {
  return this.#context.value(key);
}
```

`host.root()` accepts `{ context?: Context }`, and local method children receive `ctx` as their parent. `test/bindings.test.ts` explicitly tests “preserves shared Context values through Chord calls, without root ids or code versions.” That test uses one host, not a network round trip.

On an inbound remote call, `Connection.#call()` supplies **only `{ signal }`**, not an extracted `context`. Thus this local bridge does not implement distributed trace propagation.

Working-tree note: the uncommitted v2 object implementation additionally races against linked object/activation cancellation, whereas the baseline races its caller wait against `ctx.signal`. Neither version adds a trace carrier or changes the described cancel-frame chain.

## 6. What pi-telemetry offers and lacks

Current `packages/telemetry/src/index.ts` retains this deliberately small backend-neutral interface:

```ts
export interface TelemetryContext {
  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}
export interface TelemetrySpan extends TelemetryContext {
  addEvent(name: string, attributes?: SpanAttributes): void;
  setAttributes(attributes: SpanAttributes): void;
  setStatus(status: SpanStatus): void;
}
```

It offers explicit parent → child nesting, callback-owned span lifetime, no-op telemetry, typed names/attributes/schema composition, an in-memory reference recorder, and adapter-conformance cases. It has no dependency on a concrete tracing backend.

It does **not** offer:

- inject/extract or a remote-parent constructor;
- public trace ID/span ID getters, W3C carrier codecs, baggage or sampling propagation;
- span links or invocation cancellation/deadlines;
- an exporter or global/ambient current span.

`src/memory.ts` records numeric `id`/`parentId` in one private recorder state (`nextSpanId: 1`), not globally meaningful trace IDs. Its `createSpan()` sets `parentId: parent?.id ?? null`; it cannot import another process's parent. New child creation after the parent settled falls back to no-op. The historical implementations introduced in `35f5c265d` have the same basic process-local model; telemetry history did not reveal a removed propagation API.

The README says backend IDs, sampling/exporting and backend-specific contexts belong to adapters. Some README integration examples still mention the removed agent harness schemas; the current exported source interface above is authoritative. No shipped OpenTelemetry propagation adapter was found. Removing an unused `opentelemetry` dependency (`209bc7b9a`, 2026-08-17) is not evidence that Chord ever had one.

## 7. Why it disappeared / was not carried over

History supports **replacement of experiments**, not deliberate removal of an implemented distributed-tracing feature:

- `0104fef1e` explicitly says it moves Chord2's contracts/objects/hosts/links from p2 into Chord, replacing the facet/service runtime. Its message says `./context` and `./delta` are unchanged. So the generic Context utility survived, while the old service runtime using it was deleted; the new main runtime's `CtxImpl` instead exposed root/code-version/principal/signal.
- `7472cda0d` explicitly deletes the experimental client/protocol/server stack and its coding-agent consumers.
- `7fd478a2e` removes the old agent harness and its telemetry schemas/re-exports; `48dd1e2f0` moves the experimental application to Durable.
- `6db4070f1` then rewrites documentation to describe only current code.

I found **no commit message or decision explaining a choice to drop working cross-link trace propagation**, because no such implementation was found. The earlier documents left metadata hooks and the carrier adapter unimplemented/open. Treating the conceptual RPC design as code that was lost at cutover would overstate the evidence.

## 8. What is worth reusing for v2

1. **Reuse explicit Context keys and v2's existing local bridge.** Keep a telemetry parent in an application/integration-owned key, derive method contexts from child spans, and avoid a mutable host-wide “current trace.” This already handles concurrent local callers correctly.
2. **Implement the missing transport boundary, not Context serialization.** Recover the small `TelemetryPropagation` inject/extract design from `397673eb2`. Add a deliberately bounded/validated optional carrier to the v2 call frame, with an adapter able to reconstruct a backend parent. Symbol-keyed values and telemetry objects must not cross the wire wholesale.
3. **Keep cancellation independent.** The existing request-local controller plus `cancel(id)` path already reaches the provider through relays. Reuse it; tracing metadata must not grant authority, cancel other calls, or trigger durable business cancellation.
4. **Choose relay trace semantics explicitly.** Either forward one opaque carrier unchanged through routing relays, or create a documented client/server span pair per hop. Current relays rebuild outbound calls from explicit fields, so merely adding a wire-schema field is insufficient: `Connection.#call()`/`call()` must carry it too. Do not reinterpret old `rootId` as a trace ID.
5. **Reuse source-context delivery for state only if required.** Old local provider queues retained `{ update, context }`; the design proposed a separate carrier per emitted event. State replication currently has no such carrier. Do not accidentally parent all streaming updates to the subscription-open span.
6. **Test real boundary behavior with an adapter fixture.** Assert caller → client → provider parentage, concurrent caller isolation, nested remote calls, multiple relays, cancel/disconnect, missing/malformed carriers, and metadata size limits. A same-process Context-key test alone is not proof of network propagation. pi-telemetry's current in-memory recorder needs a test propagation adapter or extension before it can model an imported remote parent.

**Bottom line:** there is reusable local Context/telemetry composition and working distributed cancellation, plus a clear design for the missing tracing boundary. There is no discovered old implementation of trace IDs/spans/baggage propagating over Chord links to transplant.
