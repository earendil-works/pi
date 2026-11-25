---
title: p3 step 0: hello, reloaded
cover: p3 / Step 0
kicker: A spec · p3 step 0 · 2026-11-06
subtitle: A p3 server next to p2, the owner signed in, one plugin showing a value from the server, and every edit of a plugin applied in place without a restart
stats:
  - 3 | plugins (shell, hello, reload)
  - ~200 | lines of base code, the only code a restart changes
  - 0 | restarts for a plugin edit
  - 1 | kit change to decide (the reload control)
note: |
  The spec of p3's first step, for the owner and two reviewers before anything is built. p3 is built tabula rasa on
  the Chord v2 app kit, on branch `p3` in `apps/p3/`. The owner asked for baby steps and for reloads first: this step
  builds almost nothing but the base every later step stands on, and the test that keeps reloads smooth. Names marked
  "decision" do not exist yet. The whole skeleton drafted before (sessions, harness, chat) is in `docs/map/` as a map,
  not a spec.
colophon: p3 step 0 · spec, first edition · 2026-11-06 · sources: Chord design.md §3, §16-§18, §21, §23; decisions 2026-11-01..06; the app kit and example 61
---

# Before we begin {.preface}

On his phone, next to p2, Mario starts p3: `node apps/p3/start.ts` prints an owner link for port 8789. He opens it and
signs in. The page says "Hello from p3" and shows a counter with a button; he taps it three times. On slayer an agent
changes the greeting in the `hello` plugin's page code. A bar at the top of Mario's page says "1 plugin changed" with
an **Apply** button. He taps it: the greeting changes in place, the counter still says 3, the page did not reload. The
agent then changes how the server counts (each tap adds two); Apply again: the next tap adds two, nothing restarted.
Finally the agent edits the API; the bar says "restart needed", and only that restarts the server, the counter still
at its value afterwards.

In p2 most of these edits were restarts: its behaviour lives in base code (`src/runtime/`, `src/hosts/`), and a
restart stops every worker and reloads every page. p3's first rule (decision "Reloads first") is that base code is
vocabulary and every behaviour is a plugin; this step builds that base and the test that holds it to the rule, with
one small plugin to reload.

## Six things to know

:::findings
1. **Base code is vocabulary.** `start.ts`, the API package `@p3/app` (Chord's plugin surface re-exported once, the
   principal type, `defineFacet` bound to it), and a web entry rendering one slot. About 200 lines; a restart changes
   them, nothing else needs one.
2. **Three plugins.** `shell` draws the page around a list of parts, `hello` shows a counter kept on the server,
   `reload` shows what changed and applies it.
3. **No workers yet.** The kit runs a server with clients only; the session worker is a later step.
4. **The owner is a user.** Principals are `server`, `worker`, `user`, `guest`; the kit's owner link signs in as `{
   kind: "user", id: "owner" }` (Chord decision "The kit's owner is a principal the app chooses", being built).
5. **Applying is explicit and in the page.** The kit marks changed plugins and knows when base code changed, but only
   the start script can apply. Decision 1 proposes a small kit object, `AppChanges`, so a plugin can show the marks and
   apply them.
6. **Done means the reload suite passes.** A browser test edits each plugin's page and server code while the page is
   open, applies, and checks that the page never reloaded, its values stayed and the restart mark stayed off; an edit of
   the API sets it.
:::

## Words used throughout

**Base code** is what a restart changes: the start script, `src/` (the API and the web entry), and the packages it
runs on (Chord, React). A **plugin** is a directory in `apps/p3/plugins/` with one file per kind of host it runs on
(`server.ts`, `web.tsx`). **Applying changes** builds the changed plugins and rolls them out to the server and then to
the open pages; on each, only the changed plugin's code is replaced (design §21). The **restart mark** is the kit's
`plugins.state.base`: true when a file base code was built from changed since the start. A **part** is one thing the
shell shows, contributed by a plugin.

# The Base {#base lede="Every file a restart changes, and why nothing else is in it."}

```text
apps/p3/
  package.json            "@p3/app" (private): exports ./v1, ./v1/server, ./v1/web
  start.ts                startServer; prints the owner link
  src/principals.ts       P3Principal
  src/api/v1/index.ts     Chord's plugin surface re-exported; defineFacet bound to P3Principal
  src/api/v1/server.ts    the kit's server surface (Http, AppInfo, AppChanges)
  src/api/v1/web.ts       Chord's React hooks; the one slot, Page
  src/web/main.tsx        startPage; serves Page; renders its component
  plugins/shell/          contract.web.ts (Parts), web.tsx, shell.css
  plugins/hello/          contract.ts (Hello), server.ts, web.tsx
  plugins/reload/         web.tsx
  test/                   reload.test.ts (the reload suite), hello.test.ts
```

The API re-exports Chord's plugin-facing surface as one list (contract and schema builders, `defineRegistry`,
`defineState`, `defineTable` and the query builders, errors, `Ctx`, messages, themes, the kit's start-data objects and
`Files`), so a plugin that needs one more Chord export never forces an API edit. What it adds is what a plugin cannot
declare for itself:

```ts
// apps/p3/src/principals.ts
/** Who someone is in p3. `guest` is reserved: its fields come with sharing. */
export type P3Principal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly session: string }
	| { readonly kind: "user"; readonly id: string }
	| { readonly kind: "guest" };

// apps/p3/src/api/v1/index.ts (p3's own part)
/** Defines a facet of p3: its factories get p3's principals. */
export function defineFacet(setup: (host: FacetHost<P3Principal>, self: FacetSelf) => void) {
	return chordFacet<P3Principal>(setup);
}
```

`worker` is in the type now so that the type does not change when workers arrive; nothing makes one in this step.

The page's base renders one slot. Whatever draws the page is a plugin, so a new layout is a reload, not a restart:

```ts
// apps/p3/src/api/v1/web.ts
/** What draws the page: the first contribution by plugin name (the shell). */
export const Page = defineRegistry<ComponentType, ComponentType | undefined>("p3.page", { version: 1 });
export { HostProvider, useHold, useHost, useMessages, usePageState, useRegistry, useWatch } from "@earendil-works/chord/react";

// apps/p3/src/web/main.tsx
const core = defineFacet((host) => host.serve(Page, { compose: (table) => table[0]?.value }));

function Root() {
	const Drawn = useRegistry(Page);
	return Drawn === undefined ? null : <Drawn />;
}

void startPage({
	connect: () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`),
	modules: { "@p3/app/v1": v1, "@p3/app/v1/web": v1web, react: React, "react/jsx-runtime": jsx },
	core: [{ name: "@p3/web", facet: core }],
	render: (host) => createRoot(document.getElementById("root")!).render(<HostProvider host={host}><Root /></HostProvider>),
});
```

## The start script

```ts
// apps/p3/start.ts
const OWNER = { kind: "user", id: "owner" } as const;

const app = await startServer<P3Principal>(
	{
		name: "p3",                                              // ~/.p3 unless argv[2] names another directory
		dataDir: process.argv[2],
		root: fileURLToPath(new URL("./plugins/", import.meta.url)),
		listen: { host: "127.0.0.1", port: 8789 },               // p2 keeps 8788
		api: { name: "@p3/app", versions: ["v1"], modules: { "@p3/app/v1": v1, "@p3/app/v1/server": v1server } },
		kinds: {
			server: { platform: "node" },
			web: { platform: "browser", packages: { react: {}, "react/jsx-runtime": {} } },
		},
		principal: { server: { kind: "server" }, owner: OWNER },          // no worker kinds yet
		web: { entry: fileURLToPath(new URL("./src/web/main.tsx", import.meta.url)), page, paths: ["/"] },
		base: [fileURLToPath(new URL("./src/", import.meta.url)), fileURLToPath(import.meta.url)],
		onError: (error) => console.error("p3:", error.kind, error.error),
	},
	BACKGROUND_CONTEXT,
);
console.log(`Open ${app.ownerLink()}`);
```

`principal.worker` is required by the kit's options today although p3 has no worker kind yet; the kit change being
built makes it optional while an app has no worker kinds. The owner
id `"owner"` is a fixed id for the first user; a users plugin gives it a profile later. Changing it later replaces the
owner token file and leaves the old cookie signed in as the old id (the kit decision says so), so it is chosen once.

Signing in is the kit's: the start prints a one-time link, `http://127.0.0.1:8789/_chord/owner#<token>`, valid ten
minutes, whose page sets the owner's cookie; every route and the `/chord` links answer 401 without a principal; tests
and command-line clients send `~/.p3/owner-token` as a bearer token.

# The Plugins {#plugins lede="A shell with parts, a counter on the server, a bar that applies changes."}

## shell

The shell contributes the page and serves the registry its parts come from. Step 0's layout is a column; the real one
(a sidebar, screens) replaces it later as a plugin reload.

```ts
// apps/p3/plugins/shell/contract.web.ts
/** A part of the page: its name (a key) and its component, in plugin-name order. */
export type Part = { readonly name: string; readonly Component: ComponentType };
export const Parts = defineRegistry<Part, readonly Part[]>("p3.parts", { version: 1 });

// apps/p3/plugins/shell/web.tsx
function Shell() {
	const parts = useRegistry(Parts) ?? [];
	return <main className={styles.shell}>{parts.map(({ name, Component }) => <section key={name}><Component /></section>)}</main>;
}
export default defineFacet((host, self) => {
	host.serve(Parts, { compose: (table) => table.map(({ value }) => value) });
	self.contribute(Page, Shell);
});
```

The `Parts` token lives in the shell's contract file, not in the API (decision "Reloads first"): `hello` and `reload`
import it by relative path, so the build copies it into their scripts and an edit of it reloads all three plugins,
never restarts.

## hello

A counter kept on the server, per user, persisted: the smallest thing whose value must survive every reload and the
restart.

```ts
// apps/p3/plugins/hello/contract.ts
export const Hello = remote("p3.hello", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { user: { state: { count: int() }, methods: { tap: method() } } },
});

// apps/p3/plugins/hello/server.ts
const Counts = defineState("p3.hello.counts", {
	schema: obj({ byUser: map(int()) }), version: 1, initial: () => ({ byUser: {} }), persist: true,
	checkpointWhen: () => true,
});
const Counter = local("p3.hello.counter", {
	version: 1, params: {},
	members: { counts: obj({ byUser: map(int()) }), tap: method(obj({ user: str() })) },
});

export default defineFacet((host) => {
	host.serve(Counter, (_params, self) => {
		const counts = self.state(Counts);
		return {
			counts,
			tap: async ({ user }, ctx) => {
				await counts.change((draft) => { draft.byUser[user] = (draft.byUser[user] ?? 0) + STEP; }, ctx);
				return null;
			},
		};
	});
	host.serve(Hello, (_params, principal, self) => {
		if (principal.kind !== "user") throw forbidden("hello is for users");
		const counter = self.get(Counter, {});
		return {
			variant: "user",
			members: {
				count: self.derive([counter.counts], ([c]) => c.byUser[principal.id] ?? 0),
				tap: (ctx) => counter.tap({ user: principal.id }, ctx),
			},
		};
	});
});
```

The shared store with per-principal views (design §6), in miniature: one persisted document, a view per user deriving
that user's count. `STEP` is 1; the reload suite's server edit changes it to 2.

```tsx
// apps/p3/plugins/hello/web.tsx
function HelloPart() {
	const hello = useHold(Hello, {});
	const count = useWatch(hello?.count);
	const [shown, addTap] = useOptimistic(count ?? 0, (current) => current + 1);
	const tap = () => startTransition(async () => { addTap(null); await hello?.tap(BACKGROUND_CONTEXT); });
	return (<><h1>{GREETING}</h1><button onClick={tap}>{shown}</button></>);
}
export default defineFacet((_host, self) => self.contribute(Parts, { name: "hello", Component: HelloPart }));
```

The tap shows at once (`useOptimistic`); the method awaits its own commit, so the call settles after the new count
reached the page (Chord's rule that a call's answer follows its state), and the optimistic value hands over to the real
one without a flicker. `GREETING` is "Hello from p3"; the suite's page edit changes it.

## reload

The bar at the top: which plugins changed, **Apply**, and "restart needed" when base code changed. It needs the kit's
marks and its apply on a plugin's reach, which decision 1 is about.

```tsx
// apps/p3/plugins/reload/web.tsx (with decision 1's AppChanges)
function ReloadBar() {
	const changes = useHold(AppChanges, {});
	const marks = useWatch(changes?.marks);
	const [applying, setApplying] = useState(false);
	if (marks === undefined || (marks.dirty.length === 0 && !marks.set && !marks.base)) return null;
	const apply = async () => { setApplying(true); try { await changes?.apply(BACKGROUND_CONTEXT); } finally { setApplying(false); } };
	return (
		<div className={styles.bar}>
			{marks.base ? "Base code changed: restart needed" : `${marks.dirty.length} plugin(s) changed`}
			{marks.dirty.length > 0 || marks.set ? <button disabled={applying} onClick={apply}>Apply</button> : null}
		</div>
	);
}
```

# Decision 1: the reload control {#decision-1 lede="The kit knows what changed and can apply it, but only the start script can ask."}

**Decision needed (Chord, the app kit).** The kit's `app.plugins.state` (`{ dirty, install, set, base }`) and
`app.applyChanges(ctx)` are fields of the `App` object the start script gets. A plugin cannot reach them, so the only
ways to apply are base code: a signal handler in `start.ts`, or a route `start.ts` adds. Either puts reload behaviour
into base code, against decision "Reloads first", and neither gives an agent (later, a tool) or the page a way to see
what changed.

**Recommended:** the kit serves a remote object on the server, `AppChanges` (`chord.app.changes`, params `{}`), for the
owner only (any other principal is refused `forbidden`): state `marks` (the plugins component's state as it is) and
the method `apply()`, which runs `applyChanges` and answers with a summary: `{ steps: { name, failed: string[] }[] }`
(each step's host name and the plugins whose new code failed and kept the old). The kit's facet serves it like its
other objects; the app re-exports the token in its server API, and `reload` holds it from the page.

:::sequence animate | Applying from the page: the bar holds the kit's object; the rollout replaces the changed plugin on the server, then in every open page.
actor page "page" "reload + hello web" blue
actor server "server" "AppChanges (kit)" accent
actor plugins "plugins component" "watcher, builds" muted
plugins -> server: hello/web.tsx changed: marks.dirty = ["hello"]
server --> page: state: marks
page -> server: AppChanges.apply()
server => plugins: build hello, roll out: server, then web
plugins --> page: new web script set (the page reloads hello in place)
server --> page: state: marks (clean), then the answer
page -> page: HelloPart remounts: new greeting, count kept
:::

Why the object: it is the kit's own state and the kit's own operation, so the kit owns them (one owner per thing);
pages, a terminal and later an agent tool use the same object. Alternatives: (B) `start.ts` applies on a signal
(`SIGUSR2`) and prints the result: no change to the kit, but no button and no marks in the page; (C) a route
contributed by `start.ts`: base code again. Cost of the recommendation: about 50 lines in the kit with tests, the kit
README and design §23.

:::review | Review: who may apply
Applying runs the build of every changed plugin on the server: code from the plugin roots runs. It is the owner's
alone, as installing plugins is; guests and other users never get the object. Whether a second user should ever apply
is decided with multi-user.
:::

# Done {#done lede="The reload suite, and what else the build delivers."}

The reload suite is the point of the step: it runs from now on in every later step, each step adding its plugins to it.
A browser test (Chromium, `CHROMIUM_BIN`) starts p3 on a temporary data directory with a copy of `plugins/`, signs in
with the owner link, sets a marker on `window` (a page reload would lose it), and taps the counter three times. Then:

| Step | Edit | Expect |
| --- | --- | --- |
| 1 | `hello/web.tsx`: `GREETING` | the bar shows 1 plugin changed; Apply; the new greeting; count 3; marker present; `base` false |
| 2 | `hello/server.ts`: `STEP = 2` | Apply; one tap gives 5; a tap sent while the apply runs is answered (old or new code), none lost; marker present |
| 3 | `shell/web.tsx`: the layout's class | Apply; the parts remount inside the new layout; count shown; marker present |
| 4 | `shell/contract.web.ts`: a comment | Apply reloads shell, hello and reload (each copies it); marker present; `base` false |
| 5 | `src/api/v1/index.ts`: a comment | the bar shows "restart needed"; Apply is not offered for it; `base` true |
| 6 | restart the server on the same data directory | the page reconnects and reloads (new base); count 5; signed in |

Besides: `npm run check` clean at the root and in `apps/p3` (its own `check` script and tsconfig); a plugin test of
`hello` with `testPlugin` (a user taps, another user's count is apart, a non-user is refused); the kit changes with
their tests (the owner principal, being built; `AppChanges` if decided); and p3 started on the phone next to p2 (own
data directory `~/.p3`, port 8789), deployed by the phone dev session when the owner says so.

# What Comes Next {.epilogue lede="One small step at a time."}

Step 0 is the base and the reload suite, with a counter to reload. The owner decides decision 1 (the kit's
`AppChanges`, recommended); then the spec goes to two reviewers, and the build follows. The next steps, each as small:
a session list on the server; a worker per session; the harness with a fake model and a minimal chat; real models.
Each adds its plugins to the reload suite. The map of where they lead (`docs/map/`) is not a spec: each step gets its
own when its turn comes.
