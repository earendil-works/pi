---
title: p3 step 0: the skeleton
cover: p3 / Skeleton
kicker: A spec · p3 step 0 · 2026-11-06
subtitle: The smallest p3 that is already p3: sign in, start a session, send a message, watch the reply stream in, and keep all of it through a page reload, a plugin reload and a server restart
stats:
  - 4 | built-in plugins (harness, fake model, sessions, chat)
  - 2 | host kinds: the server and one worker per session
  - 3 | registries the API declares for the worker, 2 for the page
  - 1 | Chord kit addition needed (decision 1)
note: |
  The spec of p3's first step, written for the owner and two reviewers before anything is built. p3 is built tabula
  rasa on the Chord v2 app kit (`packages/chord/src/node/app/`), on branch `p3` in `apps/p3/`. Every Chord name used
  here exists in the code on the branch, except what decision 1 proposes (marked). Decisions the owner has not taken
  are marked **Decision needed** and listed in the last chapter; review notes mark points found while checking the
  sources.
colophon: p3 step 0 · spec, first edition · 2026-11-06 · sources: Chord design.md §3-§24, decisions 2026-11-01..06, the app kit and example 61, pi-durable spec §2.2, §7.1, §9.3
---

# Before we begin {.preface}

Mario is on the bus with his phone. p2 is running on it as always, on port 8788. Next to it, from the same checkout's
`p3` branch, `node apps/p3/start.ts` prints an owner link for port 8789. He opens it, the page signs him in and shows an
empty session list. He taps **New session**: a row appears at once and the chat opens. He types "hello" and sends; the
message is in the transcript before the worker has even started, and a moment later "You said: hello" streams in, word
by word, from a fake model. He pulls to reload the page: everything is there. On slayer an agent edits the chat plugin
and applies the change: the page keeps its scroll and the half-typed message, the transcript stays. Mario restarts the
server: the list, the session and its transcript come back.

That is all step 0 does, and it is enough to carry everything after it. Each piece is the shape the later steps fill:
the harness that will run real models and tools, the registries real providers and tools contribute to, the catalog
that will hold hundreds of sessions, the page's slots that every UI plugin uses. Built small and right now, step 1
(real models) is one plugin and no base code.

The obvious way to get there is to port p2's worker: its `workerCore` opens the harness in base code, threads the
store and `host.root` through closures, and keeps its own keep-alive counter. The owner rejected that path: p3 uses
Chord and its app kit as designed, puts everything but the API and the start scripts into plugins, and carries over no
p2 internals. The one place where the kit does not reach far enough for that (a plugin cannot get its host's store) is
decision 1.

## Eight things to know

:::findings
1. **Base code is four files.** `start.ts` calls the kit's `startServer`, `worker.ts` calls `startWorker`, the API
   package `@p3/app` declares the vocabulary, and a thin web entry draws two slots. Everything else is a plugin in
   `apps/p3/plugins/`, reloaded without a restart.
2. **One worker per session, each with its own store.** The host kind `Session({ id })` is the kit's only worker kind;
   its store lives in `~/.p3/workers/session/<id>/store.sqlite` and holds the session's Durable records.
3. **The harness is a plugin.** A host-lifetime object in the `harness` plugin opens Durable paused on the session's
   store, serves the `Extensions` and `ModelProviders` registries and resumes once every plugin is loaded.
4. **The kit must hand plugins their host's store.** Durable's `StoreStorage.open(store, ...)` needs the store, and
   tools need `host.root` for `chord(fn, context)`; today only base code has both. Decision 1 proposes a kit registry
   `HostRuntime`, plus `KeepAlive` so running agent work keeps its worker alive.
5. **The catalog is a server table.** The `sessions` plugin keeps one row per session in a table of the server's store
   and shows the newest 200 live; the owner's view creates sessions, each worker's view reports its own title and
   status. Reports from an older worker incarnation are ignored.
6. **The worker pushes, the server never pulls.** The session's title is the worker's data, set from the first message
   inside `send` and pushed before `send` answers; the working status is pushed by a routine.
7. **The page is optimistic.** A new session's row and a sent message appear at once with React's `useOptimistic`;
   Chord's rule that a call's answer follows its state swaps in the real values without a flicker.
8. **A fake model is the first model provider.** The `fake-model` plugin contributes one pi-ai provider, `fake`, whose
   model `echo` streams "You said: ..." back; step 1 adds real providers the same way.
:::

## Words used throughout

A **session** is one agent workspace: a catalog row on the server and a worker process with its own store. The
**server** is the one Chord host every client connects to; a **worker** is the host at `Session({ id })`, started by
the first reference to it and stopped after five idle minutes. A **plugin** is a directory of facets (`server.ts`,
`worker.ts`, `web.tsx`); **base code** is what only a restart changes. The **API** is the workspace package `@p3/app`,
whose version `v1` plugins import (`@p3/app/v1`, `/v1/server`, `/v1/worker`, `/v1/web`). A **registry** is an owner's
extension point: one contribution per plugin, composed by the plugin that serves it. The **harness** is Durable's
`Harness` on a session's store, owned by the Chord object `Harness`. The **root conversation** is the session's one
Durable conversation in step 0 (`ROOT_CONVERSATION_ID`). The **catalog** is the server's table of sessions; its
per-principal view is `SessionList`. The **view** is Durable's `ConversationView`: a window of entries plus the
built-in documents (`pi.live` holds the run and the streaming answer).

# What Runs Where {#where lede="Three kinds of host, four plugins, and which object owns what."}

A phone browser tab, the server and one worker per session: the shape of every kit app. The tab is a client host (it
serves nothing remote and reaches workers only through the server). The server owns the catalog. Each worker owns its
session: the Durable records, the title, the transcript view.

:::flow wide | Step 0's hosts and objects. Arrows are references (who holds whom); accent marks what step 0 introduces beyond the kit.
row "Page (client host)" blue
box shell "web base" "`Sidebar` + `Screens` slots" muted
box listui "sessions web" "list, New session"
box chatui "chat web" "transcript, composer"
row "Server" accent
box kit "app kit" "sign-in, HTTP, workers, `HostRuntime`" muted
box store "SessionStore" "table `p3.sessions:sessions`" accent
box list "SessionList" "owner: create; worker: report" accent
row "Worker Session({ id })" accent
box harness "Harness" "Durable on the session store" accent
box meta "SessionMeta" "title, status, pushes" accent
box chatstore "ChatStore + Chat" "follows the view; send"
box fake "fake-model" "provider `fake`" muted
arrow listui -> list "useHold"
arrow chatui -> chatstore "useHold(Chat), relayed"
arrow list -> store "self.get"
arrow meta -> list "report (as the worker)" accent
arrow chatstore -> harness "HarnessNative"
arrow meta -> harness "HarnessNative"
arrow fake -> harness "ModelProviders"
note "A worker reaches the server over its parent link; the page reaches the worker through the server's route."
:::

## The files

```text
apps/p3/
  package.json              "@p3/app": exports ./v1, ./v1/server, ./v1/worker, ./v1/web; private
  start.ts                  base: startServer, prints the owner link
  worker.ts                 base: startWorker
  src/principals.ts         base: P3Principal
  src/api/v1/index.ts       base: shared API (Chord surface, defineFacet, Session, HostRuntime, KeepAlive)
  src/api/v1/server.ts      base: server API (Http, AppInfo)
  src/api/v1/worker.ts      base: worker API (Extensions, ModelProviders, HarnessNative, chord())
  src/api/v1/web.ts         base: web API (Sidebar, Screens, navigate, useRoute, React hooks)
  src/web/main.tsx          base: the page's entry: startPage, the two slots, the shell
  src/web/style.css         base: the shell's layout over the kit's theme variables
  plugins/harness/          worker.ts
  plugins/fake-model/       worker.ts
  plugins/sessions/         contract.ts, server.ts, worker.ts, web.tsx, messages.ts
  plugins/chat/             contract.ts, worker.ts, web.tsx, messages.ts
  test/                     the step's tests (chapter X)
  examples/00-skeleton.ts   a runnable walkthrough of the step
```

Every plugin passes the pluggability check: a third party could ship an alternative the same way. A different
harness serves the same registries (one provider per registry, so it replaces `harness`, not joins it). Another model
provider is another contributor to `ModelProviders`. Another session list or chat UI contributes to `Sidebar` or
`Screens`. The catalog is the one part others build on by contract (`SessionList`), not replace: a plugin that wants
other columns keeps its own table keyed by session id.

# Starting {#starting lede="The start script, the worker entry and the principal: what the kit gets from p3."}

The start script is the tutorial's `startTodo` with p3's values. It is base code: a change restarts the server.

```ts
// apps/p3/start.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "@earendil-works/chord/app";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { pageScripts } from "@earendil-works/chord/surfaces";
import * as v1 from "@p3/app/v1";
import { API, KINDS } from "./src/kinds.ts";
import type { P3Principal } from "./src/principals.ts";

const app = await startServer<P3Principal>(
	{
		name: "p3",                                            // ~/.p3 unless argv[2] names another directory
		dataDir: process.argv[2],
		root: fileURLToPath(new URL("./plugins/", import.meta.url)),
		listen: { host: "127.0.0.1", port: 8789 },             // p2 keeps 8788 (decision 3)
		api: API,
		kinds: KINDS,
		principal: { server: { kind: "server" }, worker: (address) => ({ kind: "worker", session: address.key }) },
		workers: [
			{
				kind: v1.Session,
				entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
				execArgv: ["--experimental-strip-types", "--no-warnings"],
				start: () => ({}),
				// Step 0 is the owner's alone; guests arrive with sharing (step 3).
				authorize: (principal) => principal.kind === "owner" || principal.kind === "server",
			},
		],
		web: {
			entry: fileURLToPath(new URL("./src/web/main.tsx", import.meta.url)),
			page: (request, assets) =>
				`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>p3</title>${pageScripts(assets, request.nonce)}</head><body><div id="root"></div></body></html>`,
			paths: ["/", "/s/:id"],
		},
		base: [fileURLToPath(new URL("./src/", import.meta.url)), fileURLToPath(import.meta.url)],
		onError: (error) => console.error("p3:", error.kind, error.error),
	},
	context,
);
console.log(`Open ${app.ownerLink()}`);
```

```ts
// apps/p3/worker.ts
import { startWorker } from "@earendil-works/chord/app";
import { API, KINDS } from "./src/kinds.ts";

startWorker({ api: API, kinds: KINDS, onError: (error) => console.error("p3 session:", error) });
```

`src/kinds.ts` holds `API` (`{ name: "@p3/app", versions: ["v1"], modules: { ... } }`) and `KINDS`: `server` and
`worker` on Node, `web` in the browser with React. The worker kind also lists `@earendil-works/pi-ai` and
`@earendil-works/pi-durable` as host packages, so plugins import them by name and every plugin shares the process's one
instance (decision 2).

The principal is the kit's minimum plus the worker:

```ts
// apps/p3/src/principals.ts
export type P3Principal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly session: string }       // the worker's address key, session|<id>
	| { readonly kind: "owner" };
```

Multi-user stays possible without changing anything here: a later `{ kind: "user", id }` variant is one more case in
`authorize` and in the views' factories.

## Signing in

The kit does it. Each start prints a one-time owner link, `http://127.0.0.1:8789/_chord/owner#<token>`, valid ten
minutes; its page posts the fragment's token and gets the owner's cookie (400 days, renewed on use). Every other route
and the `/chord` links endpoint answer 401 without a principal. Tests and command-line clients send the owner token file
`~/.p3/owner-token` as a bearer token. Remote access (Radius) and pairing stay as the kit has them; step 0 adds nothing.

# The API {#api lede="What plugins import, and the three registries a session's worker is built around."}

Plugins import only `@p3/app/v1` and its per-kind modules (and the host packages of their kind). The shared module
re-exports the Chord surface p3 supports, the way example 61's does, plus p3's own small part:

```ts
// apps/p3/src/api/v1/index.ts (p3's own part)
export const Session = hostKind("session", { id: str({ pattern: "^[0-9a-f-]{36}$" }) });

/** Defines a facet of p3: its factories get p3's principals. */
export function defineFacet(setup: (host: FacetHost<P3Principal>, self: FacetSelf) => void) {
	return chordFacet<P3Principal>(setup);
}

export type { P3Principal } from "../../principals.ts";
export { AppInfo, HostRuntime, KeepAlive, WorkerInfo } from "@earendil-works/chord/app";   // HostRuntime, KeepAlive: decision 1
```

The worker module declares the three registries a session's worker is built around. It declares them only (their
tokens); the `harness` plugin serves them.

```ts
// apps/p3/src/api/v1/worker.ts
import type { Provider } from "@earendil-works/pi-ai";
import type { Extension, Harness as DurableHarness } from "@earendil-works/pi-durable";

/** Durable extensions: one per contributing plugin (a writable when its tools change at runtime). */
export const Extensions = defineRegistry<Extension, readonly Extension[]>("p3.extensions", { version: 1 });

/** Model providers: one pi-ai provider per contributing plugin, composed into the session's `Models`. */
export const ModelProviders = defineRegistry<Provider, Models>("p3.model-providers", { version: 1 });

/** The session's open Durable harness, for objects that follow its views: `undefined` while none is open. */
export const HarnessNative = defineRegistry<Native<DurableHarness>, DurableHarness | undefined>("p3.harness", {
	version: 1,
});

/** A Chord call scope from any Durable context (design §24 Q6): `host.root(fn, context)` as the host. */
export function chord<R>(fn: (ctx: Ctx) => Promise<R>, context: Context): Promise<R> {
	const root = context.get(ChordRoot);
	if (root === undefined) throw new Error("chord(): no Chord host in this context (open the harness with one)");
	return root(fn, context);
}
```

`ChordRoot` is a context key of the API (`createContextKey`); the harness opens Durable with a base context holding the
host's root under it, so every Durable phase context (a tool's, a hook's) inherits it. Step 0 has no tools, so nothing
calls `chord()` yet; a test proves a Durable context from the harness reaches a Chord object through it.

The web module declares the page's two slots and a minimal router, and re-exports Chord's React hooks:

```ts
// apps/p3/src/api/v1/web.ts
/** A part of the sidebar: the session list in step 0. Ordered by plugin name. */
export type SidebarPart = { readonly name: string; readonly Component: ComponentType };
export const Sidebar = defineRegistry<SidebarPart, readonly SidebarPart[]>("p3.sidebar", { version: 1 });

/** A screen of the main area, by path pattern (`/s/:id`); the most specific match wins. */
export type Screen = { readonly path: string; readonly Component: ComponentType<{ readonly params: Readonly<Record<string, string>> }> };
export const Screens = defineRegistry<Screen, readonly Screen[]>("p3.screens", { version: 1 });

/** The page's path, followed (`popstate` and `navigate`). */
export function useRoute(): string;
/** Moves the page to `path` without a reload (`history.pushState`). */
export function navigate(path: string): void;

export { useHold, useHost, useMessages, usePageState, useRegistry, useWatch } from "@earendil-works/chord/react";
```

`Sidebar` and `Screens` are served by the page's own core facet in `src/web/main.tsx` (as example 61's `Panels`): the
slots are base code, what fills them is plugins.

:::review | Review: the model providers' shape is step 1's
The handoff leaves the providers registry's shape undecided. Step 0 takes the smallest one that runs: one pi-ai
`Provider` per plugin, composed with `createModels()` and `setProvider` (a second contribution with the same provider id
is reported and left out, the first by plugin name wins). Step 1 (real models, credentials as worker view state, the
server refreshing tokens) may change the contribution; the token's version moves then.
:::

# The Harness {#harness lede="Durable on the session's store, opened paused, resumed once every plugin is in."}

The `harness` plugin's worker facet serves the three registries and one host-lifetime object, `Harness`, which owns the
Durable harness as a native.

```ts
// apps/p3/plugins/harness/worker.ts
import { createModels } from "@earendil-works/pi-ai";
import { Harness as DurableHarness } from "@earendil-works/pi-durable";
import { StoreStorage } from "@earendil-works/pi-durable/storage/store";
import { ChordRoot, defineFacet, HostRuntime, KeepAlive, local, withContextValue } from "@p3/app/v1";
import { Extensions, HarnessNative, ModelProviders } from "@p3/app/v1/worker";
import { durableRegistry } from "./registry.ts";

/** The session's harness: one per worker, alive as long as the worker. */
const Harness = local("p3.harness", { version: 1, params: {}, members: {} });

export default defineFacet((host) => {
	host.serve(Extensions, { compose: (table) => table.map(({ value }) => value) });
	host.serve(ModelProviders, { compose: (table, { report }) => modelsOf(table, report) });
	host.serve(HarnessNative, { compose: (table) => table[0]?.value.value });
	host.serve(Harness, (_params, self) => {
		const runtime = self.registry(HostRuntime);
		const extensions = self.registry(Extensions);
		const models = self.registry(ModelProviders);
		// Running agent work keeps the worker alive (Durable says when it needs a process: `onWake`).
		const busy = self.writable(0);
		self.contribute(KeepAlive, busy);
		const harness = self.open(
			async (context) => {
				const { store, root } = runtime.value;
				const storage = await StoreStorage.open(store, "p3.durable", context);
				const opened = await DurableHarness.open(
					storage,
					{
						models: () => models.value,                         // read at each use: a reload swaps it
						registry: durableRegistry(extensions, context),
						onWake: (wake) => busy.set(wake.active ? 1 : 0),
						onReport: (report) => reportDurable(report),
					},
					// Tools and hooks reach Chord through `chord(fn, context)` (§24 Q6).
					withContextValue(ChordRoot, root, context),
				);
				// The root conversation, created once with the first model offered.
				await opened.root(context, { agent: { model: defaultModel(models.value) } });
				return opened;
			},
			(opened, _reason, context) => opened.close(context),
		);
		self.contribute(HarnessNative, harness);
		// Paused until every plugin of the worker is loaded, so recovered work finds its extensions (§24).
		self.onLive(async (ctx) => {
			await runtime.value.whenLoaded(ctx);
			harness.value.resume();
		});
		return {};
	});
});
```

The pieces, and why each is there:

- **`self.open`** keeps Durable a native of exactly one object (natives only in objects). It opens after the
  registries are usable (they are declared dependencies), closes when the object ends. A reload of the `harness`
  plugin restarts the object: the old harness closes at the seal, the new one opens on the same store and recovers
  what was running, as after a crash.
- **`StoreStorage.open(store, "p3.durable", context)`** puts Durable's records in the session's Chord store, beside the
  kit's `Files` (`chord.app.files:*`), claimed under the owner name `p3.durable`. One store per session, one commit
  line: a fork or export of the session is one archive.
- **`durableRegistry(extensions, context)`** is Durable's `RegistryReader` over the composed `Extensions` value: a
  snapshot made once per composed list (`createRegistry()`, each extension installed), and `subscribe` observing the
  registry value so the scheduler reconsiders blocked tasks when a contribution arrives. The tool_search fallback
  (install Durable's `tool_search` extension when deferred tools exist and code mode does not) belongs here; step 0 has
  no deferred tools, so it arrives with MCP (step 4).
- **`HarnessNative`** hands the open harness to other objects of the worker (chat, sessions), which follow its views
  with `self.follow`. Its compose takes the first contribution: there is one harness per worker.
- **Paused until loaded.** Durable opens with scheduling paused. Resuming in `onLive` alone would race other plugins:
  an extension contributed by another host-lifetime object may go live after the harness, and a recovered tool call
  would find no tool. `whenLoaded` resolves once the kit's `plugins.load` of the worker has resolved, the moment p2's
  base code called `resume()`.
- **`KeepAlive`.** The workers component stops a worker after five idle minutes, counting Chord references, jobs and the
  app's `busy`. A run the user walked away from has no references; without this count the worker would stop mid-run.
  Durable's `onWake` says whether the session needs a running process; the harness contributes that as a count.

## Decision 1: how a plugin gets what only base code has {#decision-1}

**Decision needed (Chord, the app kit).** The harness needs three things the kit keeps to base code: the host's store
(Durable's `StoreStorage.open(store, ...)` takes it), a root scope (`host.root`, for `chord(fn, context)`), and the
moment the worker's plugins are loaded (to resume). It also must keep its worker alive while agent work runs, which the
kit takes only as `startWorker({ busy })` from base code. The design's own rule says base code serves "one small
start-data facet serving process values (start data, the opened store) as core objects" (design §21, decision "The
plugin model ... (8)"); the kit built `AppInfo` and `WorkerInfo` but never the store, because no kit app had an adapter
owner like Durable's `StoreStorage`.

:::sequence | Today: the harness plugin cannot open Durable. Base code has the store and `host.root`; a plugin has neither.
actor kit "kit startWorker" "base code" muted
actor host "worker host" "Session({ id })"
actor harness "Harness object" "plugin harness" accent
kit -> kit: openStore(store.sqlite)
kit -> host: createHost({ store })
kit -> host: plugins.load(host, core: WorkerInfo, Files, ...)
host -> harness: factory: self.registry(?)
note harness: no store, no host.root, no "loaded"
harness --> host: cannot call StoreStorage.open(store, ...)
:::

**Recommended (A): two kit registries on every kit host.** `HostRuntime` (`chord.app.runtime`), served by the kit with
one value: `{ store, root(fn, context, options?), whenLoaded(context) }`, the host's store, its `host.root`, and a
promise that resolves once the kit's `plugins.load` resolved. `KeepAlive` (`chord.app.keep-alive`): host-lifetime
objects contribute a number or a watchable of one; the kit adds their sum to the worker's `busy` counts. Both are
generic (any kit app with an adapter owner or long work outside Chord needs them), small (a facet and a fold in
`startWorker`, the same on `startServer` for `HostRuntime`), and keep the harness a plugin.

:::sequence animate | With A: the harness opens Durable from a registry value and resumes after the load.
actor kit "kit startWorker" "base code" muted
actor host "worker host" "Session({ id })"
actor harness "Harness object" "plugin harness" accent
actor durable "Durable" "StoreStorage" muted
kit -> host: plugins.load(host, core: HostRuntime { store, root, whenLoaded }, KeepAlive)
host -> harness: factory: self.registry(HostRuntime), self.contribute(KeepAlive, busy)
harness => durable: open: StoreStorage.open(runtime.store), Harness.open(paused)
harness --> host: live: HarnessNative contributed
host --> kit: load resolved: whenLoaded resolves
harness => durable: onLive: resume()
durable --> harness: onWake { active }: busy.set(1)
:::

**Alternatives.** (B) `startWorker` takes app core facets (`core: (host, store) => facets`) and a `ready(host, ctx)`
hook: p3's base code then opens the harness itself, as p2 does. It works, but the harness becomes base code (a change
restarts the server) and every app with an adapter owner writes the same wiring again. (C) p3 skips `startWorker` and
writes its worker on `workerMain` like p2: duplicates the kit's layout, store and telemetry wiring, the opposite of
"use the kit".

Cost of A: about 60 lines in the kit (`runtime.ts`: the facet, the registries, the fold of `KeepAlive` into `busy`),
its tests, the README and design §23 updated; a Chord decision recorded in `packages/chord/docs/decisions.md` on main,
merged into `p3`.

:::note | Security
A plugin with the store can claim any owner name in it (claims refuse a second claimant, not a first). Plugins are
code in the worker's process and can already do anything there; `HostRuntime` adds no authority a server or worker
plugin does not have. Pages and terminals have no store and are not served it.
:::

# The Fake Model {#fake lede="The first model provider: a plugin, a registry contribution, nothing else."}

```ts
// apps/p3/plugins/fake-model/worker.ts
import { fauxAssistantMessage, type FauxResponseFactory, fauxProvider } from "@earendil-works/pi-ai";
import { defineFacet } from "@p3/app/v1";
import { ModelProviders } from "@p3/app/v1/worker";

export default defineFacet((_host, self) => {
	const fake = fauxProvider({ provider: "fake", models: [{ id: "echo", name: "Echo" }], tokensPerSecond: 40 });
	// One reply per request, queued again each time: the faux provider answers from a queue.
	const echo: FauxResponseFactory = (context) => {
		fake.appendResponses([echo]);
		return fauxAssistantMessage(`You said: ${lastUserText(context)}`);
	};
	fake.setResponses([echo]);
	self.contribute(ModelProviders, fake.provider);
});
```

A facet's contribution: no object, no native (the provider is a plain in-process value fixed for the plugin's life).
At 40 tokens a second a short reply streams for about a second, long enough to see it stream and to test a restart in
the middle of it. The harness's root conversation picks `fake/echo` because it is the first model offered; with no
provider at all the root's agent has no model and Durable records `no_model` on the first send, which the chat shows.

# The Session Catalog {#catalog lede="A table on the server, a view per principal, and workers that report their own sessions."}

The `sessions` plugin owns the list of sessions. Its contract is shared (the page and the worker both hold it):

```ts
// apps/p3/plugins/sessions/contract.ts
export const SessionRow = obj({
	id: str(),
	title: str(),                                     // "" until the first message
	status: oneOf(["new", "idle", "working"]),
	created: num(),
	updated: num(),
});

/** The session catalog as one principal sees it: the owner lists and creates, a worker reports its own session. */
export const SessionList = remote("p3.sessions", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		owner: {
			state: { sessions: arr(SessionRow) },
			methods: { create: method(obj({ id: str({ pattern: "^[0-9a-f-]{36}$" }) })) },
		},
		worker: {
			state: {},
			methods: { report: method(obj({ title: opt(str()), status: opt(oneOf(["idle", "working"])) })) },
		},
	},
});
```

On the server, one host-lifetime store object holds the table and a live query of the newest 200 by `updated`; the
views are what each principal may do with it.

```ts
// apps/p3/plugins/sessions/server.ts (abridged)
const Rows = defineTable("p3.sessions", {
	version: 1,
	columns: { id: str(), title: str(), status: str(), created: num(), updated: num(), incarnation: str() },
	key: ["id"],
	indexes: { by_updated: ["updated"] },
});
const NEWEST = query(Rows).orderBy((row) => row.updated, "desc");

const SessionStore = local("p3.sessions.store", {
	version: 1,
	params: {},
	members: {
		sessions: arr(SessionRow),
		create: method(obj({ id: str() })),
		report: method(obj({ id: str(), incarnation: str(), title: opt(str()), status: opt(str()) })),
	},
});

host.serve(SessionStore, (_params, self) => {
	const rows = self.table(Rows);
	const newest = self.query(rows, NEWEST, 200);
	return {
		sessions: self.derive([newest], ([list]) => list.map(publicRow)),       // mapShared: rows keep identity
		create: async ({ id }, ctx) => {
			const now = Date.now();
			// Idempotent: a retried create of the same id changes nothing.
			await self.tx(async (tx) => {
				if ((await tx.get(rows, { id })) === undefined)
					tx.put(rows, { id, title: "", status: "new", created: now, updated: now, incarnation: "" });
			}, ctx);
			return null;
		},
		report: async ({ id, incarnation, title, status }, ctx) => {
			await self.tx(async (tx) => {
				const row = await tx.get(rows, { id });
				// Unknown sessions are not listed; reports of an older worker incarnation are late and ignored.
				if (row === undefined || incarnation < row.incarnation) return;
				tx.update(rows, { id }, { incarnation, updated: Date.now(), ...(title === undefined ? {} : { title }), ...(status === undefined ? {} : { status }) });
			}, ctx);
			return null;
		},
	};
});

host.serve(SessionList, (_params, principal, self) => {
	const store = self.get(SessionStore, {});
	if (principal.kind === "worker") {
		const id = principal.session.slice("session|".length);
		return {
			variant: "worker",
			// The id comes from the principal the link stamped, the incarnation from Chord: neither is the caller's data.
			members: { report: (report, ctx) => store.report({ id, incarnation: ctx.incarnation, ...report }, ctx) },
		};
	}
	if (principal.kind !== "owner") throw forbidden("the session list is the owner's");
	return { variant: "owner", members: { sessions: store.sessions, create: store.create } };
});
```

Why each rule:

- **A table, not a document.** Anything listed, queried or paged is a table: a thousand sessions are a thousand rows,
  a change rewrites one row, and the live query sends the window's diff. A document holding the list would rewrite
  and diff the whole list on every status change.
- **200 live, the rest by page.** The live query needs a limit. Step 0 shows the newest 200; a `page({ after })` method
  for older sessions comes with archive and search.
- **The incarnation fence.** A worker that is stopping can report after its successor started (the idle stop, then a
  new hold within the drain). `ctx.incarnation` is the reporting host's incarnation, stamped by Chord from the link's
  handshake, never sent as data; incarnations are uuidv7, so a later start compares greater. A late "working" from the
  old process cannot overwrite the new one's "idle". (Design §25, "Reading without starting a worker".)
- **The worker's id from its principal.** The worker variant has no `id` argument: a worker reports only its own
  session, whatever its code sends.

## The worker side: title and status

The title and the working state are the session's data, so the worker owns them and pushes what the catalog shows.
The `sessions` plugin's worker facet serves `SessionMeta`:

```ts
// apps/p3/plugins/sessions/worker.ts (abridged)
const Meta = defineState("p3.sessions.meta", {
	schema: obj({ title: str() }), version: 1, initial: () => ({ title: "" }), persist: true, checkpointWhen: () => true,
});

host.serve(SessionMeta, (_params, self) => {
	const meta = self.state(Meta);
	const list = self.get(SessionList, {});                  // over the parent link: acts as this worker
	const harness = self.registry(HarnessNative);
	self.retryOn(harness);
	const view = self.follow((observer, context) => observeRoot(harness.value, observer, context, { min: 1, max: 1 }));
	const status = self.derive([view], ([v]) => (v.docs["pi.live"]?.run === undefined ? "idle" : "working"));
	// Pushed from where it changes: the first call reports the current status, later calls every change.
	self.on(status, async ({ value }, ctx) => {
		if (list.variant === "worker") await list.report({ status: value }, ctx);
	});
	return {
		title: meta,
		rename: async ({ title }, ctx) => {
			await meta.change((draft) => { draft.title = title; }, ctx);
			if (list.variant === "worker") await list.report({ title }, ctx);   // before the answer: the list is current
			return null;
		},
	};
});
```

`observeRoot` is a helper of the plugin: `harness?.observeConversation(ROOT_CONVERSATION_ID, observer, context,
window)`, `undefined` while no harness is open (the follow then fails the attempt `transient`, and `retryOn` wakes it
when the harness's contribution arrives). A window of one entry keeps this observer cheap: it reads only `docs`.

:::review | Review: a hold before the create
`authorize` cannot read the catalog (it is synchronous), so a hold of `Chat` for an id the catalog does not have starts
a worker and makes an empty store, whose reports the catalog ignores. The page never does this (chapter VIII holds
`Chat` only once the row is listed). Cleaning such stores belongs to the session lifecycle step (archive and delete);
a route-level check would need an asynchronous `authorize` or the workers component's `start` hook to reach the
catalog, both larger than this case.
:::

# Chat {#chat lede="One store follows the transcript; a view per principal sends and aborts."}

The `chat` plugin's worker facet follows the root conversation's view once, in a shared store, and serves the
per-principal `Chat` view (the pattern of design §6):

```ts
// apps/p3/plugins/chat/contract.ts
export const Chat = remote("p3.chat", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: {
		owner: {
			state: { view: unknown() },                       // Durable's ConversationView, JSON
			methods: { send: method(obj({ text: str(), requestId: str() })), abort: method() },
		},
	},
});
```

```ts
// apps/p3/plugins/chat/worker.ts (abridged)
host.serve(ChatStore, (_params, self) => {
	const harness = self.registry(HarnessNative);
	const meta = self.get(SessionMeta, {});
	self.retryOn(harness);
	const view = self.follow((observer, context) => observeRoot(harness.value, observer, context, { min: 50 }));
	return {
		view,
		send: async ({ text, requestId }, ctx) => {
			const root = await harness.value!.root(ctx);
			if (meta.title.value.title === "") await meta.rename({ title: firstLine(text, 80) }, ctx);
			// Resolves once Durable committed the input: it is in `view` (an entry, or queued in `pi.inbox` while a run
			// is busy) before this method answers.
			await root.submit({ type: "input", content: text, requestId, whenBusy: "followUp" }, ctx);
			return null;
		},
		abort: async (ctx) => {
			await (await harness.value!.root(ctx)).abort(ctx);
			return null;
		},
	};
});
host.serve(Chat, (_params, principal, self) => {
	if (principal.kind !== "owner" && principal.kind !== "server") throw forbidden("chat is the owner's");
	const store = self.get(ChatStore, {});
	return { variant: "owner", members: { view: store.view, send: store.send, abort: store.abort } };
});
```

- **Followed, never copied.** The transcript is Durable's; `self.follow` over `observeConversation` makes its view a
  Chord watchable without a second copy (decision "App authoring rules confirmed by the p2 audit"). Durable keeps one
  mount per conversation; chat's and sessions' observers share it.
- **The streamed answer** is the run's `pi.live` document in the view: each delta Durable commits is one view
  revision, one `state` message to the page. Nothing in p3 assembles a stream.
- **`requestId`** makes a retried send exactly-once (Durable's submission dedupe): the page makes one per message, so a
  send whose answer was lost in a reconnect and is sent again is admitted once.
- **Answers that follow their state.** `send` awaits the rename (whose push to the catalog the server commits before it
  answers the worker) and the submission (whose commit the follow publishes before `submit` resolves: Durable
  dispatches its observers before the waits a commit resolves, design §24). So when the page's call settles, the
  input is in its `view` and the title is in its `SessionList`: the optimistic values
  are replaced by real ones, never by old ones.

:::sequence animate | Sending the first message. The page's optimistic entry is replaced by the committed one, which arrives before the answer.
actor page "page" "chat web" blue
actor server "server" "relay + SessionList" accent
actor worker "worker" "Chat, SessionMeta"
actor durable "Durable" "root conversation" muted
page -> page: useOptimistic: show "hello" at once
page -> server: Chat.send({ text, requestId })
server -> worker: relayed (origin of the page)
worker -> server: SessionList.report({ title: "hello" })
server -> server: commit row; state for the page waits
server --> worker: result
worker => durable: root.submit(input)
durable --> worker: committed: view gains the user entry
worker --> server: state (view), then result
server --> page: its own state (title), the worker's state (view), then result
page -> page: transition ends: real entry and title shown
durable -> worker: generation streams into pi.live
worker --> page: one state message per revision (via server)
:::

# The Page {#page lede="A shell with two slots; the list and the chat are plugins; both feel instant."}

The web entry is the tutorial's with a layout: a sidebar and a main area, each filled from a registry.

```tsx
// apps/p3/src/web/main.tsx (abridged)
const core = defineFacet((host) => {
	host.serve(v1web.Sidebar, { compose: (table) => table.map(({ value }) => value) });
	host.serve(v1web.Screens, { compose: (table) => table.map(({ value }) => value) });
});

function Shell() {
	const sidebar = useRegistry(v1web.Sidebar) ?? [];
	const screens = useRegistry(v1web.Screens) ?? [];
	const path = v1web.useRoute();
	const match = bestMatch(screens, path);                       // most specific pattern wins
	return (
		<div className="shell">
			<nav>{sidebar.map(({ name, Component }) => <Component key={name} />)}</nav>
			<main>{match ? <match.Component params={match.params} /> : <Empty />}</main>
		</div>
	);
}

void startPage({
	connect: () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`),
	modules: { "@p3/app/v1": v1, "@p3/app/v1/web": v1web, react: React, "react/jsx-runtime": jsx },
	core: [{ name: "@p3/web", facet: core }],
	render: (host) => createRoot(document.getElementById("root")!).render(<HostProvider host={host}><Shell /></HostProvider>),
});
```

The look comes from the kit's themes (CSS variables); p3's own design (p2's look made great) is a later step's. The
shell's CSS is base code, a plugin's CSS is the plugin's.

## Creating a session

```tsx
// apps/p3/plugins/sessions/web.tsx (abridged)
function SessionsPart() {
	const list = useHold(SessionList, {});
	const rows = useWatch(list?.variant === "owner" ? list.sessions : undefined) ?? [];
	const [shown, addRow] = useOptimistic(rows, (current, row: Row) => [row, ...current]);
	const create = () =>
		startTransition(async () => {
			const id = crypto.randomUUID();                       // the page names it: no round trip before showing it
			addRow({ id, title: "", status: "new", created: Date.now(), updated: Date.now() });
			navigate(`/s/${id}`);
			if (list?.variant === "owner") await list.create({ id }, BACKGROUND_CONTEXT);
		});
	return (/* "New session" button, then shown.map(row => <SessionLink row={row} />) */);
}
```

The row and the chat screen appear in the same frame. The chat screen holds `Chat` only once the catalog lists the id
(it reads `SessionList` too), so no worker starts for a session the server has not committed; a message typed meanwhile
is shown optimistically and its `send` waits in the reference's parked calls until the hold binds (design §7).

:::sequence animate | Creating a session: the row and the screen at once; the worker starts on the first hold, after the server committed the row.
actor page "page" "sessions + chat web" blue
actor server "server" "SessionList" accent
actor workers "workers component" "kit" muted
actor worker "worker" "Session({ id })"
page -> page: addRow (optimistic), navigate(/s/id)
page -> server: SessionList.create({ id })
server -> server: commit row (status new)
server --> page: state (row), then result
page -> server: useHold(Chat, { session: id })
server -> workers: route Session({ id }): authorize, fork
workers -> worker: start: store, HostRuntime, plugins.load
worker -> server: SessionMeta: report({ status: idle })
worker --> page: Chat bound: view (empty transcript)
:::

## The chat screen

`plugins/chat/web.tsx` contributes `Screens` `{ path: "/s/:id", Component: ChatScreen }`: the transcript from `view.entries`
(user and assistant text; tool entries render as a placeholder until tools exist), the streaming answer from
`view.docs["pi.live"]`, a composer whose half-typed text is page state (`usePageState`, kept across a plugin reload),
Send and Stop. Sending:

```tsx
const [entries, addPending] = useOptimistic(view?.entries ?? [], (current, text: string) => [...current, pendingUser(text)]);
const send = (text: string) =>
	startTransition(async () => {
		addPending(text);
		setDraft("");
		await chat?.send({ text, requestId: crypto.randomUUID() }, BACKGROUND_CONTEXT);
	});
```

A rejected send leaves the draft empty and the pending entry gone; the screen shows the error under the composer with
the text restored. The transcript shows the window (the newest 50 to 100 entries); scrolling back through older
entries is a later step (`Conversation.entries()` pages, as Durable's `ConversationTranscript` does).

# Reloads and Restarts {#survive lede="What the person on the phone sees when each kind of change lands."}

Step 0 is done only when the session survives each of these, tested end to end:

| Event | What happens | What the page shows |
| --- | --- | --- |
| Page reload | the page's host reconnects; `SessionList` and `Chat` hold again and get snapshots | the same list and transcript; the composer's draft is gone (page state lives as long as the page) |
| Plugin reload, chat | the worker's `ChatStore` and `Chat` restart (old work finishes on old code, at most 5 s); the follow attaches to the same harness; the page's `chat` script reloads in place | the transcript stays; `loading` for a blink; the draft stays (`usePageState`) |
| Plugin reload, harness | the `Harness` object restarts: the old Durable harness closes at the seal, the new one opens on the same store and recovers running work (a generation in flight is re-run from its last checkpoint) | the transcript stays; a reply being streamed restarts or continues from its last commit |
| Plugin reload, sessions | `SessionStore` restarts on the server, its table kept; each running worker's `SessionMeta` restarts and reports its status again | the list stays |
| Worker idle stop | five minutes without references or running agent work (`KeepAlive` zero): the workers component stops it | the catalog keeps the last title and status; opening the session starts the worker again |
| Server restart | every worker stops with the server; on the next start the catalog is read from the server's store; a session's worker starts on its first hold and Durable recovers its run | the list at once; the transcript when the worker is up; an interrupted reply resumes |

:::note | A run when the server restarts
A session that was working when the server stopped has no worker after the restart until someone opens it, so its run
waits. Starting the workers of sessions that were `working` at shutdown, and waking sleeping tasks on time, belongs to
the workers' lifecycle in step 2 (hands), together with Armin's worker-start proposals.
:::

# Tests and Done {#done lede="What the build delivers and how each claim is checked."}

The build subagent works in its own worktree off branch `p3`, in the Chord code style (one concept per file, a doc line
per export, tagged unions, no defensive checks of typed values), and delivers:

1. **Decision 1 in the kit** (if approved as A): `packages/chord/src/node/app/runtime.ts`, tests in
   `packages/chord/test/node/app/`, the kit README and design §23; on main first, then merged into `p3`.
2. **The app**: the files of chapter I, `npm run check` clean at the root and in `apps/p3` (p3 gets its own `check`
   script and tsconfig like p2's).
3. **Plugin tests** with `testPlugin`: `sessions` on the server (create is idempotent; the owner lists, a worker
   reports only its own row; a report of an older incarnation is ignored; a non-owner is refused); `chat` on a worker
   with a stub harness (send submits once per `requestId`; the first send sets the title).
4. **App tests** (`apps/p3/test/`, the kit in one process, a client host over the links endpoint with the owner token,
   as example 61's step 7): create, send, the fake reply streams in at least two revisions; a second client sees the
   same list and transcript (page reload); `applyChanges` after editing the chat plugin keeps the transcript and a new
   send works; `applyChanges` after editing the harness plugin during a reply recovers it; `app.close` and
   `startServer` on the same data directory keep the list and the transcript and finish an interrupted reply.
5. **A browser test** (Chromium, `CHROMIUM_BIN`): the new row and the sent message are on screen in the frame after the
   click, before any answer (the server's answers delayed by a test hook in the transport).
6. **`apps/p3/examples/00-skeleton.ts`**: the walkthrough of the preface as a script printing each step (start, sign
   in, create, send, the streamed reply, a plugin reload, a restart), in example 61's format.
7. **On the phone**: started next to p2 with its own data directory and port; the owner's link opens it. Deploying it
   there goes through the phone dev session in an owner-started turn.

Two code reviewers (one adversarial, one against design.md and this spec) check the build; their fixes go in before
the commit on `p3`.

# Open Decisions {.epilogue lede="What the owner decides before the build starts, one at a time."}

Step 0 is the kit app of the tutorial, shaped as p3: a server with a catalog table, a worker per session owning a
Durable harness as a plugin, three worker registries and two page slots, a fake model, an optimistic page. Four
decisions are the owner's; the first blocks the build.

1. **How a plugin gets its host's store, root scope, load signal and keep-alive** (chapter IV): recommended A, two kit
   registries `HostRuntime` and `KeepAlive`; alternatives B (app core facets and a ready hook in `startWorker`) and C
   (p3 on `workerMain`, without `startWorker`).
2. **pi-ai and pi-durable as host packages of the worker kind** (chapter II): plugins import them by name, as web
   plugins import React; recommended, because re-exporting Durable's whole extension surface through `@p3/app/v1/worker`
   would copy its API into p3's and pin it to p3's versions. The alternative re-exports what p3 supports and nothing
   else (stricter, more upkeep per Durable change).
3. **Data directory and port**: `~/.p3` (the kit's default for the name `p3`) and 8789, next to p2's `~/.pi/p2` and
   8788. Recommended as is.
4. **The page names new sessions** (chapter VIII): `crypto.randomUUID()` on the page, checked by pattern and created
   idempotently on the server, so the row and the screen need no round trip. The alternative (the server names it)
   costs one round trip before navigating.

Not decided here, by design: the providers registry's final shape (step 1), the tool_search fallback (step 4),
paging the list and the transcript, the session lifecycle (archive, delete, cleaning stores of uncreated ids), waking
workers whose sessions were working at shutdown (step 2).

# Reference {.appendix}

## Contracts and registries

| Name | Kind | Where | Members |
| --- | --- | --- | --- |
| `Session({ id })` | host kind | API | the session's worker |
| `HostRuntime` (`chord.app.runtime`) | registry, kit (decision 1) | every kit host | `{ store, root, whenLoaded }` |
| `KeepAlive` (`chord.app.keep-alive`) | registry, kit (decision 1) | every kit worker | counts summed into `busy` |
| `Extensions` (`p3.extensions`) | registry | worker, served by `harness` | Durable `Extension` per plugin |
| `ModelProviders` (`p3.model-providers`) | registry | worker, served by `harness` | pi-ai `Provider` per plugin; value `Models` |
| `HarnessNative` (`p3.harness`) | registry | worker, served by `harness` | the open Durable harness |
| `Harness` (`p3.harness`) | local, empty params | worker | none: owns Durable |
| `SessionStore` (`p3.sessions.store`) | local, empty params | server | `sessions`, `create`, `report`; table `p3.sessions` |
| `SessionList` (`p3.sessions`) | remote | server | owner: `sessions`, `create`; worker: `report` |
| `SessionMeta` (`p3.sessions.meta`) | local, empty params | worker | `title`, `rename`; pushes status |
| `ChatStore` (`p3.chat.store`) | local, empty params | worker | `view`, `send`, `abort` |
| `Chat` (`p3.chat`) | remote | worker | owner: `view`, `send`, `abort` |
| `Sidebar` (`p3.sidebar`) | registry | page, base | `{ name, Component }` |
| `Screens` (`p3.screens`) | registry | page, base | `{ path, Component }` |

## Words

**Base code**: the API package, `start.ts`, `worker.ts`, the web entry; changed only by a restart. **Catalog**: the
server's table of sessions. **Harness**: Durable's agent runtime on a session's store, owned by the `Harness` object.
**Incarnation**: a host's run, uuidv7, stamped on calls by Chord. **Optimistic value**: what the page shows while a
call is pending, replaced by the real state when it settles. **Plugin**: a directory of facets, reloaded in place.
**Root conversation**: the session's Durable conversation with id `ROOT_CONVERSATION_ID`. **View**: Durable's
`ConversationView`, followed into Chord.
