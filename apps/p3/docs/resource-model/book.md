---
title: p3: what a session may use
cover: One List / Many Groupings
kicker: A spec, reviewed · p3 resource model · 2026-11-08
subtitle: Users, resources, one resource source per session, groupings that only show, one policy, and workers that follow their list, with the typed APIs every plugin uses
stats:
  - 1 | resource source per session, one field in the catalog
  - 1 | policy, behind one registry, asked at one guarded step
  - 0 | action strings: requests and operations are typed values
  - 39 | p2 plugins the review maps onto it
note: |
  The spec of the model the owner agreed on in the voice walkthrough of 2026-11-08 (decision "Resource model direction"
  in `apps/p3/docs/decisions.md`), built from the two independent designs by Astra and Sol (`/tmp/p3-model-astra.md`,
  `/tmp/p3-model-sol.md`) minus their extras, and from the stress test (`model-stress/report.md`) with its reviews.
  Chord APIs are real (`remote`, `local`, `keyed`, `defineTable`, `defineRegistry`, `self.writable`, `self.derive`,
  `ParamsOf`, `CurrentVariants`); every p3 name is a proposal. Written for the reviewers first: appendix B is their
  brief. Second edition: the review by Astra and Sol is folded in (appendix C); four points wait for the owner
  (epilogue). Not built.
colophon: p3 resource model · spec, second edition after review · 2026-11-08 · from the owner's walkthrough and the Astra and Sol designs
---

# Before we begin {.preface}

Mario runs p3 on his laptop. He never thinks about resources: every session he opens has his models, his MCP servers,
his machines and every tool the installed plugins offer. When he installs a plugin with a new tool, the tool is in his
next turn.

At Earendil the same p3 serves three people. Colin, Cristina and Charlotta start a project. Colin brings his Linear MCP
server, signed in as Colin; Cristina brings her GPU machine; Charlotta brings her Anthropic key. A session in the
project uses exactly those three, whoever sends. Colin takes his MCP server back in the middle of a session; the next
call to it is refused. Engineering may create MCP servers, research may not, yet a researcher in the project uses
Colin's server. A Discord channel feeds a session that may only read the answers of one other session, for one hour.

The models we tried before mixed two questions: *where does something appear* (a project, a folder, a recent list, a
Discord server) and *what may a session use*. Every attempt to let groupings decide resources produced selectors,
precedence rules and login modes. This spec separates the questions. **Groupings show. One list equips.**

## Ten things to know

:::findings
1. **Where something appears is not what a session may use.** A session appears in any number of groupings; it uses
   exactly one list.
2. **Users are people plus one instance user.** The instance user owns company resources (a company key, the build
   machine, the Discord bot) and every plugin's built-ins. Nobody signs in as it.
3. **A resource is a Chord object of a resource kind, owned by one user forever.** Its login, if it has one, never
   changes. A second login is a second resource.
4. **Users create resources only for themselves; admins create them for the instance user.** Installing a plugin is
   an admin act: the plugin's setup-free built-ins (tools, prompt sections) become instance resources by themselves.
5. **A session has one resource source, one field in the catalog:** its owner's defaults, its own list, or one
   grouping with resources. The defaults are a rule, "everything I own plus every instance resource I may use", so new
   built-ins appear in normal sessions automatically.
6. **Groupings are plugins.** Computed ones (folders, recent) and curated ones (projects, Discord channels) show
   things. A grouping *with resources* keeps its own list in its own plugin and registers with core how to read and
   change it.
7. **Everyone who may send in a session uses its whole list.** No per-run authority (decision 2026-11-08).
8. **One policy decides, through typed requests, at core's guarded steps.** Plugins never import ACL, SAML or Radius;
   UIs never check anything, they render server views such as a user's creatable kinds.
9. **Workers follow their list.** The harness admits an extension only while its resource is on the list and belongs to
   the plugin that contributed it, and checks again at every tool call; resource plugins' per-session server views
   check the list at every call too. Anything unknown, offline or expired fails closed.
10. **Presentation is open.** Creators per resource kind, renderers per contract and form, panels from several plugins
    for one detail view; layouts are plugins.
:::

## Words used throughout

A **user** is a person with a p3 account; the **instance user** (`INSTANCE`) is the reserved user owning company
resources and built-ins. A **resource kind** is a Chord contract whose objects are resources, declared with
`resourceKind`. A **resource** is one object of a resource kind, named by its kind and typed params; its **owner** is
read from its params. A **built-in** is a setup-free resource a plugin declares, owned by the instance user. The
**index** is core's table of every resource with its owner and the plugin that serves its kind. A **list** is a set of
**entries**, each naming a resource, who brought it and an optional expiry. A session's **resource source** says where
its list comes from: the **defaults** (a rule), its **own list**, or a **grouping with resources**. The **effective
list** is the source's entries after core removed expired, unknown and denied ones; it is what the session's worker
follows. A **grouping** is a plugin's object that shows other objects. The **policy** is the one contribution to the
`Policies` registry; it answers typed **requests** given a **baseline**, the answer core and the owning plugin give
without it. A **guarded step** is a core method that asks the policy before it changes anything. An **extension grant**
is a worker contribution pairing a Durable extension with the resource it belongs to. A **creator** is a resource
kind's page contribution that creates one; a **renderer** draws a contract's object in a **form** (row, card, detail);
a **panel** is one part of a detail view.

# Names Written Once {#typing lede="How the model stays typed: contracts and tokens in code, erased addresses only at storage, wire and registry boundaries."}

The owner's rule is "no stringly-typed APIs". In p2 the session lock names MCP servers by string, capabilities are a
string list (`"ports" | "conversations"`), and every tool repeats its own access fields. The model must not repeat
that, yet resources of unrelated plugins have to live in one list, one table and one wire message. Those three places
cannot hold a TypeScript type.

The answer is the same as Chord's own: **an identity is a name written once, in a contract file; code refers to the
constant.** `remote("mcp.server", ...)` writes the name once; every other file imports `McpServer`. The model adds
three tokens of the same kind, all built from Chord contracts:

```ts
// plugins/resources/contract.ts: core's resources plugin; every facet imports it through @p3/app/v1

/** A kind of resource: the contract whose objects are resources, and how an object's params name its owner. */
export type ResourceKind<C extends RemoteContract = RemoteContract> = {
	readonly contract: C;
	readonly ownerOf: (params: ParamsOf<C>) => UserId;
};
export function resourceKind<C extends RemoteContract>(
	contract: C,
	ownerOf: (params: ParamsOf<C>) => UserId,
): ResourceKind<C>;

/** One resource: its kind and the typed params of its object. */
export type Resource<C extends RemoteContract = RemoteContract> = {
	readonly kind: ResourceKind<C>;
	readonly params: ParamsOf<C>;
};
export function resource<C extends RemoteContract>(kind: ResourceKind<C>, params: ParamsOf<C>): Resource<C>;

/** Any Chord object as stored, sent and kept in registries: its contract's name and its params. */
export const ObjectAddress = obj({ contract: str(), params: map(union([str(), int(), bool()])) });
export type ObjectAddress = Static<typeof ObjectAddress>;

/** `r` erased, for a table, a list entry or a wire message. */
export function pack(r: Resource): ObjectAddress;

/** `a` as a resource of `kind` (its params checked with the contract's params schema), or undefined: another kind. */
export function match<C extends RemoteContract>(kind: ResourceKind<C>, a: ObjectAddress): Resource<C> | undefined;
```

A plugin's operation, when the policy needs to name it, is a method of its contract, taken as a value:

```ts
/** The name of a method of `C`'s current variants, as a value: a misspelled method does not compile. */
export function operation<C extends RemoteContract, M extends MethodName<C>>(contract: C, method: M): Operation<C, M>;

// MethodName<C> and ArgsOf<C, M> are small type helpers over Chord's CurrentVariants<C> (contracts/contract.ts).
```

Where the erased `ObjectAddress` appears, the code that reads it calls `match(kind, address)` and gets typed params or
nothing. That is the only place a contract name is compared as a string: in `match`, inside core.

**Tokens are compared by declaration, never by `===`** (review, Sol 1). Chord bundles a copy of another plugin's
contract into each facet that imports it, and a reload makes another copy, so the policy plugin's `McpKind` and the MCP
plugin's `McpKind` are different JavaScript objects. Core resolves every token through its current registrations and
compares the contract's name and a compatible version; code asks through typed helpers:

```ts
/** Whether `kind` names the same declared resource kind as `token` (contract name, compatible version). */
export function isKind<C extends RemoteContract>(kind: ResourceKind, token: ResourceKind<C>): kind is ResourceKind<C>;
/** The same for grouping kinds and operations; `Request.call.match(op)` uses `isOperation` inside. */
export function isGroupingKind<C extends RemoteContract>(kind: GroupingKind, token: GroupingKind<C>): kind is GroupingKind<C>;
export function isOperation<C extends RemoteContract, M extends MethodName<C>>(op: Operation, token: Operation<C, M>): op is Operation<C, M>;
```

A test builds the policy plugin and the MCP plugin separately and reloads only one of them.

:::note | The rule for reviewers
Strings are allowed as identities written once in a contract file (`remote("mcp.server")`, `builtin("coding-tools")`,
`form("p3.row")`), as erased addresses in storage, wire messages and registry tables, and as persisted user data
(an admin's rule naming a kind). Anything else that switches behaviour on a string literal is a finding.
:::

# People {#users lede="Users, the instance user, and the one way a person becomes a user."}

Every person with an account is a user. One more user exists in every instance from the start: `INSTANCE`. It exists
so that "who owns the company's Anthropic key" has an answer that is not a person who might leave. It owns the build
machine, the Discord bot and every built-in tool. Nobody signs in as it; admins act for it.

```ts
// plugins/users/contract.ts
export type UserId = string & { readonly "~user": true };

/** The instance user: owns company resources and plugins' built-ins. Nobody signs in as it. */
export const INSTANCE: UserId;

/** p3's principals (decision 2026-11-06); links stamp them, a caller's data never sets one. */
export type P3Principal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly session: string }
	| { readonly kind: "user"; readonly id: UserId }
	| { readonly kind: "guest" }; // reserved until sharing is designed

/** Users (server, host lifetime): who exists, and the one way to become one. */
export const Users = local("p3.users", {
	version: 1,
	params: {},
	members: {
		users: arr(UserRow), // { id, name, admin, signIns: [{ issuer, subject }] }
		/** The user an external identity signs in as, created at its first sign-in. Never keyed by email. */
		signIn: method(obj({ issuer: str(), subject: str(), name: str() }), str()),
	},
});
```

**Sign-in plugins create users; nothing else does.** The kit's owner link signs in as the first user (issuer
`p3.owner`), which is the single-user laptop. A SAML plugin maps `(issuer, subject)` from a verified assertion; a Radius
plugin does the same with a Radius account (chapter IX). The first user is an admin; who else administers is the
policy's answer to the request `administer` (chapter VI).

# Things a Session Uses {#resources lede="Resource kinds, the index, the guarded create, and built-ins that create themselves."}

A resource is anything a session can use: a model provider, an MCP server, a machine, a drive, a tool, access to one
other session. Each is an ordinary Chord object whose contract's params name its owner. Its plugin keeps its
configuration and secrets; core keeps one row per resource in the **index**: its address, its owner, the plugin that
serves its kind and a label for generic lists.

## A kind, declared in the plugin's contract file

```ts
// plugins/mcp/contract.ts
export const McpServer = remote("mcp.server", {
	version: 1,
	params: { owner: str(), id: str() },
	hostAddress: () => Server(),
	variants: {
		user: { state: { info: McpInfo }, methods: { configure: method(McpConfig), signIn: method() } },
	},
});

/** MCP servers are resources; the owner is a param, so it can never change. */
export const McpKind = resourceKind(McpServer, (p) => userId(p.owner));

// plugins/mcp/server.ts: the server facet tells core the kind exists (and that this plugin serves it)
self.contribute(ResourceKinds, [register(McpKind)]);
```

`register(kind, { use? })` may give the kind a **use baseline**, the answer to `use` without a policy (review, Sol 8,
Astra S4). Most kinds leave it out (allow). Kinds that run code on the server machine set it to *the session's owner
administers*: `register(EnvKind, { use: localMachineAdminOnly })` for `LocalMachine`, and the reload built-in the same
way. The effective list passes that baseline to the policy instead of an unconditional allow.

The worker facet, the page facet and the server facet all import `McpKind` from the same file; they cannot drift. The
`ResourceKinds` registry (server) tells core which plugin serves which kind: that is the plugin recorded in each index
row and checked on the worker (chapter VII).

## Creating: the guarded step

A plugin creates a resource in its own user-facing method, as the calling user, and passes the creation through core
before its own row exists:

```ts
// plugins/mcp/server.ts: the user's view of the MCP plugin
host.serve(McpServers, (_params, principal, self) => {
	if (principal.kind !== "user") throw forbidden("users only");
	const resources = self.get(Resources, {});
	const store = self.get(McpStore, {});
	return {
		variant: "user",
		members: {
			servers: store.serversOf(principal.id),
			create: async ({ id, owner, config }, ctx) => {
				// `id` is the caller's (stable across retries); `owner` is the user or INSTANCE (an admin's company server).
				const created = resource(McpKind, { owner, id });
				// The guarded step: the owner rule, then the policy; the index row stays incomplete until `complete`.
				await resources.create({ actor: principal.id, resource: pack(created), label: config.name }, ctx);
				await guard(access, principal.id, CreateMcp, {}, { id, owner, config }, transportBaseline(config, principal), ctx);
				await store.insert(created.params, config, ctx);
				await resources.complete({ resource: pack(created) }, ctx);
				return pack(created);
			},
		},
	};
});
```

`Resources.create` is a local server method (callers are trusted server code; `actor` comes from the caller's checked
principal, as Sol's design requires for local calls that act for someone):

```ts
export const Resources = local("p3.resources", {
	version: 1,
	params: {},
	members: {
		/** Every session's effective list, by session id; a worker's server view pins its own with at(session). */
		lists: keyed(SessionList),
		/** The guarded step for a new resource: owner rule, policy, then an incomplete index row. Repeatable for the same actor and address. */
		create: method(obj({ actor: str(), resource: ObjectAddress, label: str() })),
		/** The plugin wrote its own row: the resource becomes usable. */
		complete: method(obj({ resource: ObjectAddress })),
		/** A resource's object is gone: out of the index, out of every list. */
		forget: method(obj({ resource: ObjectAddress })),
	},
});
```

What `create` does, in order:

1. Find the kind by the address's contract in `ResourceKinds`; an unknown kind is refused.
2. **The owner rule, not overridable by any policy:** the owner read with `kind.ownerOf(params)` is the actor, or the
   instance user and the actor administers. Nobody creates a resource that uses another person's login.
3. **The policy:** `{ kind: "create-resource", actor, resourceKind, owner }` with baseline allow. A SAML rule "only
   engineering may create MCP servers" denies here.
4. Write the index row with the kind's plugin, marked **incomplete**: no effective list includes it. A repeated
   `create` for the same address and actor succeeds without a second row; the same address from another actor is
   refused.
5. The plugin writes its own row and calls `complete`; only then is the resource usable. Core reconciles incomplete
   rows a crash left behind (review, Sol 14, Astra S5).

**Who the actor is.** Local calls act as the server (Chord §4), so every trusted local step takes the checked user
explicitly, from the public method's link-stamped principal, never from browser data (review, Sol 2, Astra M1). A
sign-in that provisions resources for a new user (Radius, chapter IX) calls the plugin's trusted local create
(`McpStore.createFor({ actor, owner, id, config })`) with the user its verified sign-in just produced; it never
impersonates the user on a remote call.

## Built-ins: created by installing

Tools that need no setup (read, write, edit, bash, a third-party plugin's plain tools, a prompt section) are
resources too, or a session could not be locked down to "only the conversation tool". Asking each user to create them
would be absurd, so **a plugin declares its built-ins and core creates them for the instance user when the plugin is
installed.** Installing a plugin is an admin act; the built-ins are part of it.

```ts
// core: one resource kind for all built-ins; an object per built-in describes it for people
export const Builtin = remote("p3.builtin", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	variants: { user: { state: { info: BuiltinInfo } } },     // label, description, plugin
});
export const BuiltinKind = resourceKind(Builtin, () => INSTANCE);   // a built-in carries no login

/** A built-in resource of a plugin: its id is written once, here, in the plugin's contract file. */
export function builtin(id: string): Resource<typeof Builtin>;

// plugins/coding-tools/contract.ts
export const FileTools = builtin("coding-tools.files");    // read, write, edit
export const Bash = builtin("coding-tools.bash");          // a separate resource: pickable on its own

// plugins/coding-tools/server.ts
self.contribute(Builtins, [
	describe(FileTools, { label: t.message("fileTools"), description: t.message("fileToolsAbout") }),
	describe(Bash, { label: t.message("bash"), description: t.message("bashAbout") }),
]);
```

Core follows the `Builtins` registry: a new entry becomes an index row owned by `INSTANCE` with the contributing
plugin; a built-in whose plugin is not loaded (a failed reload, an uninstall) stays in the index marked unavailable and
drops out of every effective list until it comes back. Two plugins declaring the same id is a reported conflict; the
first by plugin name keeps it.

**One Durable extension is one resource.** A plugin chooses its granularity by how it splits its extensions:
`coding-tools` above offers two, so a session can have the file tools without bash.

# One List {#lists lede="The session's one resource source, the defaults rule, bringing and withdrawing, expiry, and the effective list."}

The session catalog (the sessions plugin's server table) gets one field:

```ts
// plugins/resources/contract.ts
export const ResourceSource = union([
	obj({ kind: lit("defaults") }),                          // the owner's defaults: a rule, not a list
	obj({ kind: lit("own") }),                               // the session's own list, kept by core
	obj({ kind: lit("grouping"), grouping: ObjectAddress }), // one grouping with resources
]);

// plugins/sessions/server.ts: the catalog row
type SessionRow = {
	readonly id: string;
	readonly owner: UserId;
	readonly title: string;
	readonly source: ResourceSource;
	// location, status, pin, archive: as before
};
```

There is one field, so a session has one source **by construction**: no check across groupings, no precedence. Moving
a session into another grouping with resources replaces the field; the old grouping no longer equips it.

## Entries

Every list, wherever it is kept, holds the same entries:

```ts
export const ListEntry = obj({
	resource: ObjectAddress,
	broughtBy: str(),           // the user who brought it, stamped by core, never caller data
	until: nullable(int()),     // an expiry in ms since the epoch; null: until removed
	revision: int(),            // the resource's withdrawal revision when it was brought, stamped by core
});
```

There is no login field and no mode: the resource's owner decides which login it uses, forever. An expiry sits on the
entry, not on the resource: "Colin's MCP server in project pi until Friday" says nothing about the server.

## The three sources

- **Defaults** is not stored. It is the rule *every resource the session's owner owns, plus every instance resource the
  policy lets the owner use, minus the owner's exclusions*. That rule is why Mario never configures anything and why a
  third-party plugin's new tool appears in his next turn: installing the plugin adds an instance resource, and the
  rule includes it. **Exclusions** (review, both) are a per-user set of resource addresses core keeps; it is how
  someone turns code mode or cache warming off everywhere without locking every session down. Plugin settings that are
  not about authority (warming mode, voice choice, model cycling) stay plugin settings.
- **Own** is a list core keeps per session (`p3.resources.session-lists`, rows of session id plus entry). "Lock down
  this session" (`lockDown`) switches a session from defaults to own, starting from a snapshot of its current effective
  list, then the user removes what it should not have. The snapshot is a same-session operation: it never lets anyone
  bring those resources anywhere else (review, Astra M2, M3).
- **Grouping** names a grouping with resources. Its plugin keeps the list; core reads it through the plugin's
  registration (chapter V).

## The effective list

Core turns the source into the list a session actually gets, and keeps it live as one keyed member,
`Resources.lists.at(session)`:

```ts
/** What a session's worker follows: ready with its entries, or unavailable (fail closed). */
export const SessionList = union([
	obj({ kind: lit("ready"), entries: arr(EffectiveEntry) }),   // { resource, plugin, owner, until }
	obj({ kind: lit("unavailable"), reason: MessageSchema }),
]);

function effective(row: SessionRow, facts: Facts): SessionList {
	const entries =
		row.source.kind === "defaults" ? defaultsOf(row.owner, facts)
		: row.source.kind === "own" ? (facts.ownLists.get(row.id) ?? [])
		: facts.groupingLists.read(row.source.grouping);           // undefined: its plugin is not loaded
	if (entries === undefined) return { kind: "unavailable", reason: messages.message("sourceUnavailable") };
	return {
		kind: "ready",
		entries: entries.flatMap((entry) => {
			const indexed = facts.index.get(addressKey(entry.resource));
			if (indexed === undefined || indexed.unavailable) return [];          // unknown: never usable
			if (indexed.incomplete) return [];                                   // its plugin has not written it yet
			if (entry.revision < indexed.revision) return [];                   // withdrawn by its owner since
			if (entry.until !== null && entry.until <= facts.now) return [];     // expired
			const use = facts.policy.decide({ kind: "use", session: row, resource: indexed }, indexed.useBaseline(row));
			if (use.kind === "deny") return [];
			return [{ resource: entry.resource, plugin: indexed.plugin, owner: indexed.owner, until: entry.until }];
		}),
	};
}
```

Core recomputes a session's entries when anything it read changes: the catalog row, the own lists, the index, a
grouping's list, the policy value, or the clock. The clock is a small writable a routine advances at the next expiry,
so an entry with `until` drops out at its deadline; every server-side admission also compares `until` with the current
time itself, so a late timer never extends access.

## Bringing and withdrawing

People change lists through core's per-user view, so the actor is always the link-stamped principal:

```ts
export const MyResources = remote("p3.resources.mine", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		user: {
			state: {
				owned: arr(IndexRow),            // my resources, any kind
				excluded: arr(ObjectAddress),    // my exclusions from defaults
				creatable: arr(Creatable),       // { owner: me | INSTANCE (admins), kinds: contract names } (erased: wire state)
			},
			methods: {
				/** What I may bring into this list, with the longest `until` the policy allows: a picker's candidates. */
				candidates: method(obj({ into: ListRef }), arr(Candidate)),
				bring: method(obj({ resource: ObjectAddress, into: ListRef, until: nullable(int()) })),
				remove: method(obj({ resource: ObjectAddress, from: ListRef })),
				withdraw: method(obj({ resource: ObjectAddress })),   // the owner takes it out of every explicit list
				exclude: method(obj({ resource: ObjectAddress, excluded: bool() })),
				setSource: method(obj({ session: str(), source: ResourceSource })),
				lockDown: method(obj({ session: str() })),           // defaults or grouping to own, from a checked snapshot
			},
		},
	},
});

/** A list: a session's own, or a grouping's. */
export const ListRef = union([
	obj({ kind: lit("session"), session: str() }),
	obj({ kind: lit("grouping"), grouping: ObjectAddress }),
]);
```

**Bringing needs both sides** (owner, walkthrough): the resource side, *you own it, or it is an instance resource and
you administer*, and the list side, *the list's own rule lets you add to it* (a session's own list: its owner; a
grouping's: whatever its plugin says, for a project its members). Then the policy sees
`{ kind: "bring", actor, resource, into, until }` and may narrow (a maximum lending time) or widen (project maintainers
may bring the company key). Being allowed to *use* an instance resource is not being allowed to hand it to a project's
whole audience (review, both; the first draft's widening is dropped).

:::review | Decision for the owner: built-ins in project lists
With that baseline a non-admin cannot bring a built-in tool (bash, the file tools) into a project, and a project's list
holds only what was brought, so a project session has no tools unless an admin brings them (review, Astra N3, Sol
trace 2). Proposal: built-ins carry no login, so their resource side passes for anyone the policy lets use them, and a
new grouping's list starts with every built-in its creator may use; instance resources with a login (the company key,
the build machine) stay admin-only. Not decided.
:::

**Taking out:** the resource's owner can always withdraw it (`withdraw`), and a list's maintainers can remove anything
from their list (`remove`, the list side's rule), never touching the resource itself. Neither needs the policy's
permission. Withdrawal is **durable** (review, both): core raises the resource's `revision` in the index first, so
every entry brought before it stops counting at once, in every list, also in a grouping whose plugin is not loaded and
returns later with its old rows; then core asks each loaded keeper to delete the entry, and retries absent ones when they
return. A new bring stamps the current revision. Withdrawal covers explicit lists; the owner's own defaults sessions
stop using a resource through `exclude`.

**Changing the source** (`setSource`) always needs the session side, *you may change this session* (its owner by
baseline), and the destination side: into a grouping, its `mayJoin`; to `defaults`, the session's owner only. The
policy sees `{ kind: "set-source", actor, session, source }`. **`lockDown`** builds the own list from a snapshot: from
defaults, the same session's current entries; from a grouping, only entries the actor may bring into the session's own
list under the resource side (their `until` kept, never extended), the others listed for the user before confirming.
Cristina locking down a project session therefore cannot keep Colin's server after Colin or the project withdraws it
(review, both).

**Copies.** Clone and fork re-run these rules for the new session before its worker starts: an own list is copied
entry by entry as brings into the copy (deadlines kept), a grouping source is kept only if the actor may join it, and a
copy of a Discord-fed session becomes an own list of the authorized entries, never defaults. Content (transcript, files,
artifacts) is copied as before; copying content is not consent to use someone's resource.

# Where Things Appear {#groupings lede="Groupings as plugins: computed and curated ones, the few that carry resources, members and who sees a session."}

The owner's requirement (2026-11-07): plugins contribute kinds of groupings, each grouping shows any addressable thing
and renders its own header, without stepping on other plugins. This model adds one thing to that: most groupings only
show, and **a grouping with resources registers with core**.

## Groupings that only show

- **Folders** are computed from where sessions work: the folders plugin reads the catalog's locations and groups by
  env and directory. Moving a session's location moves it to another folder. Nobody puts it there, and the plugin
  keeps no facts of its own.
- **Recent** is per user: the recent plugin keeps a table `(user, session, at)` written when a user opens or sends in a
  session (its web facet calls its own view's `touch`), and serves each user their own rows. Cristina's recent list is
  not Mario's.
- **A mirrored SAML group** shows its members (chapter IX).

None of them registers anything with core. They cannot equip a session, so being in them is never security-sensitive.

## Groupings with resources

A project is a grouping with resources. So is a Discord channel linked to a session. Their plugins keep the lists, in
their own tables, and tell core how to read and change them:

```ts
// plugins/resources/contract.ts
export type GroupingKind<C extends RemoteContract = RemoteContract> = { readonly contract: C };
export function groupingKind<C extends RemoteContract>(contract: C): GroupingKind<C>;

/** What a grouping kind tells core. Groupings that only show register nothing. */
export type GroupingRegistration<C extends RemoteContract> = {
	readonly kind: GroupingKind<C>;
	/** Users and groupings in each grouping, by the grouping's identity key; read for visibility and policy rules. */
	readonly members?: KeyedWatchable<readonly MemberRef[]>;
	/** Present only on a grouping with resources. */
	readonly resources?: {
		readonly lists: KeyedWatchable<readonly ListEntry[]>;
		mayBring(actor: UserId, grouping: ParamsOf<C>): boolean;    // the list side of bringing
		mayRemove(actor: UserId, grouping: ParamsOf<C>): boolean;   // maintainers taking something out
		mayJoin(actor: UserId, grouping: ParamsOf<C>): boolean;     // making it a session's source
		add(grouping: ParamsOf<C>, entry: ListEntry, ctx: Ctx): Promise<void>;
		remove(grouping: ParamsOf<C>, resource: ObjectAddress, ctx: Ctx): Promise<void>;
	};
};
export function registerGrouping<C extends RemoteContract>(r: GroupingRegistration<C>): ErasedRegistration;
export const GroupingKinds = defineRegistry<readonly ErasedRegistration[], GroupingTable>("p3.groupings", { version: 1 });

export type MemberRef =
	| { readonly kind: "user"; readonly user: UserId }
	| { readonly kind: "grouping"; readonly grouping: ObjectAddress };
```

The projects plugin, which knows nothing about MCP, models or ACL:

```ts
// plugins/projects/contract.ts
export const Project = remote("projects.project", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	variants: {
		maintainer: { state: { view: ProjectView }, methods: { rename: method(obj({ title: str() })), addMember: method(MemberArgs) } },
		member: { state: { view: ProjectView } },
	},
});
export const ProjectKind = groupingKind(Project);

// plugins/projects/server.ts: a host-lifetime store registers the kind once
host.serve(ProjectStore, (_params, self) => {
	const projects = self.table(ProjectRows);      // id, title, maintainers, members
	const lists = self.state(ProjectLists);        // keyed by project: ListEntry[]
	const members = self.state(ProjectMembers);    // keyed by project: MemberRef[]
	const isMember = (user: UserId, p: ParamsOf<typeof Project>) => /* expanded through core's Members */;
	self.contribute(GroupingKinds, [registerGrouping({
		kind: ProjectKind,
		members,
		resources: {
			lists,
			mayBring: isMember,
			mayRemove: isMaintainer,
			mayJoin: isMember,
			add: (p, entry, ctx) => addEntry(lists, p, entry, ctx),
			remove: (p, resource, ctx) => removeEntry(lists, p, resource, ctx),
		},
	})]);
	return {
		/** Called by the Project view's addMember with the checked actor: core asks `add-member`, then this commits. */
		addMember: async ({ actor, project, member }, ctx) => {
			await access.addMember({ actor, to: addressOf(Project, project), member, baseline: isMaintainer(actor, project) }, ctx);
			await commitMember(members, project, member, ctx);    // Members recomputes; policy and views follow
		},
		// create (core's create-grouping, same shape), rename
	};
});
```

A project's sessions are a query, not a list it keeps: catalog rows whose source is this project. That is why the
session points up and not the project down: two projects listing the same session would give it two sources.

:::review | Decision for the owner: showing sessions a project does not equip
Both reviewers want a project to also *show* sessions that use another source (a session of pi linked to a Discord
channel now uses the channel's list and disappears from pi; p2 keeps both). The fix keeps one source: a project may
keep plain display references, drawn as "shown here, uses #support's resources", granting nothing. Not decided; the
walkthrough dropped "links" as confusing.
:::

**Roles stay live** (review, Sol 10). Chord picks a view's variant once, when it is made, so `maintainer | member`
variants would not follow a promotion. The project view has one user variant whose methods check the current facts
and whose state carries the actions the user may take now; members who leave stop getting state at the next push.

## Members and who sees a session

Members are users or groupings (a project can have the mirrored SAML group "engineering" as a member). Core's `Members`
object expands them through every registration's `members`, cutting cycles, and serves `has(grouping, user)` and the
groupings a user is in. The policy reads the same object. Mirrored groups are named by a stable directory identity
(`SamlGroup { issuer, id }`, the display name separate), are read-only through `add-member`, and a directory that is
unavailable or stale yields no members, never everyone (review, Astra S7).

**A user sees a session when** they own it, it is shared with them (the session's own people list, kept by the
sessions plugin; guests stay reserved), or they are a member of its source grouping. The sessions plugin's catalog view
for a user filters rows by exactly these three facts; no other grouping is asked.

Seeing is not every operation (review, Astra M11). The sessions plugin keeps live facts per session and user,
`mayView`, `maySend` (owner, shared with send, members of the source grouping) and `isOwner`, and its methods use them
as baselines for typed operations: `operation(Chat, "send")`, `operation(Chat, "shell")`, `operation(Chat, "reset")`,
`operation(Chat, "configure")`, `operation(SessionTree, "navigate")`, lifecycle methods. HTTP and socket routes
(uploads, downloads, artifacts, voice, terminals) authenticate, then apply the same decision before entering
server-local authority. Logs, devices, port-host control and instance integrations stay admin operations.

## A Discord channel

The Discord plugin's grouping `DiscordChannel { bot, channel }` is a grouping with resources. Linking a channel to a
session sets the session's source to the channel; the channel's list starts nearly empty (a model provider) and the
link sheet adds what the channel may use. Who may change the channel's list is the Discord plugin's rule (the link's
creator, and admins: the bot is an instance resource). The people in the channel are not users; they are attributed
authors of inputs, and like every sender they drive the whole list.

Linking and unlinking are source transitions (review, Astra S2): linking prepares the channel's list, validates the
location and commits the source before ingress starts; the previous source is kept only as transition data. Unlinking
stops ingress first, then restores the previous source if the actor may still set it, else leaves an own list of the
authorized entries and says why. Channel methods are bound to that bot and channel; cursors and bindings are never
copied to a clone.

# Who May {#policy lede="One replaceable policy answers typed requests; core asks it at its guarded steps; views carry the answers to the page."}

Groupings from SAML, from Radius and from projects do not know each other. Something must still decide that Colin may
create an MCP server, that Cristina may not, and that a researcher may still use one. **One policy, behind one
registry, decides; core asks it at the moment an action happens, on the server.**

```ts
// plugins/policy/contract.ts: core
export type Decision = { readonly kind: "allow" } | { readonly kind: "deny"; readonly reason: MessageData };

/** Everything core asks. Kinds and operations are tokens, compared with isKind / isOperation (chapter I), never by name. */
export type Request =
	| { readonly kind: "create-resource"; readonly actor: UserId; readonly resourceKind: ResourceKind; readonly owner: UserId }
	| { readonly kind: "create-grouping"; readonly actor: UserId; readonly groupingKind: GroupingKind }
	| { readonly kind: "bring"; readonly actor: UserId; readonly resource: Indexed; readonly into: ListRef; readonly until: number | null }
	| { readonly kind: "set-source"; readonly actor: UserId; readonly session: SessionRow; readonly source: ResourceSource }
	| { readonly kind: "add-member"; readonly actor: UserId; readonly member: MemberRef; readonly to: ObjectAddress }
	| { readonly kind: "use"; readonly session: SessionRow; readonly resource: Indexed }
	| { readonly kind: "administer"; readonly actor: UserId }
	| { readonly kind: "call"; readonly actor: UserId; match<C extends RemoteContract, M extends MethodName<C>>(
			op: Operation<C, M>,
		): { readonly target: ParamsOf<C>; readonly args: ArgsOf<C, M> } | undefined };

export type Policy = {
	/** The answer to one request; `baseline` is the answer core and the owning plugin give without a policy. */
	decide(request: Request, baseline: Decision): Decision;
};

/** Exactly one provider; a value that changes is a writable. Zero or two providers compose to deny-all. */
export const Policies = defineRegistry<Policy, Policy>("p3.policy", { version: 1 });
```

**The default policy is `(_request, baseline) => baseline`**, shipped as its own plugin (`default-policy`) and
installed explicitly, never a fallback for an empty registry (review, Astra N2). Baselines come from facts the owning
code has: the owner rule, the grouping's own `mayBring`, the session owner for `setSource`, the users plugin's admin
flag for `administer`, the kind's use baseline for `use` (allow unless the kind says otherwise). On one laptop nobody
ever sees it.

**Hard rules come before the policy and cannot be overridden:** nobody creates a resource owned by another person;
workers never change lists or create resources; an unknown kind is refused. A missing policy (zero providers, two, or
one that failed) composes to deny-all until it is fixed, so removing an organization's policy never opens everything
and never reinstalls the default by itself.

## Asking: core's guarded steps

Core's own operations (create a resource, bring, remove, set a source, add a member, administer) are core methods that
build the typed request and ask. A plugin's own operation that a company might want to restrict asks through one helper,
typed by its contract:

```ts
// plugins/drives/contract.ts
export const ShareDriveLink = operation(Drive, "shareLink");

// plugins/drives/server.ts: inside the method; the actor is the link-stamped caller, passed explicitly
shareLink: async (args, ctx) => {
	await guard(access, principal.id, ShareDriveLink, params, args, ownerBaseline(principal, params), ctx);   // throws forbidden
	return links.create(params, args, ctx);
},
```

`access` is core's local `Access` object (`self.get(Access, {})`); `guard` sends it the erased request
(`{ actor, operation: { contract, method }, target, args, baseline }`), and core hands the policy the typed `call`
request, whose `match` checks the operation with `isOperation` and gives back typed target and args. The actor travels
as data because a local call acts as the server (review, both). `Access` has one typed method per core request
(`createGrouping`, `addMember`, ...) for plugins that own those writes, so a project's create still meets the rules for
`create-grouping`, not an unrelated `call`. Plugins never see which policy is installed.

Configuration changes are guarded like creation (review, Astra S4): `ConfigureMcp = operation(McpServer, "configure")`
checks the new configuration, so an HTTP server cannot later become a server-machine stdio one; env mutations and a
port's public visibility use typed operations the same way.

## The answers reach the page as view state

UIs never check. Core's `MyResources` view for a user carries `creatable`, computed on the server:

```ts
// core, the user variant of MyResources
const creatable = self.derive([kinds, policy, members.ofUser.at(me)], ([registered, current]) =>
	ownersFor(me).map((owner) => ({                      // me, and INSTANCE when I administer (review, Sol 2)
		owner,
		kinds: registered
			.filter((kind) => current.decide({ kind: "create-resource", actor: me, resourceKind: kind, owner }, ALLOW).kind === "allow")
			.map((kind) => kind.contract.name),
	})),
);
```

The policy value is in-process, so the derive's output is plain data while its input changes as a writable ("derives
JSON only").

The add-resource picker shows the creators whose kind is in that list (chapter X). When an admin changes a rule, the
chain below runs without a reload and without anything polling:

:::sequence animate | An admin lets research create MCP servers; Cristina's picker gains the MCP creator.
actor admin "admin's page" "settings sheet" blue
actor rules "rules plugin" "server: the policy" accent
actor core "core resources" "server"
actor view "MyResources" "Cristina's view"
actor page "Cristina's page" "add-resource picker" blue
admin -> rules: addRule { members: research, may: create mcp.server }
rules => rules: commit the rules document
rules => rules: policy.set(new Policy): the registry recomposes
rules --> core: Policies value changed
core -> core: derive creatable for each live user view
core --> view: creatable gains "mcp.server"
view --> page: state pushed over the link
page -> page: picker re-renders: "MCP server" appears
:::

## The rules plugin

The policy a company installs is a plugin. The one p3 ships, `rules`, stores rules an admin edits in a settings sheet,
each "members of grouping G may ...", where G comes from any plugin (a mirrored SAML group, a hand-made team, a
project):

```ts
// plugins/rules/contract.ts: persisted data, so kinds are names here (the storage boundary)
export const Permission = union([
	obj({ kind: lit("create-resource"), resourceKind: str() }),
	obj({ kind: lit("create-grouping"), groupingKind: str() }),
	obj({ kind: lit("use"), resourceKind: str() }),
	obj({ kind: lit("administer") }),
]);
export const Rule = obj({ members: ObjectAddress, may: Permission });

// plugins/rules/server.ts
host.serve(RulesPolicy, (_params, self) => {
	const rules = self.state(RulesDoc);
	const members = self.get(Members, {});
	const policy = self.writable<Policy>(denyAll);
	self.contribute(Policies, policy);
	self.on([rules, members.version], () => policy.set(rulesPolicy(rules.value.rules, members)));
	return { rules, addRule, removeRule };     // admins only: the request `administer`
});

/** A permission with rules is restricted to members of their groupings; one without rules keeps the baseline. */
function rulesPolicy(rules: readonly Rule[], members: MembersReader): Policy {
	return {
		decide: (request, baseline) => {
			const relevant = rules.filter((rule) => covers(rule.may, request));
			if (relevant.length === 0) return baseline;
			const actor = actorOf(request);    // the session's owner for `use`
			return relevant.some((rule) => members.has(rule.members, actor))
				? ALLOW
				: deny(messages.message("restricted"));
		},
	};
}
```

So "only engineering may create MCP servers" is one rule. Cristina in research cannot create one; she still uses
Colin's in the project, because using is a separate request and has no rule. A company that wants research not to use
MCP at all adds `{ members: everyone-but-research, may: use mcp.server }`. A company with stranger needs replaces the
plugin; no other plugin changes.

# On the Worker {#worker lede="The worker follows its effective list; the harness admits extensions by resource and plugin; server views check every call."}

The list is computed on the server; the worker only follows it. Core's server view for workers pushes it:

```ts
export const SessionResources = remote("p3.resources.session", {
	version: 1,
	params: {},                         // the worker's principal names its session; no caller-supplied id
	hostAddress: () => Server(),
	variants: {
		worker: {
			state: {
				list: SessionList,
				builtins: arr(obj({ resource: ObjectAddress, plugin: str() })),   // every declared built-in
			},
		},
	},
});

host.serve(SessionResources, (_params, principal, self) => {
	if (principal.kind !== "worker") throw forbidden("session workers only");
	const resources = self.get(Resources, {});
	return { variant: "worker", members: { list: resources.lists.at(principal.session), builtins: resources.builtins } };
});
```

On the worker, core's harness plugin holds it in a host-lifetime object. A read is local; a change arrives as one state
push. Nobody polls and nobody asks the server per call.

## Extension grants

A plugin's worker facet contributes its Durable extension **with the resource it belongs to**, imported from its own
contract file:

```ts
// plugins/harness/contract.worker.ts: core
export type ExtensionGrant =
	| { readonly kind: "resource"; readonly resource: Resource; readonly extension: Extension }
	| { readonly kind: "any-of-kind"; readonly of: ResourceKind; readonly extension: Extension };
export function grant<C extends RemoteContract>(resource: Resource<C>, extension: Extension): ExtensionGrant;
export function grantForKind<C extends RemoteContract>(of: ResourceKind<C>, extension: Extension): ExtensionGrant;
export const Extensions = defineRegistry<
	readonly ExtensionGrant[] | Watchable<readonly ExtensionGrant[]>, ExtensionTable
>("p3.harness.extensions", { version: 1 });

// plugins/coding-tools/worker.ts
self.contribute(Extensions, [grant(FileTools, fileToolsExtension), grant(Bash, bashExtension)]);
```

The harness builds Durable's registry from the extensions table and the followed list, the way p2's
`durableRegistry(extensions, switches)` does with switches:

```ts
/** The extensions a session may run: only grants whose resource is on its list, from the plugin that serves it. */
function admitted(table: ExtensionTable, list: SessionList): readonly Extension[] {
	if (list.kind !== "ready") return [];                                  // fail closed
	return table.flatMap(({ plugin, grant }) => {
		const ok =
			grant.kind === "resource"
				? list.entries.some((e) => sameAddress(e.resource, pack(grant.resource)) && e.plugin === plugin)
				: list.entries.some((e) => e.resource.contract === grant.of.contract.name && e.plugin === plugin);
		return ok ? [grant.extension] : [];
	});
}
```

Three properties matter:

- **A plugin cannot borrow another plugin's resource.** The entry carries the plugin that serves the resource's kind
  (the index's), and the table carries the plugin that contributed the grant (Chord keeps it per entry). They must be
  equal.
- **An unregistered built-in never runs and is reported.** A grant naming a built-in absent from the pushed `builtins`
  is reported once (`extension_unregistered`, naming plugin and id), so the author sees the mistake.
- **Tools stop guarding themselves.** p2's `origin`, `locked` and per-tool lock checks
  (`src/runtime/tool-access.ts`) go away; `scope` (main conversation, subagents) stays, as decided. Without code mode,
  deferred tools still get `tool_search` as in p2's `durableRegistry`; code mode is itself a built-in resource.

`any-of-kind` exists for extensions whose tools follow configured resources: the conversations tool is present when any
`ConversationAccess` is on the list (chapter VIII), the drives tools when any drive is. One extension may have several
grants (the conversations tool: the `Peers` built-in or any access); the composer installs it **once** when any of its
grants holds, keyed by plugin and extension name, and reports two different extensions under one name (review, Astra
M8).

## Admission at every call, not only every phase

Filtering the next phase's registry is not enough (review, Astra M5): a code-mode script captured its tools when it
started, a phase pins its registry, and a worker that lost its server link still holds its last list (Chord keeps a
reference's last values, §7). So the harness also wraps the dispatch of every admitted extension's tools, nested
code-mode calls included, with one check:

```ts
/** Refuses a tool call unless the grant behind it holds now: link live, list ready, entry present, not expired. */
function admitCall(grants: readonly ExtensionGrant[], plugin: string, resources: Held<typeof SessionResources>): Decision {
	if (resources.state.value.kind !== "live") return deny(messages.message("resourcesOffline"));
	const list = resources.list.value;
	if (list.kind !== "ready") return deny(list.reason);
	const now = Date.now();
	return grants.some((g) => holds(g, plugin, list.entries, now)) ? ALLOW : deny(messages.message("notOnList"));
}
```

It is one mechanism in the harness, not a check per tool, and it is about resources, not about who started the run.
Calls admitted earlier may finish.

## Doors that are not tools

Some p2 behaviour reaches resources without a Durable tool (review, both): the composer's `!cmd` runs a shell through
`Chat.shell`; cache warming keeps timers that call a provider directly; prompt templates expand through a method; voice
rooms, terminal sockets and workspace transfers are channels. Each owner checks the same list at its own door with
`admit`: the session shell requires the `Bash` built-in and the location's env; a warmer re-admits its provider and
its built-in before every refresh and stops when either leaves; expansion loads only admitted prompt resources;
channels re-check on use, not only when a panel mounted.

## Server views check every call

Resource plugins serve per-session server views that read the same effective list, so a call through a resource that
left the list a moment ago is refused even if the worker has not updated yet:

```ts
// plugins/resources/contract.ts: the helper every kind's server view uses
/** The resources of `kind` on a worker's session list, typed; empty while the list is unavailable. */
export function resourcesOf<C extends RemoteContract>(self: RemoteSelf, principal: WorkerPrincipal, kind: ResourceKind<C>):
	Watchable<readonly OnList<C>[]>;        // OnList<C> = { resource: Resource<C>; until: number | null }

/** Throws forbidden unless `resource` is on the list now and not expired (checked against the current time). */
export function admit<C extends RemoteContract>(on: Watchable<readonly OnList<C>[]>, resource: ObjectAddress): Resource<C>;
```

`admit` also refuses while the list is unavailable and for a worker that is not the session's current one (p2's
generation fencing in `plugins/mcp/server.ts` and `plugins/conversations/server.ts` stays).


:::sequence animate | Colin withdraws his MCP server from project pi while session S1 is mid-script.
actor colin "Colin's page" "MyResources" blue
actor core "core resources" "server" accent
actor projects "projects plugin" "server: the list"
actor mcp "SessionMcp" "server, S1's view"
actor worker "S1's worker" "harness"
colin -> core: withdraw { resource: mcp.server colin/linear }
core -> projects: registration.remove(pi, linear)
projects => projects: commit pi's list
projects --> core: lists.at(pi) changed
core => core: recompute S1: linear gone
core --> worker: SessionResources.list without linear
core --> mcp: resourcesOf: linear gone, tools state shrinks
worker -> worker: next phase: no linear extension
worker -> mcp: (a call already sent) call linear.search
mcp --> worker: refused: linear is not on this session's list
:::

A call admitted before the commit may finish; nothing is replayed (p2 already marks MCP calls not replay-safe). Output
already in the transcript stays.

# Kinds in Code {#kinds lede="Six resource kinds end to end: built-in tools, conversation access, model providers, MCP servers, machines and drives."}

Every kind follows the same three parts: a contract file with its kind or built-in token, a server facet that
registers it and serves a per-session view reading `resourcesOf`, and a worker facet that grants its extension under
the same token. What differs is what the worker gets: an extension that runs locally, pushed credentials, or methods
the server runs.

## Built-in tools

Shown in chapter III and VII: `coding-tools` declares `FileTools` and `Bash` with `builtin`, describes them in its
server facet, grants them in its worker facet. Bash and the file tools run at a conversation's location, so they work
only when a machine is on the list too (below). Every p2 plugin that contributes an extension today (agent, artifacts,
cache-warming, codemode, conversations, dev-tools, discord, history, locations, mcp, ports, powershell, prompt,
send-file, sessions, subagents, terminals, voice) becomes one or more built-ins this way. Not everything is: the
review's mapping (appendix C) keeps catalog updates, indexing, status, drafts, tree, file mirrors and input delivery as
session infrastructure that runs whatever the list holds; only agent-facing operations need grants. The prompt plugin
splits (review, both): its setup-free framing is a built-in, while a user's global instructions, skills and templates
are a resource kind the prompt plugin serves (`Instructions { owner, id }`), so a project gets Colin's instructions only
if Colin brings them; project files follow the location. Voice keeps its style section as a built-in and makes the
speech service a resource.

`Builtins` also takes instance resources of a plugin's own kind, for things a plugin brings with it:

```ts
// plugins/envs/contract.ts
export const LocalMachine = resource(EnvKind, { owner: INSTANCE, id: "local" });

// plugins/envs/server.ts: the machine p3 runs on is an instance resource, created at install
self.contribute(Builtins, [describe(LocalMachine, { label: t.message("thisMachine") })]);
```

`describe` accepts only a resource whose `ownerOf` is `INSTANCE`; anything else is left out and reported.

## Conversation access: a configured resource

The owner's case: a Discord session may read the answers of session X, only X, for an hour. The conversations tool
has actions (`list`, `send`, `answer` in p2's `plugins/conversations/worker.ts`); the resource is the permission, not
the tool.

```ts
// plugins/conversations/contract.ts
/** The tool reaching the sessions that share this session's resource source (see sameSource below). */
export const Peers = builtin("conversations.peers");

/** Access to one session with chosen actions: a resource its creator owns. */
export const ConversationAccess = remote("conversations.access", {
	version: 1,
	params: { owner: str(), id: str() },
	hostAddress: () => Server(),
	variants: { user: { state: { info: AccessInfo } } },     // target title, actions
});
export const AccessKind = resourceKind(ConversationAccess, (p) => userId(p.owner));
export const AccessConfig = obj({ target: str(), actions: arr(oneOf("answer", "send")) });
export const CreateAccess = operation(ConversationAccesses, "create");

// plugins/conversations/worker.ts: one tool, present for either resource
self.contribute(Extensions, [grant(Peers, conversationsTool), grantForKind(AccessKind, conversationsTool)]);
```

The server view for the worker computes the targets from the list and checks each call:

```ts
host.serve(SessionConversations, (_params, principal, self) => {
	if (principal.kind !== "worker") throw forbidden("session workers only");
	const peers = resourcesOf(self, principal, BuiltinKind);           // filtered to Peers below
	const grants = resourcesOf(self, principal, AccessKind);
	const accesses = self.get(AccessStore, {});
	const targets = self.derive([peers, grants, accesses.configs, catalog.rows], targetsOf);   // display only
	/** The grant behind one call: Peers for a same-source target, else an access entry naming target and action, admitted now. */
	const authorize = (to: string, action: Action) => {
		if (peersOn(peers.value) && sameSource(catalog.row(principal.session), catalog.row(to))) return;
		const entry = grants.value.find((on) => accesses.config(on.resource).target === to
			&& accesses.config(on.resource).actions.includes(action));
		if (entry === undefined) throw forbidden(messages.message("noAccess", to, action));
		admit(grants, pack(entry.resource));                                       // its own `until`, against now
		requireTargetPermission(entry.resource, to, action);                        // the access owner may still do it
	};
	return {
		variant: "worker",
		members: {
			targets,
			send: async ({ to, message, requestId }, ctx) => {
				authorize(to, "send");
				return broker.send({ from: principal.session, to, message, requestId }, ctx);
			},
			answer: async ({ to }, ctx) => {
				authorize(to, "answer");
				return broker.answer({ to }, ctx);
			},
		},
	};
});

/** Peers: defaults sessions of the same owner, sessions of the same grouping; an own list peers with nobody. */
function sameSource(a: SessionRow, b: SessionRow): boolean {
	if (a.id === b.id) return false;
	switch (a.source.kind) {
		case "defaults": return b.source.kind === "defaults" && a.owner === b.owner;
		case "grouping": return b.source.kind === "grouping" && sameAddress(a.source.grouping, b.source.grouping);
		case "own": return false;
	}
}
```

Each call finds the grant that authorizes exactly that target and action, and checks that entry's own deadline and
that its owner may still send in the target (review, both): an hour of `answer` and five minutes of `send` to the same
session expire separately, and Bob un-sharing X with Alice ends Alice's access resource's effect. p2's broker checks
(archived sessions, current worker, request-id dedup, startup retry) stay.

Creating it starts where the owner wants, on the Discord session ("add a resource to you"): the picker opens the
conversations creator, which asks for the target, the actions and how long. The conversations plugin's `create` asks
`guard(access, CreateAccess, ...)` with the baseline *the actor may send in the target* (the sessions plugin's fact),
then core's `create` (owner: the actor); the picker then brings it into the session's source list with `until`. Two
checks, as the owner said: may grant access to that target, may change that list.

## Model providers: pushed credentials

The worker streams from the provider itself (the data plane stays in the worker), with auth the server refreshes:

```ts
// plugins/models/contract.ts
export const ModelProvider = remote("models.provider", {
	version: 1,
	params: { owner: str(), id: str() },
	hostAddress: () => Server(),
	variants: { user: { state: { info: ProviderInfo }, methods: { configure: method(ProviderConfig), signIn: method() } } },
});
export const ProviderKind = resourceKind(ModelProvider, (p) => userId(p.owner));

export const SessionModels = remote("models.session", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		worker: { state: { providers: arr(PushedProvider) } },   // { resource, label, api, models, auth, expires, until }
	},
});

// plugins/models/server.ts
host.serve(SessionModels, (_params, principal, self) => {
	if (principal.kind !== "worker") throw forbidden("session workers only");
	const mine = resourcesOf(self, principal, ProviderKind);
	const store = self.get(ModelStore, {});      // pi-ai CredentialStore; one serialized refresh per credential
	const pushed = self.state(Pushed);
	self.onLive(async (ctx) => {
		for (;;) {
			// Capture what this push is based on before awaiting, so a change during the refresh is never missed.
			const seen = { list: mine.value, revision: store.revision.value };     // credential + configuration revision
			const list = await Promise.all(seen.list.map((on) => store.pushFor(on, ctx)));   // auth refreshed if near expiry
			if (seen.list === mine.value && seen.revision === store.revision.value)
				await pushed.change((draft) => { draft.providers = list; }, ctx);   // a stale refresh never republishes
			await untilChanged(seen, [mine, store.revision], earliestExpiry(list) - REFRESH_MARGIN, ctx);
		}
	});
	return { variant: "worker", members: { providers: self.derive([pushed], ([p]) => p.providers) } };
});

// plugins/models/worker.ts: the harness's ModelProviders registry gets pi-ai providers whose auth reads the latest push
self.on(models.providers, ({ value }) => contributed.set(value.map((p) => createProvider({
	id: addressKey(p.resource), name: p.label, models: p.models, api: streamsFor(p.api),
	auth: { apiKey: { name: p.label, resolve: async () => currentAuth(models, list, p.resource) } },
}))));
```

`currentAuth` refuses (no auth, the request fails visibly) when the list is unavailable, the provider left it, its
entry expired or the pushed auth expired. A reference keeps its last values when its link fails (Chord §7), so a
cached token alone is never permission. Refresh tokens never reach the worker. Charlotta's provider uses Charlotta's
credential whoever sends: there is no login choice. A logout, a rotated key or an edited provider changes the store's
revision and is pushed at once, also for keys that never expire (review, both). Provider options, headers and model
metadata travel with the push, as p2's worker uses them today. Bedrock and Vertex with ambient AWS or ADC credentials
get a server-side stream under the same kind and list admission, or are marked unsupported; they are never pushed as
empty auth.

## MCP servers: methods the server runs

Decided earlier (decision 8): a checkout's `.pi/mcp.json` is a suggestion, enabled per checkout and run in that env;
server-configured stdio servers run on the server machine; HTTP servers have no location; there is no `runOn`. In this
model each is one resource with its transport in its configuration:

```ts
// plugins/mcp/contract.ts
export const Transport = union([
	obj({ kind: lit("http"), url: str(), headers: opt(map(str())) }),                       // no location
	obj({ kind: lit("server-stdio"), command: str(), args: arr(str()), env: opt(map(str())) }),  // the p3 server machine
	obj({ kind: lit("checkout"), env: ObjectAddress, dir: str(), entry: str(), digest: str() }),  // an enabled suggestion
]);
export const McpConfig = obj({ name: str(), transport: Transport });
export const CreateMcp = operation(McpServers, "create");
```

- **Creating** asks core's `create-resource` like every kind; a `server-stdio` transport runs code on the server
  machine, so the MCP plugin also calls `guard(access, actor, CreateMcp, {}, config, baseline)` with the baseline *the
  actor administers* for that transport, and `ConfigureMcp` the same on every change. A company policy can widen or
  narrow it, matching on the typed `config.transport`.
- **Suggestions:** the worker reads `.pi/mcp.json` at its conversations' locations and reports them to its
  `SessionMcp` view; the session shows "this checkout suggests ...". Enabling one creates an MCP resource owned by the
  enabling user, bound to that env, directory and the entry's digest, and brings it into the session's source list.
  Its tools are offered only to conversations working at that env and directory; a changed entry (another digest)
  needs enabling again; another user visiting the checkout gets nothing until they enable it or a project lists it.
- **The worker** gets one extension per MCP resource on the list (one extension, one resource), tool names prefixed by
  a stable short id of the resource, so two `github` servers never collide; every tool calls the server:

```ts
// plugins/mcp/worker.ts
host.serve(McpInSession, (_params, self) => {
	const session = self.get(SessionMcp, {});
	const grants = self.writable<readonly ExtensionGrant[]>([]);
	self.contribute(Extensions, grants);
	self.on(session.servers, ({ value }) => grants.set(value.map((server) =>
		grant(server.resource, mcpExtension(server, (tool, args, api, context) =>
			chord((ctx) => session.call({ server: pack(server.resource), conversation: api.conversationId, tool, args }, ctx), context))))));
	return {};
});

// plugins/mcp/server.ts: the worker variant of SessionMcp
call: async ({ server, conversation, tool, args }, ctx) => {
	const on = admit(mine, server);                                  // on the list now, not expired
	const at = locations.of(principal.session, conversation);        // the server's record, never a cwd from the message
	requirePlacement(on, at);                                        // a checkout server: this env, directory and digest
	return supervisor.call({ resource: on, session: principal.session, at, tool, args }, ctx);
},
```

The call names its conversation (review, both): a subagent working on another machine must not reach a checkout server
enabled for the main conversation's directory, and the server resolves the location from its own record. The
supervisor keys processes by resource, placement and, by default, session, as p2 does (stdio and HTTP not shared unless
configured): the configuration's typed `lifetime: "session" | "shared"` keeps that choice, which has nothing to do with
logins (review, both). Credentials and OAuth refresh stay in the server's MCP store, as in p2 today.

## Machines

An `Env { owner, id }` is a resource; the machine p3 runs on is the instance resource `LocalMachine`, whose use
baseline is *the session's owner administers*. A conversation's location is `null` or `{ env: ObjectAddress, cwd }`;
null is a session with no machine (the Discord session that only reads answers), whose harness gets no execution
environment (Durable allows `undefined`), never the server machine as a fallback; coding tools refuse there, and
attachments stay in session storage until a location exists (review, Sol 3). A non-null location must name an env on
the list; the worker's env adapter contributes the
connection to the harness's environments registry. Moving a session to an env not on its list is refused; an env that
leaves the list leaves the location unavailable (tools refuse, the session shows "relocate"), never a silent fallback
to the server machine. Terminals, the workspace view and file browsing check the same env through their own server
views.

## Drives

A drive is a file space people use directly and agents use when it is on the list:

```ts
// plugins/drives/contract.ts
export const Drive = remote("drives.drive", {
	version: 1,
	params: { owner: str(), id: str() },
	hostAddress: () => Server(),
	variants: {
		// one user variant: methods check the current facts, `actions` says what this user may do now
		user: { state: { folder: FolderView, actions: DriveActions }, methods: { upload: method(UploadArgs), remove: method(PathArgs), shareLink: method(PathArgs, str()) } },
	},
});
export const DriveKind = resourceKind(Drive, (p) => userId(p.owner));

// plugins/drives/worker.ts: one set of tools, `drive` names a drive on the list
self.contribute(Extensions, [grantForKind(DriveKind, driveTools)]);
```

The bytes are the kit's `Files` (one space per drive). People: the owner may manage it; a user who sees a list
containing the drive (a project's members) may read it, the one-hop read Sol's design describes, checked live against
the list and its expiry; every tool call admits the exact drive it names. An admin manages the company drive through
the same view with `owner: INSTANCE`. A drive backed by a
real Google Drive is the same kind with a Google login in its configuration: a second login, a second drive.

# Sign-in and Directories {#directories lede="SAML and Radius touch three places: sign-in plugins create users, sync plugins mirror groups as groupings, the policy names those groupings."}

Nothing about SAML or Radius appears in projects, MCP, models or the harness. They touch three places, each already
in the model.

**1. Sign-in creates users.** A SAML plugin verifies the assertion and calls `Users.signIn({ issuer, subject, name })`;
the result is the principal `{ kind: "user", id }` the kit's session carries. A Radius plugin does the same with a
Radius account. Emails are never identities.

```ts
// plugins/saml/server.ts
self.contribute(Http, { routes: { "POST /saml/acs": async (request, ctx) => {
	const assertion = await verify(await request.body(), idp.value, ctx);       // signature, audience, time
	const id = await users.signIn({ issuer: assertion.issuer, subject: assertion.subject, name: assertion.name }, ctx);
	await directory.mirror({ user: id, groups: assertion.groups }, ctx);
	return signInResponse(sessions, { kind: "user", id: userId(id) }, request);
} } });
```

**2. Sync mirrors groups as groupings.** The SAML plugin's `SamlGroup { name }` is a grouping kind registering only
`members`; its directory updates them at every sign-in (and from SCIM, if the company has it). A Radius sync plugin
mirrors Radius org groups the same way through the Radius API. These groupings show their members in a sidebar
section like any other grouping and can be members of projects.

**3. The policy names them.** The rules plugin's settings sheet offers every grouping as "members of ..." and every
creator as a kind. "Only engineering may create MCP servers" is `{ members: SamlGroup{engineering}, may: { kind:
"create-resource", resourceKind: "mcp.server" } }`.

**Radius resources are ordinary resources.** Signing in with Radius can create the user's Radius MCP server and Radius
model provider: the Radius plugin calls the MCP and models plugins' trusted local creates (`createFor({ actor, owner,
id, config })`) with the user its verified sign-in produced and stable ids, so "users create resources only for
themselves" holds and nobody is impersonated on a remote call. Whether one Radius sign-in can serve the relay connection, the
model gateway and the MCP server is the open question to Armin and Vegard; in p2 these are three logins. The relay
(the brain's outbound connection) is an instance integration an admin sets up, not a session resource.

# Drawing It {#presentation lede="Creators, renderers per form, panels from several plugins, grouping views and layouts: the page never decides, it draws what views say."}

## Creators and the add-resource picker

```ts
// plugins/resources/contract.web.ts
/** A resource kind's creator: shown in every add-resource picker and on the policy settings screen. */
export function creator<C extends RemoteContract>(kind: ResourceKind<C>, entry: {
	readonly label: MessageData;
	readonly description: MessageData;
	readonly icon: Icon;
	/** `owner`: the user, or INSTANCE when an admin creates a company resource; `into`: where the picker will bring it. */
	readonly Sheet: ComponentType<{ owner: UserId; into: ListRef | null; done(created: Resource<C>): void; cancel(): void }>;
}): CreatorEntry;
export const Creators = defineRegistry<readonly CreatorEntry[], readonly CreatorEntry[]>("p3.creators", { version: 1 });

// plugins/mcp/web.tsx
self.contribute(Creators, [creator(McpKind, { label: t.message("mcpServer"), description: t.message("mcpAbout"), icon: PlugIcon, Sheet: NewMcpSheet })]);
```

```tsx
// plugins/resources/web.tsx: the picker any list's "Add resource" opens
function AddResource({ into }: { into: ListRef }) {
	const mine = useHold(MyResources, {});
	const [owner, setOwner] = useState<UserId>(me);                         // INSTANCE offered to admins only
	const kinds = (useWatch(mine.creatable) ?? []).find((c) => c.owner === owner)?.kinds ?? [];
	const creators = useRegistry(Creators).filter((c) => kinds.includes(c.kind.contract.name));
	const [until, setUntil] = useState<number | null>(null);               // the picker owns the duration
	const [open, setOpen] = useState<CreatorEntry | undefined>();
	return open ? (
		<open.Sheet owner={owner} into={into} cancel={() => setOpen(undefined)} done={(created) => bringNew(mine, created, into, until)} />
	) : (
		<Picker candidates={mine.candidates({ into })} creators={creators} until={until} onUntil={setUntil} onPick={setOpen} />
	);
}
```

The picker knows no groups and no rules; it reads one list from the server. The policy settings screen reads the same
`Creators` registry for its kinds, with their labels and icons.

## Renderers per form

A thing looks different by where it is drawn: an env is one row in the sidebar and a full view when selected. Anyone
may draw anything they can read:

```ts
// plugins/presentation/contract.web.ts
/** A place things are drawn, with the props its renderers get. */
export function form<Props>(name: string): Form<Props>;
export const Row = form<{ density: "compact" | "comfortable" }>("p3.row");
export const Card = form<Record<never, never>>("p3.card");
export const Detail = form<Record<never, never>>("p3.detail");

export function renderer<C extends RemoteContract, P>(contract: C, form: Form<P>,
	Component: ComponentType<{ params: ParamsOf<C> } & P>): RendererEntry;
export const Renderers = defineRegistry<readonly RendererEntry[], RendererIndex>("p3.renderers", { version: 1 });

// any view: <Present address={entry.resource} form={Row} props={{ density: "compact" }} />
```

`Present` finds a renderer for (contract, form), else (contract, `Row`), else a generic row from the index's label.
The projects plugin draws Colin's MCP server with the MCP plugin's row without knowing MCP; if it wants MCP servers
to look special in its sidebar, it contributes its own renderer for `(McpServer, ProjectRow)` from the same public
contract.

## Panels: one detail from several plugins

```ts
export function panel<C extends RemoteContract>(contract: C, entry: {
	readonly title: MessageData; readonly order: number; readonly Component: ComponentType<{ params: ParamsOf<C> }>;
}): PanelEntry;

// plugins/terminals/web.tsx, plugins/files/web.tsx, plugins/envs/web.tsx: none imports the others
self.contribute(Panels, [panel(Env, { title: t.message("terminals"), order: 20, Component: EnvTerminals })]);
self.contribute(Panels, [panel(Env, { title: t.message("files"), order: 10, Component: EnvFiles })]);
self.contribute(Panels, [panel(Env, { title: t.message("settings"), order: 90, Component: EnvSettings })]);
```

The layout's detail area mounts every panel for the selected address, as tabs, a split or a grid, the layout's
choice. Each panel checks its own operations on the server; a panel being registered grants nothing.

## Grouping views and layouts

Groupings appear through a page registry of navigation sections (`Navigation`), each a component that holds its own
plugin's views and draws its items with `Present`. The page's route is an `ObjectAddress`; the main area draws it with
`Present` in the `Detail` form. The layout (sidebar, main, panel) is a plugin; the default one ships "so as not to
rattle cages" (decision 2026-11-07).

# Six Scenarios {#scenarios lede="The cases the reviewers must check, traced through the pieces above."}

**Mario on a laptop.** First start: Mario (admin) and `INSTANCE` exist; plugins' built-ins and `LocalMachine` are
instance resources. Mario signs in to Anthropic: a `ModelProvider` he owns. New sessions get `source: defaults`, so
their effective list is everything he owns plus every instance resource; the default policy allows all. He installs a
third-party plugin with a `weather` tool: its server facet describes `builtin("weather.tool")`, core adds an index row,
every defaults session's list gains it, the worker's harness admits the grant at its next phase. He never saw a list.

**Colin, Cristina, Charlotta.** Colin creates project pi (`create-grouping`), adds Cristina and Charlotta
(`add-member`). Each brings their own resource (`bring`: owner side, project's `mayBring`). Cristina creates S1 in pi:
`source: { grouping: Project{pi} }`. S1's list is the three plus the built-ins the project brought (decision 1 in the
epilogue; without them S1 has MCP and a model but no bash); Charlotta's message uses Colin's Linear login, Cristina's
GPU account and Charlotta's key. Colin withdraws Linear mid-script: chapter VII's sequence; the raised revision keeps it
out even if the projects plugin is reloading.

**Discord, locked down for an hour.** The Discord channel is S2's source with a list holding a model provider. Mario
opens S2, "Add resource", picks "Access to a session", chooses X, `answer` only, one hour. The conversations plugin
checks Mario may send in X, core creates the resource (owner Mario), the picker brings it into the channel's list with
`until`. S2's location is `null`: no machine, no bash, no server-machine fallback. Its worker gets the conversations
tool with one target and one action. At the deadline the entry leaves the effective list; a call a second later is
refused by `authorize`, which admits that entry against the current time, whatever the worker still shows.

**SAML: only engineering creates MCP servers.** The rule exists; Colin (engineering) sees the MCP creator, Cristina
(research) does not: her `creatable` lacks `mcp.server`. Colin brings his server into pi; Cristina's sessions in pi use
it. An admin adds research to the rule: the sequence in chapter VI, and her picker shows the creator without a reload.

**A new tool in normal sessions.** As in Mario's case: built-in, instance-owned, included by the defaults rule. A
Discord session does not get it: its source is the channel's list.

**Drives.** The company drive is an instance `Drive`; Mario's own drive is his. Both in pi's list: the agent's drive
tools see two drives; members open both read-only from the project's resources; Mario manages his own.

# Open Questions {.epilogue lede="What is left after the review: four decisions for the owner, and what stays on other tracks."}

The review (Astra and Sol, 2026-11-08, appendix C) confirmed the model for all 39 p2 plugins and the six scenarios,
and found boundary gaps, now fixed in the chapters above. Four points need the owner:

1. **Built-ins in project lists** (chapter IV): may anyone who may use a built-in bring it into a list, and does a new
   grouping's list start with them? Without it, project sessions have no tools unless an admin brings them.
2. **Projects showing sessions they do not equip** (chapter V): plain display references, granting nothing.
3. **Exclusions from defaults** (chapter IV): a per-user set, so code mode or cache warming can be off everywhere
   while new tools still appear. Both reviewers recommend it.
4. **MCP process lifetime** (chapter VIII): keep p2's per-session processes by default, with a typed `lifetime`
   configuration, or share every process per resource and placement.

Accepted changes from p2, stated so nobody finds them during the build: one source per session (a Discord link
replaces a project source; a project no longer equips a session linked elsewhere); peers narrow from every session to
the same source; MCP stdio servers configured to run at the location become checkout resources (decision 8, no
`runOn`); guest sharing stays reserved.

On other tracks: execution on the server machine and SSH keys in workers (the stress test's gap 1; this model makes
`LocalMachine`, server stdio and reload admin-only by baseline, which is not OS isolation); ambient cloud credentials
(server-side stream or unsupported); one Radius sign-in for relay, gateway and MCP (pending Armin and Vegard).

# API Surface {.appendix}

| Piece | Where | What |
| --- | --- | --- |
| `UserId`, `INSTANCE`, `Users`, `P3Principal` | users plugin | people, the instance user, `signIn` |
| `resourceKind`, `ResourceKind`, `resource`, `Resource`, `ObjectAddress`, `pack`, `addressOf`, `match`, `isKind`, `isGroupingKind`, `isOperation` | resources plugin | typed resources, erased addresses, declaration identity |
| `ResourceKinds` (server registry), `register(kind, { use })` | resources plugin | which plugin serves which kind, its use baseline |
| `Builtin`, `BuiltinKind`, `builtin`, `describe`, `Builtins` (server registry) | resources plugin | instance resources a plugin brings |
| `Resources` (server, local) | resources plugin | `lists` (effective, keyed by session), `create`, `complete`, `forget` |
| `MyResources` (server, remote, user) | resources plugin | `owned`, `excluded`, `creatable`; `candidates`, `bring`, `remove`, `withdraw`, `exclude`, `setSource`, `lockDown` |
| `ResourceSource`, `ListEntry`, `ListRef`, `SessionList` | resources plugin | the one field, entries, list names, what workers follow |
| `groupingKind`, `registerGrouping`, `GroupingKinds` (server registry), `MemberRef`, `Members` | resources plugin | groupings with members and lists |
| `SessionResources` (server, remote, worker) | resources plugin | a worker's list and the declared built-ins |
| `resourcesOf`, `admit` | resources plugin | per-session server views: typed list, admission |
| `Request`, `Decision`, `Policy`, `Policies` (server registry), `Access`, `guard`, `operation` | policy plugin | one policy, typed requests, plugin operations |
| `ExtensionGrant`, `grant`, `grantForKind`, `Extensions` (worker registry), `admitCall` | harness plugin | extensions under resources, admission per call |
| `creator`, `Creators` (web registry) | resources plugin | creators and pickers |
| `form`, `Row`, `Card`, `Detail`, `renderer`, `Renderers`, `Present`, `panel`, `Panels`, `Navigation` (web registries) | presentation plugin | drawing anything |

Every piece above lives in a reloadable p3 plugin's contract file (decision "Reloads first"), not in Chord, the kit
or the base.

# The Review Brief {.appendix}

For Astra and Sol. Check, feature by feature, how **every p2 plugin** in `apps/p2/plugins/` composes with this model:
agent, artifacts, cache-warming, chat, chat-mode, codemode, coding-tools, conversations, devices, dev-tools, discord,
drafts, envs, file-index, files, history, locations, login, logs, mcp, models, ports, powershell, projects, prompt,
proxy-marker, quiet-tools, radius, search, send-file, sessions, sharing, status, subagents, terminals, tree, voice,
web-shell, workspace. For each: is it a resource kind, a built-in, a grouping, a presentation, or none; what its server
and worker facets contribute under this spec's APIs; which p2 behaviour it loses or changes; and any gap, each with a
**typed** fix in this spec's vocabulary (no new nouns unless unavoidable, no string switches).

Then trace the scenarios of chapter XI against the code above, and the open questions. Rate each finding
must-fix, should-fix or note. Read the p2 sources you cite; cite `file:line`. Do not repeat the stress test's findings
the owner already decided (no per-run authority; no login modes) unless this spec contradicts its own text.

# What the Review Changed {.appendix}

Astra (`/tmp/resource-model-review-astra.md`) and Sol (`/tmp/resource-model-review-sol.md`) reviewed the first edition
against every p2 plugin. Both accepted the decided points (one source, no per-run authority, no login modes). Their
must-fix findings and where they are fixed:

| Finding | Who | Fixed in |
| --- | --- | --- |
| A local call acts as the server: `guard` and provisioning lost the actor | both | III (who the actor is), VI (`guard` with actor), IX |
| Tokens compared with `===` break across separately bundled facets and reloads | Sol | I (`isKind`, `isOperation`) |
| Admins could not create company resources; `creatable` only for `owner: me` | Sol | III (`create({ id, owner })`), VI, X (Sheet `owner`) |
| Lock-down and copies could keep someone else's resource | both | IV (`lockDown` snapshot, copies as brings) |
| "May use an instance resource" widened into "may bring it anywhere" | both | IV (admin baseline; built-ins: decision 1) |
| Withdrawal depended on loaded keepers; reloads resurrected entries; defaults re-included | both | IV (revision in index and entries; `exclude`) |
| Phase filtering missed captured tools, nested calls and an offline worker | Astra | VII (admission at every call) |
| Shell commands, warmers, prompt expansion and channels bypass extension grants | both | VII (doors that are not tools) |
| `LocalMachine` was claimed admin-only but used with an unconditional allow | both | III (`register(kind, { use })`), VIII |
| A model-only session has no location, yet every tool resolved one | Sol | VIII (location `null`, no fallback) |
| Conversation access lost per-action expiry and target revocation; peers compared bare tags | both | VIII (`authorize`, `sameSource`) |
| The same extension granted twice installed twice | Astra | VII (installed once per plugin and name) |
| MCP calls lacked the calling conversation's location | both | VIII (`conversation` on `call`) |
| Model pushes missed credential changes and could republish stale auth | both | VIII (revision-captured loop) |
| Seeing a session is not every operation on it | Astra | V (`mayView`, `maySend`, typed operations, routes) |
| One prompt built-in cannot carry a user's private instructions | both | VIII (`Instructions` kind; voice service a resource) |

Should-fix findings folded in: guarded configuration changes (VI), stable creation ids and incomplete rows (III), live
roles instead of factory-time variants (V), Discord link and unlink as source transitions (V), mirrored group identity
and freshness (V), the default policy as an explicit plugin (VI), per-session MCP processes (VIII, decision 4),
destination-aware pickers with the duration (IV, X). Left to the owner: decisions 1 to 4 in the epilogue.
