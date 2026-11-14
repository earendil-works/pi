---
title: p3: where everything stands
cover: Where / Everything / Stands
kicker: A rundown · p3 · 2026-11-13
subtitle: What is decided, what is built in p2 and Chord, what is only proposed, and where the pieces contradict each other, for users and resources, for the screen, and for a session's worker
stats:
  - 22 | owner decisions in apps/p3/docs/decisions.md
  - 0 | lines of p3 code: apps/p3 holds docs only
  - 4 | proposals from today, none decided
  - 1 | Chord rule most proposals trip over: factories are synchronous
note: |
  Written 2026-11-13 for the owner by the subagent "rundown" so he does not have to hold all of it in his head.
  Sources were read from `origin/main` at `927cf8aaa` (the shared checkout's `main` is 111 commits behind it and was
  not touched), plus today's uncommitted files in the working tree: `apps/p3/docs/users-sketch.md`,
  `operation-gates-sketch.md`, `multiuser-walkthrough.md` and `apps/p2/docs/views-mock/index.html`.
  **Every code block says in its first line what it is:** `BUILT` (copied from the repo, path given), `DECIDED` (from
  a decision's text), `PROPOSED` (from a proposal, named with its author and date, or written here to show how a
  proposal looks in real Chord; those use only API that exists in `packages/chord/src` today). Notes marked *review*
  are contradictions or gaps found while checking. Nothing in this rundown is a decision.
colophon: p3, where everything stands · rundown, first edition · 2026-11-13 · sources: apps/p3/docs (decisions.md, accounts, resource-model, resources-code, sharing.md, views.md, layouts, today's sketches), /tmp/users-chapter.md, apps/p2 (docs, src/runtime, plugins), packages/chord (design.md §1, §4–§7, §17, §24; src/host), packages/durable/src/harness
---

# Before we begin {.preface}

It is Friday, 13 November. The onsite is next week, and p3's design is spread over 22 decisions, five design books
written between 7 and 13 November, three sketches from this morning, a views mockup from this morning and a proposal
another session wrote an hour ago. There is no p3 code. p2 runs on the owner's phone every day and already has a
working, single-user version of most of what the p3 documents argue about: guests, read-only sharing, a session lock,
views, artifacts, a harness with filtered tools, code-mode namespaces.

The same questions keep coming back in every round: who owns a resource, who may bring it into a session, who checks
that, and where the check runs. Each round a new document answers them a little differently, often with APIs that do
not exist, and the older documents are never marked as superseded. That is what going in circles feels like.

This rundown does one thing: it sorts every piece into **decided**, **built** and **proposed**, shows real code for
each, and names the contradictions. It also checks today's main proposal against the one Chord rule it breaks,
"a factory is synchronous and only declares", and shows how each of its three mechanisms would have to be written
with Chord as it is.

## Ten things to know

:::findings
1. **p3 has no code.** Everything marked built lives in p2 (`apps/p2`), Chord (`packages/chord`) or Durable
   (`packages/durable`). p2 is single-owner with guests.
2. **The resource direction is decided in outline.** Resources are owned by a user or by the instance (2026-11-13),
   you bring only your own, and everyone who may send in a session uses the session's whole list (2026-11-08). The
   mechanics are not decided.
3. **A factory decides only from params and the principal.** Chord runs it synchronously; the values of what it
   declares arrive later. "There is no async activation guard" (design §7). Every other check runs in a method or
   shows as derived state.
4. **That is why p2 puts a guest's rights in the principal.** `GuestPrincipal.sessions` maps each shared session to
   `"view"` or `"full"`, so a factory can choose the viewer or editor variant on the spot; any change bumps a revision
   and ends the old objects. p3's decided user principal carries only an id, so this trick does not carry over.
5. **Today's "three edges" proposal needs Chord hooks that do not exist.** `scope: "user"` on tables, `ctx.scope`, a
   policy gate inside Chord's dispatch, and a list check before the factory runs. It also contradicts Chord's
   ownership principle ("the owner enforces its rules in its methods"). Each edge can be built from today's Chord as a
   small library pattern; chapter VI shows all three.
6. **Two policy shapes are on the table.** The resource-model book's policy is a synchronous `decide(request,
   baseline)`; this morning's gate sketch is `async decide(...)`. Derives (a session's list, "what may I create") can
   only use the synchronous one.
7. **p2's session lock is the single-user version of "resources on sessions".** The owner picks MCP servers,
   instructions and two capabilities; the worker mirrors the lock into Durable; tools and server objects check it at
   every call.
8. **The UI is decided at the level of plugins and items.** Views are plugins, a plugin owns its items' data, panes
   come from `ViewKinds`, listable items from `ArtifactKinds` (2026-11-12). Layouts as apps, placements, the "+", and
   several sessions in one layout are proposals.
9. **The worker is built in p2 and mostly settled.** One process per session, the Durable harness, extensions from a
   registry, a guard on every tool, code-mode namespaces declared by extensions (Durable, 2026-11-12). Extensions keyed
   by resource exist only on paper.
10. **About ten rules would settle most of it.** They are on the last page, followed by the owner's open decisions in
    the order they unblock the most.
:::

## Words used throughout

**BUILT**, **DECIDED** and **PROPOSED** label every code block (see the cover note). A **principal** is who a call is
from, stamped by the link it arrives on (`{ kind: "user", id }`). A **factory** is the function that makes a Chord
object; it runs synchronously and only declares. A **per-principal object** is a Chord `remote` object: one per
params and principal, choosing one **variant** (a set of members) when it is made. A **store** is a `local` object
with empty params: one per host, it may persist data and contribute to registries. A **registry** collects
contributions from plugins and composes one value. A **resource** is something a session can use (an MCP server, a
tool, a model provider); its **owner** is a user or the instance. **Bringing** puts a resource on a session's
**list**. The **policy** answers "may this user do this". A **lock** is p2's per-session pick of resources. A
**view** is a pane on screen showing an **item** (an artifact, a file, a terminal) of a **view kind**; a **layout**
arranges views; a **placement** is one view in a layout. A **worker** is the process running one session; its
**harness** is pi-durable's `Harness`; an **extension** is a Durable bundle of tools and prompt sections; a
**namespace** groups an extension's tools for code mode.

# The Rule Under Everything {#chord-rule lede="Part 1 starts with Chord, because every question about users, resources and locks ends at the same rule: what a factory may know when it runs."}

Every access question in p3 becomes, in code, one of three questions: may this caller get this object at all, which
variant does it get, and may it make this call now. Chord answers the first two in one place, the factory, and the
factory runs under a hard rule.

## The rule

Design §1, principle 3: *"Factories declare, Chord activates. A factory is synchronous and only declares; Chord
performs activation. Handles a factory gets are valid for the object's whole life."* Design §6 adds: *"Synchronous
and declarative: no awaits, no side effects; async work happens in activation (opens), in calls, in routines and
jobs."*

The types say the same:

```ts
// BUILT · packages/chord/src/host/attempt.ts (excerpt)
export type Factory<C extends Contract, P extends Principal = Principal> = ShapeOf<C>["kind"] extends "local"
	? (params: ParamsOf<C>, self: keyof ParamsOf<C> extends never ? StoreSelf<P> : Self<P>) => Implementation<C, Ctx<P>>
	: (params: ParamsOf<C>, principal: P, self: Self<P>) => Implementation<C, Ctx<P>>;
```

Three consequences matter for everything that follows:

1. **A factory can decide only from its params and its principal.** It may declare `self.get(Other, {})`, but the
   reference becomes live after the factory returned. It cannot read another object's state, a table or the policy
   while it runs. So it cannot refuse a caller or pick a variant because of data stored somewhere.
2. **Only stores and facets touch tables and registries.** `self.table`, `self.query` and `self.contribute` exist only
   on `StoreSelf`, the `self` of a `local` type with empty params (one per host). A per-principal object cannot own a
   table and cannot contribute to a registry (design §17, R21).
3. **Params are flat.** A record of `str()`, `int()`, `bool()` or `oneOf(...)` fields, nothing nested (design §5). A
   resource reference `{ kind, owner, id }` cannot be one param.

Design §7 states where checks therefore live: *"Authority checks live in the per-principal view's methods (and in
`route.authorize` before a host starts); there is no async activation guard."* `route.authorize` is synchronous too:
`authorize(principal, address): boolean`.

```ts
// BUILT · apps/p2/src/hosts/session-workers.ts (excerpt): the route to session workers
authorize: (principal: P2Principal, address) =>
	principal.kind === "server" || canView(principal, address.params.id),
principal: (address): P2Principal => ({
	kind: "worker",
	session: address.params.id,
	generation: this.generation(address.params.id),
}),
```

## Where a check can live

| Where | Runs | Can read | Example |
| --- | --- | --- | --- |
| the factory | once per object, synchronously | params, principal | p2's chat refuses a guest of another session |
| `route.authorize` | per hold to a routed host (a worker), synchronously | principal, the host's address | p2 admits only the session's viewers to its worker |
| a method | per call, async | anything: followed state, `await` a store | p2's telemetry refuses a locked session's agent |
| a derive | on every change, synchronously | followed values | an editor's list filtered for a reader |
| a routine (`on`, `onLive`) | on changes, async | anything | p2 mirrors the session lock into Durable |

## What p2 does with it

p2 lives inside this rule. Its chat factory decides the variant from the principal alone, because the principal
carries the guest's rights:

```ts
// BUILT · apps/p2/plugins/chat/worker.ts (excerpt)
const chatFactory: Factory<typeof Chat> = ({ session, conversation }, principal, self) => {
	if (!canView(principal, session)) throw forbidden("viewers only");
	if (!isOwner(principal) && !isGuest(principal)) throw forbidden("people only");
	const authorId = authorIdOf(principal);
	const chat = self.get(Conversation, { conversation });
	// …
	if (!canSend(principal, session))
		return {
			variant: "viewer",
			members: { view: chat.view, stats: chat.stats, model: chat.model, liveShell, entries },
		};
	// … the participant's variant with send, stop, upload
```

And where the answer depends on data that changes (is the session locked, is it shared), p2 declares the stores in
the factory and checks their followed state inside each method:

```ts
// BUILT · apps/p2/plugins/telemetry/server.ts (excerpt)
host.serve(Traces, (_params, principal, self) => {
	// …
	if (isOwner(principal)) return { variant: "owner", members: reads(store, async () => {}) };
	if (isWorker(principal)) {
		const { session } = principal;
		const shares = self.get(Shares, {});
		const locks = self.get(SessionLocks, {});
		// What the agent finds lands in the transcript: anyone the session is shared with (viewers too) would read it.
		const check = async (_ctx: Ctx) => {
			if (locks.locks.value[session] !== undefined)
				throw forbidden("Telemetry is the owner's: this session is locked.");
			const shared =
				shares.links.value.some((link) => link.session === session) ||
				shares.people.value.some((person) => person.session === session);
			if (shared) throw forbidden("Telemetry is the owner's: this session is shared.");
		};
		return { variant: "agent", members: reads(store, check) };
	}
	throw forbidden("Telemetry is the owner's.");
});
```

These two shapes, "decide from the principal in the factory" and "declare in the factory, check followed state per
call", are the only two Chord offers. Every mechanism in this rundown has to be one of them.

# Users {#users lede="Who a person is in p3: what is decided, what the kit and p2 have, and three generations of proposals."}

## Decided

- **Principals are `server`, `worker`, `user`, `guest`** (decisions.md, 2026-11-06). The guest is reserved until
  sharing is designed. The owner is the first user; the kit's owner link signs in as that user (Chord decision "The
  kit's owner is a principal the app chooses").

```ts
// DECIDED · decisions.md "Principals are server, worker, user, guest" (2026-11-06), written as a type
type P3Principal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly session: string }
	| { readonly kind: "user"; readonly id: string }
	| { readonly kind: "guest" };              // reserved until sharing is designed
```

- **Instance resources, not an instance user** (decisions.md, 2026-11-13, refines "Resource model direction"): a
  resource's owner is a user or the instance. No pretend user appears in lists, presence or audit.

```ts
// DECIDED · decisions.md "Instance resources, not an instance user" (2026-11-13), written as a type
type ResourceOwner = { readonly kind: "user"; readonly user: string } | { readonly kind: "instance" };
```

## Built

**Chord's app kit** has the pieces p3 is meant to start from: `defineUsers(profile)` (profiles by id,
`packages/chord/src/node/app/users.ts`), `Sessions` (sign-in sessions), owner links and device pairing, and a fixed
`principal.owner` in its options (`app.ts`: `principal: { server: P; worker?: …; owner: P }`).

**p2** has one owner and guests. The owner's principal says how they reached the server; a guest's carries every
session shared with them and a revision:

```ts
// BUILT · apps/p2/src/runtime/principals.ts (excerpt)
export type GuestPrincipal = {
	readonly kind: "guest";
	readonly id: string;
	readonly name: string;
	readonly email?: string;
	readonly home: string;
	readonly sessions: Readonly<Record<string, "view" | "full">>;
	readonly revision: number;
};

/** May read the session: the owner, or a guest it was shared with. */
export const canView = (principal: P2Principal | undefined, session: string): boolean =>
	isOwner(principal) || (isGuest(principal) && Object.hasOwn(principal.sessions, session));

/** May send, stop and upload in the session: the owner, or a guest it was shared with read/write. */
export const canSend = (principal: P2Principal | undefined, session: string): boolean =>
	isOwner(principal) || (isGuest(principal) && principal.sessions[session] === "full");
```

## Proposed, three generations

| Document | Date, author | What it proposes | Status |
| --- | --- | --- | --- |
| `accounts/book.md` | 2026-11-07, p3 session | `Users`, `Identities`, an `Accounts` owner of external accounts, per-session account grants, an `Access` registry `allows(user, action, thing)` | partly superseded |
| `/tmp/users-chapter.md` (= resource-model book ch. II) | 2026-11-08, p3 session | `Identities` with admin and disabled flags, the reserved `INSTANCE` user id, `Me`, `People`, `UserAdmin` | `INSTANCE` superseded by 2026-11-13 |
| `users-sketch.md` | 2026-11-13, p3 session | users as a required core plugin with contracts in p3's API; a `Directory` registry (one active provider) that admits people and says who administers; `SignIn.complete` as the one place that issues sessions; the kit's fixed owner removed | current, not decided |

The newest one, in its own words:

```ts
// PROPOSED · apps/p3/docs/users-sketch.md (2026-11-13, p3 session), excerpt
export type DirectoryProvider = {
	/** Shown on the People screen ("Managed by Acme SSO"). */
	readonly label: string;
	/** Whether the start script prints a setup link and the sign-in page offers setup. */
	setupMode(): boolean;
	admit(request: AdmitRequest, ctx: Ctx): Promise<Admission>;
	/** A local read: called inside checks and derives. */
	isAdmin(user: UserId): boolean;
	// … onSignIn, manage
};

export const Directory = defineRegistry<DirectoryProvider, ActiveDirectory>("p3.users.directory", { version: 1 });
```

Note `isAdmin` is synchronous "called inside checks and derives": the sketch already respects the factory rule there.

## Contradictions and gaps

:::review | Review: the instance user is still in two books
`/tmp/users-chapter.md` and `resource-model/book.md` (chapter II, "Admins and the instance user") define `INSTANCE:
UserId`, "owns company resources and everything plugins bring". The 2026-11-13 decision replaces it with an owner
`{ kind: "instance" }`. `users-sketch.md` already drops it ("`INSTANCE` is not part of users"). The two books are
stale on this point.
:::

:::review | Review: account grants versus "one resource, one login"
`accounts/book.md` stores per-session grants (`p3.account-grants`) so a session may use a user's account. The
resource-model book's third edition says "no grants" and "the owner of the resource decides its login, forever";
`users-sketch.md` agrees ("the per-call MCP account envelope is not needed: one resource, one login"). The accounts
book's grant table is superseded; its `AccountProviders` (how an integration refreshes credentials) has no successor
yet.
:::

- **The kit's owner.** The 2026-11-06 decision makes the owner the first user; `users-sketch.md` wants the kit's
  `principal.owner` removed in favour of an admin check registry. Not decided (its open point 1).
- **Who is admin.** The users chapter keeps an admin flag in the users plugin; `users-sketch.md` moves it into the
  active directory. Not decided.
- **What a guest is.** p3 reserves `{ kind: "guest" }` with no fields; p2's guest carries sessions and a revision;
  `sharing.md` (owner direction, 2026-11-10) says someone you share an app with is a user, not a guest. Nobody has
  written p3's guest. See chapter V for why its shape decides how every factory checks.
- **A user's data when they leave.** Each plugin keys its own per-user data by user id; nothing tells them a user was
  deleted (`users-sketch.md` open point 5).

# Resources and Bringing {#resources lede="What a session may use: the decided direction, the single-user version p2 runs today, and two proposals that disagree on where the list lives."}

The decided core is short: what a session may use is a list of resources, people bring their own resources onto it,
and everyone who may send in the session uses all of it. Everything else, where the list is kept, how it is computed,
who checks it, is open, and the two proposals answer differently.

## Decided

- **No per-run authority** (decisions.md, 2026-11-08: *"there is no point in trying to prevent prompt injections.
  that's why one should be able to define what is brought into a session"*). Everyone who may send in a session uses
  every resource in its selection, whoever started the run.
- **Resource model direction** (decisions.md, 2026-11-08, voice walkthrough; "to be specified and reviewed against
  p2's features"). In short:
  - each resource has one owner and its own login or none, and never changes whose login it uses;
  - users create resources only for themselves; plugins' built-in resources (tools, prompt sections) exist when the
    plugin is installed; **one Durable extension = one resource**;
  - groupings (recent, folders, projects, Discord channels) only show things; a grouping "with resources" keeps a list
    in its own plugin;
  - **a session has exactly one resource source**: its own list, its owner's defaults ("everything I own plus every
    instance resource I may use, so new tools appear by themselves"), or one grouping with resources;
  - one replaceable policy plugin guards create, bring, add-member "through one guarded step in core";
  - workers follow their session's list live; the harness lets in only extensions whose resource is on it "(and
    belongs to the contributing plugin)"; resource plugins' per-session server views check the list.
- **Instance resources, not an instance user** (2026-11-13): owner `{ kind: "user", user }` or `{ kind: "instance" }`;
  plugin-installed and company resources are instance resources; the policy decides who may create or bring them.
- **Session data on the server as host-keyed documents** (2026-11-09): a plugin keeps per-session server data in its
  own server object, keyed by the session's host address (`defineState(…, { keyed: Session })`, `host(Session)`
  columns), so export, import and delete carry it. A session's list, wherever it lives, follows this rule.

## Built: p2's lock

p2 has no users and no resources, but it has the single-user version of "what is brought into a session": the lock.
A locked session (one listening to a Discord channel, say) uses only what the owner picked.

```ts
// BUILT · apps/p2/src/runtime/session-lock.ts (excerpt)
/** Capabilities a locked session may get besides MCP servers and instructions. */
export const LOCK_CAPABILITIES = ["ports", "conversations"] as const;

export const SessionLockSchema = obj({
	/** Picked MCP servers of the owner's mcp.json, by name. */
	mcp: arr(str({ maxLength: 200 }), { maxItems: 200 }),
	/** Servers of `.pi/mcp.json` at the session's locations. */
	projectMcp: bool(),
	/** The global AGENTS.md, skills and prompt templates. */
	instructions: bool(),
	capabilities: arr(union([literal("ports"), literal("conversations")]), { maxItems: 8 }),
});
```

It is kept the Chord way: one store on the server, one per-principal object for the owner and for each worker. The
worker's variant is a derive picking its own session out of the store, chosen from the worker principal alone:

```ts
// BUILT · apps/p2/plugins/sessions/locks.ts (excerpt)
host.serve(SessionLock, (_params, principal, self) => {
	const locks = self.get(SessionLocks, {});
	if (isWorker(principal)) {
		const session = principal.session;
		return {
			variant: "worker",
			members: { lock: deriveTyped(self, [locks.locks], ([all]) => all[session] ?? null) },
		};
	}
	if (!isOwner(principal)) throw forbidden("session locks are the owner's");
	return { variant: "owner", members: { locks: locks.locks, set: (args, ctx) => locks.set(args, ctx) } };
});
```

On the worker, a store with a routine follows that object and commits the lock into the session's Durable state,
where the tool guard (chapter X) and the prompt read it at each use:

```ts
// BUILT · apps/p2/plugins/sessions/lock-worker.ts (excerpt)
host.serve(LockMirror, (_params, self) => {
	const harness = harnessOf(self);
	const view = self.get(SessionLock, {});
	self.onLive(async (ctx: Ctx) => {
		const watch = await expectVariant(view, "worker").lock.watch(ctx);
		// One commit at a time, the newest value last.
		let chain = mirrorLock(harness().durable, watch.value, durableContext(ctx)).catch(report);
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			const value = call.value;
			chain = chain.then(() => mirrorLock(harness().durable, value, durableContext(ctx))).catch(report);
		});
		// …
	});
	return {};
});
```

The MCP plugin's server reads the same store when it places server processes (`apps/p2/plugins/mcp/server.ts`:
`placed(…, locks.locks.value)`), so a locked session's worker never sees an unpicked server's tools. This is the
whole pipeline the p3 list needs, with one owner instead of many users.

**Host-keyed data is built too.** p2's artifacts keep a session's items in documents keyed by its address; a
per-session object pins its key synchronously, because the key comes from the params:

```ts
// BUILT · apps/p2/plugins/artifacts/server.ts (excerpt)
host.serve(Artifacts, ({ session }, principal, self) => {
	const worker = isWorker(principal) && principal.session === session;
	if (!worker && !canView(principal, session)) throw forbidden("the session's viewers and worker only");
	const store = self.get(ArtifactStoreHost, {});
	const artifacts = deriveTyped(self, [store.artifacts.at(Session({ id: session }))], ([doc]) => summariesOf(doc));
	// …
```

## Proposed: two models of the list

**The resource-model book** (`resource-model/book.md`, third edition, 2026-11-08, p3 session, after the owner's code
review). A resource is one row in the resources plugin's index (`defineResource("mcp.server")` names the kind); brought
resources come from a registry while their plugin is installed; a session's effective list is a derive on the
server, recomputed when anything it depends on changes:

```ts
// PROPOSED · apps/p3/docs/resource-model/book.md, chapter "One List" (2026-11-08), excerpt
host.serve(SessionList, ({ session }, self) => {
	const row = self.get(SessionCatalog, {}).rows.at(session);      // live: owner, source
	const resources = self.get(Resources, {});
	const own = resources.ownLists.at(session);                      // live: this session's own list
	const groupings = self.registry(Groupings);
	const policy = self.registry(Policies);
	// …
	const list = self.derive(
		[row, own, resources.index, resources.exclusions, fromGrouping, policy, clock],
		([r, ownEntries, index, excluded, grouping, current, time]) => {
			const entries =
				r.source.kind === "defaults" ? defaultsOf(r.owner, index, excluded[r.owner] ?? [])
				: r.source.kind === "own" ? ownEntries
				: grouping.entries;
			// …
			return { kind: "ready", entries: entries.flatMap((entry) => usable(entry, r, index, current, time.now)) };
		},
	);
	return { list };
});
```

This respects the factory rule: everything is declared, the key comes from params, the policy runs inside the
derive (so it must be synchronous; chapter IV).

**The multi-user walkthrough** (`multiuser-walkthrough.md`, 2026-11-13, p3 session, uncommitted). No central index:
each plugin declares a resource kind with a `list()` of the current user's resources, and a `sessions` core plugin
keeps per-session tables of people and resources:

```ts
// PROPOSED · apps/p3/docs/multiuser-walkthrough.md, A3 (2026-11-13), excerpt
const Resources = defineTable("sessions.resources", {
	version: 1,
	columns: { session: hostColumn(Session), kind: str(), owner: str() /* "" for instance-wide */, id: str(),
		broughtBy: str() /* "" for instance-wide */, added: int() },
	key: ["session", "kind", "owner", "id"],
});

// plugins/sessions/server.ts
create: async ({ title, start }, ctx) => {
	const owner = userOf(ctx.principal);
	const session = newSessionId();
	const mine = start === "mine" ? await resourcesOfUser(owner, ctx) : [];   // every kind's list(), in owner's scope
	// … puts the session's people row and one resource row per resource
},
```

Bringing is a method with a hard rule before any policy, which both proposals share:

```ts
// PROPOSED · apps/p3/docs/multiuser-walkthrough.md, B3 (2026-11-13), excerpt
bring: async ({ resource }, ctx) => {
	const user = userOf(ctx.principal);
	// Hard rules, not policy: you bring only what is yours, into a session where you may send.
	if (resource.owner !== user) throw forbidden("You can bring only your own resources.");
	if (!(await maySend(session, user, ctx))) throw forbidden("You cannot send in this session.");
	// … one row, broughtBy: user
},
```

## Contradictions and gaps

:::review | Review: defaults are a rule, not a copy
The 2026-11-08 decision says a session's owner-defaults are a rule, "so new tools appear by themselves", and the
resource-model book computes them live. The walkthrough copies "my resources" into the session's rows at creation
and asks in its open point 3 whether later resources should join. The decision already answers it; the walkthrough
contradicts it.
:::

:::review | Review: one source per session
The decision makes the source one field ("own list, owner's defaults, or one grouping with resources: the invariant
is structural"). The walkthrough has no source field and no grouping with resources: each session owns rows. A
project or a Discord channel that equips its sessions has no place in it.
:::

:::review | Review: "belongs to the contributing plugin"
The decision says the harness admits an extension only if its resource is on the list "and belongs to the
contributing plugin". The resource-model book's third edition dropped that check ("no plugin-name check: installed
plugins are trusted code"). One of them should be corrected.
:::

:::review | Review: shelved or alive
`sharing.md` §4 (owner direction, 2026-11-10) says "No per-user environments … the resource-model plugin stays
shelved" and "no access-control lists in the base". The 2026-11-13 decision ("the policy plugin decides who may create
or bring them") and both proposals from this week assume it is alive. Newest wins, but `sharing.md` still says
shelved.
:::

- **Central index or per-plugin lists.** The book keeps one index of every resource (owner, label, revision) so a
  derive can compute lists; the walkthrough asks each plugin's `list()` at the moment of use, "in owner's scope",
  which needs a way to run plugin code as a user that Chord does not have (its open point 1).
- **Withdrawal.** The book raises a revision so lists drop withdrawn entries; the walkthrough deletes the row. Both
  work; the book's also handles "Colin left the company" without touching every session.
- **Expiry.** The book has `until` per entry (the Discord case: an hour of access); the walkthrough has none.
- **What is a resource in p2 terms.** The lock picks MCP servers, instructions, and the capabilities `ports` and
  `conversations`; bash and file tools are not in it (a sandboxed location limits them). Whether p3's bash is a
  resource (the book: yes, `coding-tools.bash`) or a property of the location is not decided.

# Who May {#policy lede="One replaceable policy is decided; its shape is not, and the two shapes on the table cannot both be true."}

## Decided

The 2026-11-08 "Resource model direction": *"One replaceable policy plugin (a registry with one provider; built-in
default: the single user may do everything) guards create, bring, add-member and similar typed operations through one
guarded step in core; plugins never know about ACL, SAML or Radius; the UI only renders server views (e.g. a per-user
list of creatable kinds computed with the policy)."* The 2026-11-13 decision adds that the policy decides who may
create or bring instance resources.

## Built

Nothing in p2 is a policy: there is one owner, who may do everything, and guests whose rights are in their principal.
The closest built piece is the registry p2's server asks whether a non-owner may reach a session. It is async,
because it is called from routes and methods, never from a factory:

```ts
// BUILT · apps/p2/src/runtime/server.ts (excerpt)
export type SessionAuthorizer = (principal: P2Principal, session: string, ctx: Ctx) => boolean | Promise<boolean>;
export const SessionAccess = keyedRegistry<SessionAuthorizer>("p2.session-access");

// BUILT · apps/p2/plugins/sharing/server.ts (excerpt)
self.contribute(SessionAccess, {
	// A guest reaches the sessions shared with it while its principal (revision included) is current.
	guest: async (principal, session, ctx) => {
		if (!isGuest(principal) || !Object.hasOwn(principal.sessions, session)) return false;
		const current = await shares.grant({ id: principal.id }, ctx);
		return current !== null && current.revision === principal.revision;
	},
});
```

## Proposed: three shapes

**1. `Access.allows`** (`accounts/book.md`, 2026-11-07): a synchronous `allows(user, action, thing)` per host, the
default `acl` plugin answering from roles and groups, a Radius plugin answering from the Radius org. Superseded in
detail by the next.

**2. A typed request union with a baseline** (`resource-model/book.md`, chapter "Who May", 2026-11-08). Core lists
every question it asks; the policy is a pure, synchronous function, so it can run inside derives:

```ts
// PROPOSED · apps/p3/docs/resource-model/book.md, chapter "Who May" (2026-11-08), excerpt
export type Request =
	| { readonly kind: "create-resource"; readonly actor: UserId; readonly definition: ResourceDefinition; readonly owner: UserId }
	| { readonly kind: "bring"; readonly actor: UserId; readonly resource: ResourceRef; readonly owner: UserId; readonly into: ListRef; readonly until: number | null }
	| { readonly kind: "use"; readonly session: SessionRow; readonly resource: ResourceRef; readonly owner: UserId }
	| { readonly kind: "administer"; readonly actor: UserId }
	// … create-grouping, set-source, add-member, call
	;
export type Policy = { decide(request: Request, baseline: Decision): Decision };
/** Exactly one provider; zero, two or a failed one compose to deny-all, never to the default. */
export const Policies = defineRegistry<Policy, Policy>("p3.policy", { version: 1 });
```

**3. Operation gates with facts** (`operation-gates-sketch.md`, 2026-11-13, p3 session, uncommitted). Plugins name
their methods as operations and describe each call with a few shared facts; a gate in Chord's method dispatch asks
the policy before the handler runs; the policy is async:

```ts
// PROPOSED · apps/p3/docs/operation-gates-sketch.md (2026-11-13), excerpt
export const CreateMcp = operation(McpServers, "create", {
	facts: ({ config }) => ({
		kind: "create",                                    // shared vocabulary: create | change | delete | use | read
		runsCode: config.transport.kind === "server-stdio" ? "server"
			: config.transport.kind === "checkout" ? "machine" : "none",
		reaches: config.transport.kind === "http" ? new URL(config.transport.url).host : null,
	}),
});

// in Chord's remote method dispatch (host serving a method call), before the handler runs
const op = operationOf(contract, method);                  // registered by operation(...); undefined: ungated
if (op !== undefined) {
	const decision = await gate.decide(
		{ principal, operation: op.name, object: { contract: contract.name, params }, args, facts: op.facts(args) },
		ctx,
	);
	if (decision.kind === "deny") throw forbidden(decision.reason);
}
return handler(args, ctx);

// @acme/p3-policy/server.ts
contribute(host, Gate, {
	async decide({ principal, operation, facts, args }, ctx) {
		const groups = await directory.groupsOf(principal, ctx);
		// …
	},
});
```

## Contradictions and gaps

:::review | Review: synchronous or async
The resource-model book calls `policy.decide(...)` inside a derive (`usable`, which drops denied entries from a
session's list) and inside `MyResources.creatable`. Derives are synchronous and pure (design §12). The gate sketch's
company policy is `async` and awaits the directory. An async policy can gate a method call; it cannot compute a list
or tell a page what it may create. If p3 wants both, the policy plugin must follow what it needs (groups, rules) as
state and answer synchronously; the `await directory.groupsOf` moves into the policy plugin's own routine.
:::

:::review | Review: "one guarded step in core" versus "a gate in Chord's dispatch"
The decision puts the guarded step in p3's core (a method plugins call). The sketch puts it in Chord's dispatch, which
has no such hook. Chord's design argues against the hook: principle 2 (*"The owner holds the data, enforces its rules
in its methods"*), §17 (*"Registries add behaviour … they never replace an owner's checks"*) and §7 (*"there is no
async activation guard"*). Chapter VI shows how to get the sketch's effect without touching Chord.
:::

- **Closed or open vocabulary.** The book's `Request` is a closed union in core: a third-party plugin's operation is
  only reachable through its `call` variant with `match(op)`. The sketch is open: every plugin declares operations and
  facts, and a shared fact vocabulary (`kind`, `runsCode`, `reaches`, `audience`, `right`, `resourceKind`) lets a
  policy decide without knowing the plugin. Who owns that vocabulary is the sketch's own open point 6.
- **Conflicts.** The book composes zero, two or a failed policy to deny-all; the users sketch does the same for
  directories; the gate sketch does not say.
- **Baselines.** The book passes the asking code's own answer (the owner rule, the admin flag) as a baseline the
  policy may override; the sketch has no baseline. With a baseline the default policy is one line
  (`(_request, baseline) => baseline`); without, the default policy re-implements the hard rules.

# Sharing and Locks {#sharing lede="Read-only sharing is decided and built in p2 for guests; for p3's users the question is where 'may Ada send here' lives, and the factory rule decides that."}

## Decided

- **Read-only sharing** (decisions.md, 2026-11-11: *"we obv want read-only sharing"*): a session can be shared with a
  viewer who reads everything and sends nothing, besides full participation.
- **No per-run authority** (2026-11-08): a full participant's messages drive the same agent with the same list.
- **The agent writes plugins** (2026-11-11): the trust boundary is access to the server; *"a guest who may send can
  already have the agent run `bash` there"*.
- Superseded: "A view's frame is a Chord client with a view principal" (2026-11-10), replaced by "Artifacts and views"
  (2026-11-12). There are no view principals.

## Built in p2

p2's sharing plugin (`apps/p2/plugins/sharing`, p2-notes "Sharing") keeps links and grants in server tables keyed
by `host(Session)`, issues a guest principal per person with the sessions shared with them and their modes, and bumps
the guest's revision on any change (share, join, removal, link reset, archive). The revision is part of the principal
key, so the old principal's objects end (`invalidatePrincipal`) and the guest's page re-holds as the new one. Every
factory then decides synchronously with `canView` and `canSend` (chapter I). A read-only guest gets the `viewer` or
`reader` variant; an html artifact's bridge tells the page `readOnly`, and its changes are not saved.

The lock (chapter III) is the other half: what the session's agent may reach, whoever talks to it.

## Proposed

- **`sharing.md`** (2026-11-10, synthesis of three designers by the p3 session; nothing decided): Watch (read-only,
  default for links) and Join (talks to the agent; named, signed-in people only); approvals are never a guest's;
  links expire by default; freeze the scope, not the layout; whole-app sharing deferred. Its §4 records the owner's
  direction of the same day: views know who is there (presence); **sharing an app with someone makes them a user, not
  a guest**; which of an app's sessions they see is the app's decision, enforced in its own objects' variants; no
  access-control lists in the base; no per-user environments.
- **`multiuser-walkthrough.md`** (2026-11-13): a `sessions.people` table (`user`, `right`: `owner | send | view`) and a
  `sessions.links` table per session, `SessionPeopleView` with `share`, `unshare`, `link`, `revokeLink`.

## The gap: where does "may Ada send here" live?

In p2 the answer is in the guest's principal. p3's decided user principal is `{ kind: "user", id }`. If Ada's rights
live in the walkthrough's `sessions.people` table, a factory on the session's worker cannot read them: it runs
synchronously and the table's value arrives after it returns. So the chat cannot choose `viewer` or `editor` for Ada.
There are three ways out, all possible with today's Chord.

**(a) Rights in the principal, as p2.** `{ kind: "user", id, sessions: { S1: "view" }, revision }`. Factories stay
one line. Cost: every share or unshare anywhere bumps Ada's revision and ends all her objects on every device,
which p2 accepts for guests with one or two sessions and a user with hundreds of sessions would feel all day.

**(b) One variant for people; the right is followed state, checked per call.** The worker's route admits only
members (synchronous, against a value the server keeps current); the object exposes the right as state for the UI and
checks it in each method; removing someone revokes their objects once. p2's worker route already admits by a
synchronous check (`canView`, chapter I); here the check reads a followed membership map instead of the principal.

`SessionPeople`, `Chat` and `Conversation` below stand for p3 contracts that do not exist yet; every Chord call in
it (`host.serve`, `self.get`, `self.derive`, `forbidden`, a route's `authorize`, `host.revoke`) exists today.

```ts
// PROPOSED · this rundown: option (b), written with today's Chord API only
// Server: the route to session workers admits members only (`authorize` is synchronous; `members` is a store's
// followed state, read at each hold).
authorize: (principal, address) =>
	principal.kind === "server" ||
	(principal.kind === "user" && members.value[address.params.id]?.[principal.id] !== undefined),

// Worker: the chat as a person sees it; the variant cannot depend on the table, so the right is a state member.
host.serve(Chat, ({ conversation }, principal, self) => {
	if (principal.kind !== "user") throw forbidden("people only");
	const people = self.get(SessionPeople, {});      // server object; the worker principal names the session
	const right = self.derive([people.rights], ([rights]) => rights[principal.id] ?? "none");
	const chat = self.get(Conversation, { conversation });
	const mustSend = () => {
		if (right.value !== "owner" && right.value !== "send") throw forbidden("You can only read this session.");
	};
	return {
		variant: "person",
		members: {
			right,                                    // the page shows or hides the composer from this
			view: chat.view,
			send: async (input, ctx) => {
				mustSend();
				return chat.send(input, ctx);
			},
		},
	};
});

// Server, on unshare: end Ada's objects so her pages re-hold and meet `authorize` again.
// (`revokedBy` returns [{ user: p.id }] for user principals; design §4.)
host.revoke({ user: "u2" }, ctx);
```

**(c) A principal per session.** The page opens a link per shared session and the server stamps
`{ kind: "user", id, session, right, revision }` on it, as p2 does for a guest's grant. Factories stay one line and
only that session's objects end on a change. Cost: one socket per open session per tab.

:::review | Review: the walkthrough's sessions core assumes (b) without saying so
`SessionPeopleView` has variants `owner` and `member`, picked in its factory, while the rights are rows of
`sessions.people`. That factory cannot read the rows. Either the variant comes from the principal (a or c) or the
object has one variant and checks per call (b).
:::

## Locks in p3

p2's lock is "the owner picks what this session uses". The 2026-11-08 decision turns it into "a session's own list"
(one of the three sources). Nothing p3-specific about locks is decided beyond that. What p2's lock covers and p3's list
must also cover: MCP servers by name, project MCP servers, global instructions and skills, and the capabilities
`ports` and `conversations`. What p2's lock deliberately does not cover: bash and file tools, which a sandboxed
location limits instead.

## Open questions

1. Guests in p3: a principal kind of their own (p2's shape), or a link admission into a user-like principal
   (`users-sketch.md` open point 4)?
2. Which of (a), (b), (c) carries "may view, may send" for users?
3. Approvals: may a `send` participant approve the agent's risky calls in someone else's session? `sharing.md`:
   never; the walkthrough leaves it open.
4. Expiry of links and of named shares.
5. Whole-app sharing: the owner's direction makes the other person a user; the app then decides which sessions they
   see. With which mechanism (the app's own objects' variants need the same answer as question 2).

# Three Edges in Real Chord {#edges lede="Today's proposal, checked against the factory rule: where each of its three mechanisms breaks, and how each would have to be written with Chord as it is."}

Another session proposed this today (not decided), summarizing `multiuser-walkthrough.md`,
`operation-gates-sketch.md` and `users-sketch.md`:

> "Plugins never check anything themselves; the platform does it at three edges. (1) User scopes: a plugin declares
> some state is per user (e.g. my MCP servers) and writes code as if there were one user; the platform keeps a copy
> per user and hands the plugin the caller's copy (like browser profiles). (2) Operation gates: every contract method
> is a named operation; dispatch asks the policy before the call reaches the plugin (default allows everything; a
> company plugin restricts). (3) Resources on sessions: a plugin declares a kind of resource; the platform keeps which
> resources are on a session and who brought them, only lets you bring your own; before a call it checks the resource
> is on that session. p2's session lock is the single-user version."

The goal is right: a third-party plugin (the walkthrough's `@someone/p3-todos`) should not have to know about users,
groups or policies. The mechanism assumes something Chord does not do: that the platform can look something up
before the plugin's object exists and hand it in. In Chord the factory is synchronous and runs first; whatever it
needs that is not in its params or principal arrives after it returned. The walkthrough's own list of "Guessed APIs"
(scopes, gates, dispatch hooks, resource kinds) is exactly the set of places where it needs an async step before or
around the factory.

:::flow wide | What the proposal assumes (top) and what Chord does (bottom). The proposal looks things up before the plugin's object exists; Chord makes the object first and lets it follow what it declared.
row "The proposal: platform first" accent
box call "a call arrives" "principal, contract, params"
box scope "find the user's copy" "async: a store read" dashed
box gate "ask the policy" "async: await gate.decide" dashed
box list "check the session's list" "async: a table read" dashed
box handler "plugin code" "written as single-user"
row "Chord: object first" blue
box get "a hold arrives" "principal stamped by the link"
box factory "factory" "sync: declares only" blue
box live "activation" "loads pins, binds references"
box method "each method call" "async: checks followed state" blue
arrow call -> scope
arrow scope -> gate
arrow gate -> list
arrow list -> handler
arrow get -> factory
arrow factory -> live
arrow live -> method
note "Dashed: steps Chord has no hook for. 'There is no async activation guard' (design §7)."
:::

## Edge 1: user scopes

**What it assumes.** A table or document declared `scope: "user"`; a remote contract declared `scope: "user"`; a
`ctx.scope` in methods; the platform adding the user to every key and query.

**Where it breaks.** The walkthrough's MCP plugin, as written:

```ts
// PROPOSED · apps/p3/docs/multiuser-walkthrough.md, A2 (2026-11-13), excerpt
host.serve(McpServers, (_params, _principal, self) => {
	const configs = self.table(Configs);                // rows of this object's scope only (u1 here)
	const all = self.query(configs, query(Configs), 1000);
	return {
		variant: "user",
		members: {
			servers: self.derive([all], ([rows]) => rows.map(toInfo)),
			create: async ({ label, config }, ctx) => {
				// …
				return { kind: "mcp.server", owner: ctx.scope, id };   // ctx.scope: guessed, the platform's user id
			},
		},
	};
});
```

1. `McpServers` is a `remote` contract, so its factory gets `Self`, not `StoreSelf`: `self.table` and `self.query`
   do not exist there (chapter I). Tables belong to stores, one per host.
2. `scope: "user"` on `defineTable`, `defineState` and `remote`, and `ctx.scope`, do not exist. Adding them is a Chord
   change against design §4 (*"Objects persist a projection with its own schema, never the principal"*).
3. Background work for one user (refreshing that user's tokens) would need "run as u1", which the walkthrough itself
   lists as unsolved (its open point 1).

**What Chord already gives.** Half of "a copy per user" is free: a remote object's identity is (type, params,
principal key), so `McpServers {}` held by Mario and by Colin are already two objects. Only persisted data needs a
key, and Chord has keyed documents (design §5 "Keyed state members", example `test/examples/24-keyed-members.ts`).
The factory pins the caller's key synchronously, because the key comes from the principal; Chord loads it during
activation:

```ts
// PROPOSED · this rundown: per-user data with today's Chord API (keyed documents, a store, a per-principal object)
const Configs = defineState("mcp.configs", {
	schema: obj({ servers: arr(ServerConfig) }),
	version: 1,
	initial: () => ({ servers: [] }),
	keyed: true,                                         // one document per user id
	persist: true,
	checkpointWhen: () => true,
});

/** Every user's MCP servers, once per server: a store (local, empty params), the only place that writes them. */
export const McpStore = local("mcp.store", {
	version: 1,
	params: {},
	members: {
		configs: keyed(obj({ servers: arr(ServerConfig) })),
		add: method(obj({ user: str(), config: ServerConfig })),
	},
});

host.serve(McpStore, (_params, self) => {
	const configs = self.state(Configs);
	return {
		configs,
		add: async ({ user, config }, ctx) => {
			await configs.change(user, (draft) => { draft.servers.push(config); }, ctx);
			return null;
		},
	};
});

/** My MCP servers: one object per user already, because a remote object's identity includes the principal. */
host.serve(McpServers, (_params, principal, self) => {
	if (principal.kind !== "user") throw forbidden("users only");
	const store = self.get(McpStore, {});
	const mine = store.configs.at(principal.id);         // pinned in the factory: the key comes from the principal
	return {
		variant: "user",
		members: {
			servers: self.derive([mine], ([doc]) => doc.servers.map(toInfo)),
			create: ({ config }, ctx) => store.add({ user: principal.id, config }, ctx),
		},
	};
});
```

A p3 API helper can hide the read side (refuse non-users, pin `at(principal.id)`, hand the plugin `mine`). It cannot
hide the write side completely: a store method takes data, never a function (design §5, *"No callbacks as
arguments"*), so writes stay store methods with the user as an argument, and the store's own routines do background
work for all users at once. The plugin author writes two small objects instead of one, and never sees another user's
data from a per-principal object.

## Edge 2: operation gates

**What it assumes.** A hook in Chord's remote method dispatch that runs `await gate.decide(...)` before the handler.

**Where it breaks.**

1. Chord has no such hook, and its design rejects one: principle 2 (the owner enforces its rules in its methods), §7
   (authority checks live in the per-principal view's methods), §17 (registries never replace an owner's checks).
   This is a design change to Chord, not a missing helper.
2. The sketch's company policy is `async` and awaits `directory.groupsOf`. The same policy must also answer inside
   derives: the book's effective list drops denied entries in a derive, and a page's "what may I create" list is a
   derive. Derives are synchronous.

**How to write it with today's Chord.** Gating is a property of the methods an object returns, and a factory returns
plain functions. p3's API can serve a plugin's factory through a wrapper that wraps the named methods; the wrapper
declares the policy registry like any dependency. The plugin's handlers still contain no checks:

```ts
// PROPOSED · this rundown: a gate without a Chord hook (types simplified). Every Chord call here exists today.
export function serveGated<C extends Contract>(
	host: FacetHost<P3Principal>,
	Type: C,
	operations: readonly Operation[],                    // operation(McpServers, "create", { facts }) values
	factory: Factory<C, P3Principal>,
): void {
	host.serve(Type, (params, principal, self) => {
		const policy = self.registry(Policies);            // a declared dependency: the object parks until there is one
		const made = factory(params, principal, self);     // the plugin's own factory, still synchronous
		const members: Record<string, unknown> = { ...made.members };
		for (const op of operations) {
			const handler = members[op.method] as ((args: unknown, ctx: Ctx) => Promise<unknown>) | undefined;
			if (handler === undefined) continue;              // not in this variant
			members[op.method] = async (args: unknown, ctx: Ctx) => {
				const decision = policy.value.decide({ principal, operation: op.name, object: { contract: Type.name, params }, args, facts: op.facts(args) });
				if (decision.kind === "deny") throw forbidden(decision.reason);
				return handler(args, ctx);
			};
		}
		return { variant: made.variant, members };
	});
}

// The plugin, unchanged except for the serve call:
serveGated(host, McpServers, [CreateMcp, RemoveMcp], (_params, principal, self) => { /* as in edge 1 */ });
```

If p3's API hands plugins a facet `host` whose `serve` does this for every contract that declares operations, plugins
do not even call `serveGated`. Calls between trusted code on the server (a store's methods) are not gated, which is
correct: stores have no caller principal. The open choice is the policy's shape (chapter IV): with a synchronous
`decide` over followed state, the same policy serves gates and derives.

## Edge 3: resources on sessions

**What it assumes.** That the platform checks a resource reference against the session's list before the plugin's
object for it is made, and sets the scope to the resource's owner.

**Where it breaks.** The walkthrough's third-party plugin:

```ts
// PROPOSED · apps/p3/docs/multiuser-walkthrough.md, part C (2026-11-13), excerpts
export const TodoList = remote("todos.list", {
	version: 1,
	params: { resource: ResourceRefParam },
	// …
});

host.serve(TodoList, ({ resource }, _principal, inner) => {
	// The platform has checked the ref against the session list and set the scope to its owner.
	const items = inner.table(Items);
	// …
});

defineTool({ name: "add", parameters: obj({ text: str() }),
	execute: async ({ text }, ctx) => (await ctx.get(TodoList, { resource })).add({ text }, ctx) }),
```

1. **Params are flat** strings, integers, booleans or literals. `{ resource: ResourceRefParam }` (an object) is
   refused at declaration.
2. **No check before the factory.** The list lives in a server table or derive; reading it is async; Chord has no
   async activation guard. A worker's hold of a server object goes over its parent link, where the server sees only
   the worker principal ("Upward is a boundary", design §4), and there is no `authorize` in that direction.
3. **A check at hold time would not be enough anyway.** Colin withdraws Linear while the worker holds the reference;
   the object lives on. The resource-model book already says "check again at every call".
4. **Tools get a Durable `Context`, not a Chord `ctx`** (design §24). Durable's `execute` is `(args, api, context)`; a
   tool reaches Chord objects through a root (`chord(fn, context)` in the design, `worker().root(fn, context)` in p2).
5. **`inner.table`** in a remote factory: as in edge 1.

**How to write it with today's Chord.** The resource's identity is the params (flat); the factory declares the
session's list, chosen by the worker principal; every method checks the list, and the state members hide the data
when the resource leaves the list. This is the telemetry pattern from chapter I:

```ts
// PROPOSED · this rundown: a resource's server object for one session's worker, with today's Chord API.
// SessionList is the resource-model book's per-session list (chapter III); TodoStore a store as in edge 1.
export const TodoList = remote("todos.list", {
	version: 1,
	params: { owner: str(), id: str() },               // flat: the kind is the contract, (owner, id) the resource
	hostAddress: () => Server(),
	variants: { worker: { state: { todos: arr(Todo) }, methods: { add: method(obj({ text: str() }), str()) } } },
});

host.serve(TodoList, ({ owner, id }, principal, self) => {
	if (principal.kind !== "worker") throw forbidden("session workers only");
	const list = self.get(SessionList, { session: principal.session }).list;
	const store = self.get(TodoStore, {});
	const items = store.lists.at(`${owner}/${id}`);
	const brought = (value: SessionListValue) =>
		value.kind === "ready" &&
		value.entries.some((e) => e.resource.name === "todos.list" && e.resource.id === id && e.owner === owner);
	return {
		variant: "worker",
		members: {
			// Withdrawn: the data disappears from the worker's view at once.
			todos: self.derive([items, list], ([doc, current]) => (brought(current) ? doc.todos : [])),
			add: async ({ text }, ctx) => {
				if (!brought(list.value)) throw forbidden("This list is not brought into this session.");
				return store.add({ list: `${owner}/${id}`, text }, ctx);
			},
		},
	};
});
```

On the worker, a store follows the same list and keeps one extension per
brought resource in a writable it contributes, which is how p2's MCP plugin offers one extension per server:

```ts
// BUILT · apps/p2/plugins/mcp/worker.ts (excerpt): the pattern a resource kind's worker side copies
function mcpWorker(self: StoreSelf): void {
	const harness = harnessOf(self);
	const worker = workerOf(self);
	const view = self.get(Mcp, {});
	const call: McpCall = async ({ conversationId, read, ...request }, context) => {
		const location = await harness().environments.locate(conversationId, context, read);
		return worker().root((ctx) => expectVariant(view, "worker").call({ location, ...request }, ctx), context);
	};
	// …
	const extension = self.writable(createMcpExtensions({ servers: [], tools: [], reach: "codemode" }, call));
	self.contribute(Extensions, extension);
	self.onLive((ctx) => offerTools(view, reach, extension, call, ctx));
	leaseLocations(self, view, harness, worker);
}
```

The p3 version swaps `view.servers` for the session's list and builds `defineExtension({ name, namespace, tools })`
per entry; each tool's `execute(args, api, context)` opens `worker().root(...)` and calls the server object above. If
core should enforce the list without trusting each plugin's filter, the resource-model book's shape is the one that
fits Chord: contributions are pairs `[resource, extension]` and the harness drops pairs whose resource is not on the
list (chapter XII).

## Is p2's lock the single-user version?

Mostly, yes. The lock is a per-session list the owner picks, kept on the server, followed by the worker, mirrored into
Durable, checked by the tool guard and by server objects at each call (chapter III). Two differences: it names
capabilities (`ports`, `conversations`) and instructions, which p3 would have to make resources; and it leaves bash
and file tools to the location's sandbox, while the resource-model book makes bash a resource.

## The three edges at a glance

| Edge | Needs a Chord change as proposed | Form with today's Chord | What the plugin writes | Decision it needs |
| --- | --- | --- | --- | --- |
| user scopes | `scope` on tables, documents, contracts; `ctx.scope`; "run as user" | a store with keyed documents + a per-principal object pinning `at(principal.id)` | two objects; writes take the user as data | library pattern or Chord-level scopes |
| operation gates | a dispatch hook in Chord, against principles 2, §7, §17 | p3's `serve` wraps the methods its operations name | `operation(...)` declarations | policy sync or async; core's request union or plugins' operations |
| resources on sessions | object params; a check before the factory | flat params; the factory declares the session's list; every method checks it; state hides withdrawn data | the check line, or a p3 helper that adds it | central index or per-plugin lists; who enforces on the worker |

# Views and Items {#views lede="Part 2. What is on screen: decided at the level of plugins and items, built in p2 per session and per device, and proposed today as layouts that host placements of several sessions."}

## Decided

- **UI is contributed from a plugin's facet** (2026-11-06): objects supply data, never the UI.
- **Groupings and views are plugins** (2026-11-07, relayed from the owner's talk with Christian, Max and David): the
  page's route is a `(kind, id)` of an addressable thing; the main area renders the view registered for that kind;
  group kinds and views are registries; *"the layout itself is plugin-defined (sidebar + transcript + panel is one
  layout among others, shipped as the default 'so as not to rattle cages')"*; access control must attach to the same
  model later.
- **The agent writes plugins; sketches stay single-player** (2026-11-11): anything multiplayer or persistent (games,
  shared boards, Max's glyph editor) is a plugin the agent writes and applies; html views stay single-player
  artifacts. Rooms, view principals and views.md's two tiers are dropped.
- **Artifacts and views** (2026-11-12; p2 first, p3 the same structure with rough edges sanded down): each plugin owns
  its per-session data, keyed by the session's host address; `ArtifactKinds` collects listable items; `ViewKinds`
  only gives panes (`PaneProps` `item`, `inline`); inline artifacts are a tool card rendering the item's pane; a
  reader who may not change the session's views opens an item in the artifacts side panel on their own device; clone
  and fork copy artifacts.

## Built in p2

The two registries the 2026-11-12 decision names:

```ts
// BUILT · apps/p2/src/web/view-kinds.ts (excerpt)
/** What a pane gets: the item it shows, where it shows, whether the person may change it, and its annotations. */
export type PaneProps = {
	readonly session: string;
	/** The item the view shows (an artifact's ID, a Markdown file); absent for a view of the whole kind. */
	readonly item?: string;
	/** In the transcript (a tool card), not beside it: no view, no selection, no annotations. */
	readonly inline: boolean;
	/** The view beside the transcript (absent inline): its ID, kind and title. */
	readonly view?: View;
	/** The person may send in the session: their selections and changes are saved. */
	readonly editable: boolean;
	// … select, annotations
};
export type ViewKind = { readonly Pane: ComponentType<PaneProps> };
export const ViewKinds = keyedRegistry<ViewKind>("p2.view-kinds");

// BUILT · apps/p2/src/web/artifact-kinds.ts (excerpt)
export type ArtifactKind = {
	readonly title: string;
	readonly icon: ComponentType;
	readonly useItems: (session: string) => readonly ArtifactItem[] | undefined;
	readonly useCount: (session: string) => number | undefined;
	readonly Row?: ComponentType<{ readonly item: ArtifactItem }>;
	/** The view kind (`ViewKinds`) that opens an item. */
	readonly view: string;
	readonly useRemove?: (session: string) => ((id: string) => Promise<void>) | undefined;
};
export const ArtifactKinds = keyedRegistry<ArtifactKind>("p2.artifact-kinds");
```

A session's open views are the session's data, in its Durable document `p2.views`; the layout is each device's:

```ts
// BUILT · apps/p2/plugins/views/contract.ts (excerpt)
/** One view of a session: what it is (its kind and the item it shows), its title and the person's selection. */
export const ViewSchema = obj({
	id: Id,
	kind: ViewKindNameSchema,
	/** `markdown`: the file, relative to the workspace; `changes`: only changes below this path; a plugin's item ID. */
	item: opt(ViewItemSchema),
	title: str({ minLength: 1, maxLength: 120 }),
	selection: opt(SelectionSchema),
	/** When the agent last asked to show it: devices bring it to the front (and show it again) when this grows. */
	focus: num(),
	created: num(),
});
```

| Fact | Owner | Where (p2, `docs/views.md`) |
| --- | --- | --- |
| the session's views, selections, annotations | the session's worker | Durable document `p2.views` |
| the layout, the views hidden on a device | each device | `localStorage` `p2.views.layout:<session>` |
| the agent's last arrangement | the session's worker | `p2.views` (`arrangement`), adopted once per device |
| what a view shows | the item's owner | a workspace file, the artifacts store, a plugin's store |

The agent opens and arranges views with code-mode tools in namespace `view` (`view_open({ kind, item?, title? })`,
`view_arrange`, …). People who may send open, close, select and annotate; viewers read; a read-only guest opens
artifacts in the side panel on their own device. Panes render as siblings in a fixed order and are only positioned,
so rearranging never remounts a frame.

## Proposed

**`apps/p3/docs/views.md`** (2026-11-10, p3 session). A view kind is typed with params; session or global follows from
the params; renderers per surface (`WebViews`, `TuiViews`); slots inside views (`TranscriptEntries`, `ComposerParts`);
the workbench owns pane chrome, a fixed bar and safe mode; **layouts are apps** (recorded there as the owner's
direction of 2026-11-10, not as an entry in `decisions.md`): an app is a layout of views for one purpose, switched in
the fixed bar.

```ts
// PROPOSED · apps/p3/docs/views.md §2 (2026-11-10), excerpt
export const Changes = defineViewKind("changes", { session: str(), path: str() });
self.contribute(WebViews, { [Changes.name]: ({ params }) => <ChangesPane session={params.session} path={params.path} /> });
```

**The views mockup** (`apps/p2/docs/views-mock/index.html`, 2026-11-13, uncommitted). One way to open everything:
every tab strip ends in **+**; its sheet lists recently closed views, kinds that need no item, this session's items by
kind, and other sessions; the top bar loses its artifacts, terminal and folder buttons; a terminal tab is a view of a
running terminal item, and closing it leaves the terminal running; on the desktop each area belongs to a session
(shown at the strip's right) and its "+" lists that session's items. Its legend: *"Mail, Calendar, Traces: global …
Files, Changes, Search: the session's location … Terminals, artifacts, games: per session."*

**Today's p3 session** (not decided, relayed in the brief for this rundown):

- "+" at the end of every tab strip is the one way to open things: view kinds that need no item, items of the current
  session through `ArtifactKinds`, recently closed;
- terminals and the workspace become view kinds; no separate Views button, so no hidden views;
- the layout (an app) is the host, per user and device class;
- a placement is `{ view kind, item, session }`, where the session follows the app's current session or is pinned;
- where data lives is the plugin's business (mail global or per user; artifacts, terminals and games per session);
- session colors when several sessions show; guests see placements only of sessions they may see.

Written as a type so the pieces can be compared (this rundown's rendering of the proposal, not anyone's code):

```ts
// PROPOSED · this rundown, rendering today's p3 session's proposal as types
type Placement = {
	readonly kind: string;                                   // a ViewKinds name: "transcript", "terminal", "mail"
	readonly item?: string;                                  // absent for kinds that need none (files, mail)
	readonly session: { readonly kind: "follow" } | { readonly kind: "pinned"; readonly session: string };
};
type Layout = {                                            // an app's arrangement, per user and device class
	readonly app: string;
	readonly device: "phone" | "desktop";
	readonly current: string | null;                         // the session "follow" placements show
	readonly root: Area | Split;                             // areas of tabs (placements) inside splits, as p2's layout
	readonly closed: readonly Placement[];                   // "Recently closed" in the "+" sheet
};
```

**`apps/p3/docs/layouts/mocks.html`** (p3 session, 2026-11-10 onwards): mockups of layouts beyond sidebar, chat,
sidebar: a cross-session inbox of everything that needs a human, a board of runs, and others. They show what an app
could be; they decide nothing.

## Contradictions

:::review | Review: who owns the open views
In p2 a view belongs to a session (Durable `p2.views`) and its layout to a device. In today's proposal a placement
belongs to a layout, which belongs to a user and a device class, and may show several sessions. Then `view_open` from
a session's agent must find a layout to put the placement in, and a session's views are no longer the session's data
(export, fork and guests then see nothing of them). Neither document says which is primary.
:::

:::review | Review: typed params or one item string
`views.md` gives kinds typed params (`{ session, path }`). The 2026-11-12 decision and p2 give a pane `session` plus one
`item` string. The decision is newer; `views.md` §2 is stale on this.
:::

- **Hidden views.** p2 hides views a device's layout leaves out (`docs/views.md`: "the views hidden on a device");
  today's proposal wants none hidden, everything reachable from "+".
- **Per device or per device class.** p2 and `views.md` §5: per device; today: per user and device class.
- **"Viewers read everything."** `apps/p2/docs/views.md` says so; p2's workspace and file index serve participants
  only (`plugins/file-index/worker.ts`: *"view-only guests get no file names"*). A read-only guest sees the transcript
  and artifacts, not files or changes.
- **Two searches.** The mock's Search is a search at the session's location; p2's `search` plugin is the owner's
  search over all sessions' transcripts (`plugins/search/server.ts`: *"search is owner-only"*).

# Who Sees Which View {#screens lede="Eleven kinds of view, side by side: whose data, where it lives, who sees and acts, how it opens and comes back, and every open question."}

The table describes p2 as built unless a cell says *proposed*. "Full guest" is p2's guest with `"full"`, "read-only
guest" one with `"view"`. p3 has no answer for any column yet: its users, guests and policy are open (chapters II, V).

| View | Whose data, where it lives | Owner | Full guest | Read-only guest | Opened / reopened |
| --- | --- | --- | --- | --- | --- |
| **transcript** | the session's; Durable transcript in the session worker's store | reads, sends, stops, branches | reads, sends, stops | reads (`viewer` variant) | always the first pane of a session; *proposed*: a view kind like any other, a "chat" tab per session, back through "+" (other sessions) |
| **composer** | part of the chat pane; drafts per author in the worker (`plugins/drafts`) | types, sends | types, sends | none | with the transcript; *proposed* (`views.md`): its own prebuilt view kind with `ComposerParts` |
| **changes** | the working tree at the session's location, computed by the worker (`plugins/workspace`) | sees | sees | none ("participants only") | view kind `changes` (`view_open`), the workspace panel; *proposed*: a kind that needs no item, from "+" |
| **files** | the location's file system (`workspace`, `file-index`) | browses | browses | none | the top bar's folder button opens the workspace; *proposed*: a view kind, no item |
| **terminal** | per session; processes of the server's `TerminalService` on the session's environment | opens, types | none ("terminals are owner-only") | none | top bar button, the agent's terminal tool; *proposed*: a view of a running terminal item; closing the tab leaves it running; back through "+" or recently closed |
| **search** | p2: the owner's index over all sessions (server SQLite); mock: a search at the location | searches | none | none | p2: the command menu; *proposed*: a kind from "+" (which search is unclear) |
| **html / md artifact** | the session's; server documents keyed by `Session` address, versions in `artifact_versions` | edits state, removes | edits state, removes | reads; html `readOnly`; opens in the side panel on its own device | `artifact_show` (inline), `artifact_open`, the artifacts side panel (`ArtifactKinds`), "Open artifact…"; back from the side panel |
| **game** | an agent-written plugin's server object; items per session (2026-11-11) | what the plugin's variants give | what the plugin's variants give | what the plugin's viewer variant gives | `view_open({ kind, item })`; listed through `ArtifactKinds`; *proposed*: "+ → Games" |
| **mail** | the owner's Gmail accounts (mail plugin of the owner's install); global, not per session | reads, drafts; only the owner sends | none | none | `view_open({ kind: "mail" })`; *proposed*: a global kind from "+", the same inbox in every session; in p3 per user |
| **calendar** | the owner's Google calendars; global | reads, responds, creates; the agent only with the owner's approval | none | none | `view_open({ kind: "calendar" })`; *proposed*: as mail |
| **traces** | the server's telemetry store; instance-wide | reads | none | none | the Traces view kind, "Show traces"; the agent's `telemetry` tools only in sessions neither shared nor locked |

Three things stand out. First, p2's rule for a full guest is narrower than "may do what the owner does": no terminal,
no search, no mail, though the same guest can have the agent run `bash` (the 2026-11-11 decision says so). Second,
mail, calendar and traces are global: they belong to a person or the instance, not a session, and a guest never
sees them. Third, only the transcript, composer and artifacts have a read-only form today.

## Several sessions in one layout

The mock's desktop shows two sessions side by side ("p3: skeleton" with its terminal, "Email" with Mail); each area
belongs to a session and its "+" lists that session's items. Today's proposal adds placements that follow the app's
current session or are pinned to one, and session colors when several show. p2 has none of this: its workbench is
per session (`p2.views.layout:<session>`).

## Guests on screen

`sharing.md` (2026-11-10, not decided) recommends that the server project the guest's layout from the source app:
views whose objects give the guest nothing are dropped, and the app may list views it never shows to guests. Its owner
direction: *"Whoever shares accepts that everything shown for that session … is accessible to the guest. What a guest
sees follows from what the objects give the guest's principal."* Today's proposal: guests see placements only of
sessions they may see. Both agree that hiding a pane protects nothing; the objects behind it decide.

## Open questions

1. **Is a placement the session's data or the layout's?** p2: the session's (`p2.views`), so export, fork and guests
   carry it. Proposed: the layout's. If the layout's, where does `view_open` from an agent land, and what does a
   guest's page show?
2. **Who hosts the layout:** a per-user server record (synced across devices of a class), each device (p2), or an
   app's plugin?
3. **Device class or device:** two phones of one user share a layout or not?
4. **The "+" registry:** does `ViewKinds` gain `title`, `icon` and `needsItem` (the mock's legend says so), or is
   "+" a third registry?
5. **Recently closed:** per session, per layout or per user; how many; does it survive a reload?
6. **Closing a tab of an item with a lifetime** (a terminal, a running game): the mock says the item keeps running;
   who stops it, and from where, once no tab shows it?
7. **Terminals and files as view kinds:** which guests get them? p2 gives terminals to the owner only and files to
   participants.
8. **Global views in a shared layout:** mail, calendar and traces are a person's; a guest of a session in that layout
   must not get them. Dropped by the server projection or by their objects refusing (both, per `sharing.md`)?
9. **Session colors:** chosen by whom, stored where (session data or the layout)?
10. **Typed params or one item string** for view kinds (chapter VII review).
11. **Which search** is the "+" Search: the location's files or the user's sessions?
12. **The TUI:** p2 shows no views in the terminal; `views.md` §5 proposes the same kinds with `TuiViews`. Not
    scheduled.
13. **Layouts as apps:** recorded as owner direction in `views.md` (2026-11-10) and the plan of 2026-11-11, but not in
    `decisions.md`. Is it decided?

# What a Session's Worker Runs {#worker lede="Part 3. One process per session, the Durable harness inside it, and extensions from a registry: built in p2, designed in Chord §24, barely touched by p3's decisions."}

## Built in p2

Each session runs in its own worker process, started by the server through Chord's workers component and reached
over a route whose links stamp `{ kind: "worker", session, generation }`. The worker is a Chord host that loads every
plugin's worker facet. Its core opens pi-durable's `Harness` on the session's store, and the harness reads its
extensions from a Chord registry that host-lifetime objects and facets contribute to:

```ts
// BUILT · apps/p2/src/runtime/durable.ts (excerpt)
/**
 * Durable extensions every conversation of the worker may select, by name (host-lifetime objects contribute them). Their
 * tools declare their requirements (`P2Tool`).
 */
export const Extensions = keyedRegistry<Extension<P2Tool>>("p2.durable-extensions");

/**
 * Live switches of contributed extensions, by extension name: an extension whose switch reads `false` is left out of
 * Durable's registry, as if uninstalled, until it reads `true` again. Example: the `codemode` setting.
 */
export const ExtensionSwitches = keyedRegistry<boolean | undefined>("p2.extension-switches");

// in durableRegistry(extensions, switches, context): every tool with requirements is wrapped
for (const extension of installed)
	builder.install(extension.tools ? { ...extension, tools: extension.tools.map(guardTool) } : extension);
```

An extension is Durable's unit: a name, an optional code-mode namespace, tools, prompt sections, hooks, wraps and
tasks.

```ts
// BUILT · packages/durable/src/harness/types.ts (excerpt)
export type ToolNamespace = { readonly name: string; readonly description: string; readonly instructions?: string };

export interface Extension<Tool extends ToolRegistration = ToolRegistration> {
	readonly name: string;
	/**
	 * The code-mode namespace of this extension's tools (a tool named by several extensions belongs to the first). The
	 * `codemode` section lists it while the extension is selected, also before it has any tools.
	 */
	readonly namespace?: ToolNamespace;
	readonly tools?: readonly Tool[];
	readonly sections?: readonly PromptSection<Tool>[];
	readonly hooks?: readonly HookRegistration[];
	/** Apply where this extension is selected, in order. */
	readonly wraps?: readonly Wrap<Tool>[];
	/** Resolved by name for every task, whichever conversations select this extension. */
	readonly tasks?: readonly AnyTask[];
}
```

What else runs in a p2 worker, each a plugin's worker facet: the chat objects (one per conversation and principal),
the models (`WorkerModels`), the execution environments (local, SSH, gondolin sandboxes), code mode's sandbox
(`CodemodeRuntime`, one per worker), the MCP plugin's extensions (one per server; the processes and credentials stay
on the server), subagents, views, artifacts' tools, the lock mirror, drafts, files.

## Designed in Chord (§24)

Design §24 describes the same thing as p3's target: the harness is a store in the core facet (host lifetime) that
opens Durable paused with `self.open`, reads models, environments and extensions from registries at each use, and is
resumed after `host.load`. Tools, hooks and sections get Durable's `ToolExecutionApi` and a Durable `Context`, never a
Chord `ctx`; they reach Chord through `chord(async (ctx) => …, context)`, a root acting as the host. *"Tools, sections,
hooks, wraps and tasks reach the harness as one Durable `Extension` per plugin contributed to p3's core registry"*
(§17).

## Decided for p3

- **No per-run authority** (2026-11-08): no "who started this turn" anywhere in the worker.
- **Resource model direction** (2026-11-08): "one Durable extension = one resource"; workers follow their session's
  list live; the harness lets in only extensions whose resource is on the list.
- **Artifacts and views** (2026-11-12): plugin tools are code-mode only, grouped by the namespace their extension
  declares; the prompt lists namespaces from configuration, so it stays stable when servers connect.
- **The agent writes plugins** (2026-11-11): plugin tools are ordinary tools in the session's selection; *"a
  locked-down session does not get them, as it does not get `bash`"*.

p3 decided nothing about subagents, locations or code mode beyond this; they are p2's.

# The Filters {#filters lede="Seven places decide whether the model sees a tool and whether a call goes through; p3 must keep or replace each."}

Between "a plugin is installed" and "a tool call does something", p2 has seven filters. They run in this order.

:::flow wide animate | The filters a tool passes in a p2 worker, in order. Accent: the ones that concern people and resources; blue: the per-conversation choices.
row "Into the registry" muted
box installed "installed" "a live contribution to Extensions"
box switched "switched" "ExtensionSwitches (code mode)"
box guarded "wrapped" "guardTool on every tool" accent
row "Per conversation" blue
box selected "selected" "`AgentState.extensions`" blue
box enabled "enabled" "`AgentState.tools`" blue
box offered "offered" "modelTools, callers, deferred" blue
row "At the call" accent
box guard "guard runs" "scope and locked" accent
box server "server object checks" "per call: lock, sharing" accent
arrow installed -> switched
arrow switched -> guarded
arrow guarded -> selected
arrow selected -> enabled
arrow enabled -> offered
arrow offered -> guard "a call"
arrow guard -> server "the tool calls the server"
note "Prompt sections follow the same selection; the lock also decides instructions and skills."
:::

## 1–3: into Durable's registry

An extension is there while its contributor is live (design §17). `ExtensionSwitches` leaves switched-off extensions
out (code mode's setting). `durableRegistry` wraps every tool that declares requirements with `guardTool`.

## 4–6: per conversation (Durable)

Durable's `AgentState` holds each conversation's choices. Subagents use them to get a tool selection of their own:

```ts
// BUILT · packages/durable/src/harness/types.ts (excerpt)
export type AgentState = {
	model?: ModelRef;
	thinkingLevel?: ModelThinkingLevel;
	/** An array selects exactly these extensions, in order. An object edits the host default selection. */
	extensions?: string[] | { add?: string[]; remove?: string[] };
	/** Filters the selected extensions' tools: the enabled tools. An array enables exactly these, in order. */
	tools?: string[] | { remove: string[] };
	/**
	 * Filters the enabled tools the model may call (`callers` includes `model`): the tools offered to it. Never widens:
	 * other tools can still call the ones it leaves out.
	 */
	modelTools?: string[] | { remove?: string[]; add?: string[] };
	// … instructions, cwd, maxTurns, compaction
};
```

A tool's `callers` (`["model"]`, `["tools"]` or both) and `deferred` decide whether the model is offered it directly,
through code mode, or through `tool_search` when code mode is off.

## 7: the guard, and the server

```ts
// BUILT · apps/p2/src/runtime/tool-access.ts (excerpt)
export type ToolAccess = {
	/**
	 * Where it works: anywhere; only in the session's top-level conversations (`main`: the main conversation and its
	 * `/tree` branches, never a subagent or one-shot agent, for tools acting on the session itself); or offered only to
	 * subagents, which get it without choosing.
	 */
	readonly scope?: "any" | "main" | "subagent";
	/**
	 * In a locked session (`SessionLock`): `pass` (the default: what it reaches is limited by the lock elsewhere, MCP
	 * servers by their leases, location tools by the sandbox), `never`, or only when the owner picked the capability.
	 */
	readonly locked?: "pass" | "never" | LockCapability;
};

export function guardTool(tool: P2Tool): P2Tool {
	const rule = tool.locked ?? "pass";
	if (rule === "pass" && tool.scope !== "main") return tool;
	return {
		...tool,
		execute: async (args, api, context: Context): Promise<ToolExecutionResult | ToolPark> => {
			if (tool.scope === "main" && !(await isTopLevel(api, api.conversationId, context)))
				return refusal(`${tool.name} works only in the session's main conversation.`);
			if (rule !== "pass") {
				const lock = await sessionLock(api, context);
				if (lock && rule === "never") return refusal(`${tool.name} is not available in a locked session.`);
				if (lock && rule !== "never" && !lock.capabilities.includes(rule))
					return refusal(`${tool.name} is not among the resources the owner picked for this session.`);
			}
			return tool.execute(args, api, context);
		},
	};
}
```

Who uses which requirement today: `telemetry_*` is `locked: "never"`; `ports` is `locked: "ports"`, `scope: "main"`;
`conversations` is `locked: "conversations"`, `scope: "main"`; `subagent` is `scope: "main"`; `team` is
`scope: "subagent"`. Behind the guard, server objects check again at each call (chapter I: telemetry refuses a locked
or shared session's agent; MCP places only the lock's servers).

## Namespaces

Since 2026-11-12 (`5e24c6b1f`, "feat(durable)!: code-mode namespaces declared by extensions") an extension declares its
code-mode namespace; the `codemode` section lists it while the extension is selected, also before it has tools, so the
prompt stays byte-identical when deferred tools appear. p2's MCP plugin makes one extension per server, each with its
namespace, described from configuration only:

```ts
// BUILT · apps/p2/plugins/mcp/tools.ts (excerpt)
return Object.fromEntries(
	servers.map((server) => [
		mcpExtensionName(server.name),
		defineExtension<P2Tool>({
			name: mcpExtensionName(server.name),
			namespace: {
				name: mcpNamespace(server.name),
				description: namespaceDescription(server),
				...(server.instructions === undefined ? {} : { instructions: server.instructions }),
			},
			tools: registrations.filter((entry) => entry.server === server.name).map((entry) => entry.tool),
		}),
	]),
);
```

That is already "one Durable extension = one resource" for MCP servers. The p2 namespaces today: `artifact`, `view`,
`telemetry`, `mcp__<server>`; mail and calendar in the owner's own install.

:::review | Review: plugin tools in a locked session
The 2026-11-11 decision says a locked-down session does not get the plugin tools "as it does not get `bash`". In p2,
`reload_plugins` (`plugins/dev-tools/tool.ts`) declares no requirement, so the guard passes it in a locked session; and
p2's lock does not remove `bash` either (`locked` defaults to `pass`; the location's sandbox limits it). Either the
decision assumes a p3 list that leaves both out, or p2 should mark `reload_plugins` `locked: "never"`.
:::

# Subagents and Places {#subagents lede="Conversations inside one worker, each with its own tools and its own location; built in p2, not discussed for p3."}

## Built in p2

- **Subagents** are conversations in the same harness (`plugins/subagents`), started by the `subagent` tool
  (`scope: "main"`) with their own `model`, `thinkingLevel`, `tools` (written to their `AgentState`), and optionally
  their own `cwd` and `env`. The `team` tool is offered only to subagents (`scope: "subagent"`). A subagent's tools
  are a subset of what the worker has installed; its lock is the session's.
- **Locations.** Every conversation works at a location (an environment and a directory). The location tools move the
  main agent once its turn ended (`location_move`, `plugins/locations`); environments are local, SSH or gondolin
  sandboxes, and a conversation in a sandbox cannot leave it.
- **MCP follows locations.** The worker leases the conversations' locations to the server's MCP plugin, which runs the
  server processes there (project `.pi/mcp.json` included); *"No MCP process or credential is ever in a worker"*
  (`plugins/mcp/worker.ts`).
- **Agent-written plugins** need the server's machine: a session elsewhere spawns a subagent with `env: null` and
  `cwd: <data>/plugins` (`docs/agent-plugins.md`).

## p3

Nothing decided. The owner's direction in `sharing.md` §4 (2026-11-10): *"No per-user environments. A session in any
app may use every environment of the instance; an app may lock its sessions to one environment it chooses."* The
resource-model book (chapter "Models, Machines, Drives") makes machines resources owned by users. These two disagree.

## Open questions

1. Is a subagent's tool selection always a subset of the session's list? (In p2 yes by construction: it selects from
   what is installed, and the lock applies to all conversations.)
2. Are environments resources (the book) or instance-wide (`sharing.md`)?
3. A resource bound to a location (a project's stdio MCP server): the walkthrough's open point 7 says its identity is
   (resource, location). Does bringing it bring it for every location the session works in?

# The Worker and the People {#worker-people lede="How a session's worker relates to users, resources, policies and locks: what p2 does, what p3 decided, what is proposed, and how the proposals fit the factory rule."}

## Who the worker acts as

Always itself. Towards the server its principal is `{ kind: "worker", session }` (p2 adds `generation`); the server
ignores principal fields from a child link (design §4, "Upward is a boundary"), so a worker cannot claim to be a
user. People's input arrives as entries with an author the worker assigns from the caller's principal (p2:
`authorOf(principal, ownerName)`), and the model sees a `<sender kind="owner|guest|session|subagent" …/>` block. No
tool knows who asked. That is the decided "no per-run authority" (2026-11-08) and it is built (p2 removed `origin`,
`docs/agent-plugins.md`).

## The pieces, side by side

| Concern | Built in p2 | Decided for p3 | Proposed |
| --- | --- | --- | --- |
| who is in the session | owner + guests in the principal; author on each entry | principals `user`, `guest`, `worker`, `server` | `sessions.people` rows (walkthrough); chapter V's options |
| what the agent may use | installed extensions, minus the lock's exclusions; locations | the session's one list; "one Durable extension = one resource" | resource-model: extensions keyed by resource; walkthrough: `ResourceExtensions` per kind |
| how the worker learns it | lock mirrored into Durable (`LockMirror`) | "workers follow their session's list live" | `SessionResources {}` on the server, worker variant (book) |
| where it is enforced | `guardTool` at the call; server objects per call | "the harness lets in only extensions whose resource is on it"; "resource plugins' per-session server views check the list" | harness drops pairs whose resource left the list and wraps tools (book) |
| policy | none (one owner) | one replaceable policy plugin | applied on the server while computing the list (book); gates on methods (sketch) |
| credentials | never in the worker (MCP on the server; models through the server) | none specific | `AccountCredentials` pushed short-lived tokens (accounts book); "one resource, one login" (users sketch) |

## The proposed harness, and whether it fits Chord

The resource-model book's harness respects the factory rule: it declares the extensions registry and the session's
list in the factory, opens Durable as a native, and checks the list at compose time and at each call:

```ts
// PROPOSED · apps/p3/docs/resource-model/book.md, chapter "On the Worker" (2026-11-08), excerpt
export type HarnessExtension = readonly [resource: ResourceRef, extension: Extension];
export const Extensions = defineRegistry<
	readonly HarnessExtension[] | Watchable<readonly HarnessExtension[]>, ExtensionTable
>("harness.extensions", { version: 1 });

host.serve(HarnessHost, (_params, self) => {
	const extensions = self.registry(Extensions);
	const resources = self.get(SessionResources, {});

	/** Whether `resource` may be used now: the server link live, the list ready, the entry there and not expired. */
	const allowed = (resource: ResourceRef): boolean => {
		if (resources.state.value.kind !== "live") return false;              // a lost link keeps last values, not permission
		const list = resources.list.value;
		if (list.kind !== "ready") return false;
		const now = Date.now();
		return list.entries.some((e) => sameResource(e.resource, resource) && (e.until === null || e.until > now));
	};

	// Durable's registry, built as p2's durableRegistry (apps/p2/src/runtime/durable.ts) with `allowed` in place of
	// switches: rebuilt when the extensions or the list change, and every tool's execute wrapped so a call is refused
	// when `allowed` turns false mid-phase (captured code-mode tools, nested calls included).
	const registry = self.open((ctx) => durableRegistry(extensions, resources.list, allowed, ctx), closeRegistry);
	return {};
});
```

It is p2's `durableRegistry` with the lock replaced by the list: the same three moves (follow, compose, wrap). One
detail does not fit design §24 as written: there the harness is base code in the core facet, here a plugin
(`plugins/harness`) owns the registry. Either is possible; the 2026-11-06 "Reloads first" decision ("every behaviour
… is a plugin") favours the plugin.

The walkthrough's version (`ResourceExtensions` with an `extension(resource, label)` factory per kind) has the tools
call `ctx.get(...)` inside `execute(args, ctx)`; with Durable that is `execute(args, api, context)` and a Chord root
(chapter VI, edge 3).

## Locks become the list

p2's lock answers "what may this session's agent use" for one owner. In p3 the decided answer is the session's list,
with three sources (own, defaults, a grouping). The p2 lock is then exactly a session whose source is "own". What has
no p3 home yet: the lock's `instructions` flag (global AGENTS.md, skills, prompt templates) and the capabilities
`ports` and `conversations`; in the book's terms they would be instance resources brought by their plugins.

## Open questions

1. **Who enforces on the worker:** core (extensions keyed by resource, the book) or each resource plugin (it
   contributes extensions only for listed resources, the walkthrough)? Recommended by the book: core, and the server
   objects check again.
2. **"Belongs to the contributing plugin"** (decision) or not (book, third edition): chapter III review.
3. **Instructions and skills** in a session's list: one resource ("global instructions") as in p2's lock, or one per
   skill?
4. **Namespaces for several resources of a kind:** the walkthrough names them `mcp__gmail_work` and adds the owner
   and account to the description; the decision says the prompt lists namespaces "from configuration, so it stays
   stable". Bringing or withdrawing a resource changes the prompt by design; is that acceptable for prompt caching?
5. **Credentials:** models and MCP use the server today. Does any p3 resource push credentials to the worker (the
   accounts book's `AccountCredentials`), or does every use go through a server object?

# Ten Rules and the Decisions Left {.epilogue lede="One page: ten rules that would settle most of the above (proposed by this rundown), and the owner's open decisions in the order they unblock the most."}

## Ten rules (proposed)

1. **A factory decides only from params and the principal.** Everything else is checked in methods and shown as
   derived state. (Chord as it is; no async activation guard.)
2. **Per-user data lives in a store keyed by user id.** The per-user object pins `at(principal.id)` in its factory.
   No `scope` option in Chord.
3. **A resource's owner is a user or the instance.** You create and bring only your own; who may create or bring
   instance resources is the policy's call. (Decided 2026-11-13.)
4. **A session has one list, from one source.** Everyone who may send uses all of it. No per-run authority. (Decided
   2026-11-08.)
5. **The list is computed on the server and followed by the worker.** The policy is applied when the list is
   computed; the worker never asks the policy.
6. **Every server object a worker calls for a resource checks the list at each call** and hides the resource's data
   in its derived state once it is withdrawn.
7. **The policy is one synchronous function over state its plugin follows,** with the asking code's baseline. Hard
   rules (you bring only your own) come first and no policy changes them.
8. **Guarded methods are wrapped when served,** by p3's API from the operations a contract declares, never by a hook
   in Chord's dispatch.
9. **A view shows an item a plugin owns.** The plugin decides where the item's data lives and who sees it, through its
   per-principal objects; the layout only places.
10. **A guest sees exactly what the objects give their principal.** A layout or a hidden pane never protects anything.

## Decisions for the owner, in the order they unblock the most

1. **Where "may view, may send" lives for users:** in the principal (p2), as followed state checked per call, or a
   principal per session (chapter V, a/b/c).
2. **Policy shape:** synchronous over followed state, or async (chapter IV).
3. **Per-user data:** the store-plus-pin pattern of edge 1, or Chord-level scopes.
4. **Resource index:** one central index (resource-model book) or per-plugin `list()` (walkthrough).
5. **Defaults are a live rule** (decision of 2026-11-08): confirm, and drop the walkthrough's copy at creation.
6. **Guarded operations:** core's typed request union, or plugins' operations with shared facts; who keeps the fact
   vocabulary.
7. **Who enforces on the worker:** core (extensions keyed by resource) or each resource plugin; and whether "belongs
   to the contributing plugin" stays.
8. **Retire stale texts:** `INSTANCE` in two books, account grants, `sharing.md`'s "resource model shelved",
   `views.md`'s typed params and two tiers.
9. **Guests in p3:** their own principal kind (p2's shape) or a link admission into a user-like principal.
10. **Placements:** session data (p2) or layout data, and who hosts layouts (per user and device class, or per device).
11. **The "+" registry:** `ViewKinds` gains title, icon and `needsItem`; where recently closed is kept.
12. **Terminals and files as view kinds,** and which guests get them.
13. **Environments:** instance-wide (`sharing.md`) or resources owned by users (book).
14. **Lock capabilities and instructions** as instance resources.
15. **Plugin tools in a locked session:** mark `reload_plugins` `locked: "never"` in p2, or change the decision's
    wording.
16. **Layouts as apps:** record it in `decisions.md` or not.

# Sources and Their Status {.appendix}

| Source | Date, author | Status |
| --- | --- | --- |
| `apps/p3/docs/decisions.md` | owner, 2026-11-06 to 2026-11-13 | decided; newest wins |
| `apps/p3/docs/accounts/book.md` | p3 session, 2026-11-07 | proposal; grants superseded, `AccountProviders` unanswered |
| `apps/p3/docs/resources-code/book.md` | p3 session, 2026-11-08 | proposal, first sketch; superseded by the resource-model book |
| `apps/p3/docs/resource-model/book.md` | p3 session, 2026-11-08, third edition | proposal; `INSTANCE` superseded 2026-11-13 |
| `/tmp/users-chapter.md` | p3 session, 2026-11-08 | the book's chapter II; `INSTANCE` superseded |
| `apps/p3/docs/sharing.md` | p3 session synthesis + owner direction, 2026-11-10 | proposal; §4 owner direction partly contradicted by 2026-11-13 |
| `apps/p3/docs/views.md` | p3 session, 2026-11-10 | proposal; §4–4a superseded 2026-11-11/12 |
| `apps/p3/docs/layouts/mocks.html` | p3 session, 2026-11-10 onwards | mockups |
| `apps/p3/docs/users-sketch.md` | p3 session, 2026-11-13, uncommitted | proposal |
| `apps/p3/docs/operation-gates-sketch.md` | p3 session, 2026-11-13, uncommitted | proposal |
| `apps/p3/docs/multiuser-walkthrough.md` | p3 session, 2026-11-13, uncommitted | proposal |
| `apps/p2/docs/views-mock/index.html` | 2026-11-13, uncommitted | mockup |
| the "three edges" proposal | another session, 2026-11-13 | proposal (chapter VI) |
| `apps/p2/docs/views.md`, `artifacts.md`, `agent-plugins.md`, `p2-notes.md` | p2 | built |
| `packages/chord/docs/design.md` | Chord | design; §1, §4–§7, §17, §24 read |

# Chord Calls the Rewrites Use {.appendix}

Every `PROPOSED · this rundown` block uses only these, checked in `packages/chord/src` at `origin/main`:

| Call | Where it is defined |
| --- | --- |
| `local`, `remote`, `method`, `keyed` | `contracts/declare.ts`, `contracts/schema.ts` |
| `defineState(name, { keyed: true, persist: true, checkpointWhen })` | `documents/definition.ts` |
| `host.serve(Type, factory)`, `Factory`, `FacetHost` | `host/facet.ts`, `host/attempt.ts` |
| `self.state`, `self.get`, `self.derive`, `self.registry`, `self.writable`, `self.onLive` | `host/attempt.ts` (`Self`), `host/routines.ts` |
| `self.contribute` (stores only) | `host/attempt.ts` (`StoreSelf`) |
| `ref.member.at(key)` (keyed pin in a factory) | design §5; `test/examples/24-keyed-members.ts` |
| `handle.change(key, fn, ctx)` on a keyed document | `test/examples/24-keyed-members.ts` |
| a route's `authorize(principal, address): boolean` | `host/host.ts`, `node/workers/workers.ts` |
| `host.revoke(revocation, ctx)` with the app's `revokedBy` | design §4; `apps/p2/src/runtime/principals.ts` |
| `forbidden(message)` | `data/errors.ts` |

Not Chord, and named as such where used: p2's helpers `contribute`, `workerOf`, `harnessOf`, `expectVariant`,
`deriveTyped`, `untilAborted`; the p3 contracts `SessionList`, `SessionPeople`, `Policies`, `TodoStore`, `Chat`,
`Conversation`, which exist only in the proposals.
