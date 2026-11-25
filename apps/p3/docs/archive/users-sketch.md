# Users, sign-in and directories in p3: a code sketch

Status: sketch for the owner, 2026-11-13. Not decided, not built. It turns the conversation's agreed direction into
signatures, schemas and the key bodies. Bodies left out are comments. API names follow Chord as it is in
`packages/chord/src` (`local`, `remote`, `defineTable`, `defineState`, `defineRegistry`, `defineFacet`, `host.serve`,
`self.table`, `self.tx`, `self.registry`, `self.contribute`, the kit's `Http`, `Authenticators`, `Sessions`). Where the
sketch needs an API that does not exist yet, it says **guessed**.

Contents:

1. The users plugin: data, contracts, the directory registry, the default directory, sign-in.
2. Kit changes.
3. First start, as traces.
4. Example: `@acme/p3-sso`, a company directory with OIDC sign-in and SCIM.
5. Open points.
6. Where this departs from the accounts and resource-model books.

## 1. The users plugin

`users` is a **required core plugin (tier 2)**. It is always present and can be replaced. Its contracts are fixed in
p3's API (`@p3/app/v1/server` and `@p3/app/v1/web`), not in the plugin's own contract file. A replacement must serve
the same contracts, and every other plugin keeps working.

```
plugins/users/
  package.json
  server.ts          Users, SignIn, Me, People, the default directory, the setup/invite/device routes
  page.tsx           the sign-in page, the setup page, Me and People screens
src/api/v1/
  users.ts           contracts and types shared by every facet (re-exported by ./server and ./web)
  users.server.ts    server-only contracts: Users, SignIn, Directory, Recovery
```

### Principal and ids

The principal does not change. It names the user and nothing else.

```ts
// src/api/v1/users.ts
export type UserId = string & { readonly "~user": true };

export type P3Principal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly session: string }
	| { readonly kind: "user"; readonly id: UserId }
	| { readonly kind: "guest" };                         // reserved; sharing is designed elsewhere

export const Profile = obj({ name: str(), email: union([str(), nul()]), avatar: union([str(), nul()]) });
export type Profile = Static<typeof Profile>;

/** An external sign-in: who vouched (`issuer`) and for whom (`subject`). "local" is p3's own (setup, device links). */
export const Identity = obj({ issuer: str(), subject: str() });
export type Identity = Static<typeof Identity>;
export const LOCAL_ISSUER = "local";
```

### Tables

Users and identities live in the users plugin's tables in the server's store. Admin is not a column. Admin comes
from the directory (the default directory stores it in its own state, below).

```ts
// plugins/users/server.ts
const UserRows = defineTable("users.users", {
	version: 1,
	columns: {
		id: str(),
		name: str(),
		email: opt(str()),
		avatar: opt(str()),
		created: int(),
		disabled: bool({ default: false }),
	},
	key: ["id"],
	indexes: { by_created: ["created"] },
});

const IdentityRows = defineTable("users.identities", {
	version: 1,
	columns: { issuer: str(), subject: str(), user: str(), created: int() },
	key: ["issuer", "subject"],
	indexes: { by_user: ["user"] },
});
```

### Users: provisioning for trusted server code

`Users` is a local contract. Local objects never cross a link, so only server code reaches it: routes, other server
objects, and plugins installed on the server. Installing a plugin is trusting it (accounts book, decision 7). Its
methods take no actor user. SCIM, a recovery page or a migration calls them directly. Admin checks belong to the
remote views that people use (`People`, `Me`), not here.

```ts
// src/api/v1/users.server.ts
const UserRow = obj({ id: str(), profile: Profile, created: int(), disabled: bool() });

export const Users = local("p3.users", {
	version: 1,
	params: {},
	members: {
		/** Every user (live; bounded, see the body). */
		list: arr(UserRow),
		get: method(str(), union([UserRow, nul()])),
		byIdentity: method(Identity, union([str(), nul()])),
		identitiesOf: method(str(), arr(obj({ issuer: str(), subject: str(), created: int() }))),
		update: method(obj({ id: str(), profile: Profile })),
		/** A new user, optionally with its first identity. Returns its id. */
		create: method(obj({ profile: Profile, identity: opt(Identity) }), str()),
		/** Ends every sign-in session of the user; sign-in refuses them until `enable`. */
		disable: method(str()),
		enable: method(str()),
		/** Removes the user and their identities; their sessions end. Other plugins' per-user data: open point. */
		delete: method(str()),
		link: method(obj({ user: str(), identity: Identity })),
		unlink: method(Identity),
		/** Whether `user` administers: a live recovery grant, else the directory's answer. Disabled: never. */
		isAdmin: method(str(), bool()),
	},
});
```

```ts
// plugins/users/server.ts
host.serve(Users, (_params, self) => {
	const users = self.table(UserRows);
	const identities = self.table(IdentityRows);
	const directory = self.registry(Directory);
	const grants = self.get(RecoveryGrants, {});           // section 2: admin by machine key, time-limited
	const sessions = self.get(Sessions, {});                // the kit's sign-in sessions
	// A live query needs a limit. 10,000 users is far above a team instance; a company of that size pages instead.
	const list = self.query(users, query(UserRows).orderBy((u) => u.created, "asc"), 10_000);

	const endSessions = async (user: string, ctx: Ctx) => {
		for (const s of sessions.list.value) if (isUserPrincipal(s.principal, user)) await sessions.revoke(s.id, ctx);
	};

	return {
		list: self.derive([list], ([rows]) => rows.map(toUserRow)),
		get: async (id, ctx) => { const row = await users.get({ id }, ctx); return row ? toUserRow(row) : null; },
		byIdentity: async (identity, ctx) => (await identities.get(identity, ctx))?.user ?? null,
		identitiesOf: async (user, ctx) => { /* page of IdentityRows by_user */ },
		update: async ({ id, profile }, ctx) => {
			await self.tx(async (tx) => tx.update(users, { id }, () => fromProfile(profile)), ctx);
			return null;
		},
		create: async ({ profile, identity }, ctx) => {
			const id = newUserId();
			await self.tx(async (tx) => {
				if (identity && (await tx.get(identities, identity))) throw invalid("args", "identity is linked already");
				tx.put(users, { id, ...fromProfile(profile), created: Date.now() });
				if (identity) tx.put(identities, { ...identity, user: id, created: Date.now() });
			}, ctx);
			return id;
		},
		disable: async (id, ctx) => {
			await self.tx(async (tx) => tx.update(users, { id }, () => ({ disabled: true })), ctx);
			await endSessions(id, ctx);
			// Open views end on reconnect today; ending them at once needs the kit to pass `revokedBy` (carry-over).
			return null;
		},
		enable: async (id, ctx) => { /* disabled: false */ },
		delete: async (id, ctx) => {
			await self.tx(async (tx) => {
				tx.delete(users, { id });
				// tx.deleteWhere(identities, by user) once the store has it; else page and delete.
			}, ctx);
			await endSessions(id, ctx);
			return null;
		},
		link: async ({ user, identity }, ctx) => { /* put; refuse an identity linked to someone else */ },
		unlink: async (identity, ctx) => { /* delete; refuse the user's last identity */ },
		isAdmin: async (user, ctx) => {
			const row = await users.get({ id: user }, ctx);
			if (row === undefined || row.disabled) return false;
			return grants.active(user) || directory.value.provider.isAdmin(user as UserId);
		},
	};
});
```

### The directory registry

A directory decides **who may become or stay a user** and **who administers**. Exactly one is active.

```ts
// src/api/v1/users.server.ts
export type SignInHints = {
	/** An invite token the page carried through the sign-in (default directory). */
	readonly invite?: string;
	/** The setup link was used (default directory: only while there are no users). */
	readonly setup?: true;
	/** What the identity provider said about the email, when it says. */
	readonly emailVerified?: boolean;
	/** Groups the identity provider sent with the sign-in (OIDC claim, SAML attribute). */
	readonly groups?: readonly string[];
};

export type AdmitRequest = {
	readonly identity: Identity;
	readonly profile: Profile;
	readonly hints: SignInHints;
	/** The user this identity is linked to already, or null. */
	readonly existing: UserId | null;
};

export type Admission =
	| { readonly kind: "user"; readonly user: UserId }
	| { readonly kind: "create"; readonly profile: Profile; readonly admin: boolean }
	| { readonly kind: "refuse"; readonly reason: string };

export type DirectoryProvider = {
	/** Shown on the People screen ("Managed by Acme SSO"). */
	readonly label: string;
	/** Whether the start script prints a setup link and the sign-in page offers setup. */
	setupMode(): boolean;
	admit(request: AdmitRequest, ctx: Ctx): Promise<Admission>;
	/** A local read: called inside checks and derives. */
	isAdmin(user: UserId): boolean;
	/** After a sign-in was admitted (created or existing): refresh groups, consume an invite. */
	onSignIn?(event: { readonly user: UserId; readonly created: boolean; readonly admission: Admission;
		readonly request: AdmitRequest }, ctx: Ctx): Promise<void>;
	/** Present when people manage admins and invites in p3 (the default directory); absent when the directory does. */
	readonly manage?: DirectoryManagement;
};

export type DirectoryManagement = {
	setAdmin(user: UserId, admin: boolean, ctx: Ctx): Promise<void>;
	invites(): readonly InviteInfo[];
	invite(input: { readonly admin: boolean; readonly label: string; readonly by: UserId }, ctx: Ctx): Promise<{ readonly path: string }>;
	revokeInvite(id: string, ctx: Ctx): Promise<void>;
};

export type ActiveDirectory = { readonly plugin: string; readonly provider: DirectoryProvider };

export const Directory = defineRegistry<DirectoryProvider, ActiveDirectory>("p3.users.directory", { version: 1 });
```

**Which provider is active.** Chord composes a registry from a table sorted by plugin name, with no install order. So
"last installed wins" cannot be expressed, and it would also flip on a reinstall or a restore. The rule is:

- The users plugin's own default directory is active while nobody else contributes.
- Exactly one other contribution replaces it.
- Two or more others are a conflict. It is reported, and the active directory refuses every sign-in until an admin
  names one in the users plugin's setting `directory`. Machine-key recovery (section 2) still works. Falling back to
  the default would be wrong: it could admit people through invites in a company instance.

```ts
// plugins/users/server.ts
const Settings = defineState("users.settings", {
	schema: obj({ directory: union([str(), nul()]) }),
	version: 1,
	initial: () => ({ directory: null }),
	persist: true,
});

// compose is pure over the table; the setting reaches it as a contribution of the users plugin itself (guessed:
// a plugin reading its own state inside compose is not a Chord feature, so the setting is contributed as an entry).
host.serve(Directory, {
	compose: (table, { report }) => {
		const others = table.filter((entry) => entry.plugin !== USERS_PLUGIN);
		const chosen = /* the users plugin's entry carries `settings.directory` */ chosenName(table);
		if (chosen !== null) return pick(table, chosen) ?? refuseAll(`directory ${chosen} is not installed`);
		if (others.length === 0) return pick(table, USERS_PLUGIN)!;
		if (others.length === 1) return others[0]!;
		report({ message: "several directories; name one in the users settings", plugins: others.map((e) => e.plugin) });
		return refuseAll("several directories are installed");
	},
});
```

### The default directory

What a personal or small team install uses:

- **Setup mode** while there are no users. The setup link creates the first user, who is an admin.
- **After that**, a new identity is admitted only with an invite. The invite says whether its user will be an admin.
- **Existing identities** are admitted, as long as the user is not disabled (`SignIn` checks that for every directory).
- **Admins** are kept in its own state.

```ts
// plugins/users/server.ts
const InviteRows = defineTable("users.invites", {
	version: 1,
	columns: { id: str(), tokenHash: str(), admin: bool(), label: str(), expires: int(), createdBy: str(), created: int() },
	key: ["id"],
	indexes: { by_token: ["tokenHash"] },
});
const Admins = defineState("users.admins", {
	schema: obj({ admins: arr(str()) }),
	version: 1,
	initial: () => ({ admins: [] }),
	persist: true,
});
const INVITE_MS = 7 * 24 * 60 * 60_000;

host.serve(DefaultDirectory, (_params, self) => {
	const admins = self.state(Admins);
	const invites = self.table(InviteRows);
	const users = self.get(Users, {});
	const openInvites = self.query(invites, query(InviteRows).orderBy((i) => i.created, "desc"), 1000);
	// Re-set whenever admins or invites change, so the registry recomposes and every derive using isAdmin recomputes.
	const provider = self.writable<DirectoryProvider>(build());
	self.on(admins, () => provider.set(build()));
	self.on(openInvites, () => provider.set(build()));
	self.contribute(Directory, provider);
	return {};

	function build(): DirectoryProvider {
		return {
			label: "This instance",
			setupMode: () => users.list.value.length === 0,
			admit: async ({ identity, profile, hints, existing }, ctx) => {
				if (existing !== null) return { kind: "user", user: existing };
				if (hints.setup && users.list.value.length === 0) return { kind: "create", profile, admin: true };
				if (hints.invite === undefined) return { kind: "refuse", reason: "You need an invite to join." };
				const invite = await findInvite(invites, hints.invite, ctx);          // by hash, not expired
				if (invite === undefined) return { kind: "refuse", reason: "This invite is used up or expired." };
				return { kind: "create", profile, admin: invite.admin };
			},
			isAdmin: (user) => admins.value.admins.includes(user),
			onSignIn: async ({ user, created, admission, request }, ctx) => {
				if (!created || admission.kind !== "create") return;
				await self.tx(async (tx) => {
					if (request.hints.invite !== undefined) deleteInvite(tx, invites, request.hints.invite);
					if (admission.admin) (await tx.draft(admins)).admins.push(user);
				}, ctx);
			},
			manage: {
				setAdmin: async (user, admin, ctx) => { /* change admins; refuse removing the last admin */ },
				invites: () => openInvites.value.map(toInviteInfo),
				invite: async ({ admin, label, by }, ctx) => {
					const token = newToken();
					await self.tx(async (tx) => tx.put(invites, {
						id: newId(), tokenHash: hashToken(token), admin, label, createdBy: by,
						expires: Date.now() + INVITE_MS, created: Date.now(),
					}), ctx);
					return { path: `/users/invite#${token}` };   // the fragment never reaches a log
				},
				revokeInvite: async (id, ctx) => { /* delete */ },
			},
		};
	}
});
```

### SignIn: the one place that turns identities into sessions

Sign-in method plugins verify an external identity (OIDC, SAML, Radius) and call `SignIn.complete`. Nothing else
issues a sign-in session for a user, except recovery (section 2).

```ts
// src/api/v1/users.server.ts
export const SignInResult = union([
	obj({ kind: lit("signed-in"), user: str(), cookie: str() }),
	obj({ kind: lit("refused"), reason: str() }),
]);

export const SignIn = local("p3.users.sign-in", {
	version: 1,
	params: {},
	members: {
		complete: method(
			obj({
				identity: Identity,
				profile: Profile,
				hints: SignInHintsSchema,
				/** The session's label on the devices list ("Acme SSO, Firefox"). */
				label: str(),
				/** A remote origin: the cookie is `Secure`. */
				secure: bool(),
			}),
			SignInResult,
		),
		/** A device session (command-line client) for an already signed-in user: kind "device", returns the token. */
		device: method(obj({ user: str(), label: str() }), obj({ token: str() })),
	},
});
```

```ts
// plugins/users/server.ts
host.serve(SignIn, (_params, self) => {
	const users = self.get(Users, {});
	const directory = self.registry(Directory);
	const sessions = self.get(Sessions, {});
	return {
		complete: async ({ identity, profile, hints, label, secure }, ctx) => {
			const { provider } = directory.value;
			const existing = (await users.byIdentity(identity, ctx)) as UserId | null;
			const request = { identity, profile, hints, existing };
			const admission = await provider.admit(request, ctx);
			if (admission.kind === "refuse") return { kind: "refused", reason: admission.reason };
			let user: UserId;
			let created = false;
			if (admission.kind === "create") {
				user = (await users.create({ profile: admission.profile, identity }, ctx)) as UserId;
				created = true;
			} else {
				user = admission.user;
				// A hard rule no directory changes: a disabled user does not sign in.
				if ((await users.get(user, ctx))?.disabled) return { kind: "refused", reason: "This account is disabled." };
				if (identity.issuer !== LOCAL_ISSUER) await users.update({ id: user, profile }, ctx);  // follows the IdP
			}
			await provider.onSignIn?.({ user, created, admission, request }, ctx);
			const issued = await sessions.issue({ principal: { kind: "user", id: user }, label, kind: "browser", secure }, ctx);
			return { kind: "signed-in", user, cookie: issued.cookie };
		},
		device: async ({ user, label }, ctx) => {
			const issued = await sessions.issue({ principal: { kind: "user", id: user }, label, kind: "device" }, ctx);
			return { token: issued.token };
		},
	};
});
```

### p3's own ways in: setup, invite, device link

These are routes of the users plugin. Each verifies its token, then goes through `SignIn.complete` like any other
sign-in method, so the directory decides. The `local` identities they make have a random subject.

```ts
// plugins/users/server.ts
self.contribute(Http, {
	routes: {
		// The setup link: printed at start while the directory is in setup mode. Valid until used or the next start.
		"POST /users/setup": { public: true, handler: async (request, ctx) => {
			const { token, name } = await readTokenAndName(request);
			if (!setupLink.consume(token)) return { kind: "error", status: 403 };
			return complete(ctx, request, { issuer: LOCAL_ISSUER, subject: newId() }, name, { setup: true }, "setup link");
		} },
		// An invite link of the default directory: the page asks for a name, or starts a sign-in method with the invite
		// in its state, which comes back as hints.invite.
		"POST /users/invite": { public: true, handler: async (request, ctx) => {
			const { token, name } = await readTokenAndName(request);
			return complete(ctx, request, { issuer: LOCAL_ISSUER, subject: newId() }, name, { invite: token }, "invite");
		} },
		// A device link the signed-in user made for themselves (Me.deviceLink). It signs in the same user on another
		// browser through their own local identity, so the directory still decides.
		"POST /users/device": { public: true, handler: async (request, ctx) => {
			const { token } = await readToken(request);
			const pending = deviceLinks.consume(token);                     // { user, subject } or undefined; 10 minutes
			if (pending === undefined) return { kind: "error", status: 403 };
			return complete(ctx, request, { issuer: LOCAL_ISSUER, subject: pending.subject }, null, {}, "device link");
		} },
		"GET /users/status": { public: true, handler: async () => ({
			kind: "json", value: { setup: directory.value.provider.setupMode(), directory: directory.value.provider.label },
		}) },
	},
});
// complete(): calls SignIn.complete; on "signed-in" answers { kind: "json", value: "signed in", headers: { "Set-Cookie" } },
// on "refused" a 403 with the reason.
```

### Me: what a signed-in user sees of themselves

```ts
// src/api/v1/users.ts
const SessionSummary = obj({ id: str(), label: str(), kind: oneOf("browser", "device"), created: num(), lastUsed: num() });

export const Me = remote("p3.users.me", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		user: {
			state: {
				me: obj({ id: str(), profile: Profile, admin: bool() }),
				identities: arr(obj({ issuer: str(), subject: str(), created: num() })),
				devices: arr(SessionSummary),
			},
			methods: {
				rename: method(obj({ name: str() })),
				/** A one-time link (10 minutes) that signs this user in on another browser. */
				deviceLink: method(obj({}), obj({ path: str() })),
				/** Ends one of my sessions (this device or another). */
				revoke: method(obj({ session: str() })),
			},
		},
	},
});
```

```ts
host.serve(Me, (_params, principal, self) => {
	if (principal.kind !== "user") throw forbidden("Me is for users");
	const users = self.get(Users, {});
	const sessions = self.get(Sessions, {});
	const directory = self.registry(Directory);
	const grants = self.get(RecoveryGrants, {});
	const id = principal.id;
	return {
		variant: "user",
		members: {
			me: self.derive([users.list, directory, grants.list], ([all, dir, live]) => {
				const row = all.find((u) => u.id === id);
				return { id, profile: row!.profile, admin: live.some((g) => g.user === id) || dir.provider.isAdmin(id) };
			}),
			identities: /* derive over a live query of IdentityRows by_user = id */,
			devices: self.derive([sessions.list], ([all]) => all.filter((s) => isUserPrincipal(s.principal, id)).map(toSummary)),
			rename: async ({ name }, ctx) => { /* users.update; a directory that owns names may refuse: open */ },
			deviceLink: async (_args, ctx) => {
				const subject = await localSubjectOf(id, ctx);   // the user's local identity; made and linked on first use
				return { path: `/users/device#${deviceLinks.issue({ user: id, subject })}` };
			},
			revoke: async ({ session }, ctx) => {
				const own = sessions.list.value.find((s) => s.id === session && isUserPrincipal(s.principal, id));
				if (own === undefined) throw forbidden("not your session");
				await sessions.revoke(session, ctx);
				return null;
			},
		},
	};
});
```

### People: the admin screen

Only admins get it. Admin methods are available only when the directory lets p3 manage admins and invites
(`manage`). Disabling works under every directory: it is p3's hard rule for its own sessions. A company directory
usually disables users through SCIM.

```ts
// src/api/v1/users.ts
export const People = remote("p3.users.people", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		admin: {
			state: {
				directory: obj({ label: str(), managed: bool() }),   // managed: p3 manages admins and invites
				users: arr(obj({ id: str(), profile: Profile, admin: bool(), disabled: bool(), created: num() })),
				invites: arr(InviteInfoSchema),
			},
			methods: {
				disable: method(obj({ user: str() })),
				enable: method(obj({ user: str() })),
				setAdmin: method(obj({ user: str(), admin: bool() })),
				invite: method(obj({ admin: bool(), label: str() }), obj({ path: str() })),
				revokeInvite: method(obj({ id: str() })),
			},
		},
	},
});
```

```ts
// guessed: an async factory. If factories must be synchronous, the admin check moves into every member and the
// state derives answer empty lists to non-admins.
host.serve(People, async (_params, principal, self) => {
	const users = self.get(Users, {});
	const directory = self.registry(Directory);
	// The factory refuses non-admins. Losing admin while a page holds the view: calls are re-checked below, and the
	// view is made again on the next connection.
	if (principal.kind !== "user" || !(await users.isAdmin(principal.id, BACKGROUND_CONTEXT /* guessed: factory ctx */)))
		throw forbidden("admins only");
	const actor = principal.id;
	const requireAdmin = async (ctx: Ctx) => { if (!(await users.isAdmin(actor, ctx))) throw forbidden("admins only"); };
	const manage = () => directory.value.provider.manage ?? fail("managed by " + directory.value.provider.label);
	return {
		variant: "admin",
		members: {
			directory: self.derive([directory], ([d]) => ({ label: d.provider.label, managed: d.provider.manage !== undefined })),
			users: self.derive([users.list, directory], ([all, d]) => all.map((u) => ({ ...u, admin: d.provider.isAdmin(u.id as UserId) }))),
			invites: self.derive([directory], ([d]) => d.provider.manage?.invites() ?? []),
			disable: async ({ user }, ctx) => { await requireAdmin(ctx); if (user === actor) throw invalid("args", "not yourself"); return users.disable(user, ctx); },
			enable: async ({ user }, ctx) => { await requireAdmin(ctx); return users.enable(user, ctx); },
			setAdmin: async ({ user, admin }, ctx) => { await requireAdmin(ctx); await manage().setAdmin(user as UserId, admin, ctx); return null; },
			invite: async ({ admin, label }, ctx) => { await requireAdmin(ctx); return manage().invite({ admin, label, by: actor }, ctx); },
			revokeInvite: async ({ id }, ctx) => { await requireAdmin(ctx); await manage().revokeInvite(id, ctx); return null; },
		},
	};
});
```

**Admin checks elsewhere.** Every p3 object that asks "is this user an admin" calls `Users.isAdmin` at the moment
something happens. Pages read `Me.me.admin`. Other decisions (who may create, bring or use a resource) live in the
general `Policies` registry of the resource-model book. It is not designed here; it gets its "administer" baseline
from `Users.isAdmin`.

### The sign-in page

The sign-in page belongs to the users plugin's page facet. Sign-in methods add buttons to a page registry.

```ts
// src/api/v1/users.ts (page side, re-exported by @p3/app/v1/web)
/** A way to sign in: its label and the route that starts it. Ordered by plugin name. */
export type SignInMethod = { readonly name: string; readonly label: string; readonly start: string };
export const SignInMethods = defineRegistry<SignInMethod, readonly SignInMethod[]>("p3.users.sign-in-methods", { version: 1 });
```

```tsx
// plugins/users/page.tsx
export default defineFacet((host, self) => {
	host.serve(SignInMethods, { compose: (table) => table.map((entry) => entry.value) });
	// guessed: p3's page route registry is base piece 11, not designed yet
	self.contribute(PageRoutes, { "/sign-in": SignInPage, "/users/setup": SetupPage, "/users/invite": InvitePage,
		"/users/device": DevicePage, "/me": MePage, "/people": PeoplePage });
});

function SignInPage() {
	const methods = useRegistry(SignInMethods) ?? [];
	const status = usePublicJson<{ setup: boolean }>("/users/status");     // the page is public: no objects before sign-in
	// One button per method, `href = method.start` (+ `?invite=<token>` when the page came from an invite).
	// While status.setup: a note "Use the setup link printed by the server".
}
```

## 2. Kit changes

The kit (`packages/chord/src/node/app`) assumes one owner today. These changes make it ask the app instead.

1. **Drop `principal.owner`** from `AppOptions`, and with it `AppInfo.owner`, `ownerLink()`, the owner token file
   and `ownerFacet`. The kit no longer knows who the owner is.
2. **Admin questions go to the app.** The kit has two owner-only actions: approving a pairing and making a kit
   invite. A new kit registry answers them:
   ```ts
   // packages/chord/src/node/app/admins.ts (new)
   export type AdminCheck = (principal: Principal, ctx: Ctx) => Promise<boolean>;
   export const AdminChecks = defineRegistry<AdminCheck, AdminCheck>("chord.app.admins", { version: 1 });
   ```
   p3's users plugin contributes `(p, ctx) => p.kind === "user" && users.isAdmin(p.id, ctx)`. Without a contribution
   the answer is false.
3. **Pairing signs in the approver.** Any signed-in principal approves a pairing for itself. The new device session
   is for that principal, not for a fixed owner. p3 does not use the kit's invite facet; the default directory's
   invites replace it.
4. **The machine key becomes the recovery credential.** The kit keeps a private key in the data directory (as p2's
   `owner-key`) and serves recovery. It is **always on** and cannot be disabled by any plugin: holding the data
   folder means owning everything anyway.
   ```ts
   // packages/chord/src/node/app/recovery.ts (new)
   // POST /_chord/recover/challenge  (local provenance only)          -> { challenge }
   // POST /_chord/recover/claim      { challenge, proof: HMAC(key, port, challenge) } -> { path: "/_chord/recover#<token>" }
   // GET  /_chord/recover             the page: lists the app's candidates, or "create an admin" when there are none
   // POST /_chord/recover            { token, choice } -> a browser session for the chosen principal
   export type RecoveryProvider = {
   	candidates(ctx: Ctx): Promise<readonly { readonly id: string; readonly label: string }[]>;
   	/** Signs in `choice` (an existing user, or a new admin named `name`); returns the principal to issue for. */
   	recover(choice: { readonly user: string } | { readonly create: string }, ctx: Ctx): Promise<Principal>;
   };
   export const Recovery = defineRegistry<RecoveryProvider, RecoveryProvider | undefined>("chord.app.recovery", { version: 1 });
   ```
   The start script's `p3 recover` command proves the key the way p2's `npm run owner-link` does and prints the link.
   p3's users plugin contributes the provider. `recover` records a **recovery grant** (`RecoveryGrants`: user,
   session id, expiry of 24 hours) and bypasses the directory. `Users.isAdmin` honors a live grant, so recovery works
   even when a company directory would say "not an admin". Every recovery is logged and shown on the People screen.
5. **Start notices.** The kit prints what plugins ask it to print at start, instead of the owner link
   (**guessed** shape: a registry `chord.app.start-notices` of `() => string | undefined`). The users plugin
   contributes the setup link while `setupMode()` is true. A company directory has no setup mode, so nothing is
   printed.
6. **Local command-line clients** (the old owner token file) use recovery's challenge, choose a user once, and keep
   a device session token in their own 0600 config.

## 3. First start, as traces

### Personal install

1. `p3` starts. The kit opens the store and loads the root plugins, `users` among them. `Directory` composes to the
   default directory. `UserRows` is empty, so `setupMode()` is true.
2. The users plugin makes a setup token (in memory, single use, replaced at each start) and contributes a start
   notice. The terminal prints `Open http://127.0.0.1:8789/users/setup#<token>`.
3. Mario opens it and types his name. The page posts `{ token, name }` to `POST /users/setup`.
4. `SignIn.complete({ identity: { issuer: "local", subject: s1 }, hints: { setup: true } })`. `admit` returns
   `create, admin: true`. `Users.create` adds `u1` with identity `local/s1`. `onSignIn` adds `u1` to `Admins`.
   `Sessions.issue` returns the cookie. Mario is in.
5. **His phone:** Me, "Sign in another device", `Me.deviceLink()` gives `/users/device#<token>` (shown as a QR code).
   The phone posts it to `POST /users/device`. `SignIn.complete(local/s1)`: `existing` is `u1`, so `admit` returns
   `user u1`. The phone gets its own session, listed under Me, devices.
6. **Ada:** People, "Invite", `People.invite({ admin: false, label: "Ada" })` gives `/users/invite#<t>`. Mario
   sends it. Ada opens it and either types a name (a local identity) or taps "Sign in with Radius". The Radius
   plugin carries the invite in its OAuth state, then calls
   `SignIn.complete({ issuer: "radius", subject: "usr_42", hints: { invite: t } })`. `admit` finds the invite and
   returns `create, admin: false`. `onSignIn` deletes the invite. Ada is `u2`.
7. **Sign in with Radius later:** Ada taps the button again. `byIdentity(radius/usr_42)` is `u2`, and `admit`
   returns `user u2`. A stranger with a Radius account has no invite, so `admit` refuses: "You need an invite to join."
8. **Mario loses every device:** on the machine he runs `p3 recover`, opens the link and picks `u1`. He gets a
   session and a 24-hour recovery grant.

### Company install

1. IT provisions the machine with `@acme/p3-sso` installed and its settings and secrets set before the first start
   (or installs it through recovery, step 5).
2. `p3` starts. `Directory` composes to `@acme/p3-sso`. `setupMode()` is false, so no setup link is printed.
   The sign-in page shows "Sign in with Acme".
3. Cristina, in the groups `p3-users` and `p3-admins`, signs in.
   `SignIn.complete({ issuer: "https://login.acme.com", subject: "00u1ab", hints: { groups } })`. `admit` returns
   `create, admin: true` (admin comes from the group, not from being first). She is `u1`.
4. Colin is in `p3-users` only and becomes a member. Bob is in neither group and is refused. The IdP's SCIM client
   creates users ahead of sign-in and disables them when they leave (section 4).
5. **The IdP is down, or a group was misconfigured:** an operator on the machine runs `p3 recover`, then chooses an
   existing user or creates a local admin. The recovery grant gives admin for 24 hours whatever Acme says.
6. **A personal install moving to Acme:** Mario's `u1` has only `local/s1`. After the plugin is installed, Acme's
   `admit` refuses local identities of users it does not know. How `u1` gets linked is open (section 5).

## 4. Example: `@acme/p3-sso`

A directory backed by Acme's identity provider, an OIDC sign-in method, and SCIM provisioning, in one plugin.

```
~/.p3/plugins/acme-p3-sso/
  package.json       { "name": "@acme/p3-sso", "p3": { "server": "server.ts", "web": "page.tsx" } }
  contract.ts        the plugin's own settings view (admin only)
  oidc.ts            discovery, PKCE, code exchange, ID token verification (left out: a vetted OIDC library)
  scim.ts            SCIM 2.0 resource shapes and PATCH parsing (left out)
  server.ts          the directory, the OIDC routes, the SCIM routes, settings
  page.tsx           the sign-in button and the settings panel
```

### Settings and secrets

The issuer URL and the client id are settings. The client secret and the SCIM token are secrets. p3's secrets and
plugin settings are base piece 13 and not designed yet; the shape below is **guessed**.

```ts
// contract.ts
export const AcmeConfig = obj({
	issuer: str(),                                   // "https://login.acme.com"
	clientId: str(),
	allowedGroups: arr(str()),                       // ["p3-users", "p3-admins"]
	adminGroup: str(),                               // "p3-admins"
	deviceLinks: bool(),                             // members may sign in other browsers with device links
	deleteMeans: oneOf("delete", "disable"),         // what SCIM DELETE does
});

export const AcmeSettings = remote("acme.sso.settings", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		admin: {
			state: { config: AcmeConfig, secrets: obj({ clientSecret: bool(), scimToken: bool() }) },   // set or not, never values
			methods: {
				configure: method(AcmeConfig),
				setClientSecret: method(str()),
				rotateScimToken: method(obj({}), obj({ token: str() })),   // shown once
			},
		},
	},
});
```

### Server facet

```ts
// server.ts
import {
	defineFacet, defineState, defineTable, Directory, forbidden, Http, json, query, Secrets /* guessed */,
	SignIn, Users, type DirectoryProvider, type UserId,
} from "@p3/app/v1/server";
import { AcmeConfig, AcmeSettings } from "./contract.ts";
import { authorizationUrl, exchangeCode, verifyIdToken } from "./oidc.ts";
import { parsePatch, scimError, toScimUser } from "./scim.ts";

const PLUGIN = "@acme/p3-sso";

/** What Acme says about each person: from SCIM, refreshed at each sign-in. Keyed by Acme's subject. */
const Members = defineTable("acme.members", {
	version: 1,
	columns: {
		subject: str(),
		user: str(),
		groups: json(arr(str()), { version: 1 }),
		active: bool(),
		updated: int(),
	},
	key: ["subject"],
	indexes: { by_user: ["user"] },
});

const Config = defineState("acme.config", {
	schema: AcmeConfig,
	version: 1,
	initial: () => ({ issuer: "", clientId: "", allowedGroups: [], adminGroup: "p3-admins", deviceLinks: true, deleteMeans: "disable" }),
	persist: true,
});

const AcmeDirectory = local("acme.sso.directory", { version: 1, params: {}, members: {} });

export default defineFacet((host, self) => {
	host.serve(AcmeDirectory, (_params, inner) => {
		const config = inner.state(Config);
		const members = inner.table(Members);
		const all = inner.query(members, query(Members), 10_000);
		const users = inner.get(Users, {});
		const byUser = () => new Map(all.value.map((m) => [m.user, m]));

		const provider = inner.writable<DirectoryProvider>(build());
		inner.on(all, () => provider.set(build()));
		inner.on(config, () => provider.set(build()));
		inner.contribute(Directory, provider);
		return {};

		function build(): DirectoryProvider {
			const c = config.value;
			const index = byUser();
			return {
				label: "Acme SSO",
				setupMode: () => false,
				admit: async ({ identity, profile, hints, existing }, ctx) => {
					// Device links: the user's own local identity, only for active members Acme already knows.
					if (identity.issuer === "local") {
						const member = existing === null ? undefined : index.get(existing);
						return c.deviceLinks && member?.active
							? { kind: "user", user: existing! }
							: { kind: "refuse", reason: "Sign in with Acme." };
					}
					if (identity.issuer !== c.issuer) return { kind: "refuse", reason: "Sign in with Acme." };
					const known = await members.get({ subject: identity.subject }, ctx);
					if (known && !known.active) return { kind: "refuse", reason: "Your Acme account is not active." };
					const groups = hints.groups ?? known?.groups ?? [];
					if (!groups.some((g) => c.allowedGroups.includes(g)))
						return { kind: "refuse", reason: "Ask IT for access to p3." };
					// SCIM may have created the user already; the identity is linked to it, so existing is set.
					if (existing !== null) return { kind: "user", user: existing };
					return { kind: "create", profile, admin: groups.includes(c.adminGroup) };
				},
				isAdmin: (user) => index.get(user)?.groups.includes(c.adminGroup) ?? false,
				onSignIn: async ({ user, request }, ctx) => {
					if (request.identity.issuer !== c.issuer) return;
					await inner.tx(async (tx) => tx.put(members, {
						subject: request.identity.subject, user,
						groups: [...(request.hints.groups ?? [])], active: true, updated: Date.now(),
					}), ctx);
				},
				// no `manage`: admins and invites are managed in Acme's IdP, not in p3
			};
		}
	});

	// --- OIDC sign-in ---
	// Pending sign-ins live in memory (state, PKCE verifier, nonce, an optional invite): a restart drops them.
	const pending = new Map<string, { verifier: string; nonce: string; expires: number }>();

	self.contribute(Http, {
		routes: {
			"GET /acme/start": { public: true, page: true, handler: async (request, ctx) => {
				const config = await readConfig(ctx);
				const state = newToken();
				const { url, verifier, nonce } = await authorizationUrl({
					issuer: config.issuer, clientId: config.clientId,
					redirectUri: `${request.origin}/acme/callback`, state, scope: "openid profile email groups",
				});
				pending.set(state, { verifier, nonce, expires: Date.now() + 10 * 60_000 });
				return { kind: "redirect", to: url };
			} },
			"GET /acme/callback": { public: true, page: true, handler: async (request, ctx) => {
				const state = request.query.get("state") ?? "";
				const flow = pending.get(state);
				pending.delete(state);
				if (flow === undefined || flow.expires < Date.now()) return { kind: "redirect", to: "/sign-in?error=expired" };
				const config = await readConfig(ctx);
				const secret = await (await ctx.get(Secrets, { plugin: PLUGIN })).get("clientSecret", ctx);   // guessed
				// Code for tokens at the token endpoint (client secret, PKCE verifier), then the ID token checked:
				// signature against the issuer's JWKS, iss, aud = clientId, exp, nonce.
				const tokens = await exchangeCode({ config, secret, code: request.query.get("code") ?? "",
					verifier: flow.verifier, redirectUri: `${request.origin}/acme/callback` });
				const claims = await verifyIdToken(tokens.idToken, { config, nonce: flow.nonce });
				const signIn = await ctx.get(SignIn, {});
				const result = await signIn.complete({
					identity: { issuer: config.issuer, subject: claims.sub },
					profile: { name: claims.name ?? claims.email ?? claims.sub, email: claims.email ?? null, avatar: claims.picture ?? null },
					hints: { groups: claims.groups ?? [], emailVerified: claims.email_verified === true },
					label: "Acme SSO",
					secure: request.provenance.kind !== "local",
				}, ctx);
				if (result.kind === "refused") return { kind: "redirect", to: `/sign-in?error=${encodeURIComponent(result.reason)}` };
				return { kind: "redirect", to: "/", headers: { "Set-Cookie": result.cookie } };
			} },

			// --- SCIM 2.0: the IdP's provisioning client, server to server, with a bearer token ---
			"POST /scim/v2/Users": { crossSite: true, handler: async (request, ctx) => {
				if (!(await scimAuthorized(request, ctx))) return scimError(401);
				const body = await request.json() as ScimUser;         // a trust boundary: validated in scim.ts
				const config = await readConfig(ctx);
				const users = await ctx.get(Users, {});
				// The IdP is configured to send the OIDC subject as externalId, so sign-in later finds this user.
				const identity = { issuer: config.issuer, subject: body.externalId };
				const user = (await users.byIdentity(identity, ctx))
					?? await users.create({ profile: scimProfile(body), identity }, ctx);
				await putMember(ctx, { subject: body.externalId, user, groups: body.groups ?? [], active: body.active !== false });
				if (body.active === false) await users.disable(user, ctx);
				return { kind: "json", status: 201, value: toScimUser(user, body) };
			} },
			"PATCH /scim/v2/Users/:id": { crossSite: true, handler: async (request, ctx) => {
				if (!(await scimAuthorized(request, ctx))) return scimError(401);
				const users = await ctx.get(Users, {});
				const id = request.params.id!;
				const change = parsePatch(await request.json());       // { active?, profile?, groups? }
				if (change.active === false) await users.disable(id, ctx);
				if (change.active === true) await users.enable(id, ctx);
				if (change.profile) await users.update({ id, profile: change.profile }, ctx);
				await updateMember(ctx, id, change);                   // active and groups, so admit and isAdmin follow
				return { kind: "json", value: toScimUser(id, change) };
			} },
			"DELETE /scim/v2/Users/:id": { crossSite: true, handler: async (request, ctx) => {
				if (!(await scimAuthorized(request, ctx))) return scimError(401);
				const users = await ctx.get(Users, {});
				const config = await readConfig(ctx);
				if (config.deleteMeans === "delete") await users.delete(request.params.id!, ctx);
				else await users.disable(request.params.id!, ctx);
				await deactivateMember(ctx, request.params.id!);
				return { kind: "json", status: 204, value: null };
			} },
			// GET /scim/v2/Users?filter=..., /scim/v2/Groups (POST/PATCH members): the same pattern, updating Members.groups.
		},
	});

	// The settings view: admins only, checked through Users.isAdmin at the factory and at each call.
	host.serve(AcmeSettings, async (_params, principal, inner) => { /* config state, secret setters */ });
});

/** The SCIM bearer token against the stored one, compared by hash in constant time. */
async function scimAuthorized(request: HttpRequest, ctx: Ctx): Promise<boolean> {
	const presented = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
	const stored = await (await ctx.get(Secrets, { plugin: PLUGIN })).get("scimToken", ctx);   // guessed
	return stored !== undefined && matchesHash(presented, hashToken(stored));
}
```

### Page facet

```tsx
// page.tsx
import { defineFacet, SignInMethods, SettingsPanels /* guessed */ } from "@p3/app/v1/web";
import { AcmeSettings } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(SignInMethods, { name: "acme", label: "Sign in with Acme", start: "/acme/start" });
	self.contribute(SettingsPanels, { id: "acme-sso", label: "Acme SSO", component: AcmeSettingsPanel });
});

function AcmeSettingsPanel() {
	// useHold(AcmeSettings, {}): issuer, client id, groups, device links, delete mode; "Set client secret";
	// "Rotate SCIM token" shows the new token once. Non-admins get no variant and see nothing.
}
```

## 5. Open points

1. **The kit's owner option.** Removing `principal.owner` touches every kit app (p3, examples, tests). Either the
   kit keeps `owner` as an optional shortcut for single-user apps and gains `AdminChecks` beside it, or every app
   moves to the registry. Recommended: the registry only; a single-user app contributes `() => true` for its one
   principal.
2. **Moving a personal install to a company directory.** Mario's `u1` has only a local identity. On his first Acme
   sign-in there are two ways to link it to `u1` instead of making `u2`: automatically when Acme's ID token says the
   email is verified and matches `u1`'s email, or only after an admin approves. Recommended: admin approval by
   default, with automatic matching as a directory setting. Emails are never identities by themselves.
3. **Whether the first user links an external identity.** The setup link makes a local identity only. The setup page
   could offer "also link Sign in with Radius" so that losing every device does not need `p3 recover`. Recommended:
   offer it, but do not require it.
4. **Guests.** `{ kind: "guest" }` stays reserved. A share link could become a directory admission (a guest is
   "admitted for one session") or stay outside users entirely. This waits for the sharing decisions (`sharing.md`).
5. **Per-user data on delete.** `Users.delete` removes the user and identities. Other plugins keep data keyed by user
   id. They need a signal (an event on `Users`, or following `list`) and a rule: drop it, or keep it for an admin to
   reassign.
6. **Directory names in profiles.** With Acme, profiles follow the IdP at each sign-in. `Me.rename` should then be
   refused or overwritten at the next sign-in; the directory could say which.

## 6. Where this departs from the books

- **Accounts book (chapter "Identity").**
  - Its `p3.users` and `p3.identities` tables stay, with `disabled` added.
  - `Users.create` gated by "the instance's policy" becomes `Directory.admit`.
  - `Users.signIn` returning a cookie becomes `SignIn.complete`, which runs the directory first.
  - Admin comes from the directory, not from the `acl` plugin's roles.
  - The per-call MCP account envelope is not needed: one resource, one login.
- **Resource-model book (chapter "Users").**
  - It builds on the kit's `defineUsers`. This sketch uses its own tables: it needs `disabled`, `created`, indexed
    lookups and one transaction with identities, which a state document with profiles cannot give.
  - Its `Facts` (admins, disabled) split: disabled moves to the users table, admins move to the directory.
  - "The first user administers" becomes the default directory's setup mode. A company directory says who
    administers.
  - `Identities.signIn` and `setAdmin(actor, ...)` become `SignIn.complete` and actor-free `Users` methods for
    trusted code, with admin checks in the remote views.
  - Sign-in plugins no longer issue sessions themselves.
  - `INSTANCE` is not part of users; the resources plugin keeps it if it needs it.
- **Base inventory.** Users and identity become a tier 2 required core plugin, with contracts in p3's API. The
  inventory had no such piece.
- **Kit.**
  - The fixed owner goes.
  - The owner link becomes the setup link (a start notice) plus per-user device links.
  - The owner token file becomes recovery and device sessions.
  - The machine key becomes recovery, which no plugin can disable.
