# Chord usage guide

> Describes the runtime in `src`. The [specification](spec.md) defines its semantics and lists known limitations.

Chord builds applications out of **objects** that live in several processes (a server, workers, browser tabs) and can be **hot reloaded** while they run.

- An **object type** is declared by a contract: a name, an input (the object's address) and members. A plugin's
  **facet** (its code for one host: server, worker, browser) serves object types.
- An **object** is one instance of an object type: state plus code at an address. It is created on demand and lives
  while someone references it.
- Everyone gets a **reference**, never the object. References work the same locally and across processes, and survive reloads.
- Every object knows its **principal**: an owner and a guest get different objects, with different methods.
- **State** is observable JSON. Remote viewers get a snapshot followed by deltas.
- **Hot reload** swaps code while it runs. Work in flight finishes on the code it started with, state is kept, and incompatible changes migrate at a safe point.

## Contents

- [Quick start](#quick-start)
- [Contracts](#contracts)
- [Serving objects](#serving-objects)
- [Declarations](#declarations)
- [Activation](#activation)
- [Principals and variants](#principals-and-variants)
- [References](#references)
- [State](#state)
- [Calls, ctx and roots](#calls-ctx-and-roots)
- [Lifetime](#lifetime)
- [Registries](#registries)
- [Plugins](#plugins)
- [Hot reload](#hot-reload)
- [Hosts and links](#hosts-and-links)
- [Durable](#durable)
- [Errors](#errors)
- [Rules of thumb](#rules-of-thumb)

## Quick start

```ts
import { Type } from "typebox";
import { createHost, method, remote } from "@earendil-works/chord";

// contract.ts: shared by provider and consumers
export const Counter = remote("demo.counter", {
	version: 1,
	input: Type.Object({ name: Type.String() }),
	variants: {
		default: {
			state: { count: Type.Number() },
			methods: { increment: method(Type.Object({ by: Type.Number() })) },
		},
	},
});

const host = createHost({ name: "server", self: { kind: "server" } });

host.serve(Counter, ({ name }, _principal, self) => {
	const count = self.state("count", Type.Number(), 0);
	return {
		variant: "default",
		count,
		increment: async ({ by }, ctx) => {
			count.change(ctx, (n) => n + by);
		},
	};
});

await host.root(async (ctx) => {
	const clicks = await ctx.get(Counter, { name: "clicks" });  // ready, with its state; released when this root ends
	clicks.count.subscribe((n) => console.log("count", n));
	await clicks.increment({ by: 2 }, ctx);  // logs 0, then 2
});
```

## Contracts

A contract is a runtime value: a name, a version number, and a description of the members. Shipped bundles have no TypeScript, so everything the runtime checks must be in the contract. TypeScript types are inferred from it.

### Remote types

Remote types can be reached from other hosts. Everything that crosses the wire has a schema, and the provider validates it.

```ts
export const Chat = remote("pi.chat", {
	version: 1,
	input: Type.Object({ session: Type.String(), conversation: Type.Number() }),
	host: hostFamily("session:", "session"),  // lives on `session:S1` for `{ session: "S1", … }`
	variants: {
		viewer: {
			state: { view: ConversationViewSchema },
		},
		participant: {
			state: { view: ConversationViewSchema },
			methods: {
				send: method(SendInputSchema, Type.Object({ submissionId: Type.Number() })),
				stop: method(),  // no arguments, no result: `chat.stop(ctx)`
			},
		},
	},
});
```

**Where a remote type lives** is part of its contract, so no caller names a host:

- `host: hostNamed("server")`: every object lives on the host named `server`.
- `host: hostFamily("session:", "session")`: an object lives on `session:` + its input's `session` field, a required
  string. TypeScript checks the field name against the input.

A `get` normalizes the input (defaults count), resolves the host, and acquires the object here if that is this host,
otherwise over the link to it. `serve` refuses a type whose placement does not include the serving host, so a misplaced
type fails at startup or at the reload that adds it. The host that gets a hold checks that its own contract places the
input on itself, and a relay checks the hold's target against its contract token: a client never chooses where an
object lives. The placement is part of the description and the fingerprint: moving a type is a breaking change, and
references to it get `upgrade_required`.

### Local types

Local types are reachable only inside their host. Their members may be anything: functions, callbacks, native objects. Non-JSON members get opaque or function descriptors.

```ts
export const Index = local("pi.index", {
	version: 1,
	input: Type.Object({ session: Type.String() }),
	members: {
		search: method(Type.Object({ query: Type.String() }), Type.Array(HitSchema)),
		onChange: method(Type.Function([ChangeSchema], Type.Void()), UnsubscribeSchema),
		harness: opaque("pi.durable-harness@1"),
	},
});
```

### Inputs identify objects

`{ session: "S1", conversation: 1 }` always means the same object. Inputs are normalized (defaults applied, unknown fields removed), validated, and serialized canonically. Fields equal to their default are left out, so adding a new optional field with a default doesn't change existing addresses. Changing a default, or how inputs are normalized, needs a new type name.

### Versions and compatibility

Every bundle carries its own copy of each contract it was built against. When a consumer binds to a provider, the two copies are compared:

> A consumer built against version M binds to a provider at version N if **N = M and the provider's description covers the consumer's**. Otherwise the provider must offer an adapter in `accepts[M]`, or binding fails with `contract_mismatch`.

"Covers" means the provider still offers everything the consumer was built against:
- every member exists with the same kind;
- methods accept everything the consumer can send (new arguments must be optional) and return at least what it expects (extra result fields are fine);
- state values fit the consumer's schema;
- opaque members have the same name and version.

| Change | Version | Result |
| --- | --- | --- |
| Add a method, an optional argument, a result field, a state field | keep | binds |
| Remove or rename a member; make an argument required; change a type | **bump** | old consumers need `accepts`, or must be reloaded too |
| Same shape, different meaning (`query` is now a regular expression) | **bump** | as above; undetectable, so it's on you |
| Forgot to bump on a breaking shape change | keep | refused: "consumer needs member `search`" |

```ts
// version 2 changed what `search` means; old consumers keep working through an adapter
host.serve(Index, indexFactory, {
	accepts: {
		1: (current) => ({ search: ({ query }, ctx) => current.search({ query: escapeRegExp(query) }, ctx) }),
	},
});
```

## Serving objects

```ts
host.serve(Type, (input, principal, self) => implementation, options);
```

- The **factory** runs synchronously. It declares what the object needs and returns its implementation: methods and state members, plus `variant` for remote types. Returning a promise throws.
- There is one **object** per `(type, input, principal)`. It holds the object's state, resources and references, and survives reloads. Only the implementation is replaced.
- **Options:**
  - `accepts`: adapters for consumers built against older contract versions;
  - `lifetime`: `"referenced"` (default) creates the object at its first `get` and disposes it after the last reference
    is released; `"host"` creates it when the plugin loads and keeps it until the host closes (see [Lifetime](#lifetime));
  - `linger`: how long to keep a referenced object after the last reference is released.

## Declarations

A reload runs the factory again over the same object. Declarations that keep something across a reload have a **name**: the new code's `status` cell is the old code's `status` cell, with its value. Derivations and tasks hold nothing across a reload and have no name.

```ts
host.serve(StatusStore, ({ session }, _host, self) => {
	const status = self.state("status", StatusSchema, { running: false, tasks: 0 });
	const errors = self.state("errors", Type.Array(Type.String()), []);
	const catalog = self.get(Catalog, {});
	const db = self.resource("db", {
		version: 1,
		open: async ({ signal }) => openSqlite(statusPath(session), { signal }),
		close: async (db) => db.close(),
	});
	self.on("catalogChanges", catalog.rows, (rows, ctx) => errors.replace(ctx, checkRows(rows)));
	self.task(async (ctx) => {
		while (!ctx.signal.aborted) {
			await sleep(10_000, ctx.signal);
			await db.value.run("INSERT INTO history VALUES (?)", [JSON.stringify(status.value)]);
		}
	});
	const summary = self.derive([status, errors], (s, e) => ({ ...s, failing: e.length > 0 }));
	return { summary, report: reportMethod(status) };  // exposed state is what the implementation returns
});
```

| Declaration | What it is | On reload |
| --- | --- | --- |
| `self.state(name, schema, initial \| { init }, { version?, migrate? })` | an observable JSON cell; the schema is required | same cell and value (`init` does not run); migrated when its version rises |
| `self.get(Type, input, { at? })` | a reference to another object; its identity is the address | kept if declared again, otherwise released |
| `self.resource(name, { version, deps?, exclusive?, open, close? })` | a connection, watch, socket, port | kept; reopened only if `version`, `deps` or `exclusive` change |
| `self.on(name, source, handler)` or `self.on(name, source, select, handler)` | reacts to state or to an event source | the same subscription, with the new handler, as long as the source and `select` are unchanged |
| `self.task(async (ctx) => ...)` | long-running background work | the old run is aborted through `ctx.signal`; the new code starts once it finished (at most `taskStopDeadline`, default 5 s) |
| `self.derive(sources, fn)` | live projection of state; `fn` is synchronous | a new derivation, computed when the reload commits |
| `self.register(Registry, { key: value })` | an entry in a registry | replaced at commit |
| `self.expose(resource)` | a member backed by a resource (local types) | follows the resource |

Names are strings: declaring one twice in a run fails (`invalid/duplicate`). Each kind has its own names, so a cell and a resource may share one.

A listener keeps its subscription across reloads when it is declared on the same resource (or source) with the same `select`: the same function, or one with the same source text. `select` is not called again, so a source that accepts a single subscriber (a Durable watch) survives reloads, and `select` may wrap the value in a new adapter object. A `select` whose result depends on captured values that change between reloads is not noticed; give such a listener a new name.

**A listener on state reconciles.** A listener on state (a cell, a derivation, a reference's state member) gets the current value when it starts, then every new value. When a reload replaces its source (a derivation is new at every reload), it subscribes again and gets the current value again. Write its handler to bring things in line with the value it gets (set, compare, start or stop what the value says), not to count or append per call. An event source (a resource's events) delivers no current value.

A name you no longer declare is released, closed or stopped, after the old code has finished what it was doing.

**State that must survive a reload lives in cells,** never in closure variables. A closure variable lasts as long as one version of the code.

```ts
// wrong: reset on every reload
host.serve(Visits, (_, _p, self) => {
	let visits = 0;
	return { hit: async (ctx) => ++visits };
});

// right
host.serve(Visits, (_, _p, self) => {
	const visits = self.state("visits", Type.Number(), 0);
	return {
		hit: async (ctx) => {
			visits.change(ctx, (n) => n + 1);
			return visits.value;
		},
	};
});
```

**Methods** are declared with `method(args?, result?)` in the contract. Without `args` a method takes none: callers write `ref.hit(ctx)` (or `ref.hit()`), and its implementation is `(ctx) => …`. Without `result` it returns nothing: the implementation returns nothing, and callers get `undefined`. `method(undefined, Type.Number())` takes no arguments and returns a number.

## Activation

The factory is synchronous, but activation isn't. `self.get` and `self.resources` only *declare*; the slow work happens afterwards:

```text
get(Index, { session: "S1" })
 1. run the factory               → declarations
 2. open declared resources        → e.g. connect to SQLite
 3. wait for declared refs        → dependencies activate first
 4. run the cells' init           → e.g. read the rows into a cell
 5. live                           → refs become "live"; listeners and tasks start
```

```ts
host.serve(Index, ({ session }, _host, self) => {
	const db = self.resource("db", { version: 1, open: () => openSqlite(indexPath(session)), close: (db) => db.close() });
	return {
		search: async ({ query }, ctx) => db.value.all("SELECT entryId, text FROM fts WHERE fts MATCH ?", [query]),
	};
});

host.serve(Chat, ({ session, conversation }, principal, self) => {
	const index = self.get(Index, { session });  // a placeholder until Index is live
	return {
		variant: "participant",
		find: async ({ query }, ctx) => index.search({ query }, ctx),  // only ever runs once Chat (and Index) are live
		// ...
	};
});
```

**Rules:**
- Inside the factory, never use what you declared: `db.value` and `index.someState.value` throw `not_ready`, and calling a reference throws. Use them in methods, listeners, tasks and `init`.
- **The object goes live only with its references ready**: live, and (for a remote reference) every state member of its variant hydrated. The same holds for state it forwards or derives from a remote reference it holds some other way: it goes live once that state has its value. A reference that is not ready after the host's `readyTimeout` (default 60 s) fails the activation with `unavailable/ready_timeout`; a reference cycle across hosts ends that way instead of hanging.
- **Concurrent `get`s** of one address share one activation, so the database opens once.
- **Failure propagates:** if `openSqlite` throws, `Index` fails, `Chat` fails with that cause, and every waiting `get` rejects. The next `get` tries again.
- **Abandoned activations:** if everyone releases before activation finishes, the result is disposed.

### Startup readiness and parent admission

`await host.load(facets)` and `await host.install(facet)` wait for the `lifetime: "host"` objects they install to
become live: resources are open, declared references are live, and registrations are published. All facets in a load
are installed before activation is awaited, so a host object can use a provider in a later facet. Referenced objects
are created only when something references them. Factory, dependency and resource errors reject startup with the
reference's activation error; host object failures also reach `onError`. Installation is not rolled back on failure: close the host
when abandoning startup. `install` registers synchronously, so setup/registration errors still throw synchronously.

`await host.ready()` waits for the host objects present when called, including direct
`host.serve(..., { lifetime: "host" })` and previously deferred loads. It is an activation barrier, not a continuous health check, a wait for tasks to
finish. Later installations require another readiness wait.

A worker may need to open its local Harness and announce control readiness **before** the parent accepts its link.
A host object reporting to the server's SessionStatus cannot become live before that acceptance. Awaiting the
whole load before announcing control readiness would deadlock. Defer the whole barrier explicitly:

```ts
// Connect the upstream link first; its outgoing references can queue until the parent accepts it.
await worker.load(workerFacets, { awaitHostObjects: false });  // also supported by install
const harness = await worker.get(Harness, {});        // local bootstrap only; no upstream dependency
announceControlReady();                               // parent can now accept the worker link
await worker.ready();                                 // every host object live, including upstream references
harness.release();
```

`awaitHostObjects: false` still starts every host object; it skips waiting, not activation. There is no
automatic classification of upstream dependencies. Choose a local bootstrap reference with no upstream dependency,
connect before loading upstream consumers, and let the parent admit the link before the full barrier. Control
readiness means admission is possible, not that every host object is live. Keep worker bootstrap counted as busy
until the full barrier settles, and report a later failure through the worker's fatal/startup-error path. Never await a
reference whose object needs the parent (a remote one, or a local one that holds one) before the parent admits the link.

To hand out a native object a resource opens (a local type's `opaque` member), expose the resource. References read its value once the object is live, and `undefined` before:

```ts
host.serve(Harness, (_, _host, self) => {
	const durable = self.resource("durable", { version: 1, open: () => DurableHarness.open(storage), close: (h) => h.close() });
	return { harness: self.expose(durable) };  // contract member: harness: opaque<DurableHarness>("pi.durable-harness@1")
});

const harness = await ctx.get(Harness, {});
harness.harness.resume();  // the DurableHarness itself
```

## Principals and variants

The application defines its principals and how they're keyed. Chord invents none: the app gives every principal a
request can act as.

```ts
type Principal =
	| { kind: "owner"; access: "local" | "relay" }
	| { kind: "guest"; id: string; name: string; session: string; mode: "view" | "full"; revision: number }
	| { kind: "worker"; session: string; generation: number }
	| { kind: "server" }   // the parent's own requests, as a worker sees them
	| { kind: "host" };    // a host's own code

const host = createHost<Principal>({
	name: "server",
	self: { kind: "host" },
	principalKey: (p) =>
		p.kind === "owner" ? `owner:${p.access}` :
		p.kind === "guest" ? `guest:${p.id}:r${p.revision}` :
		p.kind === "worker" ? `worker:${p.session}:${p.generation}` :
		p.kind,
});
```

- `createHost<Principal>` types every factory's `principal`, `ctx.principal`, routes, `accept` and
  `invalidatePrincipal` patterns, so code narrows on `kind` without casts. Facet modules say it too:
  `defineFacet<Principal>((api) => …)` (an app usually exports its own `defineFacet` and `Ctx` aliases). Without a type
  argument, principals are `unknown`.
- There is one object per principal key: two tabs of the owner share an object, and a guest gets its own.
- Code inside a host acts as `self`, so internal objects are shared. A principal with the same key as `self` is the
  host's own, whichever object carries it.
- A link stamps the principal of whatever connects to it. Callers can never supply their own.
- A child host names what its parent's own requests act as: `connect(link, { principal })` (or
  `upstream: { link, principal }`). Requests the parent relays act as the caller it forwards.
- A route names what the hosts it resolves act as when they call back: `route(prefix, { …, principal: (name) => … })`.

**A remote factory picks a variant:**

```ts
host.serve(Chat, ({ session, conversation }, principal, self) => {
	if (!canView(principal, session)) throw forbidden();
	const c = self.get(Conversation, { session, conversation });  // as host: one shared instance
	if (!canSend(principal)) return { variant: "viewer", view: c.view };
	const author = authorOf(principal);
	return {
		variant: "participant",
		view: c.view,
		send: async (input, ctx) => c.submit(input, author, ctx),
		stop: async (ctx) => {
			await c.stop(author, ctx);
		},
	};
});
```

```ts
const chat = await ctx.get(Chat, { session: "S1", conversation: 1 });  // on session:S1
if (chat.variant === "participant") showComposer(chat.send);  // narrows: `send` exists only there
else showReadOnly();
```

**What a variant doesn't do:**
- **It isn't complete authorization.** Methods still check their arguments: that a submission belongs to this conversation, or a session ID to this principal.
- **It doesn't cover flags that change while you hold the object.** Those are state, for example `you: { canDraw: boolean }`.
- **Revocation** is `host.invalidatePrincipal(match)`. It force-disposes matching objects, here and over links, and their references become `gone`. A new `get` runs the factory with the new grants.

Local types have no variants. Their only callers are inside the host, acting as its `self`. If a local object needs to know who's acting, pass that explicitly, like `author` above.

## References

| Where | API | Released |
| --- | --- | --- |
| a factory | `self.get(Type, input)`: synchronous; the object goes live after it is ready | with the object (or its replaced declaration) |
| a call | `await ctx.get(Type, input, { state? })` | when the call settles |
| outside Chord | `await host.get(Type, input, { signal?, state? })` | `ref.release()` |
| a UI runtime | `host.hold(Type, input)`: synchronous, possibly `loading` | `ref.release()` |

```ts
const chat = await ctx.get(Chat, input);  // ready: live, every state member of its variant hydrated
chat.status;  // "loading" | "live" | "released" | "gone"
chat.variant;  // the current variant; a multi-variant reference narrows on it
chat.shape;  // { variant, members, contract }
const send = chat.send;  // a stable function: always dispatches to the current code
chat.view.value;  // the current value, typed T
chat.view.subscribe((v) => render(v));
chat.onStatus((status, error) => { if (status === "gone") reconnect(error); });
chat.release();
```

- **A reference you hold is usable:** an awaited `get` resolves once the object is live and every state member of its variant has its first snapshot, local or remote. It rejects with the activation error (`forbidden`, unreachable, …), with `aborted` (a `ctx.get` whose ctx is aborted or whose call settles first; `host.get`'s `signal`), or with `unavailable/ready_timeout` after the host's `readyTimeout`. Only that reference is released then.
- **A held reference stays subscribed** to the state of its variant, with or without listeners, until it is released. After a link loss the last values stay readable while it re-holds (status `loading`).
- **Reading state before the first hydration throws `not_ready`** (a `hold` that is still loading, a member read inside a factory). A member outside the current variant throws `not_in_variant`; an ended reference throws its end (`released`, or the `gone` error). A listener added before the hydration gets its snapshot then.
- **`state: false`** gives a method-only reference: it receives no state (unless another reference to the same object wants it) and is ready once its object is live.
- **Calls on a `loading` reference wait** until it's live, respecting `ctx` cancellation and a deadline.
- A member missing from the current variant rejects with `not_in_variant`.
- After `release()`, every member rejects with `released`.
- **`gone`** means the object was forced away while referenced: revocation, archive, its host dying. Call `get` again, or show "unavailable". `onStatus` reports every status change (`live`, `loading` while a link reconnects, `released`, `gone` with the error), so a UI needn't poll.
- **References to one remote object share one binding** per host and key (type, normalized input, principal key, contract fingerprint): one hold over the link, one stream per state member, calls over the same hold. Each reference keeps its own status, observers and `release`. With `createHost({ linger: { types: { [typeName]: ms }, cap } })`, a binding whose last reference is released stays held (and hydrated) for `ms`, at most `cap` (default 4) at a time, so taking the reference again costs nothing on the link.
- **Return values are values.** Anything long-lived you want to share is an object you reach with `get`.

## State

```ts
const todos = self.state("todos", Type.Array(TodoSchema), []);

todos.change(ctx, (draft) => {
	draft.push({ id: "t1", text: "Write docs", done: false });
});
todos.change(ctx, (draft) => {
	draft[0].done = true;
});
todos.replace(ctx, []);

todos.value;  // immutable
todos.subscribe((value) => render(value));

// mirroring an external immutable store: subscribers get a diff, not the whole value
view.replace(ctx, conversation.view);                    // diffs when the new value reuses old containers
view.replace(ctx, rebuilt, { diff: true });              // always diff
```

- A `change` is atomic: one revision, or nothing if the callback throws.
- `change` only touches the paths you mutate, so fields your code doesn't know about survive. Use `replace` only where your code owns the whole value.
- Values are immutable. Never mutate what you read or receive.
- Remote references get a snapshot of each state member of their variant, then deltas. After a reconnect or a reload they get a `reset` snapshot, and nothing is replayed.
- `replace` sends a structural diff when the new value shares containers with the old one (a new revision of the same state), and a single replacement otherwise. `{ diff: true | false }` forces either. The value is the same either way.
- An implementation may expose another object's state member as its own: `return { variant: "viewer", view: conversation.view }`. The object goes live only once that member has its value, local or remote.

**A cell whose first value comes from a source** declares `{ init }` instead of an initial value:

```ts
const db = self.resource("db", { version: 1, open: () => openSqlite(path), close: (db) => db.close() });
const notes = self.state("notes", Type.Array(NoteSchema), { init: () => db.value.all("SELECT * FROM notes") });
```

`init(ctx)` runs once the resources are open and the references live, before the object goes live, so no method,
listener, task or subscriber sees a value that did not come from the source. A task that loads the value instead
starts only after the object is live: a method called in between answers from the placeholder (a note that exists
reads as unknown), and an async load can overwrite a write made during its `await`. `init` may be async and gets a
`ctx` to call other objects. The `init`s of one object run in parallel, so one must not read another's cell. A throw or
an invalid value fails the activation. A reload keeps the cell and its value and does not run `init` again; a cell the
reload adds runs its `init` while the reload prepares, and a failure refuses the reload.

`init` reads a source the object has anyway. It saves nothing: what must outlive the process is written to that source
(a database, a file, a Durable document) by the code that changes it.

```ts
const visible = self.derive([catalog.rows], (rows) => rows.filter((r) => visibleTo(principal, r)));
const openCount = self.derive([todos], (t) => t.filter((x) => !x.done).length);
```

Derivation functions are synchronous. A derivation has no name: every reload makes a new one, computed when the
reload commits.

## Calls, ctx and roots

Every method gets `(args, ctx)`, or `(ctx)` when it takes no arguments. Pass `ctx` on to everything you call:

```ts
send: async (input, ctx) => {
	ctx.signal.throwIfAborted();
	const uploads = await ctx.get(Uploads, {});  // a reference owned by this call; released when it settles
	const files = await uploads.resolve({ ids: input.uploads }, ctx);
	return c.submit({ ...input, files }, author, ctx);
},
```

A **root** is a short tree of calls, started at ingress:
- by a link, for a request that arrives without one;
- by `host.root(fn)`, for timers and scripts;
- by each event delivered to a listener (`self.on`);
- by each Chord call made from a `task` or a Durable phase.

A root runs on the code that was current when it started (its **code version**), across hosts, until it ends. Keep roots short. Long-running work is a `task`, and long waits are state.

```ts
// wrong: holds a root (and its version of the code) open for minutes
approve: async (ctx) => waitForHuman(ctx),

// right: record the request as state; the answer is a separate call
request: async (req, ctx) => {
	pending.change(ctx, (d) => {
		d.push(req);
	});
},
answer: async ({ id, value }, ctx) => {
	pending.change(ctx, (d) => {
		settle(d, id, value);
	});
},
```

## Lifetime

An object lives while it's **referenced**, and every reference has an owner:

| Owner | Acquired with | Released when |
| --- | --- | --- |
| another object | `self.get` | that object is disposed, or no longer declares it |
| a call | `ctx.get` | the call settles |
| a connection | a remote host's `get` | release, disconnect, revocation |
| the host | `lifetime: "host"` | host shutdown (or a reload removing its facet) |
| UI | `useObject` | unmount |

- **Disposal** runs after the last reference is released, plus `linger`. Tasks are aborted, listeners removed, resources closed in reverse order (every close runs, and errors are collected), then the object's own references are released, which can dispose further objects.
- **A resource's `close` may still use the objects its object references.** That holds for host shutdown and revocation too: `host.close()` and `invalidatePrincipal` dispose referrers before what they reference, and close links last. Bound remote calls in `close` with a signal: a call over a link that is already down waits for a reconnect.
- **Forced disposal** (revocation, archive) makes references `gone` at once and aborts in-flight calls.
- **References must not form cycles.** Inside one host this is checked at `get`.

```ts
host.serve(Conversation, conversationFactory, { linger: 30_000 });  // switching back quickly doesn't reopen its watch
host.serve(Index, indexFactory, { lifetime: "host" });              // one object from load to host shutdown
```

**`lifetime: "host"`** is for local types with an empty input (or only defaults): the type has exactly one object,
created for the host principal when its facet loads. Every `get` reaches that object, whoever asks; a `get` with
another input is invalid. References others hold do not change its lifetime, and it cannot `linger`. Only such
objects may register into registries. TypeScript refuses `lifetime: "host"` for a remote type, for an input with a
required field and together with `linger`; `serve` checks the same at runtime, for callers without types.

## Registries

```ts
export const Routes = defineRegistry<RouteHandler>("http.routes", { conflict: "error" });

// contribute (only from `lifetime: "host"` objects)
host.serve(Downloads, (_, _host, self) => {
	const blobs = self.get(Blobs, {});
	self.register(Routes, {
		"GET /download": async (request, who, ctx) => {
			const file = await blobs.find({ id: request.query.id }, ctx);
			if (!canView(who, file.session)) return forbidden();
			return stream(file, ctx);
		},
	});
	return {};
}, { lifetime: "host" });

// consume: a request sees the table of its own code version
server.on("request", (req, res) =>
	host.root(async (ctx) => {
		const route = host.registry(Routes).get(`${req.method} ${pathOf(req)}`, ctx);
		return route ? route(req, principalOf(req), ctx) : notFound(res);
	}),
);
```

- Each code version has one complete table. A reload never leaves a moment where an entry is missing.
- A request that started before a reload keeps using the old table.
- Order is first-registration order and survives replacement.
- `conflict: "error"` makes a duplicate key fail the registration (or the reload).

## Plugins

A plugin is a feature with one **facet** per host kind:

```text
plugins/chat/
  contract.ts    Chat, Conversation, Drafts
  server.ts      facet for the server
  worker.ts      facet for session workers
  web.tsx        facet for browsers
```

```ts
// plugins/chat/worker.ts
import { defineFacet } from "@earendil-works/chord";
import { Chat, Conversation } from "./contract.ts";

export default defineFacet((host) => {
	host.serve(Conversation, conversationFactory, { linger: 30_000 });
	host.serve(Chat, chatFactory);
});
```

```ts
// a host loads the plugins' facets for its kind
await host.load([
	new URL("../plugins/chat/worker.ts", import.meta.url),
	new URL("../plugins/status/worker.ts", import.meta.url),
]);
```

Built-in plugins are trusted code from this repository and load directly from source.

The facet's `setup` argument is its host, scoped to what a plugin needs: `serve`, `name`, `root(fn)`, `registry(R)` and `signal`, which aborts once this run of the facet is no longer installed (a reload replaced or removed it, or the reload that loaded it aborted). Code that is not a Chord method, listener or task (Durable tools and hooks, callbacks of native libraries) keeps it to start roots and read registries, instead of reaching for a process-global host:

```ts
export default defineFacet((host) => {
	host.serve(Sessions, sessionsFactory);
	tools.register("rename_session", (args) =>
		host.root(async (ctx) => (await ctx.get(Sessions, {})).rename(args, ctx)),
	);
});
```

## Hot reload

```ts
await host.reload([new URL("../plugins/chat/worker.ts", import.meta.url)]);  // or reload every changed plugin
```

### What happens

1. **Load** the new modules.
2. **Prepare:** run the new factories over the existing objects, without side effects. Cell writes throw, listeners and tasks don't start, registrations are collected, and changed resources are opened next to the old ones. Contracts are checked against every live consumer. Any failure leaves everything as it was.
3. **Gate:** only if a cell's version was raised or an exclusive resource changes.
4. **Commit:** in one synchronous step, install the new code, swap registry tables, restart tasks, rebind listeners, and send `reset` and shape updates to subscribers.
5. **Retire:** old code keeps running the roots it started. Once they end, it's dropped, along with whatever it alone declared. If they are still running when the next reload starts, that reload waits up to `retireDeadline`, then aborts them (their `ctx.signal`) before it closes what only the old code used.

### Compatible changes: no waiting

Bug fixes, new methods, new cells, new resources and registration changes all switch immediately. A root that started on the old code finishes on it, and new roots get the new code.

### Changing what state looks like or means: bump the cell's version

```ts
// v1: { running, tasks } where tasks counted phases
// v2: tasks counts tasks, and usage is new
host.serve(StatusStore, ({ session }, _host, self) => {
	const status = self.state("status", StatusV2, { running: false, tasks: 0, usage: emptyUsage() }, {
		version: 2,
		migrate: (old, from) => (from < 2 ? { running: old.running, tasks: 0, usage: emptyUsage() } : old),
	});
	return {
		status,
		report: async (s, ctx) => {
			status.replace(ctx, s);
		},
	};
});
```

At the gate, for each live `StatusStore`:
1. **Roots already inside finish.** Their re-entrant calls are let in.
2. **Old roots that haven't touched it yet get `upgrade_conflict`** instead of old code over migrated state. They retry as a new root.
3. **`migrate` runs** on a private copy, and the result is validated against the new schema.
4. **Commit.** New roots use the new code and the migrated state.

If the roots inside don't finish within the deadline (5 s), the reload is **aborted** and nothing changes. The error names the blocking roots.

The version belongs to the cell (default 1); other cells of the object are not migrated. The runtime compares each
cell's schema and version between old and new code:
- unchanged: compatible;
- version raised: migrate (without `migrate`, the value is kept and must fit the new schema);
- schema changed **without** a raised version, or a lowered version: the reload is refused.

A change of meaning with an identical schema needs a bump too. Nothing can detect that one for you.

### Resources

```ts
const db = self.resource("db", { version: 2, open: () => openSqlite(path, { wal: true }), close: (db) => db.close() });  // 1 → 2: reopen
const port = self.resource("port", { version: 1, exclusive: true, open: () => listen(8787), close: (s) => s.close() });
```

- A reload keeps a resource's open value unless its `version`, `deps` or `exclusive` change: `open` doesn't run
  again. The version is required: a native value has no schema to detect a change. The kept resource still takes the
  new code's declaration at the commit, so a later `close` is the new one.
- A changed resource opens next to the old one during prepare. The old one is closed with its own `close` once the
  old code retires.
- An `exclusive` resource can't exist twice, so it's swapped at the gate: close the old one, open the new one, and reopen the old one if that fails.

### Contract changes

| Change | What happens |
| --- | --- |
| Additive, same version | reloads; consumers keep working |
| Breaking, version bumped, with `accepts[old]` | reloads; old consumers go through the adapter |
| Breaking, without an adapter | refused, unless the consumers reload in the same batch |
| Breaking, version not bumped | refused: "consumer needs member …" |

The host's own **reference to a `lifetime: "host"` object** is a lifecycle pin, not an old-version consumer. When a reload replaces
its provider, that reference adopts the new contract at commit; it does not require an `accepts` adapter for itself.
The object, cells and unchanged resources stay alive without reactivation. A refused reload keeps the original
reference and contract. Other references (`self.get`, `ctx.get`, `host.get`, peers) still obey the compatibility rules above;
state-version bumps and migrations are still required when stored state changes.

### Several plugins at once

Reload them together: `host.reload([a, b])`. Prepare sees all new code at once, so a changed contract and its updated consumer check against each other.

On the server, `host.reload(serverFacets, { remote: { "session:": workerFacets } })` reloads every connected worker too. Its report covers the server; `report.children["session:S1"]` says what each worker changed, prepared and gated.

## Hosts and links

```ts
// server
const server = createHost<Principal>({ name: "server", self: { kind: "host" }, principalKey });
server.accept(webSocketLink(wss, { principal: (req) => authenticate(req) }));  // stamps owner or guest from cookies
server.route("session:", {
	authorize: (principal, host) => canReach(principal, host),  // before resolving or spawning
	resolve: (host) => workers.ensure(host),  // a link to the worker, spawned if needed
	principal: (host) => workers.principal(host),  // what the worker acts as when it calls the server
});

// worker
const worker = createHost<Principal>({
	name: `session:${id}`,
	self: { kind: "host" },
	principalKey,
	upstream: { link: ipcLink(process), principal: { kind: "server" } },  // the server's own requests act as this
});

// anywhere
const chat = await ctx.get(Chat, { session: "S1", conversation: 1 });  // browser → server → worker session:S1
const sessions = self.get(Sessions, {});  // `hostNamed("server")`: worker → server, acting as worker{S1}
```

- **The server relays** between its children: worker to worker, and browser to worker.
- **Disconnects:** when a browser disconnects, exactly the references it had in workers are released.
- **Principals across links:**
  - a forwarded principal is accepted only from the parent link;
  - calls an object makes itself act as its host;
  - links ping, and a dead link releases everything held through it.
- **Client origins:** a hold that comes from a browser carries an opaque id of its connection (`origin`), forwarded by the server when it relays the hold, so a worker can tell its clients apart. A client cannot set it. A disconnect releases that client's holds at once.
- **Slow peers:** a peer acknowledges what it processed. While a window (`window`, default 256 KiB) of frames is unacknowledged, state waits and is coalesced per member's stream; calls, results and the first snapshots of a new reference are never held back, so a `get` does not wait behind other references' state. Waiting ops are capped per link (`pendingCap`, default four windows): beyond, the oldest streams are replaced by their current value. So under load a result can arrive before the state change it caused: wait for the state you need instead of assuming it is there when the call returns.
- **Reloads across hosts:** the server coordinates prepare and commit for every host.
- **Workers that start behind** (spawned after a reload) are caught up to the server's code version before anything is routed to them. Calls their roots make to the server meanwhile run in the server's current code version instead of failing `superseded`.
- **Protocol version:** both ends announce the link protocol version in their hello. A peer of another version is not
  talked to: the link closes, and `onProtocolMismatch` (a `LinkOptions` field of `connect` and `accept`) tells the
  side that has to load new code. A browser reloads its page instead of reconnecting:

  ```ts
  host.connect(webSocketLink(socket), { onProtocolMismatch: () => location.reload() });
  ```
- **Browsers** don't take part in commits. They learn about new code through shape and `reset` messages, and an incompatible contract makes their calls fail with `upgrade_required`.

## Durable

A worker's host provides the Durable Harness as a local object of lifetime `"host"`. A Durable phase isn't a root: it's pinned to its registry snapshot by Durable itself. Each Chord call a hook or tool makes starts a fresh short root.

```ts
host.serve(Harness, (_, _host, self) => {
	const durable = self.resource("durable", {
		version: 1,
		open: () => DurableHarness.open(storage, { models, registry: durableRegistry(host, Extensions) }),  // a reader over the code version tables
		close: (h) => h.close(),
	});
	return { conversation: (id: number) => durable.value.conversation(id) };
}, { lifetime: "host" });

// a plugin contributes a Durable extension like any registration
host.serve(Guard, (_, _host, self) => {
	self.register(Extensions, {
		guard: defineExtension({
			name: "guard",
			hooks: [hook(ToolTask, { beforeTool: (call) => (isDangerous(call) ? { block: "Needs approval" } : undefined) })],
		}),
	});
	return {};
}, { lifetime: "host" });
```

A reload changing the guard: Durable phases already running keep the old snapshot, the next phase uses the new one, and there's never a phase without a guard.

## Errors

| Code | Meaning |
| --- | --- |
| `forbidden` | The factory or a method refused this principal |
| `invalid` | Input, arguments or a result failed validation |
| `not_ready` | A declared resource or reference was used inside a factory, or state read before its reference's first hydration |
| `not_in_variant` | The member doesn't exist in the variant you have |
| `released` | The reference was released |
| `gone` | The object was forced away while referenced. Call `get` again. |
| `contract_mismatch` | The provider's contract doesn't cover the consumer's, and no adapter exists |
| `upgrade_conflict` | An old root reached an object migrated meanwhile. Retry as a new root. |
| `superseded` | The root's code version is no longer available on this host. Retry. |
| `upgrade_required` | A browser's contract is outdated. Reload its web facets. |
| `unavailable` | The target host can't be reached or started; reason `ready_timeout`: a reference was not ready within `readyTimeout` |
| `aborted` | The call's `ctx` was cancelled |

## Rules of thumb

| Do | Not |
| --- | --- |
| Keep reloadable state in cells | Closure variables (lost on reload) |
| Bump the cell's version, with `migrate`, when a cell's shape or meaning changes | Changing a schema without a bump (refused) or a meaning without a bump (silent) |
| Bump the contract version on breaking changes; add `accepts` for old consumers | Renaming or removing members at the same version (refused) |
| Do slow setup in a resource's `open` | Awaiting inside the factory (it's synchronous) |
| Do side effects in resources, listeners, tasks and registrations | Effects in the factory body (they run during prepare) |
| Use `ctx.get` inside methods | `self.get` inside methods (a new reference per call) |
| Keep roots short; long waits are state | Awaiting a human inside a method |
| Check arguments in methods | Treating the variant as all of authorization |
| Pass `ctx` everywhere | Starting background work with the caller's `ctx` (use a task) |
| Treat state values as immutable | Mutating what you read |
