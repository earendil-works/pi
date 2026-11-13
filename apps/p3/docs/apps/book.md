---
title: p3 apps: trusted plugins, confined people
cover: Apps / Users / Guests
kicker: A design note · p3 · 2026-11-13 · third edition
subtitle: The owner builds apps for his family, his club and his team; each person reaches only what an app gives them
stats:
  - 1 | owner per Pi, who installs every plugin
  - 3 | kinds of people: owner, users of an app, guests of a session
  - 1 | login per app, side by side in one browser
  - 0 | permission engines, settings layers or rule tables
note: |
  The owner's direction of 2026-11-13, worked out with three reviewers (Opus: product, Astra: adversarial, Sol:
  Chord's API). The second edition took in their review; this third edition takes in the owner's decisions since:
  objects choose their variant from followed state (`self.choose`, a Chord change under review), one login per app,
  apps may admit other apps' users, the family app in full, mocks of what people see, and an app's own sign-in.
  Replaces the decision "Org-managed Pis through managed settings" of the same day. Every code block is PROPOSED: p3
  has no code. Chord calls in the code exist in `packages/chord/src` (`defineFacet`, `host.serve`, `local`, `remote`,
  `self.get`, `self.state`, `self.derive`, `self.on`, `self.onLive`, `self.writable`, `self.contribute`, `self.registry`,
  `constant`, `defineRegistry`, `keyedEntries`, `defineState`, keyed members' `.at`, `forbidden`, the kit's `SignIns`,
  `cookie`, `readCookie`, `Http` routes), except `self.choose` (spec under review). p3 names (`Apps`, `Sessions`,
  `SessionAccess`, `sessionAccess`, `defineAppUsers`, `HarnessFilters`, `WebViews`, the view components) are proposals.
colophon: p3 apps · design note, third edition · 2026-11-13
---

> **Superseded (2026-11-13, evening):** per-app user pools, `self.choose` and the async app rule are replaced by `apps/p3/docs/people/book.md` (persons with roles in the principal, locks). Kept as the record.


# The Goal {.preface}

One Pi, one owner. The owner, or his agent, builds **apps** and shares them:

- **The robot** for his son Leo, who cannot read yet: a friendly face, hold to talk, one long-running session in a
  fixed folder with its own instructions and skills, no tools.
- **Family** for his wife: her calendars and mail, a voice chat of her own, the family files, her journal, and a pane
  with Leo's adventures with the robot.
- **The football club:** shared match sessions, a roster only coaches change.
- **Coding:** the app Pi ships with, for himself and his team.
- **Guests:** a friend watches one session, or joins it, through a link.

An app decides what you see (its layout and views), what its sessions get (machine and folder, instructions and
skills, tools, models, accounts) and who may use it. People reach only what the app gives them.

## Eight things to know

:::findings
1. **An app is a plugin.** It creates the layouts, views and objects it needs and reuses any other plugin's. The owner
   installs it; the agent writes one when asked ("make a robot app for my son").
2. **Plugins are trusted, people are confined.** Apps call each other and every plugin freely. Only users and guests
   are limited, by their principal.
3. **Every object serves only the principals it knows.** Owner-only objects (terminals, mail, settings) admit the owner
   and the host's own code (`server`, `worker`); a user or guest who holds one directly gets `forbidden`.
4. **Objects choose their variant from followed state.** With `self.choose`, an object follows what decides access
   (her user record, the session's answer for her) and picks a variant, or refuses; when that state changes, it
   chooses again. No checks in every method, no pushed grants.
5. **One session check:** the owner always passes; a guest from its principal; a user, of any app, if the session's
   app says so. The robot lets family users watch Leo's session.
6. **One login per app.** Each app's users sign in on the app's own path (`/apps/family/…`) with their own cookie, so
   one browser holds the owner and several apps' users side by side.
7. **An app owns its sign-in.** The join page is the app's own route and view: a name, GitHub, anything it verifies,
   then the kit's `SignIns` issues the sign-in.
8. **What an app's sessions get is the app's worker facet:** filters on the harness, for the agent, its subagents and
   code mode alike.
:::

## Words used throughout

A **principal** is who a call comes from, stamped by the link. A **user** is a member of one app's user pool, signed
in as `{ kind: "user", app, id }`. A **guest** is someone a session was shared with (p2's guest). An app's **store**
is its `local` object on the server, which acts as the host and reaches any plugin. A **variant** is the shape of an
object one principal gets; **choosing** it from followed state is `self.choose`. The **session check** answers "may
this principal see, or send, in this session".

# People {#people lede="Three kinds of people, each a principal the link stamps; each app has its own login."}

```ts
// PROPOSED · @p3/v1: p3's principal kinds
export type P3Principal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly session: string }
	| { readonly kind: "owner" }
	| { readonly kind: "user"; readonly app: string; readonly id: string }      // a member of one app's user pool
	| {                                                                         // a guest of shared sessions (p2's)
			readonly kind: "guest";
			readonly id: string;
			readonly name: string;                                                // as typed when joining, unverified
			readonly sessions: Readonly<Record<string, "read" | "write">>;
			readonly revision: number;
	  };
```

- **The owner** signs in with the kit's owner link, token file or pairing, on `/`.
- **A user** belongs to one app's pool. The owner invites them; they sign up on the app's page; the server issues a
  sign-in for `{ kind: "user", app, id }`. What they may do is the app's data (her calendars, a coach's role), and
  objects choose their variant from it.
- **A guest** gets one or more sessions, each read or write, in the principal itself. A change bumps the revision: the
  old objects end and the guest reconnects as the new principal, as in p2.
- **The owner is not protected against.** He passes every session check, shares any session, and can read the stores
  and run code on the machine. An app may still refuse him in its own objects (her journal), as a courtesy of its UI.

## One login per app

Leo's tablet is signed in to the robot; his mother's phone is signed in to the family app and, later, to the club.
With one sign-in cookie per browser, every new sign-up would sign her out of the last app. So each app's users sign in
on the app's path, with a cookie of their own:

| Path | Cookie | Who |
| --- | --- | --- |
| `/` | `chord-sign-in` (`Path=/`) | the owner, and guests |
| `/apps/family/` | `chord-sign-in.family` (`Path=/apps/family`) | users of the family app |
| `/apps/club/` | `chord-sign-in.club` (`Path=/apps/club`) | users of the club |

A browser sends every cookie whose path covers the request, so a request to `/apps/family/` may carry both the
owner's cookie and the family one; the authenticator takes the app's cookie first. The owner opening `/apps/family/`
without a family sign-in sees the family app as the owner. Each app's page opens its Chord link on its own path
(`/apps/family/chord`), so the link carries the app's cookie. The kit today writes every cookie with `Path=/` and has
one links endpoint; "What the Base Must Add" lists the change.

# Choosing from State {#choose lede="An object follows what decides access and picks its variant, again whenever that changes."}

A Chord factory runs synchronously and decides from params and principal. Access often depends on data the object
must first load: whether she is still a family member, whether a club member is a coach, whether the robot lets
family users watch. The second edition worked around that with checks in every method and access state pushed to the
page. `self.choose` replaces all of it (a Chord change whose spec is under review):

1. **Step one:** the factory declares the sources (her pinned user record, the session's answer for her) and returns
   `self.choose(sources, decide)`.
2. **Choice:** once the sources have values, `decide` returns a branch, or throws `forbidden`. A source still loading
   keeps the object waiting; it never denies.
3. **Step two:** the branch declares the chosen variant's members and the object goes live.
4. **Changes:** when a source changes, `decide` runs again. The same variant: nothing happens. Another variant or a
   refusal: the object restarts, and its holders re-bind to the new variant or get `forbidden`.

Her journal, in full:

```ts
// PROPOSED · plugins/family/server.ts (excerpt): present in the family's pool → her journal; absent → forbidden
host.serve(Journal, (_params, principal, self) => {
	if (principal.kind !== "user" || principal.app !== APP) throw forbidden("Your own journal only.");   // the owner too
	const me = self.get(FamilyUsers.Store, {}).user.at(principal.id);         // keyed pin; absent once removed
	const present = self.derive([me], ([u]) => u.kind === "present");          // narrow: decide runs only when this flips
	return self.choose([present], ([here]) => {
		if (!here) throw forbidden("No longer a family member.");
		return (self) => {
			const store = self.get(FamilyStore, {});
			return { variant: "mine", members: {
				text: self.derive([store.journals.at(principal.id)], ([j]) => j.text),
				write: (text, ctx) => store.write({ user: principal.id, text }, ctx),
			} };
		};
	});
});
```

When the owner removes her, her record goes absent, `decide` throws, and her open journal pane ends `forbidden` in
the same push. Revoking her sign-in ("Users and Invites") stops her coming back.

# The Session Check {#access lede="May this principal see or send in this session? The session's app answers for users."}

`Sessions` (a core plugin on the server) creates sessions and records each one's facts: its app and its creator,
fixed for its life. The answer:

```ts
// PROPOSED · plugins/sessions/access.ts (server)
export type Access = { readonly see: boolean; readonly send: boolean };
export const ALL: Access = { see: true, send: true };
export const SEE: Access = { see: true, send: false };
export const NONE: Access = { see: false, send: false };

export function access(principal: P3Principal, session: SessionFacts, own: SessionFacts | undefined, apps: AppTable): Access {
	switch (principal.kind) {
		case "owner":
		case "server":
			return ALL;
		case "worker":
			// A session's agent reaching another session asks as its own session's creator: the owner's agent passes.
			if (principal.session === session.id) return ALL;
			return own === undefined ? NONE : access(own.creator, session, undefined, apps);
		case "user":
			// The session's app decides, for users of any app: the robot lets family users watch.
			return apps.get(session.app)?.access(principal, session) ?? NONE;
		case "guest":
			if (!Object.hasOwn(principal.sessions, session.id)) return NONE;
			return { see: true, send: principal.sessions[session.id] === "write" };
	}
}
```

Every object of a session follows this answer and chooses from it. For the owner, a guest and the session's own
worker the answer is known from the principal; for everyone else the server computes it, because the `Apps` table
and the session index live there. One helper hides the difference:

```ts
// PROPOSED · @p3/v1: what a session object follows to choose its variant (worker and server alike)
export function sessionAccess(self: Self, session: string, principal: P3Principal): Readable<Access> {
	switch (principal.kind) {
		case "owner":
		case "server":
			return constant(ALL);
		case "guest":
			return constant(Object.hasOwn(principal.sessions, session) ? (principal.sessions[session] === "write" ? ALL : SEE) : NONE);
		case "worker":
			if (principal.session === session) return constant(ALL);
	}
	// Users, and another session's agent: the server's answer for this caller, followed.
	return self.get(SessionAccess, { session, caller: canonicalJson(principal) }).access;
}

// PROPOSED · plugins/sessions/contract.ts
export const SessionAccess = remote("sessions.access", {
	version: 1,
	params: { session: str(), caller: str() },                    // the caller as canonical JSON
	hostAddress: () => Server(),
	variants: { answer: { state: { access: AccessSchema } } },
});

// PROPOSED · plugins/sessions/server.ts
host.serve(SessionAccess, ({ session, caller }, principal, self) => {
	// Asked by code about the caller it serves (the session's worker, the server), or by a person about itself.
	const asker = canonicalJson(principal);
	if (!(principal.kind === "server" || (principal.kind === "worker" && principal.session === session) || asker === caller)) {
		throw forbidden("Only about yourself.");
	}
	const who = JSON.parse(caller) as P3Principal;                // written by `sessionAccess`, or the asker itself
	const index = self.get(SessionIndex, {});
	const facts = index.facts.at(Session({ id: session }));
	const own = who.kind === "worker" ? index.facts.at(Session({ id: who.session })) : facts;
	const apps = self.registry(Apps);
	return { variant: "answer", members: {
		access: self.derive([facts, own, apps], ([f, o, table]) => (f.kind === "absent" ? NONE : access(who, f, o.kind === "absent" ? undefined : o, table))),
	} };
});
```

A worker's own call to the server arrives as the worker (Chord §4, "upward is a boundary"), so it names the caller in
the params; on the server, a person's object asks about its own principal. Every session object, from any plugin,
then reads like this:

```ts
// PROPOSED · plugins/chat/worker.ts: the transcript, in the session's worker
host.serve(Transcript, ({ session, conversation }, principal, self) =>
	self.choose([sessionAccess(self, session, principal)], ([a]) => {
		if (!a.see) throw forbidden("Not in this session.");
		return a.send ? participant(session, conversation, principal) : viewer(session, conversation);
	}),
);
```

## Where else it runs

- **The worker's route** keeps a coarse, synchronous `authorize`: the owner and the server pass; a guest passes when
  the session is in its principal; users and other sessions' workers pass, and the objects decide. A user can make a
  session's worker start and then be refused by every object in it; the route may refuse sessions the server's index
  does not know.
- **HTTP handlers** (downloads, exports) compute `access` at the request.
- **A guest's page** shows the layout of the session's app with every pane dropped whose session fails `see`, and
  every global pane dropped.

# An App Is a Plugin {#app lede="What an app contributes: one registry entry, rebuilt from the state it reads."}

An app contributes one entry to the `Apps` registry: its id, title, layout per person, access rule and user pool. The
entry is a `self.writable` its store sets again whenever the state the functions read changes (her record, the
robot's session id), so the composed table changes and every `SessionAccess` answer that depends on it is computed
again.

```ts
// PROPOSED · plugins/apps/contract.server.ts (the apps core plugin defines and serves the registry)
export type Pane = { readonly kind: string; readonly session?: string; readonly item?: JsonValue };
export type AppContribution = {
	readonly id: string;                                                  // also the `app` of its users and sessions
	readonly title: string;
	readonly layout: (principal: P3Principal) => readonly Pane[];
	readonly access: (principal: P3Principal, session: SessionFacts) => Access;
	readonly users?: AppUsersAdmin;                                       // its user pool's admin object
};
export const Apps = defineRegistry<AppContribution | NativeWatchable<AppContribution>, AppTable>("p3.apps", { version: 1 });

// plugins/apps/server.ts: one app per id; a second plugin claiming an id is reported, the first by plugin name wins
host.serve(Apps, { compose: (table, { report }) => keyedEntries(table, (app) => ({ [app.id]: app }), report) });

// plugins/apps/contract.ts: the page gets its layout from the server
export const AppLayout = remote("apps.layout", { version: 1, params: { app: str() }, hostAddress: () => Server(),
	variants: { person: { state: { panes: arr(PaneSchema) } } } });
```

A user's page opens their own app (no switcher); the owner's page has the switcher.

# The Family App {#family lede="The whole app: her calendars, her journal, her own voice chat, Leo's adventures and the owner's admin view."}

The family app is four files. Her record in the family's user pool says which calendars and which mail account are
hers; the owner sets that in the Users view. Each family member gets one voice chat session of their own, private to
its creator. The owner passes every check, as always.

:::figure wide | Her family app on her phone, right after signing in: her own voice chat, her calendars, her journal, and Leo's adventures with the robot, read-only.
<div class="ap" style="display:flex;gap:28px;justify-content:center;flex-wrap:wrap;font:14px/1.4 'Avenir Next','Helvetica Neue',sans-serif;color:#2a2723">
<div style="width:260px;border:9px solid #2a2723;border-radius:32px;background:#fff;overflow:hidden">
<div style="display:flex;justify-content:space-between;padding:10px 16px 6px;font-size:11px;color:#7b7468"><span>9:41</span><span>pi.example</span></div>
<div style="padding:4px 16px 10px;border-bottom:1px solid #e3dbcc"><div style="font-size:19px">Family</div><div style="font-size:12px;color:#7b7468">Signed in as Cristina</div></div>
<div style="display:flex;font-size:12px;border-bottom:1px solid #e3dbcc"><span style="flex:1;text-align:center;padding:7px 0;border-bottom:2px solid #b4472f">Chat</span><span style="flex:1;text-align:center;padding:7px 0;color:#7b7468">Calendar</span><span style="flex:1;text-align:center;padding:7px 0;color:#7b7468">Journal</span><span style="flex:1;text-align:center;padding:7px 0;color:#7b7468">Leo</span></div>
<div style="padding:12px 14px;height:250px;background:#fbf8f2">
<div style="background:#efe7d6;border-radius:12px;padding:7px 10px;margin:0 0 8px 40px;font-size:13px">Move the dentist to next week?</div>
<div style="background:#fff;border:1px solid #e3dbcc;border-radius:12px;padding:7px 10px;margin:0 30px 8px 0;font-size:13px">Done: Monday 15:30. I wrote to the practice from your mail.</div>
<div style="font-size:11px;color:#7b7468;margin:10px 0 4px">Today</div>
<div style="border-left:3px solid #2e6a8a;padding:3px 8px;font-size:12px;margin-bottom:4px">15:00 Swimming, Leo</div>
<div style="border-left:3px solid #b4472f;padding:3px 8px;font-size:12px">19:00 Parents' evening</div>
</div>
<div style="display:flex;justify-content:center;padding:12px 0 16px;border-top:1px solid #e3dbcc"><div style="width:58px;height:58px;border-radius:50%;background:#b4472f;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px">Hold</div></div>
</div>
<div style="width:260px;border:9px solid #2a2723;border-radius:32px;background:#fff;overflow:hidden">
<div style="display:flex;justify-content:space-between;padding:10px 16px 6px;font-size:11px;color:#7b7468"><span>9:42</span><span>pi.example</span></div>
<div style="padding:4px 16px 10px;border-bottom:1px solid #e3dbcc"><div style="font-size:19px">Leo's adventures</div><div style="font-size:12px;color:#7b7468">The robot's session · watching</div></div>
<div style="padding:12px 14px;height:316px;background:#fbf8f2;font-size:13px">
<div style="color:#7b7468;font-size:11px;margin-bottom:4px">Leo, 16:10</div><div style="margin-bottom:10px">Why do dinosaurs not live anymore?</div>
<div style="color:#7b7468;font-size:11px;margin-bottom:4px">Robot</div><div style="margin-bottom:10px">A giant rock fell from space, a very long time ago. Some dinosaurs became birds. The bird outside your window is a tiny dinosaur.</div>
<div style="color:#7b7468;font-size:11px;margin-bottom:4px">Leo, 16:12</div><div>Wow. Can I tell it hello?</div>
</div>
<div style="padding:10px 14px 16px;border-top:1px solid #e3dbcc;font-size:12px;color:#7b7468;text-align:center">Read-only: the robot lets family watch</div>
</div>
</div>
:::

## The contract

```ts
// PROPOSED · plugins/family/contract.ts
import { arr, defineAppUsers, keyed, local, map, method, nullable, obj, remote, Server, str } from "@p3/v1";
import { defineViewKind } from "views/contract";

export const APP = "family";
export const Place = { environment: "slayer", cwd: "/home/badlogic/family" };   // the family files, AGENTS.md, skills
export const Model = { provider: "anthropic", id: "claude-sonnet-5-5" };

/** What the owner sets for each family member: which calendars and which mail account are hers. */
export const MemberConfig = obj({ calendars: arr(str()), mail: str() });
export const FamilyUsers = defineAppUsers(APP, {
	config: MemberConfig,
	initialConfig: () => ({ calendars: [], mail: "" }),
	ownJoinPage: true,                                                   // the family brings its own (GitHub or a name)
});

export const Event = obj({ id: str(), calendar: str(), title: str(), start: str(), end: str() });

/** Her calendars' events. */
export const MyCalendars = remote("family.my-calendars", { version: 1, params: {}, hostAddress: () => Server(),
	variants: { mine: { state: { events: arr(Event) } } } });
/** Her journal: only she reaches it. */
export const Journal = remote("family.journal", { version: 1, params: {}, hostAddress: () => Server(),
	variants: { mine: { state: { text: str() }, methods: { write: method(str()) } } } });
/** Her own voice chat session, made the first time she opens it. */
export const MyChat = remote("family.my-chat", { version: 1, params: {}, hostAddress: () => Server(),
	variants: { mine: { state: { session: nullable(str()) } } } });

/** The family's store on the server: the owner's calendar events, the journals, each member's chat session. */
export const FamilyStore = local("family.store", { version: 1, params: {}, members: {
	events: arr(Event),
	journals: keyed(obj({ text: str() })),
	chats: map(str()),                                                   // user id → session id
	write: method(obj({ user: str(), text: str() })),
	ensureChat: method(obj({ user: str() }), str()),
} });

export const ChatPane = defineViewKind("family.chat", {});
export const CalendarPane = defineViewKind("family.calendars", {});
export const JournalPane = defineViewKind("family.journal", {});
export const UsersPane = defineViewKind("family.users", {});
```

## The server

```ts
// PROPOSED · plugins/family/server.ts
import { ALL, Apps, type AppContribution, type AppUserRecord, defineFacet, defineState, forbidden, Http, map, NONE, obj,
	type P3Principal, type Readable, type Self, Sessions, type SessionFacts, SignIns, type Static, str } from "@p3/v1/server";
import { CalendarService } from "calendar/contract";       // the calendar plugin's local service (the owner's accounts)
import { RobotApp } from "robot/contract";                 // the robot's store: its one session
import { APP, FamilyStore, FamilyUsers, Journal, MemberConfig, Model, MyCalendars, MyChat, Place } from "./contract.ts";
import { familyJoinRoutes, JoinSettings } from "./join.ts";

const Journals = defineState("family.journals", { schema: obj({ text: str() }), version: 1, keyed: true, persist: true,
	initial: () => ({ text: "" }), checkpointWhen: (_v, _o, { deltasSinceBase }) => deltasSinceBase >= 50 });
const Chats = defineState("family.chats", { schema: obj({ chats: map(str()) }), version: 1, persist: true,
	initial: () => ({ chats: {} }), checkpointWhen: (_v, _o, { deltasSinceBase }) => deltasSinceBase >= 50 });

export default defineFacet((host) => {
	FamilyUsers.serve(host);                                  // Admin (owner), Store, the join page /apps/family/join

	host.serve(FamilyStore, (_params, self) => {
		const users = self.get(FamilyUsers.Store, {});
		const calendar = self.get(CalendarService, {});        // a local object: it reaches the calendar plugin as the host
		const robot = self.get(RobotApp, {});
		const sessions = self.get(Sessions, {});
		const journals = self.state(Journals);
		const chats = self.state(Chats);

		const entry = self.writable(familyApp(null));
		self.on(robot.session, ({ value }) => entry.set(familyApp(value)));
		self.contribute(Apps, entry);
		// Her own sign-in page with GitHub (chapter "Your Own Sign-in").
		self.contribute(Http, familyJoinRoutes({ users, signIns: self.get(SignIns, {}), settings: self.state(JoinSettings) }));

		return {
			events: calendar.events,
			journals,
			chats: self.derive([chats], ([c]) => c.chats),
			write: async ({ user, text }, ctx) => {
				await journals.change(user, (draft) => { draft.text = text; }, ctx);
				return null;
			},
			ensureChat: async ({ user }, ctx) => {
				if (Object.hasOwn(chats.value.chats, user)) return chats.value.chats[user]!;
				const me = await users.user.get(user, ctx);
				if (me.kind === "absent") throw forbidden("Not a family member.");
				const { id } = await sessions.ensure({
					app: APP, key: `chat:${user}`, creator: { kind: "user", app: APP, id: user }, title: `${me.name}'s chat`,
					...Place, model: Model, accounts: [me.config.mail, ...me.config.calendars],
				}, ctx);
				await chats.change((draft) => { draft.chats[user] = id; }, ctx);
				return id;
			},
		};
	});

	host.serve(MyCalendars, (_params, principal, self) => {
		if (principal.kind !== "user" || principal.app !== APP) throw forbidden("Family members only.");
		const me = self.get(FamilyUsers.Store, {}).user.at(principal.id);
		const store = self.get(FamilyStore, {});
		return self.choose([present(self, me)], ([here]) => {
			if (!here) throw forbidden("No longer a family member.");
			return (self) => ({ variant: "mine", members: {
				events: self.derive([me, store.events], ([u, all]) =>
					u.kind === "present" ? all.filter((e) => u.config.calendars.includes(e.calendar)) : []),
			} });
		});
	});

	// Her journal: the owner is refused too, as a courtesy.
	host.serve(Journal, (_params, principal, self) => {
		if (principal.kind !== "user" || principal.app !== APP) throw forbidden("Your own journal only.");
		const me = self.get(FamilyUsers.Store, {}).user.at(principal.id);
		return self.choose([present(self, me)], ([here]) => {
			if (!here) throw forbidden("No longer a family member.");
			return (self) => {
				const store = self.get(FamilyStore, {});
				return { variant: "mine", members: {
					text: self.derive([store.journals.at(principal.id)], ([j]) => j.text),
					write: (text, ctx) => store.write({ user: principal.id, text }, ctx),
				} };
			};
		});
	});

	host.serve(MyChat, (_params, principal, self) => {
		if (principal.kind !== "user" || principal.app !== APP) throw forbidden("Family members only.");
		const me = self.get(FamilyUsers.Store, {}).user.at(principal.id);
		return self.choose([present(self, me)], ([here]) => {
			if (!here) throw forbidden("No longer a family member.");
			return (self) => {
				const store = self.get(FamilyStore, {});
				self.onLive(async (ctx) => { await store.ensureChat({ user: principal.id }, ctx); });
				return { variant: "mine", members: { session: self.derive([store.chats], ([c]) => c[principal.id] ?? null) } };
			};
		});
	});
});

/** Whether her record is in the pool: the narrow source a choice follows. */
const present = (self: Self, me: Readable<AppUserRecord<Static<typeof MemberConfig>>>) =>
	self.derive([me], ([u]) => u.kind === "present");

/** The family's entry: the owner gets the Users view, a member her panes; Leo's adventures once the robot has a session. */
function familyApp(robotSession: string | null): AppContribution {
	const leo = robotSession === null ? [] : [{ kind: "chat.transcript", session: robotSession, item: { title: "Leo's adventures" } }];
	return {
		id: APP,
		title: "Family",
		users: FamilyUsers.Admin,
		layout: (p) => (p.kind === "owner"
			? [{ kind: "family.users" }, ...leo]
			: [{ kind: "family.chat" }, { kind: "family.calendars" }, { kind: "family.journal" }, ...leo]),
		// Chats are private: only their creator (the owner passed before this rule is asked).
		access: (p: P3Principal, session: SessionFacts) =>
			p.kind === "user" && session.creator.kind === "user" && p.app === session.creator.app && p.id === session.creator.id ? ALL : NONE,
	};
}
```

## The worker

```ts
// PROPOSED · plugins/family/worker.ts: what a family chat session gets
import { defineFacet, type FilterScope, HarnessFilters } from "@p3/v1/worker";
import { APP, Model, Place } from "./contract.ts";

const mine = (scope: FilterScope) => scope.app === APP;
const TOOLS = new Set(["mail", "calendar", "read", "write", "edit"]);   // her mail and calendars, the family files; no shell

export default defineFacet((_host, self) => {
	self.contribute(HarnessFilters, {
		tools: (tools, scope) => (mine(scope) ? tools.filter((t) => TOOLS.has(t.namespace ?? t.name)) : tools),
		sections: (sections, scope) => (mine(scope) ? sections.filter((s) => s.source !== "instance") : sections),
		models: (models, scope) => (mine(scope) ? models.filter((m) => m.provider === Model.provider && m.id === Model.id) : models),
		environments: (envs, scope) => (mine(scope) ? envs.filter((e) => e.id === Place.environment) : envs),
		location: (chosen, scope) => !mine(scope) || (chosen.environment === Place.environment && chosen.cwd === Place.cwd),
		// Only her accounts, set when her session was made from her record.
		accounts: (accounts, scope) => (mine(scope) ? accounts.filter((a) => scope.accounts.includes(a.id)) : accounts),
	});
});
```

## The web

```tsx
// PROPOSED · plugins/family/web.tsx
import { useHold, useWatch } from "@p3/v1/web";
import { CheckList, Select, TextEditor } from "@p3/v1/web/components";
import { type ConfigEditorProps, UsersAdmin } from "apps/contract.web";
import { VoiceChat } from "chat/contract.web";
import { Agenda } from "calendar/contract.web";
import { Accounts } from "accounts/contract";
import { FamilyUsers, Journal, MyCalendars, MyChat, MemberConfig } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(WebViews, {
		"family.chat": () => <ChatView />,
		"family.calendars": () => <CalendarView />,
		"family.journal": () => <JournalView />,
		"family.users": () => <UsersAdmin admin={FamilyUsers.Admin} config={MemberEditor} />,
	});
});

function ChatView() {
	const session = useWatch(useHold(MyChat, {}).session);
	return session ? <VoiceChat session={session} transcript="compact" /> : null;
}

function CalendarView() {
	return <Agenda events={useWatch(useHold(MyCalendars, {}).events) ?? []} />;
}

function JournalView() {
	const journal = useHold(Journal, {});
	return <TextEditor value={useWatch(journal.text) ?? ""} onSave={(text, ctx) => journal.write(text, ctx)} />;
}

/** The owner's per-member settings in the Users view: which calendars and which mail account are hers. */
function MemberEditor({ value, onChange }: ConfigEditorProps<typeof MemberConfig>) {
	const accounts = useWatch(useHold(Accounts, {}).list) ?? [];            // the owner's accounts: an owner-only object
	return <>
		<CheckList label="Calendars" items={accounts.filter((a) => a.kind === "calendar")}
			checked={value.calendars} onChange={(calendars) => onChange({ ...value, calendars })} />
		<Select label="Mail account" items={accounts.filter((a) => a.kind === "mail")}
			value={value.mail} onChange={(mail) => onChange({ ...value, mail })} />
	</>;
}
```

"Leo's adventures" is the chat plugin's own `chat.transcript` view on the robot's session. The family app writes no
code for it: the transcript object follows `sessionAccess`, the robot's rule answers `SEE` for family users, and the
transcript chooses its viewer variant, without a composer.

# The Robot {#robot lede="One session for Leo, watched by the family."}

:::figure | Leo's robot face on his tablet: no text to read, one big button to hold while he talks.
<div class="ap" style="display:flex;justify-content:center;font:14px/1.4 'Avenir Next','Helvetica Neue',sans-serif">
<div style="width:420px;height:300px;border:12px solid #2a2723;border-radius:26px;background:#fbf3e4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px">
<svg width="190" height="150" viewBox="0 0 190 150"><rect x="15" y="20" width="160" height="115" rx="38" fill="#2e6a8a"/><rect x="88" y="2" width="14" height="22" rx="7" fill="#2e6a8a"/><circle cx="95" cy="4" r="7" fill="#b4472f"/><circle cx="65" cy="68" r="15" fill="#fff"/><circle cx="125" cy="68" r="15" fill="#fff"/><circle cx="69" cy="70" r="7" fill="#2a2723"/><circle cx="129" cy="70" r="7" fill="#2a2723"/><path d="M62 103 Q95 125 128 103" stroke="#fff" stroke-width="7" fill="none" stroke-linecap="round"/></svg>
<div style="width:120px;height:52px;border-radius:26px;background:#b4472f;box-shadow:0 4px 0 #8a3322"></div>
</div>
</div>
:::

```ts
// PROPOSED · plugins/robot/contract.ts
export const APP = "robot";
export const Users = defineAppUsers(APP, { config: obj({ voice: str() }), initialConfig: () => ({ voice: "friendly" }) });
export const Place = { environment: "kidbox", cwd: "/srv/son" };       // its AGENTS.md and skills live there
export const Model = { provider: "anthropic", id: "claude-haiku-5-5" };
/** The robot's store; other apps read its session id. */
export const RobotApp = local("robot.app", { version: 1, params: {}, members: { session: nullable(str()) } });
```

```ts
// PROPOSED · plugins/robot/server.ts
const Home = defineState("robot.home", { schema: obj({ session: nullable(str()) }), version: 1,
	initial: () => ({ session: null }), persist: true, checkpointWhen: () => true });

export default defineFacet((host) => {
	Users.serve(host);
	host.serve(RobotApp, (_params, self) => {
		const users = self.get(Users.Store, {});
		const sessions = self.get(Sessions, {});
		const home = self.state(Home);
		const state = self.derive([users.list, home], ([list, h]) => ({ users: list, session: h.session }));
		const entry = self.writable(robotApp({ users: [], session: null }));
		self.on(state, ({ value }) => entry.set(robotApp(value)));
		self.contribute(Apps, entry);
		self.onLive(async (ctx) => {
			const { id } = await sessions.ensure({ app: APP, key: "main", ...Place, model: Model }, ctx);
			await home.change((draft) => { draft.session = id; }, ctx);
		});
		return { session: self.derive([home], ([h]) => h.session) };
	});
});

function robotApp({ users, session }: { users: readonly AppUser[]; session: string | null }): AppContribution {
	return {
		id: APP,
		title: "Robot",
		users: Users.Admin,
		layout: (p) => {
			const voice = p.kind === "user" ? users.find((u) => u.id === p.id)?.config.voice : undefined;
			return session === null ? [] : [{ kind: "robot.face", session, item: { voice: voice ?? "friendly" } }];
		},
		// Leo talks; family users watch; nobody else.
		access: (p, facts) => {
			if (facts.id !== session || p.kind !== "user") return NONE;
			if (p.app === APP) return users.some((u) => u.id === p.id) ? ALL : NONE;
			return p.app === "family" ? SEE : NONE;
		},
	};
}
```

```ts
// PROPOSED · plugins/robot/worker.ts: what the robot's session gets
const mine = (scope: FilterScope) => scope.app === APP;
export default defineFacet((_host, self) => {
	self.contribute(HarnessFilters, {
		tools: (tools, scope) => (mine(scope) ? [] : tools),
		// Only the AGENTS.md and skills found at its place (loaded as sections, skills inline), never the owner's own.
		sections: (sections, scope) => (mine(scope) ? sections.filter((s) => s.source !== "instance") : sections),
		models: (models, scope) => (mine(scope) ? models.filter((m) => m.provider === Model.provider && m.id === Model.id) : models),
		environments: (envs, scope) => (mine(scope) ? envs.filter((e) => e.id === Place.environment) : envs),
		location: (chosen, scope) => !mine(scope) || (chosen.environment === Place.environment && chosen.cwd === Place.cwd),
	});
});

// PROPOSED · plugins/robot/web.tsx: the face, around the chat plugin's voice chat
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

**Coding** is the plugin Pi ships. Sessions from before apps belong to it (`app: "coding"`). Its rule gives its
sessions to the owner and to users of a team it invites; team users create sessions through coding's own object. Its
layout is the sidebar, transcript and changes; no filters.

# Users and Invites {#users lede="Each app has its own user pool; the owner invites, configures and removes in one view."}

```ts
// PROPOSED · @p3/v1 (contracts) and @p3/v1/server (serve): an app's user pool. Schematic: the real types keep `C`.
export type AppUser<C> = { readonly id: string; readonly name: string; readonly config: C };
export type AppUserRecord<C> = { readonly kind: "absent" } | ({ readonly kind: "present" } & AppUser<C>);
export function defineAppUsers<C extends JsonValue>(app: string, shape: {
	config: Schema<C>;
	initialConfig: () => C;
	ownJoinPage?: true;                                // the app contributes its own join routes; the pool contributes none
}): {
	/** Owner only: invite (the join URL), list, setConfig (schema-checked), remove. */
	readonly Admin: AppUsersAdmin;                     // remote `${app}.users.admin` on the server
	/** For the app's own objects: `list`, `user` (keyed: `user.at(id)`, absent once removed), and `join` (an invite or a
	 *  known identity → a user id, or null), which join routes call. */
	readonly Store: AppUsersStore;                     // local `${app}.users.store`; contributes the default join routes
	/** Serves both (server facet only). */
	serve(host: FacetHost): void;
};
```

1. **Invite:** the owner presses Invite in the app's Users view (`Admin.invite({ label, config? })`) and sends the
   link.
2. **Join:** the link opens the app's own join page, `/apps/<app>/join#<token>`. The default page asks for a name; an
   app may bring its own ("Your Own Sign-in"). The page's route checks the token, stores the user and issues a sign-in for
   `{ kind: "user", app, id }` with the app's cookie. The browser never chooses the app, the id or the config.
3. **Configure:** the owner sets what is hers in this app (`setConfig`: her calendars, her mail account).
4. **Use:** the app's objects pin her record (`user.at(principal.id)`) and choose from it.
5. **Remove:** her record goes absent (her open objects end at once, as they chose from it), her pending invites are
   invalidated, her sign-ins revoked.

:::figure wide | The owner's Users view of the family app: invite with a link, each member's own settings, remove.
<div class="ap" style="font:14px/1.45 'Avenir Next','Helvetica Neue',sans-serif;color:#2a2723;max-width:720px;margin:0 auto;border:1px solid #e3dbcc;border-radius:10px;background:#fff;overflow:hidden">
<div style="display:flex;align-items:center;gap:10px;padding:10px 16px;background:#f4eee2;border-bottom:1px solid #e3dbcc"><span style="font-weight:600">Family</span><span style="color:#7b7468">/</span><span>Users</span><span style="margin-left:auto;font-size:12px;color:#7b7468">owner</span></div>
<div style="padding:14px 16px;border-bottom:1px solid #e3dbcc;display:flex;gap:10px;align-items:center"><span style="font-weight:600">Invite</span><span style="flex:1;border:1px solid #e3dbcc;border-radius:6px;padding:6px 10px;font:12px 'SF Mono',Menlo,monospace;color:#5a544a">https://pi.example/apps/family/join#k7Qw…3fZ</span><span style="background:#2a2723;color:#fff;border-radius:6px;padding:6px 12px;font-size:13px">Copy link</span></div>
<div style="padding:12px 16px;border-bottom:1px solid #e3dbcc"><div style="display:flex;align-items:center;gap:10px"><span style="width:30px;height:30px;border-radius:50%;background:#2e6a8a;color:#fff;display:flex;align-items:center;justify-content:center">C</span><div><div>Cristina</div><div style="font-size:12px;color:#7b7468">joined 2 days ago · GitHub cristina-z · signed in on 2 devices</div></div><span style="margin-left:auto;font-size:13px;color:#b4472f">Remove</span></div>
<div style="display:flex;gap:24px;margin:10px 0 0 40px;font-size:13px"><div><div style="color:#7b7468;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Calendars</div><div>&#9745; Family &nbsp; &#9745; Cristina &nbsp; &#9744; Mario work</div></div><div><div style="color:#7b7468;font-size:11px;text-transform:uppercase;letter-spacing:.06em">Mail account</div><div style="border:1px solid #e3dbcc;border-radius:5px;padding:2px 8px">cristina@family.example &#9662;</div></div></div></div>
<div style="padding:12px 16px;display:flex;align-items:center;gap:10px"><span style="width:30px;height:30px;border-radius:50%;background:#c2b18c;color:#fff;display:flex;align-items:center;justify-content:center">O</span><div><div>Oma</div><div style="font-size:12px;color:#7b7468">invited 1 hour ago · not joined yet</div></div><span style="margin-left:auto;font-size:13px;color:#7b7468">Cancel invite</span></div>
</div>
:::

:::figure wide | The link goes out by any channel; it opens the family app's own join page, where she picks how to sign in.
<div class="ap" style="display:flex;gap:30px;align-items:center;justify-content:center;flex-wrap:wrap;font:14px/1.45 'Avenir Next','Helvetica Neue',sans-serif;color:#2a2723">
<div style="width:250px;background:#fff;border:1px solid #e3dbcc;border-radius:12px;padding:12px"><div style="font-size:11px;color:#7b7468;margin-bottom:6px">Message from Mario</div><div style="background:#efe7d6;border-radius:10px;padding:8px 10px;font-size:13px">Here is our family Pi: <span style="color:#2e6a8a;text-decoration:underline">pi.example/apps/family/join#k7Qw…</span></div></div>
<div style="font-size:26px;color:#c2b18c">&#8594;</div>
<div style="width:300px;background:#fff;border:1px solid #e3dbcc;border-radius:12px;padding:22px 22px 18px;box-shadow:0 10px 30px -18px rgba(60,40,10,.4)"><div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#b4472f">Family</div><div style="font-size:21px;margin:4px 0 4px">Join Mario's family Pi</div><div style="font-size:13px;color:#7b7468;margin-bottom:16px">Your calendars, your mail, your journal.</div>
<div style="background:#24292f;color:#fff;border-radius:7px;padding:9px 0;text-align:center;font-size:14px;margin-bottom:12px">Sign in with GitHub</div>
<div style="display:flex;align-items:center;gap:8px;color:#7b7468;font-size:12px;margin-bottom:12px"><span style="flex:1;border-top:1px solid #e3dbcc"></span>or<span style="flex:1;border-top:1px solid #e3dbcc"></span></div>
<div style="font-size:12px;color:#7b7468;margin-bottom:4px">Just your name</div><div style="display:flex;gap:8px"><span style="flex:1;border:1px solid #e3dbcc;border-radius:7px;padding:7px 10px;color:#2a2723">Cristina</span><span style="background:#b4472f;color:#fff;border-radius:7px;padding:7px 14px">Join</span></div>
<div style="font-size:11px;color:#7b7468;margin-top:12px">This link works once and expires in 7 days.</div></div>
</div>
:::

# Your Own Sign-in {#signin lede="Can an app define its own sign-in dialog? Yes: the join page is the app's own route and view."}

The join page is not the kit's: it is an `Http` route and a page the app contributes, on the app's path. The app may
verify whatever it wants (a name with an invite, GitHub, a family password, a code sent by mail) and then call the
kit's `SignIns.issue` for `{ kind: "user", app, id }`. The kit keeps the sign-in (its cookie, expiry and revocation);
the app keeps who its users are and how they prove it.

:::sequence animate | Sign in with GitHub on the family app's own join page.
actor browser "her browser" blue
actor app "family routes" "on the Pi server" accent
actor gh "GitHub" muted
actor kit "SignIns" "the kit"
browser -> app: GET /apps/family/join#invite
app --> browser: the family's join page
browser -> app: GET /join/github?invite=…
app --> browser: redirect to GitHub, state cookie (Lax)
browser -> gh: authorize the Pi Family app
gh --> browser: redirect …/github/back?code&state
browser -> app: GET …/github/back (state cookie)
app -> gh: exchange code, read her GitHub user
app -> app: invite + github:4711 → user id
app => kit: issue { kind: user, app: family, id }
kit --> app: cookie for /apps/family
app --> browser: page that opens /apps/family/
browser => app: page and link, signed in as her
:::

```ts
// PROPOSED · plugins/family/join.ts: the family's own sign-in routes, contributed by its join object (a local store)
import { cookie, defineState, type HttpContribution, obj, readCookie, str } from "@p3/v1/server";

/** What the owner sets once for the family's sign-in: GitHub's OAuth app, and the key the state cookie is signed with. */
export const JoinSettings = defineState("family.join-settings", {
	schema: obj({ github: obj({ clientId: str(), clientSecret: str() }), secret: str() }), version: 1, persist: true,
	initial: () => ({ github: { clientId: "", clientSecret: "" }, secret: randomToken() }), checkpointWhen: () => true,
});

const STATE = "family-oauth";                         // binds the GitHub round trip to this browser and this invite
const BACK = "/apps/family/join/github/back";

export function familyJoinRoutes(deps: JoinDeps): HttpContribution {
	const { users, signIns, settings } = deps;          // the pool's Store, the kit's SignIns, the settings document
	return { routes: {
		"GET /apps/family/join": { public: true, handler: async (request) => ({ kind: "html", body: joinPage(request.nonce) }) },

		"POST /apps/family/join/name": { public: true, handler: async (request, ctx) => {
			// A trust boundary: anyone may post here.
			const body = (await request.json()) as { readonly invite?: unknown; readonly name?: unknown } | null;
			if (typeof body?.invite !== "string" || typeof body.name !== "string" || body.name.trim() === "") return { kind: "error", status: 400 };
			const joined = await users.join({ invite: body.invite, identity: null, name: body.name.trim().slice(0, 80) }, ctx);
			return joined === null ? { kind: "error", status: 403 } : signIn(joined, request, ctx, { kind: "json", value: "joined" });
		} },

		"GET /apps/family/join/github": { public: true, handler: async (request) => {
			const invite = request.query.get("invite");    // the page's script read it from the fragment; may be null for a returning user
			const nonce = randomToken();
			const { github } = settings.value;              // client id and secret, set by the owner
			const to = `https://github.com/login/oauth/authorize?${new URLSearchParams({
				client_id: github.clientId, redirect_uri: `${request.origin}${BACK}`, state: nonce, scope: "read:user" })}`;
			// Lax: GitHub's redirect back is a navigation from another site, which a Strict cookie would not survive.
			const state = cookie(STATE, JSON.stringify({ nonce, invite }), { secret: settings.value.secret, request, sameSite: "Lax", maxAge: 600 });
			return { kind: "redirect", to, headers: { "Set-Cookie": state } };
		} },

		[`GET ${BACK}`]: { public: true, handler: async (request, ctx) => {
			const saved = readCookie(request, STATE, settings.value.secret);
			const { nonce, invite } = saved === undefined ? { nonce: undefined, invite: null } : (JSON.parse(saved) as { nonce: string; invite: string | null });
			if (nonce === undefined || request.query.get("state") !== nonce) return { kind: "error", status: 403 };
			const gh = await githubUser(request.query.get("code") ?? "", settings.value.github, ctx);   // code exchange, then /user
			// An invite links this GitHub identity to a new user once; later, the identity alone finds her.
			const joined = await users.join({ invite, identity: `github:${gh.id}`, name: gh.name ?? gh.login }, ctx);
			if (joined === null) return { kind: "error", status: 403 };
			// A page, not a redirect: the next navigation is same-site, so the Strict sign-in cookie goes with it.
			return signIn(joined, request, ctx, { kind: "html", body: continuePage("/apps/family/", request.nonce) });
		} },
	} };

	// joinPage, continuePage, githubUser, randomToken and clearCookie: small helpers of this file, omitted.
	async function signIn(id: string, request: HttpRequest, ctx: Ctx, response: HttpResponse): Promise<HttpResponse> {
		const issued = await signIns.issue({
			principal: { kind: "user", app: "family", id }, label: "family", kind: "browser",
			secure: request.provenance.kind !== "local", cookie: { name: "chord-sign-in.family", path: "/apps/family" },   // kit gap
		}, ctx);
		return { ...response, headers: { "Set-Cookie": [issued.cookie, clearCookie(STATE)] } };
	}
}
```

What is real today: `Http` routes with `public: true`, `redirect` and `html` responses, `request.query` and
`request.origin`, signed cookies with `sameSite: "Lax"` and `maxAge` (`cookie`, `readCookie`), and `SignIns.issue`
for any principal. What the kit lacks: the cookie's name and path per sign-in (`cookie` writes `Path=/`, and the
authenticator reads one cookie name); an OAuth helper (state, PKCE, the code exchange); a place for secrets (here the
client secret and the cookie key sit in the app's own settings document, readable by whoever reads the store); and
`users.join`, which belongs to the p3 pool (`defineAppUsers`), not the kit.

# Guests {#guests lede="Sharing one session, read or write, with the same invite and sign-in path."}

The sharing plugin uses the same join path as app users (an invite, or a reusable link; a page for the name; a
sign-in on `/`) and issues guest principals. Read or write lives in the principal, so a session object's
`sessionAccess` is a constant and needs no server round trip. A change bumps the revision, revokes the old objects,
and the guest reconnects as the new principal (admission checks the current revision, as p2 does). A reusable link
makes one guest per browser, never one shared identity. What the guest sees: the session's app layout, cut to the
shared sessions.

# What the Base Must Add {#gaps lede="Chord and the kit are enough with these changes."}

| Where | Gap | Smallest fix |
| --- | --- | --- |
| Chord | a variant cannot depend on followed state | `self.choose(sources, decide)` (spec under review) |
| kit | `defineUsers` is one pool per server (fixed name `chord.app.users`); no keyed record to pin; no config | a namespace per pool; `list` and keyed `user` with name and config |
| kit | invites: HTTP only, a principal chosen up front, single use, in memory, no join step, not cancellable | reusable issue and redeem with a join step, cancellation, reusable share links |
| kit | one sign-in cookie per browser (`Path=/`), one links endpoint (`/chord`) | cookie name and path per sign-in, the authenticator takes the most specific path's cookie, links and the web surface on `/apps/:app/` |
| kit | `SignIns.revoke` leaves open links; a facet cannot call `host.revoke` | `revokedBy` for server and workers, a local revocation service (objects that choose from her record end without it) |
| kit | a sign-in keeps its principal forever, so a guest never gets a new revision | resolve the current principal at use; admission checks the current revision (p2 does) |
| kit | no OAuth helper, no secrets | an OAuth client helper (state, PKCE, exchange); a secrets object |
| p3 | the session check | `Sessions` (facts, creator, index, `ensure` by key), `SessionAccess`, `sessionAccess`, the coarse route `authorize`, HTTP; every session object chooses from it |
| p3 | harness filters know neither the session's app nor a fixed place nor accounts | `scope.app`, `scope.accounts`; a `location` check at choice and at resolution; sections carry their source |

# Not Covered Here {.epilogue}

- **Org-managed Pis** (an employer setting up and restricting its members' Pis) are redone on top of apps later; the
  settings layer of this morning's decision is withdrawn.
- **Privacy from the owner** is a courtesy of an app's UI, never a guarantee.
- **Discord** is an app whose session gets narrow filters; its people are authors of input, not principals.
- **`self.choose` is under review.** If the review changes it, the session check and the examples change with it; the
  model (follow, then choose) stays.
