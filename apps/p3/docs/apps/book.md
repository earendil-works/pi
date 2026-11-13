---
title: p3 apps: trusted plugins, confined people
cover: Apps / Users / Guests
kicker: A design note · p3 · 2026-11-13 · second edition
subtitle: The owner builds apps for his family, his club and his team; each person reaches only what an app gives them
stats:
  - 1 | owner per Pi, who installs every plugin
  - 3 | kinds of people: owner, users of an app, guests of a session
  - 1 | session check, run in three places
  - 0 | permission engines, settings layers or rule tables
note: |
  The owner's direction of 2026-11-13, worked out with three reviewers (Opus: product, Astra: adversarial, Sol:
  Chord's API), who then reviewed the first edition; this edition takes in their findings. Replaces the decision
  "Org-managed Pis through managed settings" of the same day. Every code block is PROPOSED: p3 has no code. Chord calls
  named in the code exist in `packages/chord/src` (`defineFacet`, `host.serve`, `host.registry`, `local`, `remote`,
  `self.get`, `self.state`, `self.onLive`, `self.contribute`, `self.derive`, `defineRegistry`, `keyedEntries`,
  `defineState`, keyed members' `.at`, `forbidden`); p3 names (`Apps`, `Sessions`, `SessionAccess`, `defineAppUsers`,
  `HarnessFilters`, `WebViews`) are proposals, and their signatures here are schematic where marked. Sources:
  `apps/p3/docs/views.md`, `apps/p3/docs/sharing.md`, `apps/p3/docs/apps/web-ui-direction.html`, the base-inventory
  explainer (harness filters).
colophon: p3 apps · design note, second edition · 2026-11-13
---

# The Goal {.preface}

One Pi, one owner. The owner, or his agent, builds **apps** and shares them:

- **The robot** for his son, who cannot read: a friendly face, hold to talk, one long-running session in a fixed
  folder with its own instructions and skills, no tools.
- **Family** for his wife: her calendars and mail, a simple voice chat, the family files; her own journal.
- **The football club:** shared match sessions, a roster only coaches change.
- **Coding:** the app Pi ships with, for himself and his team.
- **Guests:** a friend watches one session, or joins it, through a link.

An app decides what you see (its layout and views), what its sessions get (machine and folder, instructions and
skills, tools, models, accounts) and who may use it. People reach only what the app gives them.

## Six rules

:::findings
1. **An app is a plugin.** It creates the layouts, views and objects it needs and reuses any other plugin's. The owner
   installs it; the agent writes one when asked ("make a robot app for my son").
2. **Plugins are trusted, people are confined.** Apps call each other and every plugin freely. Only users and guests
   are limited, by their principal.
3. **Every object serves only the principals it knows.** Owner-only objects (terminals, mail, settings) admit the owner
   and the host's own code (`server`, `worker`); a user or guest who holds one directly gets `forbidden`, whatever pane
   it opens. A plugin that apps reuse offers a `local` service (or a variant for `server`).
4. **Users reach the rest through their app's objects.** An app's object for its users calls the app's local store,
   which acts as the host and reaches any plugin. The app chooses exactly what each user sees.
5. **One session check** for every session view and object: the owner always; a user if the session's app says so;
   a guest if the session is in its principal.
6. **What an app's sessions get is the app's worker facet:** filters on the harness, for the agent, its subagents and
   code mode alike.
:::

# People {#people lede="Three kinds of people, each a principal the link stamps."}

```ts
// PROPOSED · @p3/v1: p3's principal kinds
export type P3Principal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly session: string }
	| { readonly kind: "owner" }
	| { readonly kind: "user"; readonly app: string; readonly id: string }      // a member of one app
	| {                                                                         // a guest of shared sessions (p2's)
			readonly kind: "guest";
			readonly id: string;
			readonly name: string;                                                // as typed when joining, unverified
			readonly sessions: Readonly<Record<string, "read" | "write">>;
			readonly revision: number;
	  };
```

- **The owner** signs in with the kit's owner link, token file or pairing.
- **A user** belongs to one app. The owner invites them; they sign up on the app's page; the server issues a sign-in
  for `{ kind: "user", app, id }`. Their page always opens their app (no app switcher). What they may do inside the
  app is the app's data, not the principal: objects give every user of an app the same variant shape and check the
  right in each method, exposing it as state for the UI (`canEdit`, `maySend`). Coach versus player is such a right.
- **A guest** gets one or more sessions, each read or write, in the principal itself, so a factory picks the viewer or
  the participant variant synchronously. A change bumps the revision: the old objects end and the guest reconnects as
  the new principal, as in p2.
- **The owner is not protected against.** He passes every session check, shares any session, and can read the stores
  and run code on the machine. An app may still refuse him in its own objects (her journal view), as a courtesy of its
  UI.

# The Session Check {#access lede="One question: may this principal see or send in this session? Answered in three places."}

`Sessions` (a core plugin on the server) creates sessions and records each one's facts: its app and its creator,
fixed for its life. The answer:

```ts
// PROPOSED · plugins/sessions/access.ts (server)
export type Access = { readonly see: boolean; readonly send: boolean };
const ALL: Access = { see: true, send: true };
const NONE: Access = { see: false, send: false };

export function access(principal: P3Principal, session: SessionFacts, facts: SessionIndex, apps: AppTable): Access {
	switch (principal.kind) {
		case "owner":
		case "server":
			return ALL;
		case "worker": {
			if (principal.session === session.id) return ALL;
			// A session's agent reaching another session asks as its own session's creator: the owner's agent passes.
			const own = facts.get(principal.session);
			return own === undefined ? NONE : access(own.creator, session, facts, apps);
		}
		case "user":
			return principal.app === session.app ? (apps.get(session.app)?.access(principal, session) ?? NONE) : NONE;
		case "guest":
			if (!Object.hasOwn(principal.sessions, session.id)) return NONE;
			return { see: true, send: principal.sessions[session.id] === "write" };
	}
}
```

For users the answer depends on data (the app's members, the session's facts), and a Chord factory decides only from
params and principal. So the check never runs in a factory for a user. It runs in three places:

1. **The session worker's route.** People reach a session's data through the objects its worker serves (transcript,
   composer, artifacts, files). The route's synchronous `authorize` reads the server's in-memory session index and the
   composed `Apps` table (held by base code with `host.registry(Apps, ctx)`); until both are loaded it refuses users.
   Owner and guests pass or fail from the principal alone.
2. **Methods and derives, at use.** A method that sends checks `send` when it runs; state that depends on access is a
   derive over it. A worker cannot evaluate app rules (`Apps` lives on the server), so it asks:

   ```ts
   // PROPOSED · plugins/sessions/contract.ts: the server answers a worker about the caller it serves
   export const SessionAccess = remote("sessions.access", {
   	version: 1,
   	params: {},
   	hostAddress: () => Server(),
   	variants: {
   		worker: {
   			state: { rules: AccessRulesSchema },             // the current answers for the people holding this session
   			methods: { check: method(obj({ caller: PrincipalSchema }), AccessSchema) },
   		},
   	},
   });
   ```

   The worker passes the caller as data (a worker's upward calls arrive as the worker, Chord §4), and follows `rules`
   so an open pane loses `send` when an app's rule changes.
3. **HTTP handlers** (downloads, exports) at the request.

A guest's page shows the layout of the session's app with every pane dropped whose session fails `see` for it, and
every global pane dropped; list objects (the sidebar's) refuse guests.

# An App Is a Plugin {#app lede="What an app contributes, and the robot in four files."}

An app contributes one entry to the `Apps` registry. The entry is a plain value whose functions read live state at
use, so it never needs republishing.

```ts
// PROPOSED · plugins/apps/contract.server.ts (the apps core plugin defines and serves the registry)
export type AppContribution = {
	readonly id: string;                                                  // also the `app` of its users and sessions
	readonly title: string;
	readonly layout: (principal: P3Principal) => Layout;                  // panes: view kind, session, item
	readonly access: (principal: P3Principal, session: SessionFacts) => Access;
	readonly users?: AppUsersAdmin;                                       // its user pool's admin object
};
export const Apps = defineRegistry<AppContribution, AppTable>("p3.apps", { version: 1 });

// plugins/apps/server.ts: one app per id; a second plugin claiming an id is reported, the first by plugin name wins
host.serve(Apps, { compose: (table, { report }) => keyedEntries(table, (app) => ({ [app.id]: app }), report) });

// plugins/apps/contract.ts: the page gets its layout from the server
export const AppLayout = remote("apps.layout", { version: 1, params: { app: str() }, hostAddress: () => Server(),
	variants: { person: { state: { layout: LayoutSchema } } } });
```

## The robot

```ts
// PROPOSED · plugins/robot/contract.ts
export const APP = "robot";
export const Users = defineAppUsers(APP, {
	config: obj({ voice: str() }),                       // what the owner sets for him
	initialConfig: () => ({ voice: "friendly" }),
});
export const Place = { environment: "kidbox", cwd: "/srv/son" };       // its AGENTS.md and skills live there
export const Model = { provider: "anthropic", id: "claude-haiku-5-5" };
```

```ts
// PROPOSED · plugins/robot/server.ts
const Home = defineState("robot.home", {
	schema: obj({ session: nullable(str()) }), version: 1, initial: () => ({ session: null }),
	persist: true, checkpointWhen: () => true,
});
const Robot = local("robot.app", { version: 1, params: {}, members: {} });

export default defineFacet((host, self) => {
	Users.serve(host);                                                  // the pool: admin, store, sign-up page
	host.serve(Robot, (_params, self) => {
		const users = self.get(Users.Store, {});
		const sessions = self.get(Sessions, {});
		const home = self.state(Home);
		const member = (p: P3Principal) => p.kind === "user" && users.list.value.some((u) => u.id === p.id);
		self.contribute(Apps, {
			id: APP,
			title: "Robot",
			users: Users.Admin,
			layout: (p) => {
				const voice = p.kind === "user" ? users.list.value.find((u) => u.id === p.id)?.config.voice : undefined;
				return [{ kind: "robot.face", session: home.value.session, item: { voice: voice ?? "friendly" } }];
			},
			access: (p, session) => {
				const ok = session.id === home.value.session && member(p);   // read at the call: a removed user loses it
				return { see: ok, send: ok };
			},
		});
		// The one session, made once (idempotent by key), with its place and model.
		self.onLive(async (ctx) => {
			const { id } = await sessions.ensure({ app: APP, key: "main", ...Place, model: Model }, ctx);
			await home.change((draft) => { draft.session = id; }, ctx);
		});
		return {};
	});
});
```

```ts
// PROPOSED · plugins/robot/worker.ts: what the robot's session gets
const mine = (scope: FilterScope) => scope.app === APP;
export default defineFacet((_host, self) => {
	self.contribute(HarnessFilters, {
		tools: (tools, scope) => (mine(scope) ? [] : tools),
		// Only the AGENTS.md and skills found at its place (the instructions plugin loads them as sections, skills
		// inline): never the owner's global instructions.
		sections: (sections, scope) => (mine(scope) ? sections.filter((s) => s.source !== "instance") : sections),
		models: (models, scope) => (mine(scope) ? models.filter((m) => m.provider === Model.provider && m.id === Model.id) : models),
		environments: (envs, scope) => (mine(scope) ? envs.filter((e) => e.id === Place.environment) : envs),
		location: (chosen, scope) => !mine(scope) || (chosen.environment === Place.environment && chosen.cwd === Place.cwd),
	});
});
```

```tsx
// PROPOSED · plugins/robot/web.tsx: the face, around the ordinary voice chat
export default defineFacet((_host, self) => {
	self.contribute(WebViews, {
		"robot.face": ({ session, item }) => (
			<VoiceChat session={session} voice={item.voice} transcript="hidden">
				<RobotFace />
			</VoiceChat>
		),
	});
});
```

The owner installs it, opens Users, invites his son and sets his voice. The son signs up on the link and gets one
hold-to-talk session. He holds `Terminals` or `Mail` directly? `forbidden`: those admit the owner and the host only.

**Coding** is the plugin Pi ships. Sessions from before apps belong to it (`app: "coding"`). Its rule gives its
sessions to the owner and to users of a team it invites; team users create sessions through coding's own object, not
the owner's session service. Its layout is the sidebar, transcript and changes; no filters.

# Users and Invites {#users lede="Each app has its own user pool; the owner invites, configures, removes."}

```ts
// PROPOSED · @p3/v1 (contracts) and @p3/v1/server (serve): an app's user pool, on the kit's users, invites and sign-ins.
// Schematic: the real types keep `C` in the contracts' schemas.
export type AppUser<C> = { readonly id: string; readonly name: string; readonly config: C };
export function defineAppUsers<C extends JsonValue>(app: string, shape: { config: Schema<C>; initialConfig: () => C }): {
	/** Owner only: invite (the sign-up URL), list, setConfig (schema-checked), remove. */
	readonly Admin: AppUsersAdmin;                     // remote `${app}.users.admin` on the server
	/** For the app's own objects: `list` (every user) and `user` (one by id: `users.user.at(principal.id)`, absent once removed). */
	readonly Store: AppUsersStore;                     // local `${app}.users.store`; it also contributes the join routes
	/** Serves both (server facet only). */
	serve(host: FacetHost): void;
};
```

1. **Invite:** the owner calls `Admin.invite({ label, config? })` and sends the link.
2. **Sign up:** the page `/apps/<app>/join#<token>` asks for a name, checks the token, stores the user and issues a
   sign-in for `{ kind: "user", app, id }`. The browser never chooses the app, the id or the config.
3. **Configure:** the owner sets what is hers in this app (`setConfig`: which calendars, which mail account).
4. **Use:** the app's objects pin her record: `self.get(Users.Store, {}).user.at(principal.id)`.
5. **Remove:** deletes the record, invalidates her pending invites (a redeem after the removal is refused), revokes
   her sign-ins and ends her open objects.

## Reaching other plugins

A remote object keeps its caller's principal when it calls `self.get` (Chord §4); only a `local` object acts as the
host. So an app gives its users a slice of another plugin through its own local store:

```ts
// PROPOSED · plugins/family/server.ts: her calendars, as the owner configured them for her
host.serve(MyCalendars, (_params, principal, self) => {
	if (principal.kind !== "user" || principal.app !== "family") throw forbidden("Family only.");
	const me = self.get(FamilyUsers.Store, {}).user.at(principal.id);
	const calendars = self.get(FamilyCalendars, {});      // the family app's local store: it reads the calendar plugin as the host
	return { variant: "mine", members: { events: self.derive([me, calendars.events], ([u, all]) => onlyThese(all, u)) } };
});

// Her journal: keyed by her id; no other principal reaches it (the owner refused as a courtesy).
host.serve(Journal, (_params, principal, self) => {
	if (principal.kind !== "user" || principal.app !== "family") throw forbidden("Your own journal only.");
	const journals = self.get(JournalStore, {});          // the app's local store
	return {
		variant: "mine",
		members: {
			text: journals.entries.at(principal.id),
			write: (text, ctx) => journals.write({ id: principal.id, text }, ctx),
		},
	};
});
```

# Guests {#guests lede="Sharing one session, read or write, with the same invite and sign-in path."}

The sharing plugin uses the same join path as app users (an invite, or a reusable link; a page for the name; a
sign-in) and issues guest principals. Read or write lives in the principal; a change bumps the revision, revokes the
old objects, and the guest reconnects as the new principal (admission checks the current revision, as p2 does). A
reusable link makes one guest per browser, never one shared identity. What the guest sees: the session's app layout,
cut as above.

# What the Base Must Add {#gaps lede="Chord and the kit are enough with these changes."}

| Where | Gap | Smallest fix |
| --- | --- | --- |
| kit | `defineUsers` is one pool per server (fixed name `chord.app.users`); no keyed record to pin; no config | a namespace per pool; `list` and keyed `user` with name and config |
| kit | invites: HTTP only, a principal chosen up front, single use, in memory, no sign-up step, not cancellable | reusable issue and redeem with a sign-up step, cancellation, reusable share links |
| kit | `SignIns.revoke` leaves open objects; a facet cannot call `host.revoke` | `revokedBy` for server and workers, a local revocation service |
| kit | a sign-in keeps its principal forever, so a guest never gets a new revision | resolve the current principal at use; admission checks the current revision (p2 does) |
| p3 | the session check | `Sessions` (facts, index, `ensure` by key), `SessionAccess` for workers, the route's `authorize`, HTTP; applied to transcript, composer, artifacts, files, search, export, downloads, cross-session tools |
| p3 | harness filters know neither the session's app nor a fixed place | `scope.app`; a `location` check at choice and at resolution; sections carry their source; filters for accounts and MCP |

# Not Covered Here {.epilogue}

- **Org-managed Pis** (an employer setting up and restricting its members' Pis) are redone on top of apps later; the
  settings layer of this morning's decision is withdrawn.
- **One browser, one sign-in:** signing up for a second app in the same browser replaces the first sign-in.
- **Privacy from the owner** is a courtesy of an app's UI, never a guarantee.
- **Discord** is an app whose session gets narrow filters; its people are authors of input, not principals.
