---
title: p3: what a session may use
cover: One List / Many Groupings
kicker: The spec · p3 resource model · third edition · 2026-11-08
subtitle: Resources, the one list each session uses, groupings that only show, one policy, workers that follow their list, and the screens on top, with every piece in code
stats:
  - 1 | function to define a resource, defineResource
  - 2 | ways one comes to exist, brought by a plugin or created by a person
  - 1 | field decides what a session may use
  - 0 | resource objects, resource kinds or grants
  - 1 | way to become a user: a sign-in plugin calls Identities.signIn
note: |
  The third edition, rewritten after the owner's code review of 2026-11-08 cut the abstractions of the second (resource
  kinds, built-ins, grants, resource objects). The model is the owner's decision "Resource model direction"
  (`apps/p3/docs/decisions.md`); the review by Astra and Sol of the second edition (appendix C) still applies, its fixes
  carried over. Chord APIs are real and checked against the source (`self.tx(fn, ctx)`, `tx.put`, `self.on`,
  `self.derive`, keyed members, registries with their contributing plugin); every p3 name is a proposal. Not built.
colophon: p3 resource model · spec, third edition · 2026-11-08
---

# Before we begin {.preface}

Mario runs p3 on his laptop. Every session he opens has his models, his MCP servers, his machines and every tool the
installed plugins offer, and he never configured any of it. At Earendil, Colin, Cristina and Charlotta share project pi:
its sessions use exactly what the three brought, each with its owner's login. A session fed by the #support Discord
channel may read the answers of one other session for an hour and has no shell at all.

Two questions were mixed up in every earlier model: *where does something appear* and *what may a session use*.
Groupings answer the first: recent, folders, projects, Discord channels, any number per session. One list answers the
second, and one field in the session catalog says where that list comes from.

## Eight things to know

:::findings
1. **A resource is a row,** kept by the resources plugin: a name, an id, an owner and a label. The name comes from
   `defineResource("mcp.server")` in the owning plugin's contract file; what the row means stays inside that plugin.
2. **A resource comes to exist in one of two ways.** A plugin brings it (bash: contributed while the plugin is
   installed, owned by the instance user), or a person creates it (Colin's Linear server: `Resources.create`, owned by
   Colin forever, with Colin's login).
3. **A session uses one list,** named by one field in the catalog: its owner's defaults, its own list, or the list of
   one grouping with resources (a project, a Discord channel). A project is not a resource; it is where a list lives.
4. **Defaults are a rule:** everything the session's owner owns plus every instance resource, minus the owner's
   exclusions. A new plugin's tool is in the next turn by itself.
5. **Everyone who may send in a session uses its whole list.** No per-run authority (owner, 2026-11-08).
6. **One policy decides,** asked by core at the moment something happens; plugins never import ACL, SAML or Radius;
   pages never check, they draw what server views say.
7. **Plugins read the list and use their own entries.** The harness lets an extension run only while the resource it
   is keyed by is on the list; the MCP plugin serves only the servers on the list; and they check again at every call.
8. **Resources on screen come from registries:** a creator sheet, a row and detail panels per resource definition,
   contributed by the owning plugin or any other; the session panel, the picker and "my resources" are core's.
:::

## Words used throughout

A **user** is a person with an account; the **instance user** (`INSTANCE`) owns company resources and everything
plugins bring. A **resource definition** is a token made by `defineResource(name)`. A **resource** is one row: the
definition's name plus an id (`null` for the single resource a plugin brings). A **list** holds **entries** (a
resource, who brought it, an optional expiry). A session's **resource source** names its list: **defaults**, **own**,
or a **grouping with resources**. The **effective list** is what the session actually gets after core drops withdrawn,
expired, missing and denied entries. A **grouping** shows things; a **grouping with resources** also keeps a list. The
**policy** answers typed **requests**. A **creator** is a resource definition's creation sheet; a **resource row** and
**resource panels** draw one resource.

# What a Resource Is {#resources lede="One row per resource, one function to define a name, and two ways a resource comes to exist."}

A resource is something a session can use. The model needs four facts about it, and nothing else:

1. an **id** a list can hold;
2. its **owner**: only the owner adds it to a list or withdraws it, and the defaults rule is "everything I own";
3. a **label** for pickers and panels;
4. the **name** of its definition, which tells every plugin whose resource it is.

That is one row in one table of the resources plugin. There is no resource object with state and methods: when a
resource has state (an MCP server's configuration, its sign-in, its tools), that state belongs to the plugin that made
it, keyed by the resource's id.

```ts
// plugins/resources/contract.ts: shared by every facet (server, worker, page)

/** A resource definition: a name a plugin owns, written once in its contract file. */
export type ResourceDefinition = { readonly name: string; readonly id: null };
export function defineResource(name: string): ResourceDefinition;

/** One resource as stored, listed and sent: its definition's name and, for created ones, an id. */
export const ResourceRef = obj({ name: str(), id: nullable(str()) });
export type ResourceRef = Static<typeof ResourceRef>;

/** A created resource of `definition` by its id. */
export function resourceOf(definition: ResourceDefinition, id: string): ResourceRef;
/** Whether `ref` is a resource of `definition`. */
export function isOf(ref: ResourceRef, definition: ResourceDefinition): boolean;
export function sameResource(a: ResourceRef, b: ResourceRef): boolean;
```

`defineResource` returns `{ name, id: null }`, so a definition is also the reference to the one resource a plugin
brings with it. Names are identities written once, like contract names; code passes the constant.

## Brought: it exists while the plugin is installed

```ts
// plugins/coding-tools/contract.ts
export const Bash = defineResource("coding-tools.bash");
export const FileTools = defineResource("coding-tools.files");

// plugins/coding-tools/server.ts
export default defineFacet((host, self) => {
	self.contribute(InstanceResources, [Bash, FileTools]);
});
```

`InstanceResources` is a server registry of the resources plugin. A contribution is in a Chord registry exactly while
its contributor is live (design §17): installed, Bash exists, owned by `INSTANCE`; uninstalled or failed, it is gone
and drops out of every list. Nothing is written, nobody is the actor: installing a plugin is the admin's act.

## Created: a person makes it, for themselves

Colin adds his Linear server. The MCP plugin's own user view does the work and calls the resources plugin for the row:

```ts
// plugins/mcp/server.ts (full plugin in chapter VIII)
create: async ({ owner, config }, ctx) => {
	const resource = await resources.create({ actor: principal.id, owner, definition: McpServer, label: config.name }, ctx);
	await store.add({ id: resource.id, config }, ctx);
	return resource;
},
```

**Actor and owner differ** only when an admin creates a company resource: the actor is the admin, the owner is
`INSTANCE`. Everyone else creates for themselves. `actor` is passed as data because a local call runs as the server
(design §4); it is always the link-stamped principal of the plugin's own user-facing method, never browser input.

## The resources plugin's server side

```ts
// plugins/resources/contract.server.ts: server-only declarations other plugins use
export const InstanceResources = defineRegistry<readonly ResourceDefinition[], BroughtResources>(
	"p3.instance-resources", { version: 1 });

export const Resources = local("p3.resources", {
	version: 1,
	params: {},
	members: {
		/** Every resource: created rows and brought ones, by resource key. */
		index: map(IndexRow),                                   // { resource, owner, label, revision }
		/** Each session's own list, by session id. */
		ownLists: keyed(arr(ListEntry)),
		/** Each user's exclusions from their defaults, by user id. */
		exclusions: map(arr(ResourceRef)),
		/** The guarded step for a new resource: the owner rule, the policy, then the row. */
		create: method(obj({ actor: str(), owner: str(), definition: ResourceRef, label: str() }), ResourceRef),
		/** The owning plugin deleted the resource. */
		forget: method(obj({ resource: ResourceRef })),
	},
});
```

```ts
// plugins/resources/server.ts
const CreatedRows = defineTable("resources.created", {
	version: 1,
	columns: { name: str(), id: str(), owner: str(), label: str(), revision: int() },
	key: ["name", "id"],
});

export default defineFacet((host) => {
	host.serve(InstanceResources, { compose: (table, { report }) => byName(table, report) });   // a name twice: reported

	host.serve(Resources, (_params, self) => {
		const created = self.table(CreatedRows);
		const createdIndex = self.state(CreatedIndex);         // in memory: the table's rows as a map, filled at activation
		const brought = self.registry(InstanceResources);
		const policy = self.registry(Policies);
		const identities = self.get(Identities, {});         // users, admins (chapter II)
		const ownLists = self.state(OwnLists);                 // persisted, keyed by session id
		const exclusions = self.state(Exclusions);             // persisted: user id -> refs

		// One index: created rows plus brought resources (owner INSTANCE, revision 0).
		const index = self.derive([createdIndex, brought], ([rows, bringing]) => ({ ...rows, ...broughtRows(bringing) }));

		return {
			index,
			ownLists,
			exclusions,
			create: async ({ actor, owner, definition, label }, ctx) => {
				// 1. You create only for yourself; admins also for the company. No policy changes this.
				if (owner !== actor && !(owner === INSTANCE && isAdmin(identities.users.value, actor)))
					throw forbidden(messages.message("notYourResource"));
				// 2. The policy, e.g. "only engineering creates MCP servers".
				const decision = policy.value.decide({ kind: "create-resource", actor, definition, owner }, ALLOW);
				if (decision.kind === "deny") throw forbidden(decision.reason);
				// 3. The row, and the in-memory index the lists read.
				const id = newId();
				await self.tx(async (tx) => {
					tx.put(created, { name: definition.name, id, owner, label, revision: 0 });
					(await tx.draft(createdIndex)).rows[key(definition.name, id)] = { owner, label, revision: 0 };
				}, ctx);
				return { name: definition.name, id };
			},
			forget: async ({ resource }, ctx) => { /* delete the row and its index entry; lists drop it */ },
		};
	});
});
```

`self.tx(fn, ctx)` is the object's transaction for this call: its handles (`created`, `createdIndex`) belong to the
object, `ctx` to the call; one commit, cancelled if the caller goes away.

# Users {#users lede="Who a user is, how a person becomes one, admins, the instance user, sign-in plugins, per-user data, and what happens when someone leaves."}

A user is a person with an account on this p3 instance. Everything in the model hangs off users: a resource's owner is
a user, a session's owner is a user, a project's members are users (or groupings of users), the policy decides per
user. Users are kept small on purpose: an id the principal carries, a profile, the identities a person signs in with,
and an admin flag. Everything else about a person (their recent sessions, their exclusions, their picks) is data of the
plugin that needs it, keyed by the user id.

p3 builds on the app kit's users and sessions rather than beside them (design §23): the kit's `defineUsers(profile)`
keeps profiles by id, the kit's `Sessions` issues and revokes sign-in sessions, the kit's `Authenticators` registry
turns a request into a principal. p3's users plugin adds what the kit leaves to the app: how an external identity maps
to a user, who is an admin, and the instance user.

## The principal and the ids

```ts
// plugins/users/contract.ts: shared by every facet
export type UserId = string & { readonly "~user": true };

/** The instance user: owns company resources and everything plugins bring. Never signs in, never in the user list. */
export const INSTANCE: UserId;

/** p3's principals (decision 2026-11-06); links stamp them, a caller's data never sets one. */
export type P3Principal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly session: string }
	| { readonly kind: "user"; readonly id: UserId }
	| { readonly kind: "guest" };                      // reserved until sharing is designed

/** What every user's profile holds (the kit's users plugin stores it by id). */
export const Profile = obj({ name: str(), email: nullable(str()), avatar: nullable(str()) });
```

A principal names the user and nothing else: no name, no groups, no admin flag (design §4: objects persist a
projection, never the principal). A changed name or admin flag never needs a new session.

## The server side: identities, admins, the user list

```ts
// plugins/users/contract.server.ts: server-only declarations other plugins use
/** The kit's users plugin, instantiated with p3's profile (the API re-exports it; design §23). */
export const users = defineUsers(Profile);           // users.Users: list, get, update, remove

export const Identities = local("p3.users.identities", {
	version: 1,
	params: {},
	members: {
		/** Every user with their admin flag; the kit's profile list joined with p3's facts. */
		users: arr(obj({ id: str(), profile: Profile, admin: bool(), disabled: bool() })),
		/** The user an external identity signs in as; creates the user at its first sign-in. Never returns INSTANCE. */
		signIn: method(obj({ issuer: str(), subject: str(), profile: Profile }), str()),
		/** Adds another identity to an existing user (a second sign-in method). */
		link: method(obj({ actor: str(), user: str(), issuer: str(), subject: str() })),
		/** Makes a user an admin or not; asks the policy for `administer`. */
		setAdmin: method(obj({ actor: str(), user: str(), admin: bool() })),
		/** Disables a user: their sessions end, their resources stop counting (below). */
		disable: method(obj({ actor: str(), user: str() })),
	},
});
```

```ts
// plugins/users/server.ts
const IdentityRows = defineTable("users.identities", {
	version: 1,
	columns: { issuer: str(), subject: str(), user: str() },
	key: ["issuer", "subject"],
});
const Facts = defineState("users.facts", {
	schema: obj({ admins: arr(str()), disabled: arr(str()) }),
	version: 1,
	initial: () => ({ admins: [], disabled: [] }),
	persist: true,
	checkpointWhen: () => true,
});

export default defineFacet((host) => {
	host.serve(Identities, (_params, self) => {
		const identities = self.table(IdentityRows);
		const facts = self.state(Facts);
		const profiles = self.get(users.Users, {});      // the kit's profiles by id
		const policy = self.registry(Policies);
		const sessions = self.get(Sessions, {});         // the kit's sign-in sessions

		const list = self.derive([profiles.list, facts], ([all, f]) =>
			all.map((u) => ({ id: u.id, profile: u.profile, admin: f.admins.includes(u.id), disabled: f.disabled.includes(u.id) })));

		const administers = (actor: string) =>
			policy.value.decide({ kind: "administer", actor: userId(actor) }, allowIf(facts.value.admins.includes(actor))).kind === "allow";

		return {
			users: list,
			signIn: async ({ issuer, subject, profile }, ctx) => {
				let id = "";
				await self.tx(async (tx) => {
					const found = await tx.get(identities, { issuer, subject });
					if (found !== undefined) { id = found.user; return; }
					id = newUserId();
					tx.put(identities, { issuer, subject, user: id });
					const f = await tx.draft(facts);
					if (profiles.list.value.length === 0) f.admins.push(id);   // the first user administers
				}, ctx);
				if (facts.value.disabled.includes(id)) throw forbidden(messages.message("userDisabled"));
				await profiles.update({ id, profile }, ctx);                    // name and email follow the identity provider
				return id;
			},
			link: async ({ actor, user, issuer, subject }, ctx) => {
				if (actor !== user && !administers(actor)) throw forbidden(messages.message("notYou"));
				await self.tx(async (tx) => tx.put(identities, { issuer, subject, user }), ctx);
			},
			setAdmin: async ({ actor, user, admin }, ctx) => {
				if (!administers(actor)) throw forbidden(messages.message("adminsOnly"));
				await facts.change((f) => { f.admins = admin ? [...new Set([...f.admins, user])] : f.admins.filter((a) => a !== user); }, ctx);
			},
			disable: async ({ actor, user }, ctx) => {
				if (!administers(actor)) throw forbidden(messages.message("adminsOnly"));
				await facts.change((f) => { f.disabled.push(user); }, ctx);
				for (const s of sessions.list.value) if (isUser(s.principal, user)) await sessions.revoke(s.id, ctx);
			},
		};
	});
});
```

## Signing in

Every way in is a plugin that verifies something, calls `Identities.signIn`, and issues a kit session for the
principal it got back. Nothing else creates users.

- **The owner link** (single user, the laptop): the kit prints a one-time link at start. p3 sets the kit's owner
  principal to the first user (`signIn({ issuer: "p3.owner", subject: "owner", ... })` at first start), so the link,
  the owner token file and device pairing sign in as that user (Chord decision "The kit's owner is a principal the app
  chooses").
- **SAML** (a company): a route verifies the assertion (signature, audience, time) and signs in by issuer and subject:

```ts
// plugins/saml/server.ts
self.contribute(Http, { routes: { "POST /saml/acs": async (request, ctx) => {
	const assertion = await verify(await request.body(), idp.value, ctx);
	const id = await identities.signIn({ issuer: assertion.issuer, subject: assertion.subject,
		profile: { name: assertion.name, email: assertion.email, avatar: null } }, ctx);
	await directory.mirror({ user: id, groups: assertion.groups }, ctx);          // groupings for the policy (chapter XII)
	const session = await sessions.issue({ principal: { kind: "user", id }, label: assertion.email ?? assertion.name, kind: "browser", secure: true }, ctx);
	return { kind: "redirect", to: "/", headers: { "set-cookie": session.cookie } };
} } });
```

- **Radius**: the same with a Radius account's issuer and subject; it may also create the user's Radius MCP server and
  model provider through those plugins' trusted local creates, with this user as actor.

Emails are never identities: two providers may report the same address for different people, and a person may change
theirs. Linking a second identity to an existing user is explicit (`link`), by the user themselves or an admin.

## Admins and the instance user

- **Admins** are a flag the users plugin keeps; the first user is one. The flag is the baseline of the policy's
  `administer` request, so a company policy can say "members of the SAML group admins administer" instead. Admins
  create company resources (owner `INSTANCE`), install plugins, edit rules, disable users.
- **The instance user** is a reserved id, never in the user list, never returned by `signIn`, shown as "the company".
  It owns what plugins bring and what admins create for everyone. Nobody acts as it: an admin creating the company
  key is the actor, the instance the owner.

## What the page sees

```ts
// plugins/users/contract.ts
/** Myself: my profile, whether I administer, my sign-in sessions (devices) with a sign-out each. */
export const Me = remote("p3.users.me", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		user: {
			state: { me: obj({ id: str(), profile: Profile, admin: bool() }), sessions: arr(SessionSummary) },
			methods: { rename: method(obj({ name: str() })), signOut: method(obj({ session: str() })) },
		},
	},
});

/** The people of this instance, for pickers (add a member, share a session); names only, no emails for non-admins. */
export const People = remote("p3.users.people", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { user: { state: { people: arr(obj({ id: str(), name: str(), avatar: nullable(str()) })) } } },
});

/** Admins: every user with flags and identities, and the methods behind the users screen. */
export const UserAdmin = remote("p3.users.admin", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		admin: { state: { users: arr(AdminUserRow) }, methods: { setAdmin: method(obj({ user: str(), admin: bool() })), disable: method(obj({ user: str() })) } },
	},
});
```

`UserAdmin` is served only to principals that administer (the factory asks the policy and refuses others); its methods
pass the link-stamped principal as `actor` to `Identities`. A user who loses admin while a page holds the view gets
refused calls; the view is made again on the next connection.

## Per-user data lives with its plugin

The users plugin does not grow a settings bag. Each plugin keys its own data by user id and serves it through a
per-user view: recent sessions in the recent plugin, exclusions from defaults in the resources plugin (`MyResources`),
model defaults in the models plugin, the theme and language in the kit's preferences. A user's data is found by
asking the plugin that owns it, never through the users plugin.

## When someone leaves

`disable` is the admin's act; the effects follow from facts other plugins already read:

1. **Sign-in ends:** the kit's sessions for that user are revoked; `signIn` refuses the user's identities.
2. **Their resources stop counting:** the resources plugin's `usable` drops entries whose owner is disabled, so
   Colin's Linear server leaves project pi's effective list the moment Colin is disabled. The rows stay, so an admin
   can re-enable without anyone re-bringing anything.
3. **Their sessions stay** visible to the people who could see them (shared with, members of the source grouping);
   who owns them from then on is an admin's choice (reassign or archive), not automatic.
4. **Live objects:** ending a disabled user's live views at once needs the kit to pass Chord's `revokedBy` to the
   server host (design §4, `{ user: id }`); today the kit revokes sessions only, so open views end on the next
   reconnect. A small kit change, recorded as carry-over.

:::review | Decision for the owner: a departed user's resources
Dropping a disabled user's resources from every list is the safe default: their logins are theirs. A company that wants
Colin's MCP server to keep running after he leaves moves it to the company by re-creating it as an instance resource
(a second resource, the company's login), never by re-assigning his.
:::

# One List {#lists lede="The session's one resource source, the entries, how core computes a session's list, and bringing, withdrawing and locking down."}

## The field

```ts
// plugins/resources/contract.ts
export const GroupingRef = obj({ name: str(), id: str() });        // a grouping definition's name and the grouping's id

export const ResourceSource = union([
	obj({ kind: lit("defaults") }),                                // everything the owner owns + instance, minus exclusions
	obj({ kind: lit("own") }),                                     // the session's own list
	obj({ kind: lit("grouping"), grouping: GroupingRef }),         // a project, a Discord channel
]);

// plugins/sessions/contract.server.ts: the catalog row, kept by the sessions plugin
export const SessionRow = obj({ id: str(), owner: str(), title: str(), source: ResourceSource, /* location, status, ... */ });
export const SessionCatalog = local("p3.sessions.catalog", {
	version: 1,
	params: {},
	members: { rows: keyed(SessionRow), setSource: method(obj({ actor: str(), session: str(), source: ResourceSource })) },
});
```

One field, so one source, by construction. Moving a session into another project replaces the field.

## Entries

```ts
export const ListEntry = obj({
	resource: ResourceRef,
	broughtBy: str(),          // stamped by core, never caller data
	until: nullable(int()),    // an expiry (ms since the epoch); null: until removed
	revision: int(),           // the resource's revision when brought; a withdrawal raises it
});

/** What a session gets: ready with entries, or unavailable (fail closed). */
export const SessionListSchema = union([
	obj({ kind: lit("ready"), entries: arr(obj({ resource: ResourceRef, owner: str(), until: nullable(int()) })) }),
	obj({ kind: lit("unavailable"), reason: MessageSchema }),
]);
```

No login field, no mode: the owner of the resource decides its login, forever.

## A session's list, computed

One local object per session, alive while something holds it: the session worker's view and every resource plugin's
per-session server view hold the same one.

```ts
// plugins/resources/contract.server.ts
export const SessionList = local("p3.resources.session-list", {
	version: 1,
	params: { session: str() },
	members: { list: SessionListSchema },
});
```

```ts
// plugins/resources/server.ts
host.serve(SessionList, ({ session }, self) => {
	const row = self.get(SessionCatalog, {}).rows.at(session);      // live: owner, source
	const resources = self.get(Resources, {});
	const own = resources.ownLists.at(session);                      // live: this session's own list
	const groupings = self.registry(Groupings);                      // how to read a grouping's list (chapter IV)
	const policy = self.registry(Policies);
	const fromGrouping = self.state(SourceEntries);                  // in memory: { entries: ListEntry[] | "absent" | null }
	const clock = self.state(Clock);                                 // in memory: { now }, advanced at the next expiry

	// A grouping's id is known only from the row's state, so its list is watched here, not pinned in the factory.
	// Routine calls never overlap and a change does not abort a running call (design §14), so the watch runs under
	// a child context that `untilSourceChanges` aborts when the row stops naming this grouping; the next call then
	// starts with the new source.
	self.on(row, async ({ value }, ctx) => {
		if (value.source.kind !== "grouping") return fromGrouping.change((d) => { d.entries = null; }, ctx);
		const source = groupings.value.get(value.source.grouping.name)?.resources;
		if (source === undefined) return fromGrouping.change((d) => { d.entries = "absent"; }, ctx);   // plugin not loaded
		const named = value.source.grouping;
		const scoped = untilSourceChanges(row, named, ctx);      // withAbortSignal(controller.signal, ctx), aborted on change
		for await (const entries of source.lists.watch(named.id, scoped))
			await fromGrouping.change((d) => { d.entries = entries; }, ctx);
	});

	const list = self.derive(
		[row, own, resources.index, resources.exclusions, fromGrouping, policy, clock],
		([r, ownEntries, index, excluded, grouping, current, time]) => {
			const entries =
				r.source.kind === "defaults" ? defaultsOf(r.owner, index, excluded[r.owner] ?? [])
				: r.source.kind === "own" ? ownEntries
				: grouping.entries;
			if (entries === "absent" || entries === null)
				return { kind: "unavailable", reason: messages.message("sourceUnavailable") };
			return { kind: "ready", entries: entries.flatMap((entry) => usable(entry, r, index, current, time.now)) };
		},
	);

	// The clock: sleep until the earliest `until` on the list, then advance, so an entry drops out on time.
	self.on(list, async ({ value }, ctx) => {
		const next = earliestUntil(value);
		if (next === null) return;
		await sleep(Math.max(0, next - Date.now()), ctx);
		await clock.change((d) => { d.now = Date.now(); }, ctx);
	});

	return { list };
});

/** Defaults: every resource the owner owns plus every instance resource, minus the owner's exclusions. */
function defaultsOf(owner: string, index: Index, excluded: readonly ResourceRef[]): ListEntry[] {
	return Object.values(index)
		.filter((row) => (row.owner === owner || row.owner === INSTANCE) && !excluded.some((x) => sameResource(x, row.resource)))
		.map((row) => ({ resource: row.resource, broughtBy: owner, until: null, revision: row.revision }));
}

/** One entry as a session gets it, or nothing: missing, withdrawn since, expired, or denied by the policy. */
function usable(entry: ListEntry, row: SessionRow, index: Index, policy: Policy, now: number) {
	const indexed = index[keyOf(entry.resource)];
	if (indexed === undefined) return [];                                   // its plugin is gone, or it was deleted
	if (disabled(indexed.owner)) return [];                                  // its owner left (chapter II)
	if (entry.revision < indexed.revision) return [];                       // withdrawn by its owner since
	if (entry.until !== null && entry.until <= now) return [];              // expired
	const use = policy.decide({ kind: "use", session: row, resource: entry.resource, owner: indexed.owner }, useBaseline(entry.resource, row));
	if (use.kind === "deny") return [];
	return [{ resource: entry.resource, owner: indexed.owner, until: entry.until }];
}
```

Every input is live state; Chord recomputes `list` when any of them changes and pushes it to whoever holds it. The
clock only makes the derive run again at a deadline: every call admission (chapter VI) also compares `until` with
the current time, so a late timer never extends access. `useBaseline` is allow, except for resources whose definition
asks for more: the local machine and server-side stdio need the session's owner to administer (chapter XI).

## Bringing, removing, withdrawing, locking down

People change lists through core's per-user view, so the actor is the link-stamped principal:

```ts
// plugins/resources/contract.ts
export const ListRef = union([obj({ kind: lit("session"), session: str() }), obj({ kind: lit("grouping"), grouping: GroupingRef })]);

export const MyResources = remote("p3.resources.mine", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		user: {
			state: {
				owned: arr(IndexRow),                    // my resources
				excluded: arr(ResourceRef),              // my exclusions from defaults
				creatable: arr(Creatable),               // { owner: me | INSTANCE (admins), definitions: names }
			},
			methods: {
				candidates: method(obj({ into: ListRef }), arr(Candidate)),   // what I may bring here, with the longest allowed `until`
				bring: method(obj({ resource: ResourceRef, into: ListRef, until: nullable(int()) })),
				remove: method(obj({ resource: ResourceRef, from: ListRef })),
				withdraw: method(obj({ resource: ResourceRef })),
				exclude: method(obj({ resource: ResourceRef, excluded: bool() })),
				setSource: method(obj({ session: str(), source: ResourceSource })),
				lockDown: method(obj({ session: str() })),
			},
		},
	},
});
```

- **Bring** needs both sides (owner, walkthrough). The resource side: you own it, or it is an instance resource and
  you administer. The list side: a session's own list, its owner; a grouping's, the grouping's own rule (`mayBring`,
  chapter IV). Then the policy sees `{ kind: "bring", actor, resource, into, until }`. Core stamps `broughtBy` and the
  resource's current `revision`.
- **Remove**: a list's maintainers take anything out of their list, never touching the resource.
- **Withdraw**: the owner takes a resource back from every list. Core raises its `revision` in the index first, so
  every entry brought before stops counting at once, also in a grouping whose plugin is reloading and comes back with
  its old rows; then it asks each loaded list keeper to delete the entry and retries absent ones when they return. The
  owner's own defaults sessions stop using it through `exclude`.
- **Set source** needs the session side (its owner by baseline) and the destination side (a grouping's `mayJoin`);
  the policy sees `{ kind: "set-source", ... }`.
- **Lock down** switches a session to its own list, from a snapshot: from defaults, the same session's current
  entries; from a grouping, only the entries the actor may bring themselves, `until` kept. Cristina locking down a pi
  session cannot keep Colin's server.
- **Copies** (clone, fork) re-run these rules before the copy's worker starts; content is copied, consent is not.

:::review | Decision for the owner: tools in project lists
With "only admins bring instance resources", nobody but an admin can put bash into a project, and a project session
has no tools. Proposal: resources a plugin brings carry no login, so anyone who may use one may bring it, and a new
grouping's list starts with every brought resource its creator may use. Company resources with a login (the company
key, the build machine) stay admin-only.
:::

# Where Things Appear {#groupings lede="Groupings show things; the few that carry a list register it with the resources plugin; a project from the inside."}

A grouping is any plugin's object that shows things: **recent** (per user, from what each opened), **folders**
(computed from where sessions work), **projects** (curated), a **Discord channel**, a mirrored **SAML group**. A
session appears in any number of them, and appearing grants nothing. Groupings that only show need nothing from core.

A **grouping with resources** keeps a list in its own plugin and tells the resources plugin how to read and change it,
through one server registry:

```ts
// plugins/resources/contract.ts
export type GroupingDefinition = { readonly name: string };
export function defineGrouping(name: string): GroupingDefinition;
export function groupingOf(definition: GroupingDefinition, id: string): GroupingRef;

export type MemberRef = { readonly kind: "user"; readonly user: UserId } | { readonly kind: "grouping"; readonly grouping: GroupingRef };

// plugins/resources/contract.server.ts
/** What a grouping plugin tells the resources plugin; groupings that only show contribute nothing. */
export type GroupingRegistration = {
	readonly grouping: GroupingDefinition;
	/** Who is in each grouping, by grouping id: for who sees its sessions, and for the policy's rules. */
	readonly members?: KeyedWatchable<readonly MemberRef[]>;
	/** Only on a grouping with resources. */
	readonly resources?: {
		readonly lists: KeyedWatchable<readonly ListEntry[]>;            // by grouping id
		mayBring(actor: UserId, id: string): boolean;                    // the list side of bringing
		mayRemove(actor: UserId, id: string): boolean;                   // maintainers taking something out
		mayJoin(actor: UserId, id: string): boolean;                     // making it a session's source
		add(id: string, entry: ListEntry, ctx: Ctx): Promise<void>;
		remove(id: string, resource: ResourceRef, ctx: Ctx): Promise<void>;
	};
};
export const Groupings = defineRegistry<readonly GroupingRegistration[], ReadonlyMap<string, GroupingRegistration>>(
	"p3.groupings", { version: 1 });
```

The resources plugin reads `lists` for `SessionList`, calls `mayBring`/`add` from `MyResources.bring` and `remove`
from `remove` and `withdraw`; core's `Members` object expands every registration's `members` (cutting cycles) for
visibility and for policy rules.

## A project

```ts
// plugins/projects/contract.ts: what the page needs
export const Project = defineGrouping("projects.project");

/** One project as a signed-in member sees it. Actions say what this user may do now (live, not a variant). */
export const ProjectView = remote("projects.view", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	variants: {
		user: {
			state: { project: nullable(ProjectState) },   // { title, members, list: ListEntry[], sessions: SessionRef[], actions }
			methods: { rename: method(obj({ title: str() })), addMember: method(obj({ member: MemberRefSchema })) },
		},
	},
});
export const Projects = remote("projects.mine", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { user: { state: { projects: arr(ProjectSummary) }, methods: { create: method(obj({ title: str() }), str()) } } },
});
```

```ts
// plugins/projects/server.ts
const ProjectRows = defineTable("projects.rows", {
	version: 1,
	columns: { id: str(), title: str(), maintainers: json(arr(str()), { version: 1 }) },
	key: ["id"],
});
const Lists = defineState("projects.lists", { schema: arr(ListEntry), version: 1, keyed: true, persist: true, initial: () => [], checkpointWhen: () => true });
const Members = defineState("projects.members", { schema: arr(MemberRefSchema), version: 1, keyed: true, persist: true, initial: () => [], checkpointWhen: () => true });

/** The projects plugin's server store (host lifetime): its tables, its registration, its writes. */
const ProjectStore = local("projects.store", { version: 1, params: {}, members: { /* rows, create, rename, addMember */ } });

export default defineFacet((host) => {
	host.serve(ProjectStore, (_params, self) => {
		const rows = self.table(ProjectRows);
		const lists = self.state(Lists);
		const members = self.state(Members);
		const access = self.get(Access, {});
		const isMember = (user: UserId, id: string) => expanded(members, id).includes(user);
		const isMaintainer = (user: UserId, id: string) => maintainersOf(rows, id).includes(user);

		self.contribute(Groupings, [{
			grouping: Project,
			members,
			resources: {
				lists,
				mayBring: isMember,
				mayRemove: isMaintainer,
				mayJoin: isMember,
				add: (id, entry, ctx) => lists.change(id, (draft) => { draft.push(entry); }, ctx),
				remove: (id, resource, ctx) => lists.change(id, (draft) => removeEntry(draft, resource), ctx),
			},
		}]);

		return {
			create: async ({ actor, title }, ctx) => {
				await access.require({ kind: "create-grouping", actor, grouping: Project, baseline: ALLOW }, ctx);
				const id = newId();
				await self.tx(async (tx) => {
					tx.put(rows, { id, title, maintainers: [actor] });
					(await tx.draft(members, id)).push({ kind: "user", user: actor });
				}, ctx);
				return id;
			},
			addMember: async ({ actor, id, member }, ctx) => {
				await access.require({ kind: "add-member", actor, to: groupingOf(Project, id), member, baseline: allowIf(isMaintainer(actor, id)) }, ctx);
				await members.change(id, (draft) => { draft.push(member); }, ctx);
			},
		};
	});
	// ProjectView and Projects: per-user views over the store and the catalog (sessions whose source is the project).
});
```

A project's sessions are a query: catalog rows whose source names the project. The session points up, never the
project down, so no two projects can both equip a session.

## Who sees a session

The sessions plugin's catalog view for a user shows a session when the user owns it, it is shared with them (the
session's own people list), or they are a member of its source grouping (`Members`). Seeing is not every operation:
the sessions plugin keeps `mayView`, `maySend` (owner, shared with send, members of the source grouping) and `isOwner`
per session and user, and uses them as baselines for its typed operations (send, shell, reset, configure, set source).

:::review | Decision for the owner: showing sessions a project does not equip
Linking a pi session to Discord makes it use the channel's list, and it leaves pi. Both reviewers propose that a
project may also keep plain "shown here" references to such sessions, granting nothing.
:::

# Who May {#policy lede="One replaceable policy, typed requests, asked by core at the moment something happens."}

```ts
// plugins/policy/contract.server.ts: core
export type Decision = { readonly kind: "allow" } | { readonly kind: "deny"; readonly reason: MessageData };

/** Everything core asks. Definitions are compared by name with `isOf`; operations with `isOperation`. */
export type Request =
	| { readonly kind: "create-resource"; readonly actor: UserId; readonly definition: ResourceDefinition; readonly owner: UserId }
	| { readonly kind: "create-grouping"; readonly actor: UserId; readonly grouping: GroupingDefinition }
	| { readonly kind: "bring"; readonly actor: UserId; readonly resource: ResourceRef; readonly owner: UserId; readonly into: ListRef; readonly until: number | null }
	| { readonly kind: "set-source"; readonly actor: UserId; readonly session: SessionRow; readonly source: ResourceSource }
	| { readonly kind: "add-member"; readonly actor: UserId; readonly member: MemberRef; readonly to: GroupingRef }
	| { readonly kind: "use"; readonly session: SessionRow; readonly resource: ResourceRef; readonly owner: UserId }
	| { readonly kind: "administer"; readonly actor: UserId }
	| { readonly kind: "call"; readonly actor: UserId; match<C extends RemoteContract, M extends MethodName<C>>(op: Operation<C, M>):
			{ readonly target: ParamsOf<C>; readonly args: ArgsOf<C, M> } | undefined };

export type Policy = { decide(request: Request, baseline: Decision): Decision };
/** Exactly one provider; zero, two or a failed one compose to deny-all, never to the default. */
export const Policies = defineRegistry<Policy, Policy>("p3.policy", { version: 1 });

/** Asks the policy for plugins that own a write (a project's create, a guarded configuration change). */
export const Access = local("p3.access", { version: 1, params: {}, members: { require: method(RequestData) } });
export function guard<C extends RemoteContract, M extends MethodName<C>>(
	access: Ref<typeof Access>, actor: UserId, op: Operation<C, M>, target: ParamsOf<C>, args: ArgsOf<C, M>, baseline: Decision, ctx: Ctx,
): Promise<void>;
```

- **The default policy** is `(_request, baseline) => baseline`, its own plugin, installed explicitly. Baselines come
  from the facts the asking code has: the owner rule, a grouping's `mayBring`, the session owner, the users plugin's
  admin flag, allow for `use` unless the definition says otherwise.
- **Hard rules come first and no policy changes them:** nobody creates a resource owned by another person; workers
  never change lists or create resources.
- **Plugins never see which policy is installed.** They ask through `Access` with a baseline from their own facts.
- **The rules plugin** is the policy a company installs: rules "members of grouping G may create MCP servers", edited
  on a settings screen that reads the creators registry for the definitions and any plugin's groupings for G. A
  permission with rules is restricted to their members; one without keeps the baseline.
- **Answers reach pages as view state:** `MyResources.creatable` is a derive over the registered definitions, the
  policy value and the user's memberships. An admin adding research to the MCP rule commits the rules document, the
  rules plugin sets its policy writable, the registry recomposes, the derive recomputes, Cristina's picker gains the
  MCP creator; nothing polls.

# On the Worker {#worker lede="The worker gets its session's list; the harness keys extensions by resource and checks at compose time and at every call."}

```ts
// plugins/resources/contract.ts
/** A session worker's view of its list: the worker's principal names the session. */
export const SessionResources = remote("p3.resources.session", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { worker: { state: { list: SessionListSchema } } },
});

// plugins/resources/server.ts
host.serve(SessionResources, (_params, principal, self) => {
	if (principal.kind !== "worker") throw forbidden("session workers only");
	return { variant: "worker", members: { list: self.get(SessionList, { session: principal.session }).list } };
});
```

The harness plugin owns the `Extensions` registry; contributions are pairs of a resource and the Durable extension
that needs it:

```ts
// plugins/harness/contract.worker.ts
export type HarnessExtension = readonly [resource: ResourceRef, extension: Extension];
export const Extensions = defineRegistry<
	readonly HarnessExtension[] | Watchable<readonly HarnessExtension[]>, ExtensionTable
>("harness.extensions", { version: 1 });
```

```ts
// plugins/harness/worker.ts
host.serve(Extensions, { compose: (table, { report }) => byResource(table, report) });   // one extension per resource key

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
	// ...Durable opens with `registry`
	return {};
});
```

Doors that are not tools check the same list at their own entry: the composer's `!cmd` needs `Bash` on the list and a
location; a cache warmer re-checks its provider before every refresh; terminal and voice channels re-check on use.

# Tools {#tools lede="A plugin that brings its tools: three lines on the server and the worker."}

```ts
// plugins/coding-tools/contract.ts
export const FileTools = defineResource("coding-tools.files");
export const Bash = defineResource("coding-tools.bash");

// plugins/coding-tools/server.ts
export default defineFacet((host, self) => {
	self.contribute(InstanceResources, [FileTools, Bash]);
});

// plugins/coding-tools/worker.ts
export default defineFacet((host, self) => {
	self.contribute(Extensions, [
		[FileTools, defineExtension({ name: "files", tools: [read, write, edit] })],
		[Bash, defineExtension({ name: "bash", tools: [bash] })],
	]);
});
```

1. Installed, `coding-tools.files` and `coding-tools.bash` exist in the resources plugin's index, owned by `INSTANCE`.
2. Every defaults session's list includes them; the Discord channel's hand-picked list does not.
3. The harness admits each extension while its resource is on the session's list. In the Discord session the model
   never sees a bash tool.

A third-party plugin's tool works the same way and is in every defaults session's next turn. Splitting bash from the
file tools is the plugin's choice: two resources, two extensions.

# MCP End to End {#mcp lede="Resources people create, a store on the server, a per-session view, extensions that follow it, and the page."}

## contract.ts: what more than one facet uses

```ts
// plugins/mcp/contract.ts
export const McpServer = defineResource("mcp.server");

export const Transport = union([
	obj({ kind: lit("http"), url: str() }),                                               // no location
	obj({ kind: lit("server-stdio"), command: str(), args: arr(str()) }),                 // the p3 machine; admin by baseline
	obj({ kind: lit("checkout"), env: ResourceRef, dir: str(), entry: str(), digest: str() }),   // an enabled .pi/mcp.json entry
]);
export const McpConfig = obj({ name: str(), transport: Transport, lifetime: oneOf("session", "shared") });

/** A signed-in user's MCP: their servers, and the methods behind the creation sheet and the detail panels. */
export const McpServers = remote("mcp.servers", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		user: {
			state: { servers: arr(ServerInfo) },     // id, name, transport (no secrets), status, tools, owner
			methods: {
				create: method(obj({ owner: str(), config: McpConfig }), ResourceRef),
				configure: method(obj({ id: str(), config: McpConfig })),
				signIn: method(obj({ id: str() }), SignInStart),
				remove: method(obj({ id: str() })),
			},
		},
	},
});
export const CreateMcp = operation(McpServers, "create");
export const ConfigureMcp = operation(McpServers, "configure");

/** A session worker's MCP: the servers on its list, and calls the server runs. */
export const SessionMcp = remote("mcp.session", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		worker: {
			state: { servers: arr(SessionServer) },  // { resource, name, tools }
			methods: { call: method(obj({ server: str(), conversation: int(), tool: str(), args: unknown() }), CallResult) },
		},
	},
});
```

## server.ts: the store, the user's view, the session view

```ts
// plugins/mcp/server.ts
const Configs = defineTable("mcp.configs", { version: 1, columns: { id: str(), owner: str(), config: json(McpConfig, { version: 1 }) }, key: ["id"] });

/** The MCP store (server only, host lifetime): configurations, secrets, the supervisor of clients and processes. */
const McpStore = local("mcp.store", {
	version: 1,
	params: {},
	members: {
		servers: map(ServerInfo),                                  // by id; no secrets
		add: method(obj({ id: str(), owner: str(), config: McpConfig })),
		call: method(obj({ id: str(), session: str(), at: nullable(Location), tool: str(), args: unknown() }), CallResult),
	},
});

export default defineFacet((host) => {
	host.serve(McpStore, (_params, self) => {
		const configs = self.table(Configs);
		const supervisor = self.open((ctx) => new McpSupervisor(ctx), (s) => s.close());   // processes, OAuth, refresh
		/* servers: a follow of the supervisor's status and tools; add: tx.put(configs, ...); call: supervisor.call */
	});

	host.serve(McpServers, (_params, principal, self) => {
		if (principal.kind !== "user") throw forbidden("users only");
		const resources = self.get(Resources, {});
		const access = self.get(Access, {});
		const store = self.get(McpStore, {});
		return {
			variant: "user",
			members: {
				servers: self.derive([store.servers], ([all]) => Object.values(all).filter((s) => visibleTo(s, principal.id))),
				create: async ({ owner, config }, ctx) => {
					// Running code on the server machine needs an admin by baseline; a company policy may say otherwise.
					await guard(access, principal.id, CreateMcp, {}, { owner, config }, transportBaseline(config, principal), ctx);
					const resource = await resources.create({ actor: principal.id, owner, definition: McpServer, label: config.name }, ctx);
					await store.add({ id: resource.id!, owner, config }, ctx);
					return resource;
				},
				configure: async ({ id, config }, ctx) => { /* owner only; guard(ConfigureMcp) with the new transport; update */ },
				signIn: async ({ id }, ctx) => { /* owner only: start the OAuth flow; tokens stay in the store */ },
				remove: async ({ id }, ctx) => { /* owner only: delete config, then resources.forget(...) */ },
			},
		};
	});

	host.serve(SessionMcp, (_params, principal, self) => {
		if (principal.kind !== "worker") throw forbidden("session workers only");
		const list = self.get(SessionList, { session: principal.session }).list;
		const store = self.get(McpStore, {});
		const locations = self.get(ConversationLocations, {});        // sessions plugin: where each conversation works

		// The session's MCP servers: list entries of McpServer whose config the store has.
		const servers = self.derive([list, store.servers], ([current, all]) =>
			current.kind !== "ready" ? [] : current.entries.flatMap(({ resource }) =>
				isOf(resource, McpServer) && all[resource.id!] !== undefined
					? [{ resource, name: all[resource.id!].name, tools: all[resource.id!].tools }] : []));

		return {
			variant: "worker",
			members: {
				servers,
				call: async ({ server, conversation, tool, args }, ctx) => {
					// Checked here at every call: on the list now, not expired; a checkout server only where this conversation works.
					const entry = onList(list.value, resourceOf(McpServer, server));
					if (entry === undefined) throw forbidden(messages.message("notOnList"));
					const at = locations.of(principal.session, conversation);
					return store.call({ id: server, session: principal.session, at, tool, args }, ctx);
				},
			},
		};
	});
});
```

## worker.ts: extensions that follow the server

```ts
// plugins/mcp/worker.ts
export default defineFacet((host) => {
	host.serve(McpInSession, (_params, self) => {
		const mcp = self.get(SessionMcp, {});
		const extensions = self.writable<readonly HarnessExtension[]>([]);
		self.contribute(Extensions, extensions);
		// The server pushes `servers` again whenever the session's list or a server's tools change.
		self.on(mcp.servers, ({ value }) => extensions.set(value.map((server) => [
			server.resource,
			mcpExtension(server, (tool, args, api, ctx) =>
				mcp.call({ server: server.resource.id!, conversation: api.conversationId, tool, args }, ctx)),
		] as const)));
		return {};
	});
});
```

## When Colin withdraws Linear from project pi

1. `MyResources.withdraw` raises Linear's revision in the index and asks the projects plugin to remove the entry.
2. `SessionList` for every pi session recomputes without Linear; `SessionMcp.servers` recomputes and is pushed.
3. The worker's `self.on` replaces the extensions; the harness also stops admitting Linear's.
4. A call already on its way reaches `SessionMcp.call` and is refused there. Output already in the transcript stays.

Processes stay per session by default (`lifetime: "session"`), as in p2; `shared` keeps one per resource and
placement. Credentials and OAuth refresh never leave the store.

# Discord End to End {#discord lede="A bot the company owns, a channel that is a grouping with a list, and access to one session for an hour."}

Three plugins meet here: discord (the bot, the channel grouping, ingress), conversations (the tool and access to
another session), and the resources plugin (lists).

## The bot: a company resource an admin creates

```ts
// plugins/discord/contract.ts
export const DiscordBot = defineResource("discord.bot");
export const DiscordChannel = defineGrouping("discord.channel");     // id: "<bot id>:<channel id>"

export const DiscordAdmin = remote("discord.admin", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		user: {
			state: { bots: arr(BotInfo), links: arr(LinkInfo) },
			methods: {
				createBot: method(obj({ owner: str(), token: str(), name: str() }), ResourceRef),
				link: method(obj({ bot: str(), channel: str(), session: str() })),
				unlink: method(obj({ bot: str(), channel: str() })),
			},
		},
	},
});
```

`createBot` calls `resources.create({ actor, owner: INSTANCE, definition: DiscordBot, ... })`: only an admin passes
the owner rule. The token stays in the discord plugin's server store.

## The channel: a grouping with a list

```ts
// plugins/discord/server.ts (inside the discord store, host lifetime)
self.contribute(Groupings, [{
	grouping: DiscordChannel,
	resources: {
		lists: channelLists,                                       // keyed by channel id, persisted
		mayBring: (actor, id) => linkOf(id)?.by === actor || isAdmin(actor),
		mayRemove: (actor, id) => linkOf(id)?.by === actor || isAdmin(actor),
		mayJoin: (actor, id) => isAdmin(actor) || linkOf(id)?.by === actor,
		add: (id, entry, ctx) => channelLists.change(id, (d) => { d.push(entry); }, ctx),
		remove: (id, resource, ctx) => channelLists.change(id, (d) => removeEntry(d, resource), ctx),
	},
}]);
```

**Linking** a channel to session S2 (`DiscordAdmin.link`), in order:

1. Prepare the channel's list: the company's model provider and `conversations.tool`; nothing else.
2. Ask the sessions plugin to set S2's source to `{ kind: "grouping", grouping: groupingOf(DiscordChannel, id) }`
   (`SessionCatalog.setSource`, with the session side and the channel's `mayJoin` checked) and S2's location to `null`:
   no machine.
3. Start ingress. Discord people are not users; their messages are inputs authored "Lena · Discord", and like every
   sender they drive the whole list.

**Unlinking** stops ingress first, then restores the previous source if the actor may still set it, else leaves S2 an
own list of the authorized entries.

## The conversations tool and access to one session

```ts
// plugins/conversations/contract.ts
export const ConversationsTool = defineResource("conversations.tool");    // brought: the tool, reaching same-source sessions
export const ConversationAccess = defineResource("conversations.access"); // created: access to one session, chosen actions

export const AccessConfig = obj({ target: str(), actions: arr(oneOf("answer", "send")) });
export const Accesses = remote("conversations.accesses", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { user: { state: { accesses: arr(AccessInfo) }, methods: { create: method(obj({ config: AccessConfig }), ResourceRef) } } },
});
export const SessionConversations = remote("conversations.session", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		worker: {
			state: { targets: arr(Target) },                                  // { session, title, actions }: what the tool lists
			methods: {
				send: method(obj({ to: str(), message: str(), requestId: str() })),
				answer: method(obj({ to: str() }), AnswerResult),
			},
		},
	},
});
```

```ts
// plugins/conversations/server.ts
self.contribute(InstanceResources, [ConversationsTool]);

host.serve(Accesses, (_params, principal, self) => {
	/* create: baseline "the actor may send in the target" (the sessions plugin's maySend); guard; then
	   resources.create({ actor, owner: actor, definition: ConversationAccess, label: `${title} · answers` });
	   store.add({ id, config }) */
});

host.serve(SessionConversations, (_params, principal, self) => {
	const list = self.get(SessionList, { session: principal.session }).list;
	const store = self.get(AccessStore, {});                               // server only: configs by resource id
	const catalog = self.get(SessionCatalog, {});
	const targets = self.derive([list, store.configs, catalog.visible], targetsOf);   // display only

	/** The entry behind one call: the tool for a same-source target, else an access naming target and action, live. */
	const authorize = (to: string, action: "answer" | "send") => {
		const current = list.value;
		if (current.kind !== "ready") throw forbidden(messages.message("listUnavailable"));
		const now = Date.now();
		const live = current.entries.filter((e) => e.until === null || e.until > now);
		if (live.some((e) => isOf(e.resource, ConversationsTool)) && sameSource(catalog.row(principal.session), catalog.row(to))) return;
		const grant = live.find((e) => isOf(e.resource, ConversationAccess) &&
			store.config(e.resource.id!)?.target === to && store.config(e.resource.id!)!.actions.includes(action));
		if (grant === undefined) throw forbidden(messages.message("noAccess", action));
		requireStillAllowed(grant.owner, to, action);                       // the access owner may still send in the target
	};
	return {
		variant: "worker",
		members: {
			targets,
			send: async ({ to, message, requestId }, ctx) => { authorize(to, "send"); return broker.send({ from: principal.session, to, message, requestId }, ctx); },
			answer: async ({ to }, ctx) => { authorize(to, "answer"); return broker.answer({ to }, ctx); },
		},
	};
});

/** Same source: defaults sessions of the same owner, sessions of the same grouping; an own list peers with nobody. */
function sameSource(a: SessionRow, b: SessionRow): boolean {
	if (a.id === b.id) return false;
	switch (a.source.kind) {
		case "defaults": return b.source.kind === "defaults" && a.owner === b.owner;
		case "grouping": return b.source.kind === "grouping" && sameGrouping(a.source.grouping, b.source.grouping);
		case "own": return false;
	}
}
```

```ts
// plugins/conversations/worker.ts: one extension, keyed by the tool; its targets come from the server view
self.contribute(Extensions, [[ConversationsTool, conversationsExtension(session)]]);
```

## An hour of answers from "Release notes draft"

1. Mario opens S2 (the Support bot session), Resources panel, **Add resource**, picks **Access to a session**.
2. The conversations creator sheet asks: which session (from those he may send in), which actions (`answer`), how
   long (one hour). It calls `Accesses.create`: the baseline "Mario may send in the target" passes; core creates the
   resource owned by Mario.
3. The picker brings it into the channel's list with `until` = now + 1 h: the resource side passes (Mario owns it),
   the list side passes (Mario made the link).
4. S2's `SessionList` gains the entry; `SessionConversations.targets` lists one session with `answer`; the tool shows
   one target.
5. Tom (Discord) asks Pi to tell the release session to hurry up: `send` is refused by `authorize`; Lena's question is
   answered from the release session's latest answer.
6. At the deadline the entry leaves the list; a call a second later is refused by `authorize` against the current
   time, whatever the worker still shows.

S2's list never holds bash, a machine or an MCP server, so none of them exist in that session.

# Resources on Screen {#ui lede="Creation sheets, rows and detail panels per resource definition; the session panel, the picker and My resources are core's; every action is a server method."}

The page never decides anything. It draws server views and calls their methods; the server checks. What a plugin
adds is UI for its own resources, through three page registries of the resources plugin:

```ts
// plugins/resources/contract.web.ts
/** The creation sheet of one definition: offered by every add-resource picker and by My resources. */
export type Creator = {
	readonly definition: ResourceDefinition;
	readonly label: MessageData;
	readonly description: MessageData;
	readonly icon: Icon;
	/** `owner`: the user, or INSTANCE when an admin creates a company resource. `done` gets the new resource. */
	readonly Sheet: ComponentType<{ readonly owner: UserId; done(resource: ResourceRef): void; cancel(): void }>;
};
export const Creators = defineRegistry<readonly Creator[], CreatorIndex>("p3.creators", { version: 1 });

/** How one definition's resources look as a row (session panel, picker, project, My resources). */
export type ResourceRowRenderer = { readonly definition: ResourceDefinition; readonly Row: ComponentType<{ readonly resource: ResourceRef }> };
export const ResourceRows = defineRegistry<readonly ResourceRowRenderer[], RowIndex>("p3.resource-rows", { version: 1 });

/** A part of one resource's detail sheet; several plugins may contribute for one definition. */
export type ResourcePanel = {
	readonly definition: ResourceDefinition;
	readonly title: MessageData;
	readonly order: number;
	readonly Panel: ComponentType<{ readonly resource: ResourceRef }>;
};
export const ResourcePanels = defineRegistry<readonly ResourcePanel[], PanelIndex>("p3.resource-panels", { version: 1 });
```

And two server views core serves for the page, next to `MyResources`:

```ts
// plugins/resources/contract.ts
/** One resource as a signed-in user sees it: what every detail sheet's header shows. */
export const ResourceInfo = remote("p3.resources.info", {
	version: 1,
	params: { name: str(), id: str() },                    // id "" for a brought resource
	hostAddress: () => Server(),
	variants: {
		user: {
			state: { info: nullable(obj({ label: str(), owner: str(), lists: arr(ListUse), actions: InfoActions })) },
			methods: {},                                     // withdraw, exclude, remove: MyResources' methods
		},
	},
});

/** A session's list as a user who may see the session sees it: what the session's resource panel shows. */
export const SessionResourcesView = remote("p3.resources.session-view", {
	version: 1,
	params: { session: str() },
	hostAddress: () => Server(),
	variants: {
		user: { state: { view: nullable(obj({ source: ResourceSource, list: SessionListSchema, actions: PanelActions })) } },
	},
});
```

`ListUse` is one list the resource is on that this user may see, with its expiry; `InfoActions` and `PanelActions`
say what this user may do now (withdraw, exclude, add, remove, lock down, change source), computed with the same rules
and policy the methods check, so buttons match what the server will accept.

## The core components

```tsx
// plugins/resources/web.tsx (core)
/** One resource as a row: its definition's renderer, else the label from the index. */
export function ResourceRowView({ resource }: { resource: ResourceRef }) {
	const rows = useRegistry(ResourceRows);
	const Row = rows.get(resource.name);
	return Row ? <Row resource={resource} /> : <PlainRow resource={resource} />;   // PlainRow holds ResourceInfo for the label
}

/** A resource's detail sheet: core's header, then every panel contributed for its definition, in order. */
export function ResourceDetail({ resource }: { resource: ResourceRef }) {
	const info = useWatch(useHold(ResourceInfo, { name: resource.name, id: resource.id ?? "" }).info);
	const panels = useRegistry(ResourcePanels).filter((p) => p.definition.name === resource.name);
	if (info === null || info === undefined) return <Unavailable />;
	return (
		<Sheet title={info.label}>
			<OwnerLine owner={info.owner} />
			<UsedIn lists={info.lists} />                                  {/* "pi · until Fri", "Support bot" */}
			<HeaderActions resource={resource} actions={info.actions} />  {/* Withdraw everywhere, Exclude from my defaults */}
			<Tabs>{panels.map((p) => <Tab key={p.title.key} title={p.title}><p.Panel resource={resource} /></Tab>)}</Tabs>
		</Sheet>
	);
}

/** The session's resource panel: where its list comes from, the entries, and what this user may do. */
export function SessionResourcesPanel({ session }: { session: string }) {
	const view = useWatch(useHold(SessionResourcesView, { session }).view);
	if (view === null || view === undefined) return null;
	return (
		<Panel>
			<SourceChip source={view.source} />                               {/* "from project pi", "from #support", "your defaults" */}
			{view.list.kind === "ready"
				? view.list.entries.map((e) => <EntryRow key={keyOf(e.resource)} entry={e} actions={view.actions} />)
				: <Unavailable reason={view.list.reason} />}
			{view.actions.add && <AddResourceButton into={listOf(view.source, session)} />}
			{view.actions.lockDown && <LockDownButton session={session} />}
		</Panel>
	);
}

/** "Add resource": things I may bring here, then the creators I may use; creating brings the new resource in. */
export function AddResource({ into }: { into: ListRef }) {
	const mine = useHold(MyResources, {});
	const creatable = useWatch(mine.creatable) ?? [];
	const [owner, setOwner] = useState<UserId>(me);                   // admins also see "the company"
	const allowed = creatable.find((c) => c.owner === owner)?.definitions ?? [];
	const creators = useRegistry(Creators).filter((c) => allowed.includes(c.definition.name));
	const candidates = useCall(() => mine.candidates({ into }), [into]);
	const [until, setUntil] = useState<number | null>(null);          // the picker owns the duration
	const [open, setOpen] = useState<Creator>();
	if (open) return <open.Sheet owner={owner} cancel={() => setOpen(undefined)}
		done={(resource) => mine.bring({ resource, into, until })} />;
	return <Picker candidates={candidates} creators={creators} until={until} onUntil={setUntil}
		onBring={(resource) => mine.bring({ resource, into, until })} onCreate={setOpen} owner={owner} onOwner={setOwner} />;
}
```

**My resources** is a page of the same pieces: `MyResources.owned` as rows (`ResourceRowView`), each opening
`ResourceDetail`, and the creators the user may use. Nothing in it knows MCP, models or machines.

## What the MCP plugin adds on the page

```tsx
// plugins/mcp/web.tsx
export default defineFacet((host, self) => {
	self.contribute(Creators, [{
		definition: McpServer,
		label: t.message("mcpServer"),
		description: t.message("mcpServerAbout"),                       // "HTTP, or a command on this machine (admins)"
		icon: PlugIcon,
		Sheet: NewMcpSheet,
	}]);
	self.contribute(ResourceRows, [{ definition: McpServer, Row: McpRow }]);
	self.contribute(ResourcePanels, [
		{ definition: McpServer, title: t.message("tools"), order: 10, Panel: McpTools },
		{ definition: McpServer, title: t.message("connection"), order: 20, Panel: McpConnection },   // status, sign in, reconnect
		{ definition: McpServer, title: t.message("configuration"), order: 90, Panel: McpConfiguration },
	]);
});

/** The creation sheet: a form for McpConfig; the server's create checks and makes the resource. */
function NewMcpSheet({ owner, done, cancel }: { owner: UserId; done(resource: ResourceRef): void; cancel(): void }) {
	const servers = useHold(McpServers, {});
	const [config, setConfig] = usePageState<McpConfig>("mcp.new", { name: "", transport: { kind: "http", url: "" }, lifetime: "session" });
	const [error, setError] = useState<string>();
	return (
		<Form title={t("newMcpServer")} onCancel={cancel} onSubmit={async (ctx) => {
			try { done(await servers.create({ owner, config }, ctx)); } catch (e) { setError(messageOf(e)); }   // e.g. "only engineering ..."
		}}>
			<TextField label={t("name")} value={config.name} onChange={(name) => setConfig({ ...config, name })} />
			<TransportField value={config.transport} onChange={(transport) => setConfig({ ...config, transport })} />
			{error && <ErrorLine text={error} />}
		</Form>
	);
}

/** The row: name, status, tool count, from the plugin's own user view. */
function McpRow({ resource }: { resource: ResourceRef }) {
	const servers = useWatch(useHold(McpServers, {}).servers) ?? [];
	const server = servers.find((s) => s.id === resource.id);
	return server ? <Row icon={PlugIcon} title={server.name} detail={`${server.tools.length} tools · ${server.status}`} /> : <PlainRow resource={resource} />;
}
```

A project member who is not the owner sees Colin's server in pi with the MCP plugin's row and panels; the panels read
`McpServers`, whose view for that member shows the server (it is on a list they see) without secrets and without the
owner's methods' effect: `configure`, `signIn` and `remove` refuse anyone but the owner, and the panel shows them only
when `actions` says so.

## Another plugin's UI for someone else's resource

A plugin may contribute rows and panels for a definition it does not own, from the owner plugin's public contract: a
team plugin adds a "Usage" panel to `McpServer` reading its own usage store. Registering a panel grants nothing; the
data it shows is whatever its own views allow.

# Models, Machines, Drives {#kinds lede="Three more definitions, each the same pattern: a row, a store keyed by id, a per-session view."}

- **Model providers** (`models.provider`, created): the store keeps pi-ai credentials and refreshes on the server;
  `SessionModels` pushes, per provider on the list, its models and pi-ai `AuthResult` with expiry; the worker's
  provider auth reads the latest push and refuses when the list is not ready, the provider left it or the auth
  expired. Logouts and edits push at once. Bedrock and Vertex with ambient credentials get a server-side stream or are
  unsupported.
- **Machines** (`envs.machine`, created; `envs.local-machine`, brought): a conversation's location is `null` or
  `{ machine: ResourceRef, cwd }` and must name a machine on the list; null means no shell, never a fallback to the
  server machine. `envs.local-machine` declares a use baseline: the session's owner administers. The machine's detail
  sheet gets panels from the files, terminals and envs plugins.
- **Drives** (`drives.drive`, created): kit `Files` per drive; the owner manages it, members of a list holding it read;
  one extension keyed per drive on the list.

# Sign-in and Directories {#directories lede="SAML and Radius touch three places, each already in the model."}

1. **Sign-in creates users:** `Identities.signIn({ issuer, subject, profile })` from a verified assertion; never email
   (chapter II).
2. **Sync mirrors groups as groupings:** `SamlGroup` registers only `members`, updated at sign-in or by SCIM; a stale
   directory yields no members, never everyone.
3. **The policy names them:** "members of engineering may create MCP servers" is one rule.

Signing in with Radius can create the user's Radius MCP server and model provider through those plugins' trusted
local creates, with the user the sign-in produced as actor. Whether one Radius sign-in serves relay, gateway and MCP is
open with Armin and Vegard.

# Six Scenarios {#scenarios lede="The cases every change must keep working."}

1. **Mario on a laptop:** defaults everywhere; installing a plugin with a tool puts it in the next turn.
2. **Project pi:** Colin creates it, adds Cristina and Charlotta, each brings their own resource (plus tools, decision
   1); Charlotta's message uses Colin's Linear, Cristina's machine, Charlotta's key. Colin withdraws Linear: chapter
   VIII.
3. **Discord for an hour:** chapter IX.
4. **SAML:** engineering may create MCP servers; Cristina in research does not see the creator but uses Colin's server
   in pi; adding research to the rule shows her the creator without a reload.
5. **A new tool:** in defaults sessions at once; never in the Discord channel's list.
6. **Drives:** the company drive and Mario's drive in pi; the agent gets drive tools for both.

# Open Questions {.epilogue lede="Four decisions for the owner."}

1. **Tools in project lists** (chapter III): may anyone who may use a brought resource bring it, and do new groupings
   start with them? Recommended: yes.
2. **Projects showing sessions they do not equip** (chapter IV). Recommended: plain references, granting nothing.
3. **Exclusions from defaults** (chapter III). Recommended: yes, per user.
4. **MCP processes per session by default** (chapter VIII). Recommended: yes, as p2.

On other tracks: execution on the server machine and SSH keys in workers; ambient cloud credentials; one Radius
sign-in.

# Where Everything Lives {.appendix}

| File | Holds |
| --- | --- |
| `plugins/resources/contract.ts` | `defineResource`, `ResourceRef`, `isOf`, `resourceOf`, `defineGrouping`, `GroupingRef`, `ResourceSource`, `ListEntry`, `ListRef`, `SessionListSchema`, `MyResources`, `ResourceInfo`, `SessionResourcesView`, `SessionResources` |
| `plugins/resources/contract.server.ts` | `InstanceResources`, `Resources`, `SessionList`, `Groupings`, `Members` |
| `plugins/resources/contract.web.ts` | `Creators`, `ResourceRows`, `ResourcePanels` |
| `plugins/resources/server.ts` | the index, `create`, own lists, `SessionList`, the user and worker views |
| `plugins/resources/web.tsx` | `ResourceRowView`, `ResourceDetail`, `SessionResourcesPanel`, `AddResource`, My resources |
| `plugins/users/contract.ts`, `contract.server.ts` | `UserId`, `INSTANCE`, `P3Principal`, `Profile`, `Me`, `People`, `UserAdmin`; `users` (the kit's `defineUsers`), `Identities` |
| `plugins/policy/contract.server.ts` | `Request`, `Decision`, `Policy`, `Policies`, `Access`, `guard` |
| `plugins/harness/contract.worker.ts` | `HarnessExtension`, `Extensions` |
| `plugins/sessions/contract.server.ts` | `SessionRow` (with `source`), `SessionCatalog` |
| a plugin's `contract.ts` | its `defineResource` / `defineGrouping` constants and the views its facets share |
| a plugin's `server.ts` | its store (server only), `InstanceResources` / `Groupings` contributions, its views |
| a plugin's `worker.ts` | its `Extensions` contributions, following its session view |
| a plugin's `web.tsx` | its `Creators`, `ResourceRows`, `ResourcePanels` |

# What Changed {.appendix}

The third edition follows the owner's code review: no resource objects, no resource kinds, no built-ins, no grants,
no plugin-name check (installed plugins are trusted code); a resource is a row named by `defineResource`; brought
resources are registry contributions, created ones `Resources.create`; extensions are keyed by their resource;
server-only declarations live in `contract.server.ts`, never in a plugin's shared `contract.ts`. The fixes from Astra's
and Sol's review of the second edition carry over: withdrawal by revision, lock-down and copies re-checked as brings,
admin baseline for company resources, per-call admission, doors that are not tools, `null` locations, per-action
expiry for conversation access, the calling conversation on MCP calls, revision-captured model pushes, typed session
operations, actor as data on local calls, the default policy as its own plugin.
