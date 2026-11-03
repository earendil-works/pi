# Chord v1 (`@earendil-works/chord/old`)

Chord v1 is the runtime p2 runs on. It moved unchanged to `src/old` (its tests to `test/old`, these docs to
`docs/old`) when Chord v2 became the package's root (`@earendil-works/chord`); it stays until p2 runs on Chord v2,
then it is removed. New code uses Chord v2 ([README](../../README.md)).

Chord v1 builds applications out of **objects** that live in several processes (a server, workers, browser tabs) and can be **hot reloaded** while they run.

- An **object** is state plus code at an address. It is created on demand and lives while someone references it.
- Everyone gets a **reference**, never the object. References work the same locally and across processes, and survive reloads.
- Every object knows its **principal**: an owner and a guest get different objects, with different methods.
- **State** is observable JSON. Remote viewers get a snapshot followed by deltas.
- **Hot reload** swaps code while it runs. Work in flight finishes on the code it started with, state is kept, and incompatible changes migrate at a safe point.

## Entry points

| Import | Contents | Runs in |
|--------|----------|---------|
| `@earendil-works/chord/old` | Contracts (`local`, `remote`, `method`, `opaque`), declarations (through the factory's `self`: `state`, `derive`, `resource`, `on`, `task`), hosts (`createHost`, `defineFacet`, `defineRegistry`), links (`memoryLinkPair`, `ipcLink`, `webSocketLink`, `acceptWebSockets`), errors (`ChordError`, `isChordError`, `forbidden`, `invalid`), `replicatedState` with its types. It also re-exports the foundations it was built with (`Context`, `JsonValue`, `copyJson`, `Draft`, the watch types); new code imports those from `/context`, `/json`, `/delta` and `/watch`. | Node and browsers |
| `@earendil-works/chord/old/node` | Child host processes: `createHostManager`, `forkDriver`, `childControl`, `processLock`; the facet module loader `nodeLoader`. | Node |

## Quick start

```ts
import { num, obj, str } from "@earendil-works/pi-schema";
import { createHost, hostNamed, method, remote } from "@earendil-works/chord/old";

// contract.ts: shared by provider and consumers
export const Counter = remote("demo.counter", {
	version: 1,
	input: obj({ name: str() }),
	host: hostNamed("server"), // where its objects live; callers never name a host
	variants: {
		default: {
			state: { count: num() },
			methods: { increment: method(obj({ by: num() })) },
		},
	},
});

const host = createHost({ name: "server", self: { kind: "server" } });

host.serve(Counter, ({ name }, _principal, self) => {
	const count = self.state("count", num(), 0);
	return {
		variant: "default",
		count,
		increment: async ({ by }, ctx) => {
			count.change(ctx, (n) => n + by);
		},
	};
});

await host.root(async (ctx) => {
	const clicks = await ctx.get(Counter, { name: "clicks" }); // ready, with its state; released when this root ends
	clicks.count.subscribe((n) => console.log("count", n));
	await clicks.increment({ by: 2 }, ctx); // logs 0, then 2
});
```

## Documentation

- [Tutorial](tutorial.md): a shared todo list, built up section by section. Every example runs as `test/old/tutorial.test.ts`.
- [Usage guide](guide.md): API reference for contracts, objects, state, roots, lifetime, plugins, hot reload, hosts, and links.
- [Specification](spec.md): compatibility, lifetime, and reload semantics, plus known limitations and implementation decisions.

## Replicated state

Replicated state provides the delta tracker's model (`@earendil-works/chord/delta`) through a callback. `replicatedState` is a
standalone observable value, independent of hosts:

```ts
import { replicatedState } from "@earendil-works/chord/old";

const initial = { output: "", count: 0 };
const status = replicatedState(initial); // transfers ownership of initial
status.change(context, (draft) => {
	draft.output += "done\n";
	draft.count += 1;
});
```

A successful `change()` publishes exactly one atomic revision. If its callback
throws, the original value and sequence remain unchanged. Draft references become
unusable when the callback returns. The tracker emits string append and
front-truncate operations, array splices and permutations, sets, and deletes; large
edit sets may fold into a complete replacement.

`replicatedState(source, { onError })` instead attaches a publication-only state to
an authoritative revision source (`ReplicatedStateSource`): it captures a snapshot,
then publishes every committed frame in cursor order.

## Public state subscriptions

`state.subscribe(async (value, context, delivery) => { ... })` serializes callbacks
independently for each subscription. Hydration starts immediately when a value is
available, and its returned promise must settle before updates start. Synchronous
callbacks still run synchronously. Read the captured `value` inside an asynchronous
callback: `state.value` may already refer to a later revision.

Each subscription retains at most 100 pending complete-value deliveries, excluding
the running callback. On overflow, only the newest pending value, context, and
delivery metadata are retained; a not-yet-started initial hydration is preserved.
Thus public delivery sequences may skip. This is a frame-count policy, not a byte
limit.

The returned unsubscribe function immediately discards pending work and prevents
new callbacks. It neither aborts nor waits for the running callback. Synchronous
throws and promise rejections are observed, reported, and do not stop other
subscriptions or subsequent callbacks. Attached sources use their `onError`
handler; mutable states (and attached sources without a handler) report failures
by throwing in a microtask. Unsubscribing does not hide a later rejection from the
running callback.

Cells of Chord objects and their remote readables have their own subscription
model; see [State](guide.md#state) in the usage guide.
