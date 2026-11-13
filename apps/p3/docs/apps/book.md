---
title: p3 apps: trusted plugins, confined people
cover: Apps / Users / Guests
kicker: A design note · p3 · 2026-11-13
subtitle: The owner builds apps for his family, his club and his team; each person reaches only what an app gives them
stats:
  - 1 | owner per Pi, who installs every plugin
  - 3 | kinds of people: owner, users of an app, guests of a session
  - 1 | session check for every session view and object
  - 0 | permission engines, settings layers or rule tables
note: |
  The owner's direction of 2026-11-13, worked out with three reviewers (Opus: product, Astra: adversarial, Sol:
  Chord's API). Replaces the decision "Org-managed Pis through managed settings" of the same day. Every code block is
  PROPOSED: p3 has no code. Chord calls named in the code exist in `packages/chord/src` (`defineFacet`, `host.serve`,
  `local`, `remote`, `self.get`, `self.state`, `self.on`, `self.onLive`, `self.writable`, `self.contribute`,
  `defineRegistry`, `defineState` with `keyed`, keyed members' `.at`, `forbidden`); p3 names (`Apps`, `Sessions`,
  `defineAppUsers`, `HarnessFilters`, `WebViews`) are proposals. Sources: `apps/p3/docs/views.md`,
  `apps/p3/docs/sharing.md`, `apps/p3/docs/apps/web-ui-direction.html`, the base-inventory explainer (harness filters).
colophon: p3 apps · design note, first edition · 2026-11-13
---

# The Goal {.preface}

One Pi, one owner. The owner, or his agent, builds **apps** and shares them:

- **The robot** for his son, who cannot read: a friendly face, hold to talk, one long-running session in a fixed
  folder with its own skills and AGENTS.md, no shell.
- **Family** for his wife: her calendars and mail, a simple voice chat, the family files; her own journal.
- **The football club:** shared match sessions, a team roster only coaches change.
- **Coding:** the app Pi ships with, for himself and his team.
- **Guests:** a friend watches one session, or joins it, through a link.

An app decides what you see (its layout and views), what its sessions get (machine and folder, skills, tools, models,
accounts) and who may use it. People reach only what the app gives them.

## Six rules

:::findings
1. **An app is a plugin.** It creates the layouts, views and objects it needs and reuses any other plugin's. The owner
   installs it; the agent writes one when asked ("make a robot app for my son").
2. **Plugins are trusted, people are confined.** Apps call each other and every plugin freely. Only users and guests
   are limited, by their principal.
3. **Every object serves only the principals it knows.** The terminal, mail and settings serve the owner; a user who
   holds them directly gets `forbidden`, whatever pane he opens.
4. **Users reach the rest through their app's objects.** An app's object for its users calls the app's local store,
   which acts as the host and reaches any plugin. The app chooses exactly what each user sees.
5. **One session check** for every session view and object: the owner always; a user if the session's app says so;
   a guest if the session is in its principal.
6. **What an app's sessions get is the app's worker facet:** filters on the harness, for the agent, its subagents and
   code mode alike.
:::

# People {#people lede="Three kinds of people, each a principal the link stamps; who may reach what follows from it."}

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
			readonly sessions: Readonly<Record<string, "read" | "write">>;
			readonly revision: number;
	  };
```

- **The owner** signs in with the kit's owner link, token file or pairing.
- **A user** belongs to one app. The owner invites them; they sign up on the app's page; the server issues a sign-in
  for `{ kind: "user", app, id }`. What they may do inside the app is the app's data, not the principal.
- **A guest** gets one or more sessions, each read or write, in the principal itself, so a factory picks the viewer or
  the participant variant synchronously (Chord's factory rule). A change bumps the revision: the old objects end and
  the guest reconnects with the new principal, as in p2.
- **The owner is not protected against.** He passes every session check, shares any session, and can read the store.
  An app may still refuse him in its own objects (her journal view), as a courtesy of its UI.

# The Session Check {#access lede="One question every session view and object asks: may this principal see or send in this session?"}

The base records each session's app when the session is created (it never changes). Transcript, composer,
artifacts, files, search, export and cross-session tools all ask one function:

```ts
// PROPOSED · plugins/sessions: the one session check (server and worker)
export type Access = { readonly see: boolean; readonly send: boolean };
const NONE: Access = { see: false, send: false };

export function access(principal: P3Principal, session: SessionFacts, apps: AppTable): Access {
	switch (principal.kind) {
		case "owner":
		case "server":
			return { see: true, send: true };
		case "worker":
			return principal.session === session.id ? { see: true, send: true } : apps.get(session.app)?.access(principal, session) ?? NONE;
		case "user":
			return principal.app === session.app ? apps.get(session.app)?.access(principal, session) ?? NONE : NONE;
		case "guest": {
			const mode = principal.sessions[session.id];
			return mode === undefined ? NONE : { see: true, send: mode === "write" };
		}
	}
}
```

The session worker's route applies it in its synchronous `authorize`, so every object a session's worker serves is
covered; methods that send check `send` again at the call, and HTTP routes (downloads, exports) at the request.

# An App Is a Plugin {#app lede="What an app contributes, and the robot in four files."}

An app contributes one entry to the `Apps` registry: its id, title, layout and the `access` rule above. It keeps no
other configuration: everything else is its own code and objects.

```ts
// PROPOSED · @p3/v1/server
export type AppContribution = {
	readonly id: string;                                                  // also the `app` of its users and sessions
	readonly title: string;
	readonly layout: (principal: P3Principal) => Layout;                  // panes: view kind, session, item
	readonly access: (principal: P3Principal, session: SessionFacts) => Access;
	readonly users?: AppUsersAdmin;                                       // its user pool's admin object, if it has users
};
export const Apps = defineRegistry<AppContribution | Watchable<AppContribution>, AppTable>("p3.apps", { version: 1 });
```

## The robot

```ts
// PROPOSED · plugins/robot/contract.ts
export const APP = "robot";
export const SESSION = "robot-main";
export const Users = defineAppUsers(APP, {
	profile: obj({ name: str() }),                       // what he enters when signing up
	config: obj({ voice: str() }),                       // what the owner sets for him
	initialConfig: () => ({ voice: "friendly" }),
});
export const Place = { environment: "kidbox", cwd: "/srv/son" };       // its AGENTS.md and skills live there
```

```ts
// PROPOSED · plugins/robot/server.ts
const Robot = local("robot.app", { version: 1, params: {}, members: {} });

export default defineFacet((host, self) => {
	Users.serve(host, self);                                            // the user pool: admin, store, sign-up page
	host.serve(Robot, (_params, self) => {
		const users = self.get(Users.Store, {});
		const sessions = self.get(Sessions, {});
		const app = (members: readonly AppUser[]): AppContribution => ({
			id: APP,
			title: "Robot",
			users: Users.Admin,
			layout: (p) => {
				const voice = p.kind === "user" ? members.find((u) => u.id === p.id)?.config.voice : undefined;
				return [{ kind: "robot.face", session: SESSION, item: { voice: voice ?? "friendly" } }];
			},
			access: (p, session) => {
				const ok = session.id === SESSION && p.kind === "user" && members.some((u) => u.id === p.id);
				return { see: ok, send: ok };
			},
		});
		const entry = self.writable(app([]));
		self.on(users.list, ({ value }) => entry.set(app(value)));     // a removed user loses access at once
		self.contribute(Apps, entry);
		self.onLive((ctx) => sessions.ensure({ id: SESSION, app: APP, ...Place }, ctx));   // the one session
		return {};
	});
});
```

```ts
// PROPOSED · plugins/robot/worker.ts: what the robot's session gets
export default defineFacet((_host, self) => {
	self.contribute(HarnessFilters, {
		tools: (tools, scope) => (scope.app === APP ? [] : tools),                       // no tools at all
		models: (models, scope) => (scope.app === APP ? models.filter((m) => m.id === "child-chat") : models),
		environments: (envs, scope) => (scope.app === APP ? envs.filter((e) => e.id === Place.environment) : envs),
		location: (chosen, scope) => scope.app !== APP || (chosen.environment === Place.environment && chosen.cwd === Place.cwd),
	});
});
```

```tsx
// PROPOSED · plugins/robot/web.tsx: the face, around the ordinary voice chat
export default defineFacet((_host, self) => {
	self.contribute(WebViews, {
		"robot.face": ({ app, session, item }) => (
			<VoiceChat app={app} session={session} voice={item.voice} transcript="hidden">
				<RobotFace />
			</VoiceChat>
		),
	});
});
```

The owner installs it, opens Users, invites his son and sets his voice. The son signs up on the link and gets one
hold-to-talk session. He holds `Terminals` or `Mail` directly? `forbidden`: those serve the owner only.

**Coding** is the plugin Pi ships: its access rule gives its sessions to the owner (and to users of a team it invites),
its layout the sidebar, transcript and changes, no filters.

# Users and Invites {#users lede="Each app has its own user pool; the owner invites, configures, removes."}

```ts
// PROPOSED · @p3/v1: an app's user pool, built on the kit's users, invites and sign-ins
export function defineAppUsers<P extends JsonValue, C extends JsonValue>(app: string, shape: {
	profile: Schema<P>; config: Schema<C>; initialConfig: () => C;
}): {
	/** Owner only: invite (returns the sign-up URL), the users, set a user's config, remove a user. */
	readonly Admin: RemoteContract;        // `${app}.users.admin`
	/** For the app's own objects: the users, and one user by id (`users.at(principal.id)`), absent when removed. */
	readonly Store: LocalContract;         // `${app}.users.store`
	/** Serves both and the public sign-up page `/apps/<app>/join#<token>`. */
	serve(host: FacetHost, self: FacetSelf): void;
};
```

1. **Invite:** the owner calls `Admin.invite({ label, config? })` and sends the link.
2. **Sign up:** the page asks for the profile (her name), checks the token, stores the user, and issues a sign-in for
   `{ kind: "user", app, id }`. The browser never chooses the app, the id or the config.
3. **Configure:** the owner sets what is hers in this app (`setConfig`: which calendars, which mail account).
4. **Use:** the app's objects pin her record: `self.get(Users.Store, {}).users.at(principal.id)`.
5. **Remove:** deletes the record, revokes her sign-ins and ends her open objects.

## Reaching other plugins

A remote object keeps its caller's principal when it calls `self.get` (Chord §4); only a `local` object acts as the
host. So an app gives its users a slice of another plugin through its own local store:

```ts
// PROPOSED · plugins/family/server.ts: her calendars, chosen by the owner's config for her
host.serve(MyCalendars, (_params, principal, self) => {
	if (principal.kind !== "user" || principal.app !== "family") throw forbidden("Family only.");
	const me = self.get(FamilyUsers.Store, {}).users.at(principal.id);
	const calendars = self.get(FamilyCalendars, {});      // the family app's local store: it reads the calendar plugin as the host
	return { variant: "mine", members: { events: self.derive([me, calendars.events], ([u, all]) => onlyThese(all, u)) } };
});

// her journal: keyed by her id; nobody else's principal reaches it (the owner refused as a courtesy)
host.serve(Journal, (_params, principal, self) => {
	if (principal.kind !== "user" || principal.app !== "family") throw forbidden("Your own journal only.");
	const journals = self.get(JournalStore, {});           // the app's local store
	const journal = journals.entries.at(principal.id);
	return { variant: "mine", members: { text: journal, write: (text, ctx) => journals.write({ id: principal.id, text }, ctx) } };
});
```

The calendar plugin must serve its local store to the server (or a server variant); a plugin that serves only the
owner's remote object cannot be reused by apps until it does.

# Guests {#guests lede="Sharing one session, read or write, with the same invite and sign-in path."}

The sharing plugin uses the same join path as app users (invite or reusable link, a page for the name, a sign-in) and
issues guest principals. Read or write lives in the principal; a change bumps the revision, revokes the old objects,
and the guest reconnects as the new principal. A guest sees the layout of the app the session belongs to, cut to that
session. A share link many people open makes one guest per browser, never one shared identity.

# What the Base Must Add {#gaps lede="Chord and the kit are enough with these small changes."}

| Where | Gap | Smallest fix |
| --- | --- | --- |
| kit | `defineUsers` exists once (fixed name `chord.app.users`), no record by id | a namespace per pool; keyed records (profile, config) |
| kit | invites: HTTP only, one principal chosen up front, single use, in memory, no sign-up form | reusable issue and redeem, a sign-up step; reusable share links |
| kit | `SignIns.revoke` leaves open objects; a facet cannot call `host.revoke` | `revokedBy` for server and workers, a local revocation service |
| kit | a sign-in keeps its principal forever, so a guest never gets a new revision | resolve the current principal at sign-in use; admission checks the current revision (p2 does) |
| Chord | a changed rule does not reach panes already open (`authorize` runs when a hold starts) | methods and derives check at use; or `route.reauthorize(address)` |
| p3 | harness filters do not know the session's app, nor a fixed folder, accounts or MCP | `scope.app`, a `location` check at choice and at resolution, filters for accounts and MCP |
| p3 | the session check everywhere | transcript, composer, artifacts, files, search, export, downloads, cross-session tools |

# Not Covered Here {.epilogue}

- **Org-managed Pis** (an employer setting up and restricting its members' Pis) are redone on top of apps later; the
  settings layer of this morning's decision is withdrawn.
- **One browser, one sign-in:** signing up for a second app in the same browser replaces the first sign-in.
- **Privacy from the owner** is a courtesy of an app's UI, never a guarantee: he owns the machine and the code.
- **Discord** is an app whose session gets narrow filters; its people are authors of input, not principals.
