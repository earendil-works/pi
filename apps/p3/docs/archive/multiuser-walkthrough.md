# Multi-user p3, end to end: a walkthrough

Status: walkthrough for the owner, 2026-11-13. It ties the agreed direction into one story. Not decided in detail,
not built. Code is a sketch: real Chord shapes where they exist (`local`, `remote`, `defineTable`, `defineState`,
`defineRegistry`, `defineFacet`, `host.serve`, `self.table`, `self.tx`, `self.registry`, `self.contribute`, the
kit's `Http`, `Sessions`), and **guessed** where they do not. The guesses are listed at the end.

Sources: `users-sketch.md` (layer 1), `operation-gates-sketch.md` (layer 3), `resource-model/book.md` (lists, the
harness keyed by resource), the MCP identity note ("MCP identity and naming: our direction", Radius artifact
01m7a3jgggfze9cgdv1hekx1sg).

## The five layers in one page

| # | Layer | Question it answers | Who owns it | What it stores |
|---|---|---|---|---|
| 1 | **Who** | Which user is this request? | `users` core plugin + one Directory provider | users, identities (issuer, subject → user) |
| 2 | **Mine** | Whose data does this plugin code see? | the platform (Chord + kit) | nothing itself: it keys a plugin's state by user |
| 3 | **May** | May this user do this operation? | one Gate provider | nothing itself (a company policy may) |
| 4 | **Sessions** | Who is in this session, and what may its agent use? | `sessions` core plugin | per session: people list, resource list |
| 5 | **Agent** | How does the model see and call those resources? | the plugin of each resource kind (here: MCP) | nothing new: names are computed per conversation |

A request goes through them in order. Every call from a page, a terminal or a session worker passes the same
dispatch:

```ts
// The platform's dispatch of a method call on the server (Chord host + p3's core plugins). Plugin handlers run last
// and contain no checks.
async function dispatch(call: MethodCall, ctx: Ctx) {
	const principal = call.principal;                        // 1. Who: stamped on the link at sign-in (kit Sessions)
	const scope = scopeOf(call.contract, call.params, principal);   // 2. Mine: the user whose data the object sees
	const op = operationOf(call.contract, call.method);      // 3. May: declared by the plugin, undefined = ungated
	if (op !== undefined) {
		const decision = await gate.value.decide({ principal, operation: op.name,
			object: { contract: call.contract.name, params: call.params }, args: call.args, facts: op.facts(call.args) }, ctx);
		if (decision.kind === "deny") throw forbidden(decision.reason);
	}
	if (isResourceContract(call.contract))                    // 4. Sessions: a call for a resource needs it on the list
		await requireOnList(principal, call.params.resource, ctx);
	return call.handler(call.args, { ...ctx, scope });         // the plugin's code, written as if single-user
}
```

The rest of this document fills in each line with a story.

---

# Part A: Mario alone

Mario runs p3 on his laptop. One user, one scope, the default policy. Every layer is present, and none of them is
in his way.

## A1. First start: the setup link

**Mario does:** runs `p3`. The terminal prints a link. He opens it and types his name.

**Acts:** the kit, then the `users` core plugin, then the default Directory provider, then the kit's `Sessions`.

**Stores:** a row in `users.users` (`u1`), a row in `users.identities` (`local/s1 → u1`), `u1` in the default
directory's admins, and one kit session.

```ts
// plugins/users/server.ts (core, tier 2; contracts fixed in @p3/app/v1/server)
const UserRows = defineTable("users.users", {
	version: 1,
	columns: { id: str(), name: str(), email: opt(str()), created: int(), disabled: bool({ default: false }) },
	key: ["id"],
});
const IdentityRows = defineTable("users.identities", {
	version: 1,
	columns: { issuer: str(), subject: str(), user: str(), created: int() },
	key: ["issuer", "subject"],
	indexes: { by_user: ["user"] },
});

// The one place that turns a verified identity into a sign-in session.
complete: async ({ identity, profile, hints, label, secure }, ctx) => {
	const existing = await users.byIdentity(identity, ctx);
	const admission = await directory.value.provider.admit({ identity, profile, hints, existing }, ctx);
	if (admission.kind === "refuse") return { kind: "refused", reason: admission.reason };
	const user = admission.kind === "create"
		? await users.create({ profile: admission.profile, identity }, ctx)
		: admission.user;
	await directory.value.provider.onSignIn?.({ user, created: admission.kind === "create", admission }, ctx);
	const { cookie } = await sessions.issue({ principal: { kind: "user", id: user }, label, kind: "browser", secure }, ctx);
	return { kind: "signed-in", user, cookie };
},
```

The default directory admits the setup identity only while there are no users. It makes that user an admin:

```ts
// plugins/users/server.ts, the default Directory provider
admit: async ({ profile, hints, existing }) =>
	existing !== null ? { kind: "user", user: existing }
	: hints.setup && userCount() === 0 ? { kind: "create", profile, admin: true }
	: hints.invite !== undefined && (await validInvite(hints.invite)) ? { kind: "create", profile, admin: invite.admin }
	: { kind: "refuse", reason: "You need an invite to join." },
isAdmin: (user) => admins.value.admins.includes(user),
```

From now on every request from Mario's browser carries the principal `{ kind: "user", id: "u1" }`. Nothing else
about him rides in it.

## A2. Mario adds three Gmail MCP servers

**Mario does:** Settings, MCP, "Add server", three times: Gmail personal, Gmail work, Gmail earendil. Each one has
the same URL and its own Google sign-in.

**Acts:** the page calls `McpServers.create` (the MCP plugin's remote object). Dispatch runs the gate (default
policy: allow), then the handler. Then `McpServers.signIn` runs OAuth, and the token goes into the MCP plugin's
user-scoped table.

**Stores:** three rows in `mcp.configs` and three in `mcp.auth`, all in scope `u1`. Three resources: `mcp.server/m1`,
`m2`, `m3`, each with owner `u1`.

This is how the MCP plugin declares its state. It is written as if there were one user:

```ts
// plugins/mcp/server.ts
// guessed: `scope: "user"` on a table. The platform adds the scope to the key and to every query; the plugin never
// names a user and cannot reach another scope's rows.
const Configs = defineTable("mcp.configs", {
	version: 1,
	scope: "user",
	columns: { id: str(), label: str(), config: json(McpConfig, { version: 1 }), instructions: opt(str()) },
	key: ["id"],
});
const Auth = defineTable("mcp.auth", {
	version: 1,
	scope: "user",
	columns: { id: str(), account: opt(str()), tokens: json(OAuthState, { version: 1 }) },
	key: ["id"],
});
```

The page talks to a remote object that the platform also scopes. The plugin's factory does not look at the principal:

```ts
// plugins/mcp/contract.ts
// guessed: `scope: "user"` on a remote contract: one object per signed-in user, its scope the caller's user id.
export const McpServers = remote("mcp.servers", {
	version: 1,
	params: {},
	scope: "user",
	hostAddress: () => Server(),
	variants: {
		user: {
			state: { servers: arr(ServerInfo) },     // id, label, url, account, status, tools; never tokens
			methods: {
				create: method(obj({ label: str(), config: McpConfig }), ResourceRef),
				signIn: method(obj({ id: str() }), SignInStart),
				remove: method(obj({ id: str() })),
			},
		},
	},
});

// Layer 3: the operations and their facts (operation-gates-sketch.md).
export const CreateMcp = operation(McpServers, "create", {
	facts: ({ config }) => ({
		kind: "create",
		runsCode: config.transport.kind === "server-stdio" ? "server" : config.transport.kind === "checkout" ? "machine" : "none",
		reaches: config.transport.kind === "http" ? new URL(config.transport.url).host : null,
	}),
});
export const RemoveMcp = operation(McpServers, "remove", { facts: () => ({ kind: "delete" }) });
```

```ts
// plugins/mcp/server.ts
host.serve(McpServers, (_params, _principal, self) => {
	const configs = self.table(Configs);                // rows of this object's scope only (u1 here)
	const all = self.query(configs, query(Configs), 1000);
	return {
		variant: "user",
		members: {
			servers: self.derive([all], ([rows]) => rows.map(toInfo)),
			create: async ({ label, config }, ctx) => {
				const id = newId();
				await self.tx(async (tx) => tx.put(configs, { id, label, config }), ctx);
				return { kind: "mcp.server", owner: ctx.scope, id };   // ctx.scope: guessed, the platform's user id
			},
			signIn: async ({ id }, ctx) => startOAuth(id, ctx),      // the callback writes Auth in the same scope
			remove: async ({ id }, ctx) => { /* delete config and auth; the sessions core drops the ref from lists */ },
		},
	};
});
```

The gate with the default policy:

```ts
// plugins/policy-default/server.ts
self.contribute(Gate, {
	decide: async ({ principal, facts }, ctx) =>
		principal.kind !== "user" ? deny("users only")
		: facts.runsCode === "server" && !(await users.isAdmin(principal.id, ctx)) ? deny("runs code on the p3 machine")
		: allow(),
});
```

Mario's three http servers run no code on the machine, so the gate allows them. As an admin he could add a stdio
server too.

## A3. Mario opens a session: its lists

**Mario does:** "New session".

**Acts:** the `sessions` core plugin creates the session. It fills the people list with its owner, and the resource
list with the owner's defaults.

**Stores:** a session row, a people row (`u1`, owner), and resource rows: `m1`, `m2`, `m3` (brought by `u1`), plus
the instance-wide resources plugins bring (bash, file tools), which have no owner and no bringer.

```ts
// plugins/sessions/server.ts (core, tier 2)
const People = defineTable("sessions.people", {
	version: 1,
	columns: { session: hostColumn(Session), user: str(), right: str() /* "owner" | "send" | "view" */,
		via: opt(str()) /* a link id when they came through a link */, added: int() },
	key: ["session", "user"],
	indexes: { by_user: ["user"] },
});
const Links = defineTable("sessions.links", {
	version: 1,
	columns: { session: hostColumn(Session), id: str(), tokenHash: str(), right: str() /* "send" | "view" */,
		expires: opt(int()) },
	key: ["session", "id"],
	indexes: { by_token: ["tokenHash"] },
});
const Resources = defineTable("sessions.resources", {
	version: 1,
	columns: { session: hostColumn(Session), kind: str(), owner: str() /* "" for instance-wide */, id: str(),
		broughtBy: str() /* "" for instance-wide */, added: int() },
	key: ["session", "kind", "owner", "id"],
});
```

Every resource kind is declared once by its plugin. The declaration says how to list a user's resources of that
kind, and which contract serves calls for one:

```ts
// plugins/mcp/contract.ts
// guessed: `defineResourceKind` and the `ResourceKinds` registry of the sessions core.
export const McpServerKind = defineResourceKind("mcp.server", {
	/** The calls for one resource: params carry the ref; the platform checks it is on the caller's session list. */
	contract: McpResource,
});

// plugins/mcp/server.ts
self.contribute(ResourceKinds, {
	kind: McpServerKind,
	/** The resources of the scope this runs in (a user's), for "bring" pickers and defaults. */
	list: (ctx) => listConfigs(ctx).map((c) => ({ id: c.id, label: c.label, account: c.account ?? null })),
});
```

Creating a session:

```ts
// plugins/sessions/server.ts
create: async ({ title, start }, ctx) => {
	const owner = userOf(ctx.principal);
	const session = newSessionId();
	const mine = start === "mine" ? await resourcesOfUser(owner, ctx) : [];   // every kind's list(), in owner's scope
	await self.tx(async (tx) => {
		tx.put(people, { session: Session({ id: session }), user: owner, right: "owner", added: Date.now() });
		for (const r of [...mine, ...instanceResources.value])
			tx.put(resources, { session: Session({ id: session }), ...r, broughtBy: r.owner === "" ? "" : owner, added: Date.now() });
	}, ctx);
	return session;
},
```

A new session either starts with "my resources", the default, or with "instance tools only". Part B uses the
second for a session meant for sharing.

## A4. "Check my work mail"

**Mario does:** types "check my work mail".

**Acts, in order:**
1. The `sessions` core attributes the input: sender block `<sender kind="user" id="u1" name="Mario"/>`.
2. The MCP plugin's worker facet renders the `mcp_servers` prompt section for this conversation.
3. Code mode calls `tools.mcp__gmail_work__search_threads(...)`.
4. The worker calls `McpResource.call` on the server. Dispatch checks that `mcp.server/u1/m2` is on the list, then
   sets scope `u1`.
5. The MCP plugin's handler reads `m2`'s config and token from its scope and calls Gmail.

**Stores:** the transcript entry with the author. Nothing else.

The section lists one line per namespace. Names stay plain unless two clash. Here three Gmail servers clash, and
they differ by account label:

```text
## MCP servers
- mcp__gmail_personal (codemode): Gmail, owner Mario, account mario.z@gmail.com. Read and send mail ...
- mcp__gmail_work (codemode): Gmail, owner Mario, account mario@badlogicgames.com. Read and send mail ...
- mcp__gmail_earendil (codemode): Gmail, owner Mario, account mario@earendil.com. Read and send mail ...
```

The labels are the ones Mario typed when he created each server (`label`). The account comes from OAuth. Only
servers that run at a location (project stdio, `runOn: location`) add "runs at <location>".

```ts
// plugins/mcp/worker.ts: names, computed per conversation from the session's list
type Entry = { ref: ResourceRef; serverName: string; ownerName: string; account: string | null; label: string;
	location: string | null };

/** Plain while unique; else qualified by what differs; a hash of (resource, location) on any remaining clash. */
export function namespaces(entries: readonly Entry[]): Map<Entry, string> {
	const byName = groupBy(entries, (e) => e.serverName);
	const out = new Map<Entry, string>();
	for (const [name, group] of byName) {
		if (group.length === 1) { out.set(group[0]!, mcpNamespace(name)); continue; }
		const parts = differing(group, ["ownerName", "label", "location"]);   // only the fields that differ in this group
		for (const e of group) out.set(e, mcpNamespace([name, ...parts.map((p) => slug(e[p]))].join("_")));
	}
	// A qualified name equal to another name, or cut at 64 characters: append the short hash of the identity.
	return withCollisionHashes(out, (e) => hash8(`${refKey(e.ref)}\0${e.location ?? ""}`));
}
```

The call path. The worker never holds the token:

```ts
// plugins/mcp/contract.ts
/** Calls for one MCP resource. The platform checks the ref against the caller's session list and scopes the object. */
export const McpResource = remote("mcp.resource", {
	version: 1,
	params: { resource: ResourceRefParam },
	hostAddress: () => Server(),
	variants: {
		worker: {
			state: { tools: arr(ToolInfo), instructions: union([str(), nul()]), account: union([str(), nul()]) },
			methods: { call: method(obj({ tool: str(), args: unknown(), location: union([str(), nul()]) }), CallResult) },
		},
	},
});

// plugins/mcp/server.ts
host.serve(McpResource, ({ resource }, _principal, self) => {
	// The platform has checked the list and set this object's scope to resource.owner (u1).
	const configs = self.table(Configs);
	const auth = self.table(Auth);
	const client = self.open((ctx) => connect(resource.id, configs, auth, ctx), closeClient);   // one login per resource
	return {
		variant: "worker",
		members: {
			tools: self.derive([client.tools], ([t]) => t),
			instructions: self.derive([client.instructions], ([i]) => i),
			account: /* from Auth */,
			call: async ({ tool, args }, ctx) => client.value.callTool(tool, args, ctx),
		},
	};
});
```

```ts
// The platform's list check (sessions core, called by dispatch for every resource contract).
async function requireOnList(principal: P3Principal, resource: ResourceRef, ctx: Ctx) {
	if (principal.kind === "worker") {
		if (!(await onList(principal.session, resource, ctx))) throw forbidden("not on this session's list");
		return;
	}
	// A person calling a resource directly (a "test connection" button): only their own.
	if (principal.kind !== "user" || principal.id !== resource.owner) throw forbidden("not yours");
}
```

For Mario alone, every layer is present and cheap. Layer 1 is one user. Layer 2 is one scope. Layer 3 is one `if`.
Layer 4 is a list he never has to edit. Layer 5 names his three Gmails apart.

---

# Part B: Acme

Acme runs one p3 instance for a team. It was provisioned with two company plugins:

- `@acme/p3-sso`: a Directory provider, Sign in with Acme (OIDC), and SCIM routes. It replaces the default directory.
- `@acme/p3-policy`: a Gate provider. It replaces the default policy.

Nothing else changes: the MCP plugin, the sessions core and code mode are the same code as on Mario's laptop.

## B1. Colin and Cristina sign in

**Colin does:** opens p3 and clicks "Sign in with Acme".

**Acts:** `@acme/p3-sso`'s `/acme/callback` route verifies the ID token and calls `SignIn.complete` with the groups
from the token. Its Directory provider admits Colin, because `engineering` is an allowed group.

**Stores:** `users.users` `u1` (Colin), `users.identities` (`https://login.acme.com`, `00u1ab`) → `u1`, and
`acme.members` (`00u1ab`, `u1`, groups `["engineering"]`). Cristina the same: `u2`, groups `["research"]`.

```ts
// @acme/p3-sso/server.ts, its Directory provider
admit: async ({ identity, profile, hints, existing }) => {
	if (identity.issuer !== config.value.issuer) return { kind: "refuse", reason: "Sign in with Acme." };
	const groups = hints.groups ?? [];
	if (!groups.some((g) => config.value.allowedGroups.includes(g))) return { kind: "refuse", reason: "Ask IT for access." };
	return existing !== null ? { kind: "user", user: existing } : { kind: "create", profile, admin: groups.includes("p3-admins") };
},
isAdmin: (user) => membersByUser().get(user)?.groups.includes("p3-admins") ?? false,
/** Used by Acme's gate: the directory is the one place that knows groups. guessed: groupsOf on the provider. */
groupsOf: (user) => membersByUser().get(user)?.groups ?? [],
onSignIn: async ({ user }, ctx) => { /* upsert acme.members with the token's groups */ },
setupMode: () => false,
```

## B2. Colin adds Linear and his Gmail; Cristina tries a stdio server

**Colin does:** adds two http MCP servers: Linear (`mcp.linear.app`) and Gmail (`gmail.mcp.acme.com`, signed in as
colin@acme.com).

**Acts:** `McpServers.create` in scope `u1`. Dispatch asks Acme's gate with the facts `{ kind: "create", runsCode:
"none", reaches: "mcp.linear.app" }`. The host is on Acme's list, so the gate allows it.

**Stores:** two configs and two auth rows in scope `u1`. Resources `mcp.server/u1/l1` and `mcp.server/u1/g1`.

**Cristina does:** adds a stdio server (`npx some-mcp`). Dispatch asks the gate with `{ kind: "create", runsCode:
"server", reaches: null }`. Cristina is in `research`, not `engineering`, so the gate denies. Her page shows the
reason. The MCP plugin's handler never ran.

```ts
// @acme/p3-policy/server.ts
self.contribute(Gate, {
	async decide({ principal, operation, facts, args }, ctx) {
		if (principal.kind !== "user") return principal.kind === "worker" ? allow() : deny("users only");
		const groups = directory.value.provider.groupsOf?.(principal.id) ?? [];
		if (facts.kind === "create" && facts.runsCode !== "none" && !groups.includes("engineering"))
			return deny("Only engineering adds servers that run code.");
		if (facts.reaches != null && !APPROVED_HOSTS.includes(facts.reaches))
			return deny(`${facts.reaches} is not an approved service.`);
		// A rule specific to MCP: imports the MCP plugin's published contract, never the other way round.
		if (isOperation(operation, CreateMcp) && args.config.lifetime === "shared" && !groups.includes("p3-admins"))
			return deny("Only admins add shared servers.");
		// A rule on sessions: sharing with send rights outside the company is off.
		if (isOperation(operation, ShareSession) && facts.audience === "link" && facts.right === "send")
			return deny("Send links are off at Acme.");
		return allow();
	},
});
```

Cristina then adds her own Gmail (http, allowed): resource `mcp.server/u2/g2` in scope `u2`.

## B3. Colin creates "release", shares it, brings Linear

**Colin does:** "New session", start with "instance tools only", title "release". Share, Cristina, "can send". Then,
in the session's resources panel, "Bring", Linear.

**Acts:** `Sessions.create` (start `"instance"`). Then `SessionPeople.share` (an operation: the gate sees `{ kind:
"change", audience: "user", right: "send" }`). Then `SessionResources.bring` (an operation, plus the hard rule:
only from your own scope).

**Stores:** people rows `u1` owner and `u2` send. Resource rows: bash and file tools (instance-wide), and
`mcp.server/u1/l1` brought by `u1`.

```ts
// plugins/sessions/contract.ts (core; contracts in @p3/app/v1)
export const SessionPeopleView = remote("sessions.people", {
	version: 1,
	params: { session: param.str() },
	hostAddress: () => Server(),
	variants: {
		owner: {
			state: { people: arr(PersonRow), links: arr(LinkRow) },
			methods: {
				share: method(obj({ user: str(), right: oneOf("send", "view") })),
				unshare: method(obj({ user: str() })),
				link: method(obj({ right: oneOf("send", "view"), expires: opt(int()) }), obj({ url: str() })),
				revokeLink: method(obj({ id: str() })),
			},
		},
		member: { state: { people: arr(PersonRow) } },
	},
});
export const ShareSession = operation(SessionPeopleView, "share", {
	facts: ({ right }) => ({ kind: "change", audience: "user", right }),
});
export const LinkSession = operation(SessionPeopleView, "link", {
	facts: ({ right }) => ({ kind: "change", audience: "link", right }),
});

export const SessionResourcesView = remote("sessions.resources", {
	version: 1,
	params: { session: param.str() },
	hostAddress: () => Server(),
	variants: {
		sender: {
			state: { resources: arr(ResourceRow) /* kind, owner name, label, account, brought by */ },
			methods: {
				bring: method(obj({ resource: ResourceRef })),
				withdraw: method(obj({ resource: ResourceRef })),
			},
		},
		viewer: { state: { resources: arr(ResourceRow) } },
	},
});
export const BringResource = operation(SessionResourcesView, "bring", {
	facts: ({ resource }) => ({ kind: "use", resourceKind: resource.kind }),
});
```

```ts
// plugins/sessions/server.ts
bring: async ({ resource }, ctx) => {
	const user = userOf(ctx.principal);
	// Hard rules, not policy: you bring only what is yours, into a session where you may send.
	if (resource.owner !== user) throw forbidden("You can bring only your own resources.");
	if (!(await maySend(session, user, ctx))) throw forbidden("You cannot send in this session.");
	await self.tx(async (tx) => tx.put(resources, { session: Session({ id: session }), ...resource, broughtBy: user,
		added: Date.now() }), ctx);
	return null;
},
withdraw: async ({ resource }, ctx) => {
	// The bringer or the session's owner may withdraw. The list change reaches workers as live state.
	await self.tx(async (tx) => tx.delete(resources, { session: Session({ id: session }), ...resource }), ctx);
	return null;
},
```

Bringing is the grant. Everyone who may send in "release" now uses Colin's Linear through the agent. There is no
per-turn check of who asked, because the other person's message stays in the context and a prompt injection would
defeat it.

## B4. Cristina asks about Linear

**Cristina does:** types "what's open in Linear?" in "release".

**Acts:**
1. The sessions core admits her input: she is on the people list with `send`.
2. The sender block is `<sender kind="user" id="u2" name="Cristina"/>`.
3. The prompt section, for this conversation: `- mcp__linear (codemode): Linear, owner Colin. ...`. There is only
   one Linear on the list, so the name is plain.
4. Code mode calls `mcp__linear__list_issues`. The worker calls `McpResource({ resource: u1/l1 }).call`.
5. Dispatch finds `u1/l1` on the "release" list and sets scope `u1`. The handler calls Linear with Colin's token.

**Stores:** Cristina's message and the agent's answer in the transcript, each with its author.

Linear sees Colin's account, because that is the resource on the list. The answer is visible to everyone in the
session. That is what Colin agreed to by bringing it.

## B5. Two Gmails: "check my mail"

**Colin and Cristina do:** Colin brings his Gmail (`u1/g1`). Cristina brings hers (`u2/g2`), then types "check my
mail".

**Acts:** `SessionResources.bring` twice, each from the bringer's own scope. **Stores:** two more resource rows.
Two servers on the list are named `gmail`, and they differ by owner:

```text
## MCP servers
- mcp__linear (codemode): Linear, owner Colin. Issues, projects ...
- mcp__gmail_colin (codemode): Gmail, owner Colin, account colin@acme.com. Read and send mail ...
- mcp__gmail_cristina (codemode): Gmail, owner Cristina, account cristina@acme.com. Read and send mail ...
```

The owner names match the names in the sender blocks. Cristina's message carries `name="Cristina"`, so "my mail"
maps to `mcp__gmail_cristina`. The call goes through `McpResource({ resource: u2/g2 })` in scope `u2`, with
Cristina's token.

Nothing stops the model from reading Colin's Gmail for Cristina. Colin brought it into a session where she may send.
That is the decided rule; the page warns when you bring a personal account into a shared session.

## B6. Colin withdraws Linear

**Colin does:** in the resources panel, Linear, "Withdraw".

**Acts:** `SessionResources.withdraw` deletes the row. The worker's view of the list changes as live state. The MCP
plugin's worker facet drops the namespace from the next prompt. A call already captured by a running script reaches
dispatch, and `requireOnList` refuses it: "not on this session's list".

**Stores:** one row fewer in `sessions.resources`. Colin's Linear config and token stay in his scope. He can bring
it again later.

## B7. A share link

**Colin does:** makes a view link for "release" (allowed: Acme's policy only refuses send links) and posts it in
the company chat.

**Acts:** `SessionPeople.link`, gated with `{ kind: "change", audience: "link", right: "view" }`. The link page
redeems the token.

**Stores:** a row in `sessions.links` (token hash, `view`, optional expiry). When someone opens it:

- **Sam from sales, signed in as `u3`**, stays himself. His right is the higher of his own grant (none) and the
  link's (`view`). A people row `u3`, `view`, `via: link1` is stored, so he shows up by name and revoking the link
  removes him. He cannot send. If Colin had also shared "release" with Sam with `send`, he would keep `send`.
- **An outsider without an Acme sign-in** (the instance is reachable through Acme's front door, but the link page is
  public) gets the principal `{ kind: "guest", id: "g7", link: "link1" }`. The right comes from the link only. A
  typed name is shown as "Ann (guest)". No people row is stored: guests last as long as the link and their cookie.

```ts
// plugins/sessions/server.ts, the link route
"POST /sessions/join": { public: true, handler: async (request, ctx) => {
	const { token, name } = await readJoin(request);
	const link = await linkOfToken(token, ctx);                       // by hash; not revoked, not expired
	if (link === undefined) return { kind: "error", status: 403, message: "This link has ended." };
	if (ctx.principal?.kind === "user") {                              // signed in: stays themselves
		await addViaLink(link, ctx.principal.id, ctx);                  // people row with max(own right, link right)
		return { kind: "json", value: { session: link.session } };
	}
	const guest = await guests.issue({ link: link.id, name }, ctx);     // kit Sessions, ephemeral kind, guest principal
	return { kind: "json", value: { session: link.session }, headers: { "Set-Cookie": guest.cookie } };
} },
```

What anyone may do in a session is computed from the people list and their principal. One function, used for
views, sends and approvals:

```ts
// plugins/sessions/server.ts
function rightOf(session: SessionRow, principal: P3Principal): "owner" | "send" | "view" | null {
	if (principal.kind === "user") return max(peopleRight(session, principal.id), linkRightsOf(session, principal.id));
	if (principal.kind === "guest") return linkRight(session, principal.link);
	return principal.kind === "worker" && principal.session === session.id ? "send" : null;
}
```

---

# Part C: A third-party plugin that knows nothing about users

`@someone/p3-todos` keeps todo lists and gives the agent tools for them. The author never thought about users,
groups or policies. This is the whole plugin.

```ts
// @someone/p3-todos/contract.ts
import { arr, bool, defineResourceKind, int, method, obj, operation, opt, remote, ResourceRefParam, Server, str }
	from "@p3/app/v1";

const Todo = obj({ id: str(), text: str(), done: bool() });

/** The user's todo lists (the page). */
export const TodoLists = remote("todos.lists", {
	version: 1,
	params: {},
	scope: "user",                                                    // 1. Mine: one per user, written as single-user
	hostAddress: () => Server(),
	variants: {
		user: {
			state: { lists: arr(obj({ id: str(), title: str(), open: int() })) },
			methods: {
				create: method(obj({ title: str() }), str()),
				remove: method(obj({ id: str() })),
			},
		},
	},
});

// 2. May: operations with facts. No policy is imported.
export const CreateList = operation(TodoLists, "create", { facts: () => ({ kind: "create", runsCode: "none", reaches: null }) });
export const RemoveList = operation(TodoLists, "remove", { facts: () => ({ kind: "delete" }) });

/** One list, as a session's agent uses it. */
export const TodoList = remote("todos.list", {
	version: 1,
	params: { resource: ResourceRefParam },
	hostAddress: () => Server(),
	variants: {
		worker: {
			state: { title: str(), todos: arr(Todo) },
			methods: {
				add: method(obj({ text: str() }), str()),
				check: method(obj({ id: str() })),
			},
		},
	},
});

// 3. Sessions: a resource kind. A list can be brought into a session; calls for it are checked against the list.
export const TodoListKind = defineResourceKind("todos.list", { contract: TodoList });
```

```ts
// @someone/p3-todos/server.ts
import { defineFacet, defineTable, query, ResourceKinds } from "@p3/app/v1/server";
import { TodoList, TodoListKind, TodoLists } from "./contract.ts";

const Lists = defineTable("todos.lists", {
	version: 1, scope: "user",
	columns: { id: str(), title: str() }, key: ["id"],
});
const Items = defineTable("todos.items", {
	version: 1, scope: "user",
	columns: { list: str(), id: str(), text: str(), done: bool({ default: false }) },
	key: ["list", "id"],
});

export default defineFacet((host, self) => {
	host.serve(TodoLists, (_params, _principal, inner) => {
		const lists = inner.table(Lists);
		const all = inner.query(lists, query(Lists), 500);
		return {
			variant: "user",
			members: {
				lists: inner.derive([all], ([rows]) => rows.map((r) => ({ id: r.id, title: r.title, open: 0 /* count */ }))),
				create: async ({ title }, ctx) => { const id = newId(); await inner.tx(async (tx) => tx.put(lists, { id, title }), ctx); return id; },
				remove: async ({ id }, ctx) => { await inner.tx(async (tx) => tx.delete(lists, { id }), ctx); return null; },
			},
		};
	});

	host.serve(TodoList, ({ resource }, _principal, inner) => {
		// The platform has checked the ref against the session list and set the scope to its owner.
		const items = inner.table(Items);
		const todos = inner.query(items, query(Items).where((i) => eq(i.list, resource.id)), 500);
		return {
			variant: "worker",
			members: {
				title: /* from Lists */,
				todos: inner.derive([todos], ([rows]) => rows.map(({ id, text, done }) => ({ id, text, done }))),
				add: async ({ text }, ctx) => { const id = newId(); await inner.tx(async (tx) => tx.put(items, { list: resource.id, id, text }), ctx); return id; },
				check: async ({ id }, ctx) => { await inner.tx(async (tx) => tx.update(items, { list: resource.id, id }, () => ({ done: true })), ctx); return null; },
			},
		};
	});

	self.contribute(ResourceKinds, {
		kind: TodoListKind,
		list: async (ctx) => (await lists(ctx)).map((l) => ({ id: l.id, label: l.title, account: null })),
	});
});
```

```ts
// @someone/p3-todos/worker.ts: tools per list on the session's list (the harness keys extensions by resource)
export default defineFacet((_host, self) => {
	self.contribute(ResourceExtensions, {
		kind: TodoListKind,
		extension: (resource, label) => defineExtension({
			name: `todos_${slug(label)}`,
			tools: [
				defineTool({ name: "add", parameters: obj({ text: str() }),
					execute: async ({ text }, ctx) => (await ctx.get(TodoList, { resource })).add({ text }, ctx) }),
				defineTool({ name: "check", parameters: obj({ id: str() }),
					execute: async ({ id }, ctx) => (await ctx.get(TodoList, { resource })).check({ id }, ctx) }),
			],
		}),
	});
});
```

The plugin declares three things and nothing else:

1. **Per-user state:** `scope: "user"` on its two tables and on `TodoLists`. It never names a user.
2. **Operations with facts:** `CreateList` and `RemoveList`. It never imports a policy.
3. **A resource kind:** `TodoListKind`, with `list()` and the `TodoList` contract. It never checks a session.

**For Mario alone:** his lists are in scope `u1`. The default gate allows `create`. His new sessions start with all
his lists.

**For Acme:** Colin's and Cristina's lists are in separate scopes. Neither sees the other's on the Todos page.
Acme's gate applies its generic rules (`create`, runs no code, reaches nothing): allowed. If Colin brings his
"release checklist" into "release", Cristina's agent can add items to it, and the items land in Colin's scope. If
Acme wants "only engineering creates todo lists", its policy adds one rule that imports `CreateList` from the
plugin's contract. The plugin does not change.

---

# Who knows what

| Part | Knows | Does not know |
|---|---|---|
| **Base / kit (Chord)** | principals (`user`, `guest`, `worker`, `server`), sign-in sessions, the Http and Authenticators registries, dispatch with three hooks: scope, gate, list check (guessed) | users' names, groups, admins, policies, sessions' contents |
| **Users core plugin** | users, identities, which Directory provider is active, `SignIn.complete`, `isAdmin` | what any user may do; resources; sessions |
| **Directory provider** (default or `@acme/p3-sso`) | who may join, who is admin, groups (company) | operations, sessions, resources |
| **Sessions core plugin** | per session: the people list and links, the resource list, who brought what; resource kinds by declaration; the list check; `rightOf` | what a resource is or does; groups; policy rules |
| **Gate provider** (default or `@acme/p3-policy`) | principal, operation name, object, args, facts; groups from the directory; optionally plugins' published contracts | plugins' internals, scopes' data |
| **MCP plugin** | server configs and tokens of the scope it runs in; how to connect; the naming rule; its operations' facts; its resource kind | other users' data (cannot reach it), groups, policy, who else is in a session (beyond the list's owner names) |
| **Third-party plugin** | its own state (per user by declaration), its operations' facts, its resource kind | users, groups, policies, sessions |

# Open points

1. **How scopes are enforced** (layer 2): a key prefix the store adds to tables and states declared `scope: "user"`,
   and a scope set on each object by dispatch. Needs a Chord decision. The hard part is server code that is not a
   call: a plugin's background job for a user (refreshing tokens) needs a way to run "in scope u1" that only the
   platform grants.
2. **Instance-wide data a plugin keeps beside user scopes** (MCP's shared servers that admins add, Discord bots):
   an `INSTANCE` scope that only admins write, through gated operations.
3. **Defaults for new sessions:** "my resources" copies the owner's resources at creation. Should resources created
   later join existing sessions, as in the resource-model book's "defaults are a rule"? Recommended: no for shared
   sessions, yes for private ones, as a per-session switch.
4. **Withdrawing on leave:** when a user is disabled, their brought resources should drop out of every list at once
   (`requireOnList` also checks the owner is enabled). Their sessions' ownership stays an admin's choice.
5. **Guests and approvals:** may a `send` user answer the agent's questions and approve risky calls in someone
   else's session? `sharing.md` says approvals stay the owner's.
6. **The fact vocabulary** (`kind`, `runsCode`, `reaches`, `audience`, `right`, `resourceKind`): small and shared.
   Who keeps it, and how it grows without plugins inventing their own.
7. **Location-bound resources** (project stdio servers): the identity is (resource, location). The list holds the
   resource; where it runs follows the conversation. Bringing a project server means bringing it for every location
   the session works in.

# Guessed APIs

These do not exist in `packages/chord` or p3 today:

- **Scopes:** `scope: "user"` on `defineTable`, `defineState` and `remote`; `ctx.scope`.
- **Gates:** `operation(contract, method, { facts })`, `operationOf`, `isOperation`, the `Gate` registry, `allow`/`deny`.
- **Dispatch hooks:** the three hooks themselves (scope, gate, list check); Chord's dispatch has none.
- **Resource kinds:** `defineResourceKind`, the `ResourceKinds` registry, `ResourceRef`/`ResourceRefParam`, and
  `ResourceExtensions` on the worker (the resource-model book's `Extensions` keyed by resource, with a factory per ref).
- **Sessions core:** `SessionPeopleView`, `SessionResourcesView`, `Sessions.create`'s `start` option, the join route,
  guest principals carrying a link.
- **Directory:** `groupsOf` on the Directory provider.
- **Smaller ones:** the MCP plugin's `McpServers`/`McpResource` shapes (adapted from the resource-model book), and
  `mcpNamespace` reused from `@earendil-works/pi-mcp` for the namespace slugs.
