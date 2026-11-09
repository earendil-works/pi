---
title: p3: users, accounts and access
cover: Users / Accounts / Access
kicker: A design explainer · p3 · 2026-11-07
subtitle: How third-party plugins let a p3 user sign in with another service, connect their accounts there, and use them for models, MCP servers and tools, while every secret stays on the server
stats:
  - 3 | concepts: identity, accounts, access
  - 1 | built-in owner of external accounts (the server's `Accounts`)
  - 0 | integrations p3 ships itself: Radius, Gmail, Notion, Slack, Discord are plugins
  - 0 | long-lived secrets on workers, pages or terminals
note: |
  A design proposal for the owner, written 2026-11-07 after his direction: "we won't provide those integrations
  ourselves, but p3 must allow 3rd parties to integrate them and associate external accounts with the p3 account AND let
  a plugin that provides that integration use that account info to do stuff like mcp sign in, or providers, or
  whatever." Nothing here is decided or built; every name is a proposal. Chord names (remote, local, registries,
  references, the kit's `Sessions` and `Http`) are real. pi-ai's provider auth follows its `ApiKeyAuth`
  (`packages/ai/src/auth/types.ts`). The decisions needed are listed at the end.
colophon: p3 users, accounts and access · design proposal, first edition · 2026-11-07 · sources: Chord design §4, §6, §7, §17, §23; the app kit; pi-ai auth types; the Radius API's members, groups and context operations
---

# Before we begin {.preface}

Mario installs a plugin a third party wrote, `@acme/p3-radius`, into `~/.p3/plugins/` and applies it. p3's sign-in page
now has a button **Sign in with Radius**. He taps it, signs in at Radius, and lands in p3 as his p3 user `u1`; his
Radius account `mario@earendil.com` shows under Settings, Accounts. He opens a session and picks the model
`radius/claude-sonnet`: the session's worker calls Radius's model gateway with a token for his account. He adds
Radius's MCP server to the session: it connects as him. Later Ada, another p3 user, signs in with her own Radius
account; her sessions use hers. When Mario shares a session with Ada, his Radius account does not come along unless he
brings it in.

p3 ships none of this. It ships the places it plugs into: a users store, one owner of external accounts on the server,
a registry through which an integration says how to turn a stored account into credentials, a way to hand those
credentials to a session's worker for a few minutes at a time, a slot on the sign-in page, and a pluggable access
policy. The `@acme/p3-radius` plugin fills them; a Gmail, Notion, Slack or Discord plugin would fill them the same way.

## Nine things to know

:::findings
1. **Three concepts.** **Identity**: who someone is in p3 (a p3 user id). **Accounts**: their connections to other
   services (a Radius, Gmail or Slack account), linked to the p3 user. **Access**: what a p3 user may do in p3 (a
   policy). Each is a different owner; none knows the others' internals.
2. **The principal stays tiny.** `{ kind: "user", id: "u1" }` on every call. External ids, tokens and roles never go
   into it.
3. **"Sign in with X" is a plugin.** It runs X's OAuth flow through routes it contributes to `Http`, finds or creates
   the p3 user that X's account is linked to, and issues an ordinary kit session for that user.
4. **One owner keeps every external account: `Accounts`, on the server.** A table of `{ user, provider, account, label,
   data }`; `data` is the integration's own JSON (tokens, scopes), stored in the server's store, never sent to a client.
5. **Integrations say how to use an account: the `AccountProviders` registry.** One contribution per integration:
   `credentials(account)` turns a stored account into usable credentials (refreshing tokens when needed) and gives the
   updated `data` back to store.
6. **Clients see accounts without secrets.** Pages and terminals hold `MyAccounts`, a per-user view of the user's own
   accounts: provider, label, status. Never `data`.
7. **Workers get short-lived credentials, followed, not fetched.** A session's worker holds `AccountCredentials` for an
   account the session may use; its state is the current access token and its expiry. The server refreshes it before it
   expires and the new token arrives as a state change; every use on the worker is a local read.
8. **A session uses an account only when its owner brought it in.** Bringing an account into a session is a grant the
   account's user makes; the server checks it when the session's worker asks for credentials. Nothing personal comes
   into a shared session by itself.
9. **Models and MCP use the same path.** A model-provider plugin contributes a pi-ai provider whose auth reads the
   followed token; the MCP plugin connects to a server with an `auth: { account }` setting the same way.
:::

## Words used throughout

A **p3 user** is a row of p3's users store, with an id like `u1`; its principal is `{ kind: "user", id }`. An
**identity** links an external sign-in (a provider and its subject id) to a p3 user. An **account** is a connection of a
p3 user to another service: a provider name (`radius`), the account's id there, a label to show, and the integration's
**data** (tokens and whatever else it needs). An **integration** is a third-party plugin for one service: it contributes
routes, an account provider, UI, and whatever it does with the account (a model provider, tools). **Credentials** are
what an account yields for one use: an access token with an expiry, or a key. A **grant** lets one session use one
account. A **policy** answers "may this user do this to that".

# Three Concepts {#concepts lede="Who someone is, what they are connected to, and what they may do: three owners."}

:::flow wide | The three owners on the server, and who reads them where. Accent: p3's built-in parts; muted: a third-party integration.
row "Server" accent
box users "Users" "p3 users, identities" accent
box accounts "Accounts" "accounts with data (tokens)" accent
box policy "Access policy" "the acl plugin, replaceable" accent
row "Integration plugins (third party)" muted
box radius "@acme/p3-radius" "sign-in, provider, models" muted
box gmail "@acme/p3-gmail" "provider, tools" muted
box mcp "mcp plugin" "servers with auth: { account }" muted
row "Readers" blue
box page "page / terminal" "MyAccounts: labels only" blue
box worker "session worker" "AccountCredentials: a token" blue
arrow radius -> users "link identity"
arrow radius -> accounts "link account, refresh"
arrow gmail -> accounts "link account, refresh"
arrow page -> accounts "MyAccounts (view)"
arrow worker -> accounts "AccountCredentials (view)"
arrow mcp -> worker "uses the token"
note "Every secret is in Accounts' table in the server's store; clients see labels, workers see a short-lived token."
:::

The three are separate because they change separately and belong to different parties. Identity is p3's: a p3 user
exists whether or not they ever connected Radius. Accounts are the integrations': only the Radius plugin knows what a
Radius token looks like and how to refresh it, but it should not have to keep its own vault, own its own table per user,
or invent how a session's worker gets a token. Access is the instance owner's: who may administer the app, which
groups may use which models, who sees whose sessions.

# Identity: Users and Sign-In {#identity lede="A p3 user is p3's own; an external sign-in only finds one."}

p3's built-in `users` plugin owns the users and the identities linked to them, in two tables of the server's store:

```ts
// plugins/users/server.ts (built-in)
const UsersTable = defineTable("p3.users", {
	version: 1,
	columns: { id: str(), name: str(), created: num() },
	key: ["id"],
});
const Identities = defineTable("p3.identities", {
	version: 1,
	columns: { provider: str(), subject: str(), user: str(), created: num() },
	key: ["provider", "subject"],
	indexes: { by_user: ["user"] },
});
```

Its contract, published in p3's API so integrations can use it:

```ts
// @p3/app/v1/server
/** p3's users and the external sign-ins linked to them (server, trusted callers: routes and server objects). */
export const Users = local("p3.users", {
	version: 1,
	params: {},
	members: {
		/** The p3 user an external sign-in is linked to, or null. */
		byIdentity: method(obj({ provider: str(), subject: str() }), union([str(), nul()])),
		/** Makes a p3 user (when the instance's policy allows new users) and links the identity to it. */
		create: method(obj({ name: str(), identity: obj({ provider: str(), subject: str() }) }), str()),
		/** Links another identity to an existing user (a signed-in user connecting a second sign-in method). */
		link: method(obj({ user: str(), identity: obj({ provider: str(), subject: str() }) })),
		/** Issues a sign-in session for `user` (the kit's `Sessions`, principal `{ kind: "user", id }`): its cookie. */
		signIn: method(obj({ user: str(), label: str(), secure: bool() }), obj({ cookie: str() })),
	},
});
```

`signIn` is the one place that turns a p3 user into a kit session: it calls the kit's `Sessions.issue({ principal: {
kind: "user", id }, label, kind: "browser", secure })` and returns the cookie. Integrations never build principals
themselves. The first user of an instance is made at its first start (the start link signs in as it), and is an admin
of the default policy (chapter VIII).

**The sign-in page is the app's.** The kit renders no pages (owner, 2026-11-07); p3's page bundle has a public route
`/sign-in` drawn with p3's components and theme. Integrations add their buttons through a registry of the page:

```ts
// @p3/app/v1/web
/** A way to sign in, shown on the sign-in page: its label and where it starts. Ordered by plugin name. */
export type SignInMethod = { readonly name: string; readonly label: string; readonly start: string };
export const SignInMethods = defineRegistry<SignInMethod, readonly SignInMethod[]>("p3.sign-in-methods", { version: 1 });
```

# Accounts: One Owner on the Server {#accounts lede="Every external account of every user, with the integration's data, in one table nobody else writes."}

The built-in `accounts` plugin owns all external accounts. One table in the server's store; one local object writes it;
per-principal views read it.

```ts
// @p3/app/v1 (shared: the schema clients and workers see)
/** An account as its user sees it: no data. */
export const AccountInfo = obj({
	provider: str(),                 // the integration's name: "radius", "gmail"
	account: str(),                  // the account's id at the provider: "usr_8f2…", "mario@earendil.com"
	label: str(),                    // what to show: "mario@earendil.com (Radius)"
	status: oneOf("ok", "needs_reconnect"),
	created: num(),
});

// @p3/app/v1/server
/** The owner of external accounts (server, trusted callers). `data` is the integration's own JSON. */
export const Accounts = local("p3.accounts", {
	version: 1,
	params: {},
	members: {
		link: method(obj({ user: str(), provider: str(), account: str(), label: str(), data: unknown() })),
		unlink: method(obj({ user: str(), provider: str(), account: str() })),
		/** The user an account is linked to, or null: how "sign in with X" finds its user. */
		userOf: method(obj({ provider: str(), account: str() }), union([str(), nul()])),
		/** Credentials for one use, from the account's provider (refreshed and stored when the provider says so). */
		credentials: method(obj({ user: str(), provider: str(), account: str() }), Credentials),
		/** Lets `session` use the account (only its user may: checked by the views that call this). */
		grant: method(obj({ user: str(), provider: str(), account: str(), session: str() })),
		revoke: method(obj({ provider: str(), account: str(), session: str() })),
	},
});

/** What an account yields for one use. */
export const Credentials = union([
	obj({ kind: lit("token"), token: str(), expires: num() }),       // OAuth access token, epoch ms
	obj({ kind: lit("key"), key: str() }),                           // an API key that does not expire
	obj({ kind: lit("unavailable"), reason: str() }),                // needs a reconnect: the user signs in again
]);
```

The table and the object, in the plugin:

```ts
// plugins/accounts/server.ts (built-in)
const Table = defineTable("p3.accounts", {
	version: 1,
	columns: {
		user: str(), provider: str(), account: str(), label: str(),
		data: json(unknown(), { version: 1 }),      // the integration's JSON: stored, never queried
		status: str(), created: num(),
	},
	key: ["provider", "account"],                  // one external account belongs to one p3 user
	indexes: { by_user: ["user"] },
});
const Grants = defineTable("p3.account-grants", {
	version: 1,
	columns: { provider: str(), account: str(), session: str(), user: str() },
	key: ["provider", "account", "session"],
	indexes: { by_session: ["session"] },
});

host.serve(Accounts, (_params, self) => {
	const rows = self.table(Table);
	const grants = self.table(Grants);
	const providers = self.registry(AccountProviders);
	return {
		credentials: async ({ user, provider, account }, ctx) => {
			const row = await rows.get({ provider, account }, ctx);
			if (row === undefined || row.user !== user) throw forbidden("not this user's account");
			const integration = providers.value.get(provider);
			if (integration === undefined) return { kind: "unavailable", reason: `no plugin provides ${provider}` };
			const { credentials, data } = await integration.credentials(row.data, ctx);   // may refresh
			if (data !== undefined) await self.tx(async (tx) => tx.update(rows, { provider, account }, { data }), ctx);
			return credentials;
		},
		// link, unlink, userOf, grant, revoke: one transaction each
	};
});
```

The extension point an integration fills:

```ts
// @p3/app/v1/server
/**
 * How to use one provider's accounts: `credentials` turns a stored account's `data` into credentials for one use,
 * returning updated `data` when it refreshed something (stored by `Accounts` in the same call).
 */
export type AccountProvider = {
	readonly name: string;
	credentials(data: unknown, ctx: Ctx): Promise<{ readonly credentials: Credentials; readonly data?: unknown }>;
};
export const AccountProviders = defineRegistry<AccountProvider, ReadonlyMap<string, AccountProvider>>(
	"p3.account-providers",
	{ version: 1 },
);
```

**Why one owner.** Each integration could keep its own table of tokens per user. Then deleting a user means asking every
plugin; listing "what is this user connected to" means asking every plugin; handing a token to a worker is reinvented
per plugin, each with its own way of leaking it. One owner gives one place for all three, and an integration's code
shrinks to the protocol it knows: how to start the OAuth flow, how to refresh.

# A Third-Party Integration {#integration lede="The @acme/p3-radius plugin, end to end: connect, sign in, refresh."}

The whole plugin is ordinary p3 plugin code against p3's API. Its server facet contributes routes and its account
provider:

```ts
// ~/.p3/plugins/p3-radius/server.ts (third party)
import { AccountProviders, Accounts, defineFacet, Http, Users } from "@p3/app/v1/server";
import { exchange, me, refresh } from "./oauth.ts";

export default defineFacet((_host, self) => {
	self.contribute(AccountProviders, {
		name: "radius",
		credentials: async (data, ctx) => {
			const stored = data as RadiusTokens;
			if (stored.expires - Date.now() > 60_000) return { credentials: { kind: "token", token: stored.access, expires: stored.expires } };
			const fresh = await refresh(stored.refresh, ctx.abortSignal);            // Radius's token endpoint
			if (fresh === undefined) return { credentials: { kind: "unavailable", reason: "sign in to Radius again" } };
			return { credentials: { kind: "token", token: fresh.access, expires: fresh.expires }, data: fresh };
		},
	});
	self.contribute(Http, {
		routes: {
			"GET /radius/start": { public: true, handler: (request) => redirectToRadius(request) },   // state + PKCE
			"GET /radius/callback": {
				public: true,
				handler: async (request, ctx) => {
					const tokens = await exchange(request.query.get("code")!, request);
					const radius = await me(tokens.access);                      // { id, email, name }
					const users = await ctx.get(Users, {});
					const accounts = await ctx.get(Accounts, {});
					// A signed-in user connects Radius; otherwise this is "sign in with Radius".
					const user =
						signedIn(ctx) ??
						(await accounts.userOf({ provider: "radius", account: radius.id }, ctx)) ??
						(await users.create({ name: radius.name, identity: { provider: "radius", subject: radius.id } }, ctx));
					await accounts.link({ user, provider: "radius", account: radius.id, label: radius.email, data: tokens }, ctx);
					const { cookie } = await users.signIn({ user, label: "Radius", secure: request.provenance.kind !== "local" }, ctx);
					return { kind: "redirect", to: "/", headers: { "Set-Cookie": cookie } };
				},
			},
		},
	});
});

// ~/.p3/plugins/p3-radius/web.tsx: the button on the sign-in page, and a row under Settings, Accounts
export default defineFacet((_host, self) => {
	self.contribute(SignInMethods, { name: "radius", label: "Sign in with Radius", start: "/radius/start" });
	self.contribute(AccountKinds, { provider: "radius", label: "Radius", connect: "/radius/start" });
});
```

:::sequence animate | Signing in with Radius for the first time: the plugin finds no linked user, makes one, links the account, and gets a p3 session.
actor page "p3 sign-in page" "app's page bundle" blue
actor plugin "@acme/p3-radius" "server routes" muted
actor radius "Radius" "OAuth" muted
actor users "Users" "server" accent
actor accounts "Accounts" "server" accent
page -> plugin: GET /radius/start
plugin --> page: redirect to Radius (state, PKCE)
page -> radius: sign in, consent
radius --> page: redirect /radius/callback?code
page -> plugin: GET /radius/callback
plugin -> radius: exchange code; who am I?
plugin -> accounts: userOf(radius, usr_8f2) -> null
plugin => users: create(Mario, identity radius/usr_8f2) -> u1
plugin => accounts: link(u1, radius, usr_8f2, tokens)
plugin -> users: signIn(u1) -> cookie
plugin --> page: redirect / with the session cookie: principal { user u1 }
:::

A **Gmail** plugin is the same minus the sign-in button: only `AccountKinds` (connect from Settings) and the provider,
plus its tools. A **Slack** or **Discord** plugin may also keep a bot token for the instance, not a user: that is the
integration's own configuration, outside `Accounts`, which is about users' accounts.

# Stored on the Server, Used Elsewhere {#where lede="Where the secret is, what each kind of host sees, and how it stays current."}

| Host | Holds | Sees | How it stays current |
| --- | --- | --- | --- |
| server | `Accounts` (the table with `data`), `Users` | everything | it writes it |
| page, terminal | `MyAccounts {}` (remote, per user) | the user's own accounts as `AccountInfo`: no `data` | a reference: state pushed on change |
| session worker | `AccountCredentials { provider, account }` (remote, per session) | one account's current credentials, if the session was granted it | a reference: the server pushes a new token before the old expires |

**What a page shows:**

```ts
// @p3/app/v1
export const MyAccounts = remote("p3.my-accounts", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		user: {
			state: { accounts: arr(AccountInfo) },
			methods: {
				unlink: method(obj({ provider: str(), account: str() })),
				/** Brings one of my accounts into one of my sessions (a grant the session's worker can use). */
				bring: method(obj({ provider: str(), account: str(), session: str() })),
			},
		},
	},
});

// plugins/accounts/server.ts: the view derives from the shared table, filtered to its user, `data` left out
host.serve(MyAccounts, (_params, principal, self) => {
	if (principal.kind !== "user") throw forbidden("accounts are users'");
	const store = self.get(AccountsStore, {});        // the shared store object holding the live query
	return {
		variant: "user",
		members: {
			accounts: self.derive([store.byUser], ([all]) => all[principal.id] ?? NONE),
			unlink: (args, ctx) => store.unlink({ user: principal.id, ...args }, ctx),
			bring: (args, ctx) => store.grant({ user: principal.id, ...args }, ctx),   // the store checks the session is the user's
		},
	};
});
```

The terminal shows the same view with `scope.hold(MyAccounts, {})`; Settings in the page with `useHold(MyAccounts, {})`.

**What a worker uses:**

```ts
// @p3/app/v1
/** One account's credentials for the session that holds it: on the server, for the session's worker only. */
export const AccountCredentials = remote("p3.account-credentials", {
	version: 1,
	params: { provider: str(), account: str() },
	hostAddress: () => Server(),
	variants: { session: { state: { credentials: Credentials }, methods: {} } },
});

// plugins/accounts/server.ts
host.serve(AccountCredentials, ({ provider, account }, principal, self) => {
	// A worker's link stamps its session: the grant decides, never the caller's data.
	if (principal.kind !== "worker") throw forbidden("credentials go to session workers only");
	const store = self.get(AccountsStore, {});
	const current = self.state(Current);               // in memory: the credentials this view hands out
	self.onLive(async (ctx) => {
		for (;;) {
			const credentials = await store.credentialsFor({ provider, account, session: principal.session }, ctx);
			await current.change((draft) => { draft.credentials = credentials; }, ctx);
			// Refresh a minute before expiry; a key or "unavailable" waits for a change of the account instead.
			if (credentials.kind !== "token") return;
			await sleep(Math.max(0, credentials.expires - Date.now() - 60_000), ctx);
		}
	});
	return { variant: "session", members: { credentials: self.derive([current], ([c]) => c.credentials) } };
});
```

On the worker, anything that needs the token holds the reference once and reads it locally:

```ts
// a worker plugin
const radius = self.get(AccountCredentials, { provider: "radius", account });   // in a factory: live once bound
// …at each use, no round trip:
const credentials = radius.credentials.value;
```

The secret on the worker is a token that expires within the hour; the refresh token and everything else stays in the
server's table. A revoked grant ends the view (`Accounts.revoke` ends the session's `AccountCredentials` objects), so the
worker's reference fails and its next use sees "unavailable".

:::sequence animate | A worker keeps a Radius token current without asking for it.
actor worker "session worker" "a model request" blue
actor view "AccountCredentials" "server, per session"
actor accounts "Accounts" "server" accent
actor plugin "@acme/p3-radius" "provider" muted
worker -> view: hold { radius, usr_8f2 } (once)
view -> accounts: credentialsFor(session S1): granted? yes
accounts -> plugin: credentials(data): still valid
view --> worker: state: token T1, expires 12:00
worker -> worker: each request reads T1 (local)
note view: 11:59: a minute before expiry
view -> accounts: credentialsFor again
accounts -> plugin: credentials(data): refresh -> T2, new data stored
view --> worker: state: token T2
:::

# Models {#models lede="A model-provider plugin whose auth reads the followed token."}

The Radius integration (or a separate plugin) contributes a pi-ai provider to the session worker's `ModelProviders`
registry (the harness's, from the map). Its auth resolves the token from the followed `AccountCredentials`, so each
request uses the current token and the refresh is the server's business:

```ts
// ~/.p3/plugins/p3-radius/worker.ts (third party)
host.serve(RadiusModels, (_params, self) => {
	const session = self.get(SessionAccounts, {});                     // the session's granted accounts (worker data)
	const radius = self.writable<Held<typeof AccountCredentials> | undefined>(undefined);
	self.on(session.granted, async ({ value }, ctx) => {               // follow which Radius account the session has
		const account = value.find((each) => each.provider === "radius");
		radius.set(account === undefined ? undefined : await ctx.get(AccountCredentials, account));
	});
	self.contribute(ModelProviders, createProvider({
		id: "radius",
		api: openAiCompatible,                                         // Radius's gateway speaks an OpenAI-style API
		baseUrl: "https://radius.earendil.com/v1",
		models: radiusModels,
		auth: {
			apiKey: {
				name: "Radius account",
				resolve: async () => {
					const credentials = radius.value?.credentials.value;
					return credentials?.kind === "token" ? { auth: { apiKey: credentials.token }, source: "p3 account" } : undefined;
				},
			},
		},
	}));
	return {};
});
```

(The reference is kept for the object's life in practice; this sketch shows the shape. `SessionAccounts` is the
session's own list of accounts brought into it, chapter VII.)

# MCP {#mcp lede="An MCP server that needs a sign-in names the account; the MCP plugin uses its token."}

The MCP plugin (built-in or not) keeps each session's MCP servers. A server entry can name an account instead of a
static header:

```json
{ "name": "radius", "url": "https://radius.earendil.com/mcp", "auth": { "account": { "provider": "radius" } } }
```

When it connects, the MCP plugin holds `AccountCredentials` for the session's Radius account and sends its token as
the bearer; when the state changes (a refreshed token), it uses the new token for the next request or reconnects,
depending on the transport. A tool call of an MCP server with several accounts brought into the session carries which
one in the call's envelope `{ account?, input }` (decided for MCP earlier); without one, the session's only account of
that provider is used.

Who connects as whom in a shared session follows from the grant: the account belongs to whoever brought it, and every
user who may send inputs to the session uses it through the session (the resources rule: anything brought into a
session is usable by everyone who can send inputs there; nothing personal is brought implicitly).

# Bringing an Account Into a Session {#grants lede="The one step that lets a session use a user's account, and how it is checked."}

The grant is stored on the server (`Grants`), because it gates a secret the server keeps; the session's worker keeps its
own list of what was brought in (`SessionAccounts`), because tools and the UI read it there. The user brings an
account in from the session's resources panel:

1. The page calls `MyAccounts.bring({ provider, account, session })` as the user.
2. The server checks the account is the user's and the user may change the session's resources (the policy, chapter
   VIII), stores the grant, and tells the session's worker through `SessionAccounts.add` (the worker owns its data;
   the server pushes).
3. The worker's plugins see the account in `SessionAccounts` and hold `AccountCredentials` for it.

Removing it revokes the grant; the server ends that session's `AccountCredentials` objects; the worker's references
fail; tools and providers using it see "unavailable" at their next use.

# Access: a Pluggable Policy {#access lede="One provider answers 'may this user do this', locally on every host."}

```ts
// @p3/app/v1
/** What a user may do. One provider per host (the `acl` plugin by default); readers call it locally. */
export type Policy = {
	allows(user: string, action: string, thing: ThingAddress): boolean;   // ThingAddress: a contract name and params
};
export const Access = defineRegistry<Policy, Policy | undefined>("p3.access", { version: 1 });
```

The default `acl` plugin keeps a small model in the server's store, close to Radius's organizations: built-in roles
(`admin`, `member`) mirrored as groups (`@admins`, `@members`), groups the instance's admins define, and grants of
actions on things to users or groups. Its server facet serves the data; its worker facet follows the parts a worker
needs as a reference (live state, pushed on change) and contributes a `Policy` whose `allows` reads only that local
state. The kit asks the app one question, "may this user administer the app?", which p3 answers as
`access.allows(user, "administer", App())`.

A third party replaces the policy by installing another plugin that serves `Access` (one provider per registry: the
`acl` plugin is then switched off). Example: a policy that reads the user's Radius organization role and groups through
their Radius account (`context_read`, `groups_read` in Radius's API), refreshed like credentials, so a Radius
organization's admins administer the p3 instance.

# Bring Your Own Org Model {#byo lede="An integration that knows its service's users, orgs, groups and roles answers p3's access questions from them; p3 never copies them."}

Radius has its own model: an organization, members with a fixed membership role (owner, admin, member), groups (local
ones, externally managed ones, and the built-in `@owners` and `@admins` that mirror the roles), and things attached to
groups (budgets, model availability, policies). Google Workspace, Slack and Discord each have theirs. Mapping all of
them into one generic p3 model of orgs and groups would be a parallel system that is always a little wrong; each
service's integration already knows its service's model, and it is the only code that needs to.

So p3 keeps only two things of its own, and asks the rest:

- **the anchor**: a p3 user (an id, a name) and the identities linked to it, so everything else has something to
  point at;
- **the question**: `Access.allows(user, action, thing)`, asked by p3's built-in parts and by plugins.

Who answers the question is a plugin. p3's default `acl` plugin answers from its own small model (roles, groups,
grants in the server's store) for instances that have no outside org. An instance run by a Radius organization installs
the Radius integration's policy instead, which answers from Radius:

```ts
// ~/.p3/plugins/p3-radius/server.ts (third party), its policy part
host.serve(RadiusOrg, (_params, self) => {
	const accounts = self.get(AccountsStore, {});
	// Each user's Radius role and groups, read through their Radius account, kept in memory and refreshed.
	const members = self.state(Members);                // { [p3 user]: { role: "owner" | "admin" | "member"; groups: string[] } }
	self.onLive(async (ctx) => {
		for (;;) {
			await refreshMembers(members, accounts, ctx);     // Radius API: context_read, members_list, groups_read
			await sleep(5 * 60_000, ctx);
		}
	});
	self.contribute(Access, {
		allows: (user, action, thing) => {
			const member = members.value[user];
			if (member === undefined) return false;                                   // no Radius account: not in the org
			if (action === "administer") return member.role === "owner" || member.role === "admin";
			if (action === "use-model") return modelAvailableTo(member.groups, thing); // the org's model availability
			return member.role !== undefined;                                         // members may use p3
		},
	});
	return { members };
});
```

And the same policy is followed on each worker (its worker facet holds the server's `RadiusOrg` view and contributes a
local `Policy` reading it), so a check in a session is a local read there too.

What stays p3's even then: the things only p3 has. Who a session is shared with, and what a guest may do in it, is the
session's own data; the policy can consult it (`allows(user, "send", Chat({ session }))` asks the session's sharing
first), but Radius knows nothing about p3 sessions and should not.

**Where each kind of rule lives:**

| Rule | Owner | Example |
| --- | --- | --- |
| who is a p3 user, which sign-ins are theirs | p3 (`Users`) | Mario is `u1`, signs in with Radius or Google |
| what a user is in an outside org (role, groups) | the integration, read from the service | Mario is an admin of the Earendil org |
| what an outside resource allows (budgets, model availability, a Notion page's sharing) | the service itself, enforced when the account is used | Radius's gateway refuses a model the user's groups cannot use |
| who may administer p3, use p3 at all | the policy plugin (default `acl`, or the integration's) | Radius org admins administer this p3 |
| who may see or send in a session | the session's sharing data | Mario shared session S1 with Ada as a reader |

**Is each service's model used only by its integration?** Mostly, and that is the point: Radius's groups are read by
the Radius plugin, Slack's channels by the Slack plugin. Two cases cross that line, both through p3's contracts, never
through another plugin's internals: the policy (an integration's org model answering p3's `Access` question for
everyone), and accounts (a Radius account used by the MCP plugin or a model provider through `AccountCredentials`).
Neither needs the other side to know the service's model.

# What p3 Provides, What Integrations Provide {.epilogue lede="The split, and the decisions this needs."}

| p3 (built-in plugins and API) | A third-party integration |
| --- | --- |
| `Users`: p3 users, identities, `signIn` | its OAuth routes (`/x/start`, `/x/callback`) |
| `Accounts`: the table, links, grants, `credentials` | its `AccountProvider`: how to refresh and what credentials are |
| `MyAccounts` (pages, terminals), `AccountCredentials` (workers), `SessionAccounts` | what it does with credentials: a model provider, tools, an MCP server entry |
| `AccountProviders`, `SignInMethods`, `AccountKinds`, `Access` registries | its sign-in button and settings row |
| the sign-in page, Settings, Accounts, the session's resources panel | its own configuration (a bot token, a workspace id) |
| the default `acl` policy | optionally a replacement policy |

Decisions this needs, one at a time:

1. **Users instead of an owner**: principals `server | worker | user { id }`; the first user made at first start; the
   kit asks the app whether a user may administer (replaces `principal.owner`, built and committed as d4d6d9241).
2. **The kit renders no pages**: sign-in, pairing approval and invites are endpoints; p3's page bundle draws the pages.
3. **`Accounts` as the one owner of external accounts**, with `data` opaque to p3 and only `AccountInfo` shown to
   clients.
4. **Credentials to workers as followed state**, refreshed by the server, never the refresh token.
5. **Grants per session**, stored on the server, mirrored into the session's `SessionAccounts`.
6. **The `Access` registry** with one provider: a default `acl` plugin for instances without an outside org, replaced
   by an integration's policy (e.g. Radius roles and groups) when the instance belongs to one. p3 never copies an
   outside org model; it keeps only users, identities and its own sessions' sharing.
7. **Trust**: installed plugins run in the server's process and could read any integration's `data`; p3 does not
   pretend otherwise. Installing a plugin is trusting it; per-plugin isolation of `data` (each integration reads only
   its own provider's rows) is enforceable for well-behaved plugins through the API, not against hostile code.

# Reference {.appendix}

## Contracts and registries (proposed)

| Name | Kind | Host | For |
| --- | --- | --- | --- |
| `Users` | local | server | trusted callers: find, create, link users; `signIn` |
| `Accounts` | local | server | trusted callers: link, unlink, `userOf`, `credentials`, grants |
| `MyAccounts` | remote, per user | server | pages and terminals: the user's accounts without data |
| `AccountCredentials { provider, account }` | remote, per session worker | server | workers: current credentials of a granted account |
| `SessionAccounts` | local | session worker | the session's accounts brought in |
| `AccountProviders` | registry | server | integrations: how to use their accounts |
| `SignInMethods`, `AccountKinds` | registries | page | integrations: buttons and settings rows |
| `Access` | registry | every host | the policy: `allows(user, action, thing)` |
