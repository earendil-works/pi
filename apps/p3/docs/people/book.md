---
title: p3 people: one owner, persons with roles in apps
cover: Owner / Persons / Roles
kicker: A design note · p3 · 2026-11-13
subtitle: The additions to Chord's app kit and p3's base, and one app in full
stats:
  - 0 | changes to Chord's core
  - 3 | changes to the app kit
  - 1 | kind of person besides the owner
  - 2 | open questions on third-party contributions
note: |
  The owner's direction of 2026-11-13 (evening), replacing the per-app user pools and `self.choose` of the apps note
  (`apps/book.md`, second edition): rights live in the principal, as p2's guests. Every code block is PROPOSED. Chord
  and kit names used as they exist: `local`, `remote`, `host.serve`, `self.get`, `self.contribute`, `defineRegistry`,
  `defineTable`, `defineFacet`, `forbidden`; the kit's `SignIns` (`issue`, `verify`, `revoke`), `Authenticators`,
  pairing (`src/node/app/sign-ins.ts`, `pairing.ts`, `src/node/http/authenticate.ts`).
colophon: p3 people · design note, first edition · 2026-11-13
---

# The Model {.preface}

One Pi, one owner, who installs every plugin; plugins (apps among them) are trusted. Everyone else is a **person**:
someone the owner lets in, who proves who they are once per device. What a person may do is in their principal:

```ts
// PROPOSED · @p3/v1
export type P3Principal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly session: string }
	| { readonly kind: "owner" }
	| {
			readonly kind: "person";
			readonly id: string;                                            // stable across devices and apps
			readonly name: string;
			readonly roles: Readonly<Record<string, string>>;               // app id → role: { family: "member", club: "coach" }
			readonly sessions: Readonly<Record<string, "read" | "write">>;  // single shared sessions (p2's guests)
			readonly revision: number;                                      // in the principal key: a change ends the old objects
	  };
```

:::findings
1. **Factories decide from the principal, synchronously**, as Chord requires: `roles.club === "coach"`.
2. **A change of rights** (invite, role, a shared session, removal) bumps the revision and revokes: the person's
   objects end, their devices reconnect as the new principal. Rare changes; a short reconnect is accepted.
3. **Every object serves only the principals it knows.** Owner-only objects (terminals, mail, settings) refuse persons
   whatever pane they open.
4. **One session check:** the owner always; a person if the session is in `sessions`, or if the session's app says so.
5. **Identity is pluggable:** Radius (a verified email) and this device (a cookie or a terminal token) ship by default.
:::

# What the App Kit Adds {#kit lede="Three changes; Chord's core is untouched."}

**1. Sign-ins name a subject, the app resolves the current principal.** Today `SignIns.issue({ principal })` stores a
snapshot; a person whose role changes would sign in as the old one. The change: a sign-in stores what the app gives it
(a subject), and the app resolves the principal at every use.

```ts
// PROPOSED · kit: startServer option and SignIns
startServer<P>({
	// …
	signIns: {
		/** The current principal of a subject, or null (removed). Called by the kit's authenticator at every request and link. */
		resolve: (subject: JsonValue, ctx: Ctx) => Promise<P | null>,
	},
});
// SignIns.issue({ subject, label, kind, secure? }) → { id, token, cookie }   (was: principal)
// SignIns.verify(token) → P | null                                          (resolved through `resolve`)
// The owner's sign-ins keep working: their subject is { owner: true }, resolved to `principal.owner`.
```

**2. Revocation reachable from plugins.** `host.revoke` exists, but the kit passes no `revokedBy` and no plugin can
call it.

```ts
// PROPOSED · kit
startServer<P>({ /* … */ revokedBy: (p: P) => (p.kind === "person" ? [{ person: p.id }] : []) });
/** Server-local: revokes on the server and propagates to every worker (Chord's `revoke` message on route links). */
export const Revocations = local("chord.app.revocations", { version: 1, params: {}, members: { revoke: method(unknown()) } });
```

**3. Pairing for any subject.** Today pairing signs a new device in as the owner only. The change: a signed-in
principal confirms a pairing code for *its own* subject, so a person adds her laptop from her phone, and a terminal
client signs in with the same code flow.

```ts
// PROPOSED · kit: pairingFacet(pairings, { subjectOf: (principal) => JsonValue | undefined })
// POST /_chord/pair (public) → code + poll secret;  the signed-in person confirms the code on /_chord/pair/:code;
// the device's poll gets a device sign-in for that person's subject (a terminal stores it as its token file).
```

# What p3's Base Adds {#base lede="Plugins of p3's required root: people, identity providers, apps, the session check."}

**People** (server): persons, identities and invites in its tables; the owner's admin object; the resolver.

```ts
// PROPOSED · plugins/people
const Persons = defineTable("people.persons", { version: 1,
	columns: { id: str(), name: str(), roles: json(map(str())), sessions: json(map(oneOf("read", "write"))), revision: int() },
	key: ["id"] });
const Identities = defineTable("people.identities", { version: 1,
	columns: { provider: str(), subject: str(), person: str() }, key: ["provider", "subject"] });

export const People = remote("people.admin", { version: 1, params: {}, hostAddress: () => Server(),
	variants: { owner: {
		state: { persons: arr(PersonSchema), invites: arr(InviteSchema) },
		methods: {
			invite: method(obj({ name: str(), roles: map(str()), sessions: map(oneOf("read", "write")) }), obj({ url: str() })),
			grant: method(obj({ person: str(), roles: opt(map(nullable(str()))), sessions: opt(map(nullable(oneOf("read", "write")))) })),
			remove: method(obj({ person: str() })),
		},
	} } });
// grant/remove: write the row with revision + 1, then Revocations.revoke({ person }); roles are checked against the
// roles the app declared in `Apps` (a trust boundary: the owner's page).
// The kit's `signIns.resolve` reads Persons by the sign-in's subject { person: id }.
```

**Identity providers** (registries People owns, one plugin per provider, with up to three facets):

```ts
// PROPOSED · server: verify; web: a button or form on the join page; tui: a flow in the terminal client
export type IdentityProvider = {
	readonly id: string;
	start(request: HttpRequest, invite: InviteRef, ctx: Ctx): Promise<HttpResponse>;
	finish(request: HttpRequest, ctx: Ctx): Promise<{ subject: string; name?: string } | undefined>;
};
export const IdentityProviders = defineRegistry<IdentityProvider, ProviderTable>("people.identity-providers", { version: 1 });
export const SignInOptions = defineRegistry<SignInOption, readonly SignInOption[]>("people.sign-in-options", { version: 1 });   // web
export const TuiSignIns = defineRegistry<TuiSignIn, readonly TuiSignIn[]>("people.tui-sign-ins", { version: 1 });             // tui
// Built in: `radius` (while connected: the email Radius verified; Google or GitHub happen at Radius) and `device`
// (a cookie in this browser, a token file in this terminal; more devices through pairing).
```

**Apps** (server registry) and **the session check**:

```ts
// PROPOSED · plugins/apps
export function defineApp<const R extends readonly string[]>(id: string, shape: { roles: R }): {
	readonly id: string;
	readonly roles: R;
	/** The person's role in this app, typed; undefined for anyone else (the owner included: apps decide for him). */
	roleOf(principal: P3Principal): R[number] | undefined;
};
export type AppContribution = {
	readonly id: string;
	readonly title: string;
	readonly roles: readonly string[];
	readonly layout: (principal: P3Principal) => Layout;
	readonly access: (principal: P3Principal, session: SessionFacts) => Access;   // synchronous: the principal has the roles
};
export const Apps = defineRegistry<AppContribution, AppTable>("p3.apps", { version: 1 });

// plugins/sessions: facts fixed at creation, in memory on the server; one check for every session view and object
export type SessionFacts = {
	readonly id: string;
	readonly app: string;
	readonly creator: { readonly kind: "owner" } | { readonly kind: "person"; readonly id: string };
};
export function access(p: P3Principal, s: SessionFacts, apps: AppTable): Access {
	if (p.kind === "owner" || p.kind === "server") return ALL;
	if (p.kind === "worker") return p.session === s.id ? ALL : NONE;     // cross-session tools check their own rules
	if (Object.hasOwn(p.sessions, s.id)) return { see: true, send: p.sessions[s.id] === "write" };
	return apps.get(s.app)?.access(p, s) ?? NONE;
}
// Synchronous, so it runs where Chord decides: the session worker's route `authorize`, factories, methods, HTTP.
```

# One App in Full: the Football Club {#club lede="Roles coach and player, a roster only coaches change, match sessions everyone joins."}

```ts
// PROPOSED · plugins/club/contract.ts
export const Club = defineApp("club", { roles: ["coach", "player"] as const });

export const Player = obj({ id: str(), name: str(), position: str() });
/** The roster as a person of the club sees it: coaches change it, players read it. */
export const Roster = remote("club.roster", { version: 1, params: {}, hostAddress: () => Server(),
	variants: {
		coach: { state: { players: arr(Player) }, methods: { put: method(Player), remove: method(obj({ id: str() })) } },
		player: { state: { players: arr(Player) } },
	} });
/** The club's match sessions: everyone in the club sees them; coaches open new ones. */
export const Matches = remote("club.matches", { version: 1, params: {}, hostAddress: () => Server(),
	variants: {
		coach: { state: { sessions: arr(str()) }, methods: { open: method(obj({ title: str() }), str()) } },
		player: { state: { sessions: arr(str()) } },
	} });
```

```ts
// PROPOSED · plugins/club/server.ts
const Players = defineTable("club.players", { version: 1, columns: { id: str(), name: str(), position: str() }, key: ["id"] });

/** The club's store (host lifetime): its tables, its match sessions, its app entry. */
const ClubStore = local("club.store", { version: 1, params: {}, members: {
	players: arr(Player), sessions: arr(str()),
	put: method(Player), remove: method(obj({ id: str() })), open: method(obj({ title: str() }), str()),
} });

export default defineFacet((host) => {
	host.serve(ClubStore, (_params, self) => {
		const players = self.table(Players);
		const all = self.query(players, query(Players), 100);           // a live query: the roster, kept current
		const sessions = self.get(Sessions, {});
		const mine = self.derive([sessions.byApp.at(Club.id)], ([ids]) => ids);
		self.contribute(Apps, {
			id: Club.id,
			title: "Football club",
			roles: Club.roles,
			layout: (p) => [{ kind: "club.home" }],
			// every person of the club sees and talks in its match sessions; nobody else
			access: (p, _session) => (Club.roleOf(p) === undefined ? NONE : ALL),
		});
		return {
			players: all,
			sessions: mine,
			put: (player, ctx) => self.tx(async (tx) => tx.put(players, player), ctx),
			remove: ({ id }, ctx) => self.tx(async (tx) => tx.delete(players, { id }), ctx),
			open: async ({ title }, ctx) => (await sessions.create({ app: Club.id, title }, ctx)).id,
		};
	});
	/** The owner counts as a coach; persons by their club role; anyone else is refused. */
	const roleOf = (principal: P3Principal) => {
		const role = principal.kind === "owner" ? "coach" : Club.roleOf(principal);
		if (role === undefined) throw forbidden("Club members only.");
		return role;
	};
	host.serve(Roster, (_params, principal, self) => {
		const store = self.get(ClubStore, {});
		return roleOf(principal) === "coach"
			? { variant: "coach", members: { players: store.players, put: (p, ctx) => store.put(p, ctx), remove: (a, ctx) => store.remove(a, ctx) } }
			: { variant: "player", members: { players: store.players } };
	});
	host.serve(Matches, (_params, principal, self) => {
		const store = self.get(ClubStore, {});
		return roleOf(principal) === "coach"
			? { variant: "coach", members: { sessions: store.sessions, open: (a, ctx) => store.open(a, ctx) } }
			: { variant: "player", members: { sessions: store.sessions } };
	});
});
```

```tsx
// PROPOSED · plugins/club/web.tsx: the club's home: the roster and the matches; a match opens the ordinary transcript
export default defineFacet((_host, self) => {
	self.contribute(WebViews, { "club.home": () => <ClubHome /> });
});
function ClubHome() {
	const roster = useHold(Roster, {});
	const matches = useHold(Matches, {});
	const players = useWatch(roster.players) ?? [];
	return (
		<Split>
			<List title="Team">{players.map((p) => <Row key={p.id} title={p.name} detail={p.position}
				actions={roster.variant === "coach" ? [{ label: "Remove", run: (ctx) => roster.remove({ id: p.id }, ctx) }] : []} />)}</List>
			<List title="Matches">{(useWatch(matches.sessions) ?? []).map((id) => <SessionRow key={id} session={id} />)}
				{matches.variant === "coach" && <Button onClick={(ctx) => matches.open({ title: "Next match" }, ctx)}>New match</Button>}</List>
		</Split>
	);
}
```

**The flow:** the owner opens People, invites Max with club: player, and sends the link. Max opens it, taps "Continue
with Radius" (his Google account at Radius), and lands in the club: the team list, the matches, no buttons. The owner
makes him coach: Max's revision goes up, his pages reconnect, the Remove and New match buttons appear. Max holds
`Terminals` directly: `forbidden`. A match session's transcript is the ordinary one; the session check lets every club
person send there.

# Open: Third-Party Contributions in an App's Sessions {.epilogue}

1. **Hooks and wraps of third-party plugins run in every session.** They are trusted code (stats, approvals); an app
   cannot switch them off for its sessions. Options: (a) accept it: installing a plugin is trusting it everywhere;
   (b) the harness filter may exclude whole extensions for an app's sessions (`extensions` filter by plugin), hooks
   and wraps included; (c) extensions declare where they apply (all sessions, or only apps that opt in).
2. **Slots in reused views.** The club reuses the transcript; a third-party plugin's composer part ("attach from
   Drive") appears for Max too, broken if its object serves the owner only, unapproved by the club if it serves
   persons. Options: (a) the app's layout lists the slot contributions its panes show (an allowlist per app);
   (b) contributions declare the principals they are for and the slot hides the others for persons; (c) slot
   contributions render only for the owner unless an app names them.
