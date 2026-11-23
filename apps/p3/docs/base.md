# p3's base (branch `skeleton`, 2026-11-23)

What the base gives every plugin, so the team builds the Pi Next features on it and anyone writes an app as plugins.
Decided by Mario's agent with Fable and Astra, on Mario's request ("you make all the decisions"), and for things with
Mario himself (2026-11-23). The skeleton on main (`7e0e34563`) is the starting point; this branch changes it where
needed. Everything below is PROPOSED until the section "Built" lists it (there is none yet: `next.md`, item 4).

## Words

| Word | Means |
| --- | --- |
| **owner** | the person who owns the Pi: a person with the owner flag; reaches and changes everything |
| **person** | anyone who signs in, the owner among them |
| **group** | persons, made by an app for one of its roles (coaches, players) |
| **party** | a person or a group |
| **app** | a plugin that owns the page below the top bar, and its sessions |
| **session** | one agent working in one folder of one environment, with its members and its things. The page may call it a workspace; in code it is the session, one id |
| **member** | a party in a session, who reads or writes |
| **thing** | one record of a kind a plugin brings: a canvas, a notebook, a login, an inbox, the coding tools. It has one id, one name and one owner: a person, a group, the Pi, or nobody. Sessions use things |
| **content** | a thing nobody owns: made in a session by a writer or by the agent, gone when no session uses it |
| **options** | what a thing allows in one session: one whole object per party there (everyone, the agent, a member), typed by the kind |
| **everywhere** | an owned thing's switch, "in all my sessions" on the page: every session that follows its owner has the thing |
| **follows** | a session follows one party, or nobody: it has that party's `everywhere` things, live, while the party writes in it |
| **view** | a React component a plugin offers for something to show; apps put views on their page |
| **environment** | a machine sessions work on. This device is made at the server's first start |
| **location** | where a session works: an environment and a folder |

## Working in a session, and managing it

Working is reading or writing: seeing the transcript, sending, using the views of its things. Managing is choosing
who is in it, where it works and whom it follows (members, location, `follows`, title, archive).

- **The owner** is the person with the owner flag (made at the server's first start, named after the OS account, never
  removed). They work in and manage every session, and are a member of groups and sessions like anyone, with options
  of their own. Owner rights are data read live (`SessionAccess`, `AppAccess`, `admitOwner`): no plugin tells the
  owner apart by the principal, which is a person's like everyone's.
- **Any other person** works in a session as its members say: `write` wins over `read`, a direct membership and one
  through a group count alike.
- **Everyone in a session reads every thing it has. Writers also use them**, as each thing's options allow, through
  its views and through the agent. The agent works for every writer: a guest who writes can have the agent read an
  inbox the session has.
- **A writer** makes content there, adds things they manage, gives content an owner ("keep"), and renames, removes
  or deletes the things they manage (section "Things"). A person manages nothing else in a session.
- **An app manages its sessions in its server code** (`SessionsStore`, server only), and gives its people the
  narrower actions it wants as objects of its own ("a player starts a chat with the coaches").
- **A session's worker** works in its own session only.

`Sessions.create({ app, title, location, members, things, follows })` writes the session, its members and its things
in one commit. Through it the owner makes only content as new things, and links existing things. An app's
server code (`SessionsStore.create`) may make any thing, and may leave out the location: the session then works on
this device in a folder the sessions plugin makes for it.

**An app's own objects** (the club's board, "a player starts a chat with the coaches") use `admitApp(app)`: the
factory gets `{ kind: "person", id, owner, groups }`: whether they are the owner, and the names of the app's groups
they are in (their roles); a person who may not enter the app is denied. The owner's own objects (`Sessions`,
`People`, `Environments`, ...) use `admitOwner`: allowed while the caller has the owner flag.

## One question for every object: `admitSession`

A plugin never reads a principal. An object of a session (not of one thing) declares the admission value
`SessionAdmission` (`{ access: "read" | "write" }`) and `admitSession` as its admission; its factory gets the
caller's access:

```ts
export const Pad = remote("pad.pad", { version: 1, params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }), admission: SessionAdmission,
	variants: { reader: { … }, writer: { … } } });
host.serve(Pad, (params, _principal, { access }, self) => (access === "write" ? writer : reader), { admit: admitSession });
```

The sessions plugin answers it (`SessionAccess`, live). A member removed, a group changed, a session archived: the
caller's object is rebuilt or denied at once (Chord's admission).

**The route asks the same question before it starts anything** (`src/server.ts`): no worker starts for a caller who
would be denied; a worker never reaches another session's worker; the server's waker reaches a session that is not
archived. An archived session starts for the owner only.

## Things (decided with Mario, 2026-11-23; PROPOSED, being built)

**What a thing is**

- **A thing has one id.** It is one record of its kind. Its kind's plugin keeps what is in it (the items, the
  shapes, the token), keyed by that id, **on the server**: the same thing may be in two sessions. Its name is the
  thing's, the same in every session.
- **A thing belongs to a person, a group, the Pi, or nobody.** The sessions plugin keeps the owner; no kind keeps
  one. A thing nobody owns is **content**.
- **Who manages a thing** (renames, deletes, gives it away, adds it to a session, removes it, changes its options):
  its owner; for a group's thing every person in the group; for the Pi's only the owner; for content every writer of
  a session that uses it. The owner manages every thing.

**How things come to exist** (the kind says it: `creation` in `serveThing`)

| `creation` | Who makes one, where | For whom |
| --- | --- | --- |
| `content` (a canvas, notes, a checklist) | a writer of a session, or its agent, in that session (`SessionThings.create`, the agent's `thing_create`) | nobody |
| `person` (a login, an inbox, an MCP server) | a person, in "My things" (`MyThings.create`), with the input the kind's `Create` view collected (a sign-in) | themselves, one of their groups, or (the owner) the Pi |
| `plugin` (the coding tools; the default) | only server code: `SessionsStore.ensureThing({ kind, owner })` gives the one thing of that kind and owner, made if there is none | whom the code says |

A kind that says nothing is `plugin`. The store refuses the rest: a write guest cannot make the coding tools, and
the agent cannot make a login. The owner's `Sessions.create` makes only content too. An app's server code is trusted
(`SessionsStore.createThing`, `SessionsStore.create`'s `things`): it may make any thing for any owner.

**How a session has a thing**

- **Linked:** a link `(session, thing)`, made when the thing is made there, or added later (`SessionThings.add`:
  only a thing the caller manages). Content stays in its session: to use it in a second one, keep it first. Only the
  owner, who manages every thing, can add content to a second session as it is; it is then gone with its last link.
  A link says who linked it: a person, the app, or the agent.
- **A session holds at most 1000 things.** One more link is refused.
- **Followed:** a session follows one party, or nobody (`follows`). It has, live, every thing of that party that is
  `everywhere`: for a person who is the owner, theirs and the Pi's; for a group, the group's. This holds **while that
  party writes in the session** (the owner writes every session; anyone else through a write membership). A thing
  both followed and linked counts once.
- **Who chooses whom a session follows:** the owner (`Sessions.follow`; `Sessions.create` follows the owner who
  calls it unless told otherwise) and an app's server code (`SessionsStore.follow`; `create` follows nobody unless
  told). `follow` with `keep` (the default) first links what the session had from the old party, so stopping to
  follow takes nothing away until someone removes it. Those links are made by whoever called: the owner, or the app.
- **`everywhere`** is the thing's owner's choice (`MyThings.setEverywhere`). It starts true for an owned thing made
  outside a session (My things, `ensureThing`), false for a thing made into a session. Keeping content turns it
  off; giving an owned thing to someone else leaves it as it was.

So a new coding session has the Pi's coding tools and the owner's login without anyone adding them: the tools plugin
made the tools for the Pi at its start (`ensureThing`, everywhere), and the session follows the owner who made it.

**Keeping, removing, deleting, leaving**

- **Keep:** a writer of a session gives its content to themselves, a group they are in, or (the owner) the Pi. It
  stays linked; it is not `everywhere` until its owner says so. From then on only who manages it changes it. Who
  manages an owned thing may give it to someone else the same way (My things); it stays "in all my sessions" if it
  was.
- **Remove** unlinks a thing from a session. Content is deleted with its last link. A followed thing cannot be
  removed from a session (stop following instead); its options there can be changed.
- **Delete** deletes a thing in every session, with what is in it (the kind's `delete` hook).
- **A member removed from a session** takes along the options chosen for them and the links of the things they own;
  the session's content stays. A followed party that no longer writes gives the session nothing (`follows` stays as
  data). **A person removed from the Pi**: the things they own are deleted; their groups' stay.

**Options**

- Options belong to a thing in one session: one whole object per party (everyone, the agent, a member), typed by
  the kind. Exactly one applies to a caller: their own, else their first group's in member order, else everyone's;
  the agent gets its own, else everyone's. Nothing is merged. A new link gets the kind's `initial` options. Followed
  things have options per session like linked ones.
- **Options only limit writers.** A reader always reads. What an option means for a writer is the kind's one line:
  `if (access === "read" || !options.check) return reader`.
- **Only an owned thing limits writers.** Every writer manages content, so a writer limited by a content's options
  can change those options, or keep the content. An app that limits a role makes the thing for a group or the Pi.
- Options stored at another version than the kind's give the thing nothing (its tools absent, its views refused),
  never the defaults; a kind's `migrate` carries old options over.

**What a kind's plugin writes** (the whole of it: the checklist below)

- `defineThing(name, { version, options, initial })` in its contract, and one remote object with params
  `{ session, thing }` and `admission: thingAdmission(Kind)`.
- On the server, one `serveThing(host, Kind, { title, creation, create?, delete?, object })`: the base makes every
  thing and its id; `create` prepares what is in a new thing (most kinds need none), `delete` drops it; the object's
  factory gets the caller's `{ access, options }`.
- On the worker, `thingExtension(Kind, (things, agent) => …)`: the agent's tools.
- On the page, `ThingViews`: its view of one thing, its options form, and for a `person` kind its `Create` view.

## What the agent gets

The agent is Durable's harness in the session's worker (plugin `harness`). **It gets exactly its session's things**,
linked and followed, with the agent's options:

- **One extension per kind**, for all the session's things of it: `thingExtension(Kind, (things, agent) => ({
  extension, providers }))`, called again whenever they change, never with none. Its tools take a thing's id; a list
  tool names the things (`checklist_list`), so descriptions stay fixed text. A tool that writes is there only while
  some thing allows it, and the thing's object refuses the others.
- **`agent.call(fn, context)`** runs `fn` as the session's worker, so a tool reaches its plugin's object, the same
  one people use, and the base answers it with the agent's options.
- **`thing_create({ kind, name })`**, the harness's own tool: the agent makes content of one of the session's
  content kinds, owned by nobody. It is there while the Pi has content kinds.
- **The agent makes only content.** It never makes an owned thing, never gives a thing an owner, never changes
  options: it works for every writer of its session, so what it could do for one of them, any of them could have it
  do.
- Installing a plugin gives no session anything; there is no global tools registry. A session without a login
  thing has no model.

The selection is applied before the harness resumes and before every submit: work starts only through the harness
(`SessionHarness.submit`), which waits until the agent's tools match what the server last said. A thing removed
while a tool call runs: that call finishes; no task phase that starts after the worker applied the removal sees the
tool (Durable resolves tools per task phase). A worker whose kind's plugin is of another version than the stored
options gives that thing nothing (no tools, no providers) until they agree. A session's location never changes while
a tool call runs. An archived session's worker opens its transcript without scheduling any work. The session is
reported `working` before Durable accepts an input, so a crash in between leaves it for the waker.

## Apps and the page

- **Server:** `Apps` (id, title, `chrome: "bar" | "button"`). A person may enter an app when they are in one of its
  groups or a member of one of its sessions; the owner enters every app. `AppCatalog` gives each caller the apps
  they may enter.
- **Page:** `AppPages` (app id, `Page` component). Everything below the top bar is the app's: it composes views and
  services (the session list, new session, the transcript, a session's things).
- **The top bar** (plugin `chrome`): app switcher, person menu (with "My things"), connection state. An app chooses
  statically: the full bar (`bar`) or one corner button (`button`, Leo's robot). An app that throws shows its error
  below the bar; the bar stays.
- **Routing:** `/<app>/<rest>`; the chrome owns the first segment, the app gets `useRoute()` and `navigate()` for the
  rest.
- **Views** are typed tokens: `defineView<Props>(name)` in a contract file, one `Views` contribution per view,
  `useView(Token)` returns its component. The base's: `SessionListView`, `NewSessionView`, `TranscriptView`,
  `SessionThingsView` (what a session has, opened on demand, never an always-shown strip: new content, add one of
  mine, keep, options, whom it follows), `MyThingsView` (what a person manages outside sessions: new, "in all my
  sessions", rename, give away, delete, where it is used).
- **A kind's views:** `ThingViews`; `<ThingView session thing kind />` renders the right one, so an app never knows
  kinds.
- **The pane layout** (`PaneLayoutView`, the `layout` plugin's view; its contract re-exported by `/v1/web` with the
  tree's types and the few pure functions an app calls on it): panes in splits and tabs the person drags; on a phone
  one pane at a time under a strip of chips. The app keeps the tree (JSON). An app may use it for its page; the
  coding app opens things as panes with it. A plugin, not base code: a change of it reloads in place.

## Registries

| Registry | Host | Contributed by |
| --- | --- | --- |
| `Apps` | server | each app |
| `ThingKinds` | server | each kind's plugin, through `serveThing`: its title, how its things come to exist, its `create` and `delete` hooks |
| `ThingExtensions` | worker | each kind's plugin: one extension (and providers) for all the session's things of the kind |
| `ExecutionEnvironments` | worker | the environments plugin: an `ExecutionEnv` for a location |
| `SessionHarness` | worker | the harness: the open Durable harness and `submit`, for the transcript and others |
| `AppPages` | page | each app |
| `Views` | page | each view's plugin (the pane layout: the `layout` plugin) |
| `ThingViews` | page | each kind's plugin: `View`, `Options`, `Create` |
| `PageRoot`, `PageConnection` | page | the chrome (the one component the base renders); the base |
| (base, as on main) `WorkerRunners`, `WorkerRunnerWraps`, `WorkerBusy`, `ServerCommands`, `LinkOpened` | | |

## Plugins

| Plugin | Owns |
| --- | --- |
| `sign-in` | sign-ins; the owner link (as on main, with the reload gap closed) |
| `people` | persons and groups; `Me`; invite links that make a person and sign them in |
| `environments` | environments; this device; `ExecutionEnvironments` |
| `sessions` | sessions (app, title, location, state, whom each follows), their members; the things, their owners, links and options; `SessionAccess`, `ThingAccess`; the waker |
| `apps` | `Apps`, `AppCatalog`, `AppAccess` |
| `harness` | Durable in the worker, `ThingExtensions`, `thing_create`, the activity report |
| `transcript` | a session's conversation as people see it; its view |
| `tools` | the coding tools: a `plugin` kind (`tools.coding`, options `{ shell: boolean }`), one thing, the Pi's, everywhere |
| `notes`, `canvas`, `checklist` | three kinds of content: notebooks, a shared drawing board, and the small example below |
| `chrome` | the page's frame: the top bar and the chosen app's page |
| `layout` | the pane layout (`PaneLayoutView`): splits, tabs, dragging; chips and swipes on a phone |
| `coding` | the coding app: its sessions (each follows the owner who made it), new session, the transcript, things as panes |
| `runner`, `control` | as on main |

## The page

Elanor as Inkling uses it, from npm, pinned together (`@earendil-works/elanor-react` 0.1.1, `design-tokens` 0.1.0,
`elanor-fonts` 0.1.0, `elanor-icons-react` 0.1.0): the base's stylesheet declares `@layer reset, elanor;`, Elanor's
component styles from `elanor.min.css`, plugins' CSS modules unlayered and winning; the server serves Elanor's fonts
at `/fonts/elanor/` and the `pi` brand tokens at `/tokens.css` as stable files (the owner link's page links
them too); light and dark follow the system. React and Elanor are host packages of the `web` kind, so a third
party's plugin type-checks against the versions p3 ships; icons come from `/v1/web` by name.

## Out of the base, for later packages

- Sharing UI and guest links beyond invites: [ERNDL-717 Permissions and sharing](https://linear.app/earendil/issue/ERNDL-717),
  [ERNDL-706 Sign-in and identity](https://linear.app/earendil/issue/ERNDL-706).
- Real provider logins: [ERNDL-705 Models and providers: sign-in and selection](https://linear.app/earendil/issue/ERNDL-705).
- The file, diff and terminal views: [ERNDL-796 Earendil-provided views](https://linear.app/earendil/issue/ERNDL-796).
- MCP: [ERNDL-725 MCP (UX, device MCP)](https://linear.app/earendil/issue/ERNDL-725).

Each plugs into the registries above without a base change.

## Two examples (PROPOSED until the acceptance test wrote them)

### A kind of thing: a checklist

Items with a "done" mark. One option, `{ check: boolean }`: whether a writer may add and tick. This is the plugin
`plugins/checklist/`, its four files as they are (its stylesheet `web.module.css` and its tests are left out).

`contract.ts`:

```ts
// The checklist kind: its options, an item, and the object people and the agent use. A checklist is content (a writer
// of a session or its agent makes one there); its items live on the server, keyed by the thing's id.

import {
	arr,
	bool,
	defineThing,
	method,
	obj,
	remote,
	Server,
	type Static,
	str,
	thingAdmission,
} from "@earendil-works/p3/v1";

/** A checklist; one option: whether a writer may tick items (and add them). */
export const ChecklistKind = defineThing("checklist.checklist", {
	version: 1,
	options: obj({ check: bool() }),
	initial: { check: true },
});

/** An item's text: 1 to 500 characters. */
export const ItemText = str({ min: 1, max: 500 });

/** An item of a checklist: its id, its text, and whether it is done. */
export const Item = obj({ id: str(), text: ItemText, done: bool() });

/** An item of a checklist (see `Item`). */
export type Item = Static<typeof Item>;

/**
 * One checklist (`thing`: its id) in one session, for one caller: a reader sees its items (at most 500, in the order
 * they were added), a checker (who writes and whose options say `check`) also adds and ticks them.
 */
export const Checklist = remote("checklist.checklist", {
	version: 1,
	params: { session: str(), thing: str() },
	hostAddress: () => Server(),
	admission: thingAdmission(ChecklistKind),
	variants: {
		reader: { state: { items: arr(Item) } },
		checker: {
			state: { items: arr(Item) },
			methods: {
				/** Adds an item, not done; answers its id. Refused once the checklist holds 500 items. */
				add: method(obj({ text: ItemText }), str()),
				/** Marks item `id` done or not. */
				tick: method(obj({ id: str(), done: bool() })),
			},
		},
	},
});
```

`server.ts`:

```ts
// The checklist on the server: its items (a table keyed by the checklist's thing id), the store that owns them, and
// the kind with its object (`serveThing`). The store is used only here (and by the query plans' test), so its contract
// lives here too.

import {
	bool,
	defineFacet,
	defineTable,
	eq,
	type FacetHost,
	int,
	invalid,
	local,
	method,
	obj,
	type P3Principal,
	queries,
	query,
	str,
	type Tx,
} from "@earendil-works/p3/v1";
import { serveThing } from "@earendil-works/p3/v1/server";
import { Checklist, ChecklistKind, Item } from "./contract.ts";

/** How many items a checklist holds at most: its object reads them whole. */
const LIMIT = 500;

/** The items of every checklist, and their writes; a checklist is its thing's id. Exported for the query plans' test. */
export const ChecklistStore = local("checklist.store", {
	version: 1,
	params: {},
	members: {
		items: queries(Item, {
			/** Checklist `checklist`'s items, in the order they were added. */
			of: obj({ checklist: str() }),
		}),
		/** Adds an item, not done; answers its id. Refused once the checklist holds `LIMIT` items. */
		add: method(obj({ checklist: str(), text: str() }), str()),
		/** Marks item `id` done or not; refused for an item the checklist does not have. */
		tick: method(obj({ checklist: str(), id: str(), done: bool() })),
		/** Removes every item of a checklist (its thing is gone). */
		clear: method(obj({ checklist: str() })),
	},
});

/** Every checklist's items. Index `by_order`: a checklist's items in the order they were added (`seq`). */
const Items = defineTable("checklist.items", {
	version: 1,
	columns: { checklist: str(), id: str(), text: str(), done: bool(), seq: int() },
	key: ["checklist", "id"],
	indexes: { by_order: ["checklist", "seq"] },
});

export default defineFacet((host) => {
	serveStore(host);
	serveThing(host, ChecklistKind, {
		title: "Checklist",
		creation: "content",
		// A new checklist starts empty; its items go with it.
		delete: async (thing, ctx) => {
			await (await ctx.get(ChecklistStore, {})).clear({ checklist: thing }, ctx);
		},
		object: {
			contract: Checklist,
			factory: ({ thing }, { access, options }, self) => {
				const store = self.get(ChecklistStore, {});
				const found = self.liveQuery(store.items.of, { checklist: thing }, { first: LIMIT });
				const reader = { items: self.derive([found], ([{ rows }]) => rows) };
				// The kind's one rule: a reader only reads; a writer ticks (and adds) only if the option allows it.
				if (access === "read" || !options.check) return { variant: "reader", members: reader };
				return {
					variant: "checker",
					members: {
						...reader,
						add: ({ text }, ctx) => store.add({ checklist: thing, text }, ctx),
						tick: ({ id, done }, ctx) => store.tick({ checklist: thing, id, done }, ctx),
					},
				};
			},
		},
	});
});

/** Serves `ChecklistStore` on `host`. */
function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(ChecklistStore, (_params, self) => {
		const items = self.table(Items);
		/**
		 * How many items checklist `checklist` holds: its last item's `seq` (items are numbered from 1 and never removed
		 * one by one), one row of index `by_order`.
		 */
		const count = async (tx: Tx, checklist: string) => {
			const newest = query(Items)
				.where((item) => eq(item.checklist, checklist))
				.orderBy((item) => item.seq, "desc");
			return (await tx.page(items, newest, 1)).items[0]?.seq ?? 0;
		};
		return {
			items: self.queries(
				items,
				{ map: ({ id, text, done }) => ({ id, text, done }), reads: ["id", "text", "done"] },
				{
					// Index `by_order`: `checklist` fixed, in the order of `seq`, then the key.
					of: ({ checklist }: { checklist: string }) =>
						query(Items)
							.where((item) => eq(item.checklist, checklist))
							.orderBy((item) => item.seq, "asc"),
				},
			),
			add: async ({ checklist, text }, ctx) => {
				const id = crypto.randomUUID();
				await self.tx(async (tx) => {
					// A full checklist refuses, so its object, which reads `LIMIT` items, never hides one.
					const held = await count(tx, checklist);
					if (held >= LIMIT) throw invalid("args", `checklist: a checklist holds ${LIMIT} items`);
					tx.put(items, { checklist, id, text, done: false, seq: held + 1 });
					return null;
				}, ctx);
				return id;
			},
			tick: ({ checklist, id, done }, ctx) =>
				self.tx(async (tx) => {
					if ((await tx.get(items, { checklist, id })) === undefined) {
						throw invalid("args", `checklist: ${checklist} has no item ${id}`);
					}
					tx.update(items, { checklist, id }, { done });
					return null;
				}, ctx),
			clear: ({ checklist }, ctx) =>
				self.tx(async (tx) => {
					// The key's prefix `checklist`: one statement.
					tx.deleteWhere(items, (item) => eq(item.checklist, checklist));
					return null;
				}, ctx),
		};
	});
}
```

`worker.ts`:

```ts
// The checklist on a session's worker: what the session's checklists give its agent, one set of tools for all of
// them. `checklist_list` (each checklist's id, name and whether the agent may tick there) and `checklist_read` (a
// checklist's items with their ids) always; `checklist_add` and `checklist_tick` only while at least one checklist
// lets the agent tick (the option covers adding too), refused with an error naming the checklist on the others. The tools take a checklist's id from `checklist_list`, so
// their descriptions stay fixed whatever checklists the session has. They reach the checklist on the server
// (`Checklist`) through `agent.call`, as the session's worker, so `admitThing` answers for the agent: options changed
// while a call runs refuse the tick there too.

import { bool, type Context, defineFacet, forbidden, obj, str } from "@earendil-works/p3/v1";
import {
	type Agent,
	type AgentThing,
	defineExtension,
	defineTool,
	type Extension,
	ThingExtensions,
	thingExtension,
} from "@earendil-works/p3/v1/worker";
import { Checklist, ChecklistKind, ItemText } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(
		ThingExtensions,
		// Called with every checklist of the session, again whenever they change.
		thingExtension(ChecklistKind, (lists, agent) => ({ extension: checklistExtension(lists, agent) })),
	);
});

/** A checklist of the session as the tools get it. */
type List = AgentThing<{ check: boolean }>;

/** The tools of the session's checklists: listing and reading, and ticking while one of them allows it. */
function checklistExtension(lists: readonly List[], agent: Agent): Extension {
	const list = defineTool({
		name: "checklist_list",
		description:
			"Lists the session's checklists as JSON: each one's `id` (what the other checklist tools take), its `name` " +
			"and whether you may `tick` its items.",
		parameters: obj({}),
		execute: async () => {
			const shown = lists.map(({ thing, name, options }) => ({ id: thing, name, tick: options.check }));
			return { output: [{ type: "text", text: JSON.stringify(shown) }] };
		},
	});
	const read = defineTool({
		name: "checklist_read",
		description:
			"Reads one of the session's checklists (`checklist`: its id from `checklist_list`): its items as JSON, each " +
			"with its `id` (what checklist_tick takes), `text` and whether it is `done`.",
		parameters: obj({ checklist: str() }),
		execute: async ({ checklist }, _api, context) => {
			const at = { session: agent.session, thing: listOf(lists, checklist).thing };
			const items = await agent.call(async (ctx) => (await ctx.get(Checklist, at)).items.value, context);
			return { output: [{ type: "text", text: JSON.stringify(items) }] };
		},
	});
	const add = defineTool({
		name: "checklist_add",
		description:
			"Adds an item (`text`) at the end of one of the session's checklists (`checklist`: its id from " +
			"`checklist_list`, one you may tick); answers the new item's id.",
		parameters: obj({ checklist: str(), text: ItemText }),
		execute: async ({ checklist, text }, _api, context) => {
			const id = await change(lists, checklist, { kind: "add", text }, agent, context);
			return { output: [{ type: "text", text: `Added ${id}.` }] };
		},
	});
	const tick = defineTool({
		name: "checklist_tick",
		description:
			"Ticks (`done: true`) or unticks an item (`item`: its id from checklist_read) of one of the session's " +
			"checklists (`checklist`: its id from `checklist_list`, one you may tick).",
		parameters: obj({ checklist: str(), item: str(), done: bool() }),
		execute: async ({ checklist, item, done }, _api, context) => {
			await change(lists, checklist, { kind: "tick", item, done }, agent, context);
			return { output: [{ type: "text", text: `${done ? "Ticked" : "Unticked"} ${item}.` }] };
		},
	});
	return defineExtension({
		name: "checklist",
		tools: lists.some(({ options }) => options.check) ? [list, read, add, tick] : [list, read],
	});
}

/** A change the agent makes to a checklist. */
type Change = { kind: "add"; text: string } | { kind: "tick"; item: string; done: boolean };

/**
 * Makes `change` on checklist `id` as the agent, through the object people use: refused when the agent may not tick
 * there (its options now, which also cover adding). Answers the new item's id for an add.
 */
async function change(
	lists: readonly List[],
	id: string,
	change: Change,
	agent: Agent,
	context: Context,
): Promise<string | null> {
	const found = listOf(lists, id);
	if (!found.options.check) throw forbidden(`checklist: you may not change ${described(found)}`);
	return agent.call(async (ctx) => {
		const at = await ctx.get(Checklist, { session: agent.session, thing: found.thing });
		if (at.variant !== "checker") throw forbidden(`checklist: you may not change ${described(found)} now`);
		switch (change.kind) {
			case "add":
				return at.add({ text: change.text }, ctx);
			case "tick":
				return at.tick({ id: change.item, done: change.done }, ctx);
		}
	}, context);
}

/** The session's checklist `id`; an id that is none of them is the model's mistake, answered as its error result. */
function listOf(lists: readonly List[], id: string): List {
	const found = lists.find(({ thing }) => thing === id);
	if (found === undefined) {
		throw new Error(`checklist: the session has no checklist ${JSON.stringify(id)} (see checklist_list)`);
	}
	return found;
}

/** A checklist as an error names it: its name and id. */
function described({ thing, name }: List): string {
	return name === "" ? `the checklist ${thing}` : `the checklist "${name}" (${thing})`;
}
```

The agent makes a new checklist with the harness's `thing_create({ kind: "checklist.checklist", name })`: the kind
writes no tool for it.

`web.tsx`:

```tsx
// The checklist on the page: its view of one checklist (`ThingViews`' `View`: its items, ticked and added by a
// checker, shown to a reader) and its options form in the session sheet (one switch, "May tick").

import { Button, Checkbox, Input, SelectionControlAndLabel, Switch } from "@earendil-works/elanor-react";
import { BACKGROUND_CONTEXT, type Context, defineFacet, type OptionsOf } from "@earendil-works/p3/v1";
import {
	type ThingOptionsProps,
	type ThingViewProps,
	ThingViews,
	useHold,
	useRefState,
	useVariant,
	useWatch,
} from "@earendil-works/p3/v1/web";
import { useState } from "react";
import { Checklist, ChecklistKind } from "./contract.ts";
import styles from "./web.module.css";

export default defineFacet((_host, self) =>
	self.contribute(ThingViews, { kind: ChecklistKind.name, View: ChecklistView, Options: ChecklistOptions }),
);

/** Checklist `thing` of session `session`, as the viewer's admission allows: a checker ticks and adds. */
function ChecklistView(props: ThingViewProps) {
	const ref = useHold(Checklist, { session: props.session, thing: props.thing });
	const checker = useVariant(ref, "checker");
	const reader = useVariant(ref, "reader");
	const state = useRefState(ref);
	const items = useWatch((checker ?? reader)?.items);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | undefined>(undefined);
	/** Runs `call`, keeping its failure to show. */
	const run = (call: (context: Context) => Promise<unknown>) => {
		setError(undefined);
		call(BACKGROUND_CONTEXT).catch((failure: unknown) =>
			setError(failure instanceof Error ? failure.message : String(failure)),
		);
	};
	if (state?.kind === "failed" && state.cause.kind === "denied") {
		return <p className={styles.note}>You may not read this checklist.</p>;
	}
	if (state?.kind === "failed" || state?.kind === "ended") {
		return <p className={styles.note}>This checklist cannot be shown now.</p>;
	}
	const add = () => {
		const item = text.trim();
		if (checker === undefined || item === "") return;
		run(async (ctx) => {
			await checker.add({ text: item }, ctx);
			setText("");
		});
	};
	return (
		<section aria-label="Checklist" className={styles.checklist} data-checklist={checker ? "checker" : "reader"}>
			{items === undefined ? (
				<p className={styles.note}>Loading…</p>
			) : items.length === 0 ? (
				<p className={styles.note}>No items yet.</p>
			) : (
				<ul className={styles.items}>
					{items.map((item) => (
						<li data-item={item.id} key={item.id}>
							<SelectionControlAndLabel
								className={item.done ? styles.done : undefined}
								control={
									<Checkbox.Root
										checked={item.done}
										disabled={checker === undefined}
										onCheckedChange={(done: boolean) =>
											checker && run((ctx) => checker.tick({ id: item.id, done }, ctx))
										}
									>
										<Checkbox.Indicator />
									</Checkbox.Root>
								}
							>
								{item.text}
							</SelectionControlAndLabel>
						</li>
					))}
				</ul>
			)}
			{checker === undefined ? null : (
				<form
					className={styles.add}
					onSubmit={(event) => {
						event.preventDefault();
						add();
					}}
				>
					<Input
						aria-label="New item"
						className={styles.field}
						data-item-new=""
						onValueChange={setText}
						placeholder="A new item"
						value={text}
					/>
					<Button data-item-add="" disabled={text.trim() === ""} hierarchy="secondary" type="submit">
						Add
					</Button>
				</form>
			)}
			{error === undefined ? null : <p className={styles.error}>{error}</p>}
		</section>
	);
}

/** The options form over `props.options` (none readable: the kind's initial), saved for `props.for`. */
function ChecklistOptions(props: ThingOptionsProps) {
	// The options the sessions plugin gives a form are its kind's, checked against its schema when written.
	const stored = (props.options ?? ChecklistKind.initial) as OptionsOf<typeof ChecklistKind>;
	const [check, setCheck] = useState(stored.check);
	return (
		<div className={styles.options} data-checklist-options="">
			<SelectionControlAndLabel
				control={
					<Switch.Root checked={check} data-option="check" onCheckedChange={setCheck}>
						<Switch.Thumb />
					</Switch.Root>
				}
			>
				May tick
			</SelectionControlAndLabel>
			<Button
				data-options-save=""
				disabled={check === stored.check}
				hierarchy="secondary"
				onClick={() => props.onSave(props.for, { check })}
			>
				Save
			</Button>
		</div>
	);
}
```

Who decides what:

| Question | Decided by |
| --- | --- |
| The thing's id, name, owner; which sessions have it | the base (the sessions plugin) |
| Whether the caller reads or writes in this session | the base, live |
| Which options apply to this caller | the base |
| What `check` means: a writer with `check` adds and ticks, everyone else reads | the kind: one line in `server.ts` |
| What is in the checklist, and dropping it | the kind (its store, `delete`) |
| What the agent can do with checklists | the kind's tools, through the same object, as the agent |

### An app: a club without a sidebar

Coaches and players are its groups. A player's chat is a session with the coaches. Its plan is a checklist the
coaches own, so its options limit the player. The chat follows the coaches: what the coaches' group has "in all my
sessions" (the club's login) is in every chat.

```ts
// club/contract.ts
export const Club = remote("club.club", { version: 1, params: {}, hostAddress: () => Server(), admission: AppAdmission,
	variants: { club: { methods: { startChat: method(obj({}), str()) } } } });
// club/server.ts
self.contribute(Apps, { id: "club", title: "Club", chrome: "bar" });
host.serve(Club, (_params, _principal, who, self) => ({ variant: "club", members: {
	startChat: async (_args, ctx) => {
		if (!who.groups.includes("players")) throw forbidden("club: players start chats");
		const store = self.get(SessionsStore, {});
		const coaches = await (await ctx.get(PeopleStore, {})).group({ app: "club", name: "coaches" }, ctx);
		const group = { kind: "group", id: coaches } as const;
		// The plan is the coaches', in this chat only. By default nobody ticks; the coaches do.
		const plan = await store.createThing({ kind: ChecklistKind.name, name: "Plan", owner: group, everywhere: false }, ctx);
		const session = await store.create({ app: "club", title: "Chat", follows: group,
			members: [{ kind: "person", id: who.id, access: "write" }, { ...group, access: "write" }],
			things: [usingThing(plan, { check: false })] }, ctx);
		await store.setOptions({ session, thing: plan, for: group, options: { check: true } }, ctx);
		return session;
	} } }), { admit: admitApp("club") });
// club/web.tsx: self.contribute(AppPages, { app: "club", Page: ClubPage }): ClubPage shows TranscriptView and <ThingView>.
```

## Acceptance

A fresh agent gets only the installed `/v1` API and this file and writes, in `test/plugins/`, an app without a
sidebar and one kind of thing with a view and a tool. Then the test reloads it while two people are connected,
removes one person, and restarts the server mid-call. A base edit or a plugin-specific permission check fails it.

## Decided

**From the reviews of 2026-11-22**

- Whole options objects, one applies, no merging, no fallback to defaults on unknown data (Fable, Astra).
- `admitSession` and `admitThing` are the whole admission; params `{ session }` and `{ session, thing }` (Fable).
- No global extensions registry; the agent gets its session's things (Fable, Astra).
- Views as typed tokens registered once; `ThingViews` per kind; `<ThingView>` (Fable, Astra).
- The top bar's form is static per app (Fable).
- The route asks the session's access before it starts a worker (`admitRoute`); `names.md` changes with this branch
  (Fable, Astra).
- Working and managing are separate; a session's creation is one commit (Astra).
- The sign-in reload gap is closed: the link hook reads the request's token itself; a signed-in link no sign-in
  tracks is closed at once (Astra).
- The waker skips archived sessions and starts at most four workers at once (Astra).
- `admitApp` for an app's own objects; `thingExtension(Kind, give)` typed, with `agent.call`; the location optional
  for apps; `thingOf(Kind, { name?, owner?, options? })`; a kind's `migrate`; one `Party` for who a member is;
  `Harness`, `StoreStorage`, `createRegistry`, `createModels` in `/v1/worker` are p3's own and outside the promise
  (Fable).
- Anyone may ask the access answer about themselves (an admission asks as its object's caller); a worker matches
  its kind's version before it gives a thing anything; work starts only through `SessionHarness.submit`; an archived
  session opens without scheduling; the page's rollout step always runs; a direct session member enters its app
  (Astra).
- The owner is a person with a flag (Mario; `decisions.md`).
- Cut: per-key merging, owner-made groups, a deployment theme file (Fable).

**Things, with Mario, 2026-11-23** (`decisions.md`, "Things are made by how their kind says; sessions follow one
party")

- One id per thing; its kind keeps what is in it by that id, on the server. Owners: a person, a group, the Pi, or
  nobody; kept by the base, never by a kind.
- A session uses things through links, with options per party; the same thing may be in several sessions.
- Content is made in a session, mostly by the agent, owned by nobody, gone with its last link. "Keep" gives it an
  owner.
- Everyone in a session reads every thing; options only limit writers.
- The agent gets one extension per kind with all the session's things of it; tools take the thing's id; list tools.
- How things of a kind come to exist: `content`, `person`, or `plugin` (the default).
- The agent makes only content, with the harness's `thing_create`; it never makes an owned thing, never keeps,
  never changes options.
- "In all my sessions" (`everywhere`), and a session follows one party or nobody. The coding app's sessions follow
  the owner who made them; the coding tools are the Pi's, made by the tools plugin (`ensureThing`).
- From the reviews of that round (Fable, Astra): a session holds at most 1000 things; the owner's
  `Sessions.create` makes only content as new things; `follow` with keep links as whoever called (the owner, or the
  app); keeping content turns "in all my sessions" off, giving an owned thing away leaves it; removing a link keeps
  the thing's options while the session still follows it; "where it is used" also says when every session that
  follows the owner has the thing.
- Superseded by the above: a kind's own records with `ref`, `ThingKinds.records`, `ThingKindCatalog`, members
  bringing things (`BringThings`), a removed member's brought things going with them.
- Open, to decide with Armin: `next.md`, "Open, with Armin".
