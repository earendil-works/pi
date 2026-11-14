---
title: p3 people, apps and locks
cover: People / Apps / Locks
kicker: The design so far · p3 · 2026-11-13 · second edition
subtitle: One owner, persons with roles in apps, and one lock mechanism for apps, sessions, the Pi and companies; every decision of 2026-11-13, the review findings, and what is still open
stats:
  - 0 | changes to Chord's core (one open question may need one)
  - 6 | changes to the app kit
  - 4 | lock layers: company, Pi, app, session
  - 4 | open questions for the owner
note: |
  The state of the design at the end of 2026-11-13, written so the work can resume from this note alone. It supersedes
  `apps/book.md` (all editions: per-app user pools, `self.choose`, the async app rule) and the settings layer of
  `org-managed/book.md` (its enrollment and gate stay, chapter IX). Every code block is PROPOSED: p3 has no code. Names
  that exist and are used as they are: Chord's `local`, `remote`, `host.serve`, `self.get`, `self.state`,
  `self.derive`, `self.on`, `self.onLive`, `self.writable`, `self.contribute`, `self.table`, `self.query`, `self.tx`
  (`tx.put`, `tx.delete`), `defineRegistry`, `keyedEntries`, `defineState` (`keyed: Session`), `defineTable`, `json`
  columns with `{ version }`, `forbidden`, `host.revoke` and `revokedBy`; the kit's `SignIns` (`issue`, `verify`,
  `revoke`), `Authenticators`, pairing, `testPlugin`, the two plugin roots; pi-schema's builders (`str` with `format`).
  The owner said at the end: "this still seems overly complex imo". Reviewers are asked to find what can go.
colophon: p3 people, apps and locks · second edition · 2026-11-13
---

# Where This Comes From {.preface}

The owner wants to build **apps** on his Pi and share them: a robot for his son (who cannot read: a face, hold to talk,
one session in a fixed folder, no tools), a family app for his wife (her calendars and mail, a voice chat, her
journal, and Leo's robot adventures to watch), a football club (coaches change the roster, everyone talks in match
sessions), coding (the app Pi ships with), guests of single sessions, a Discord bot session that may only message one
other session. And companies (Colin's plan, Dec 18: Org Devices) must be able to restrict the Pis of their members.

The day went through several designs that the owner rejected: managed settings (`defineSetting`), plugin manifests
in `package.json`, per-plugin "features", rule tables over registry entries, per-app user pools with `self.choose`
(two-step activation; the reviews found it hits Chord's reload, staging and document invariants), an
`plugins: { only: [...] }` list in app code. What survived is below.

## Read first, in full {#read}

To be up to speed on this design (after a compaction or in a new session), read these completely, in this order:

1. **This note**, all chapters.
2. **`apps/p3/docs/decisions.md`**, all entries (newest last; the last three are today's).
3. **`apps/p3/docs/base-inventory/explainer/book.md`**: chapters "The Harness" (extensions, `HarnessFilters`,
   `FilterScope`, model and environment providers), "What Is Offered" (`ConversationOffer`), "Waiting Costs Nothing";
   its session metadata store is superseded by host-keyed documents (decisions.md).
4. **`apps/p3/docs/status-2026-11-09.md`** (the harness direction, instruction scopes, the session service).
5. **`apps/p3/docs/views.md`** and **`apps/p3/docs/sharing.md`** (views, layouts as apps, sharing and the owner's
   direction of 2026-11-10).
6. **`apps/p3/docs/apps/web-ui-direction.html`** (the apps mockup: robot, family, club, music, friends,
   environments) and **`apps/p3/docs/apps/book.md`** (superseded; the record of the per-app user pools).
7. **`apps/p3/docs/org-managed/book.md`** (enrollment, gate, machine lock-down; its settings layer superseded) and,
   for detail, `details.md` next to it.
8. **`apps/p3/docs/rundown/book.md`** chapters "The Rule Under Everything", "Resources and Bringing", "Who May",
   "Sharing and Locks", "The Filters".
9. **Chord:** `packages/chord/docs/design.md` §1, §4 (principals, revocation), §6–§7 (the factory rule), §10 "Data
   belonging to a host", §16–§18, §21 "The plugin model", §23 "The app kit"; code: `src/node/app/sign-ins.ts`,
   `pairing.ts`, `invite.ts`, `users.ts`, `worker.ts`, `app.ts`; `src/node/http/authenticate.ts` and `http.ts` (the
   accept path); `src/host/revocation.ts`; `src/remote/hold.ts` (`#bindTo`, the rebind race).
10. **p2 as precedent** (not reused): `apps/p2/src/runtime/principals.ts` (the guest principal),
    `apps/p2/plugins/sharing/server.ts` and `store.ts` (guests, revisions, Radius email shares),
    `apps/p2/src/runtime/session-lock.ts`, `tool-access.ts`, `durable.ts`, `apps/p2/plugins/envs/schema.ts`,
    `apps/p2/plugins/mcp/placement.ts`, `apps/p2/plugins/prompt/worker.ts` (what p2 locks today).
11. **Research:** `apps/p3/docs/authz-research.md` (prior art; its levels and policy are superseded) and the two
    team-mode research notes `apps/p3/docs/*-teams.md` (how other agent systems handle teams and tool policies).
12. **Reviews** (temporary, on slayer): `/tmp/apps-brief.md`, `/tmp/apps-opus.md`, `/tmp/apps-astra.md`,
    `/tmp/apps-sol.md` (the first app designs), `/tmp/choose-spec.md` and the reviews of `self.choose` (rejected).
13. **History** of the p3 session (8b6ab5cc): the harness and filter design (entries 271840–273175), the apps
    discussion (277211–277720); today's people and locks discussion: search "person", "locks", "otherPlugins",
    "lock down".

## Decisions of 2026-11-13 {#decisions}

:::findings
1. **One Pi, one owner, who installs every plugin; plugins (apps among them) are trusted code.** Only people are
   confined. ("we control that shit, owner installs all code")
2. **An app is a plugin.** It creates the layouts, views and objects it needs and reuses any other plugin's. The
   agent writes one when asked. Coding is the built-in app.
3. **Everyone besides the owner is a person** whose rights live in the principal, as p2's guests: roles per app and
   single shared sessions. A change bumps the revision and revokes. ("maybe guest is sufficient")
4. **Identity is pluggable;** by default Radius (a verified email; Google or GitHub happen at Radius) and this device.
5. **No defensive machinery against the owner:** he passes every session check; an app may refuse him in its own
   objects as a courtesy; privacy from him is never a guarantee ("I can just dig out her journal from sqlite").
6. **A session belongs to exactly one app** (its rules and locks apply); any app may show any session.
7. **Lockdown is locks:** a plugin declares what can be switched off or limited, registers it with the server, and
   enforces it itself; layers company > Pi > app > session only narrow.
8. **Plugins outside Pi's own root get a plugin switch per app;** an app says only `otherPlugins: "on" | "off"`; on
   install the owner chooses the apps. Base plugins (Pi's root) have no switch; they declare locks.
9. **One sheet per scope** (app, session, optionally the Pi), for technical owners, with the agent's help; the
   company's values show read-only.
10. **The company layer is the org profile:** an initial copy on disk, then whatever Radius delivers.
11. **Radius learns the locks** from member Pis' reports and by loading selected plugins' server facets in a sandbox.
:::

# People {#people lede="One principal kind for everyone the owner lets in; rights in the principal; changes revoke."}

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
			readonly revision: number;                                      // part of the principal key
	  };
```

- **Why in the principal:** a Chord factory decides only from params and principal, synchronously (design §6, §7).
  With the roles in the principal, every object picks its variant at once: `roles.club === "coach"`.
- **A change** (invite, role, a shared session, removal): the person's row gets `revision + 1`; `host.revoke({ person:
  id })` ends all of the person's objects on the server and every worker (calls in flight aborted); the devices
  reconnect, the kit resolves the current principal (chapter VIII), the references re-bind with the new variant. The
  revision distinguishes the new principal; the revocation ends the old objects. A short reconnect of every open pane,
  on every device; rights change rarely.
- **Typed roles:** an app declares its roles once; a helper reads them typed.

```ts
// PROPOSED · @p3/v1
export function defineApp<const R extends readonly string[]>(id: string, shape: {
	roles: R;
	otherPlugins: "on" | "off";                                       // chapter VI
}): {
	readonly id: string;
	readonly roles: R;
	/** The person's role in this app, typed; undefined for anyone else (the owner included: apps decide for him). */
	roleOf(principal: P3Principal): R[number] | undefined;
};
```

`People.grant` checks a role against the roles the app declared (a trust boundary: the owner's page); an unknown role
never reaches a principal.

- **One person, several apps:** one principal with several roles. One login per person, not per app (an earlier idea
  of one cookie per app path is dropped).
- **Apps admitting other apps' people:** the robot's rule lets family members watch: `p.roles.family !== undefined`
  gives `see`, not `send`.
- **Guests are persons** with `sessions` and no roles: the same principal, the same join path.

# Identity and Joining {#identity lede="The people plugin: persons, identities, invites; identity providers with server, web and terminal parts."}

```ts
// PROPOSED · plugins/people (server): tables (json columns need a version)
const Persons = defineTable("people.persons", { version: 1, key: ["id"], columns: {
	id: str(), name: str(),
	roles: json(map(str()), { version: 1 }),
	sessions: json(map(oneOf("read", "write")), { version: 1 }),
	revision: int(),
} });
const Identities = defineTable("people.identities", { version: 1, key: ["provider", "subject"],
	columns: { provider: str(), subject: str(), person: str() } });           // radius: the verified email; device: a token's hash
const Invites = defineTable("people.invites", { version: 1, key: ["hash"], columns: {
	hash: str(), person: str(), expires: int(), used: bool() } });           // the token is never stored, only its hash

/** The owner's management of people. */
export const People = remote("people.admin", { version: 1, params: {}, hostAddress: () => Server(),
	variants: { owner: {
		state: { persons: arr(PersonSchema), invites: arr(InviteSchema) },
		methods: {
			invite: method(obj({ name: str(), roles: map(str()), sessions: map(oneOf("read", "write")) }), obj({ url: str() })),
			grant: method(obj({ person: str(), roles: opt(map(nullable(str()))), sessions: opt(map(nullable(oneOf("read", "write")))) })),
			remove: method(obj({ person: str() })),
		},
	} } });
```

- **invite** creates the person row (no identity yet) and an invite (single use, expiring); the URL is
  `/people/join#<token>`. Sending it by email goes through Radius when connected.
- **remove** deletes the person's row and identities (removed ids are never reused), marks pending invites used,
  revokes the person's sign-ins (and so their open links, chapter VIII), then `host.revoke({ person })`.
- **The join page** (the people plugin's own route and web view) checks the invite token and offers every identity
  provider; after a provider's `finish` it links the identity to the invited person and issues a sign-in (kit
  `SignIns.issue` with the subject `{ person: id }`, chapter VIII).
- **A returning person** (a new device, no invite) signs in through a provider; `finish` looks the identity up in
  `Identities` and finds the person.

## Identity providers

A provider is an ordinary plugin with up to three facets, registered in registries the people plugin owns:

```ts
// PROPOSED · plugins/people/contract.server.ts
export type IdentityProvider = {
	readonly id: string;                                     // "radius", "device", later "google", "saml"
	/** Begins sign-in: a redirect, or a page of its own. `invite` is null for a returning person. */
	start(request: HttpRequest, invite: InviteRef | null, ctx: Ctx): Promise<HttpResponse>;
	/** Its callback: the verified subject, or undefined. */
	finish(request: HttpRequest, ctx: Ctx): Promise<{ subject: string; name?: string } | undefined>;
};
export const IdentityProviders = defineRegistry<IdentityProvider, ProviderTable>("people.identity-providers", { version: 1 });

// plugins/people/contract.web.ts: the join page renders one entry per provider
export type SignInOption = { readonly provider: string; readonly Button: ComponentType<{ invite: InviteRef | null }> };
export const SignInOptions = defineRegistry<SignInOption, readonly SignInOption[]>("people.sign-in-options", { version: 1 });

// plugins/people/contract.tui.ts: the terminal client offers each flow when it has no sign-in yet
export type TuiSignIn = { readonly provider: string; readonly label: string; run(io: TuiIo, ctx: Ctx): Promise<SignInToken | undefined> };
export const TuiSignIns = defineRegistry<TuiSignIn, readonly TuiSignIn[]>("people.tui-sign-ins", { version: 1 });
```

- **Built in:** `radius` (while the Pi is connected to Radius: Radius signs the person in, with Google or GitHub at
  Radius, and forwards the verified email, as p2's guests by email work today) and `device` (a cookie in this
  browser; a token file in this terminal, `~/.pi/clients/<pi>.json`, mode 0600, sent as a bearer header).
- **OAuth directly at Google or GitHub** would need every Pi registered as an OAuth client at its own address (and
  Google refuses private LAN addresses): impractical; it happens at Radius once for everyone.
- **More devices:** sign in through the same provider, or pair: on a signed-in device "Add device" shows a code or QR
  code; the new browser or terminal polls and gets a sign-in for the same subject (kit pairing, generalized,
  chapter VIII). A terminal can also `pi join <link>`.
- **Without Radius** (a LAN-only Pi) only `device` remains.
- **The owner invites from the terminal too:** `/invite Tanja family:member` prints the link and a QR code.

# The Session Check {#access lede="One question every session view and object asks: may this principal see or send here?"}

The sessions plugin creates sessions and records each one's facts (app, creator), fixed at creation, in memory on
the server (one small row per session).

```ts
// PROPOSED · plugins/sessions
export type SessionFacts = {
	readonly id: string;
	readonly app: string;                                                         // exactly one
	readonly creator: { readonly kind: "owner" } | { readonly kind: "person"; readonly id: string };
};
export type Access = { readonly see: boolean; readonly send: boolean };

export function access(p: P3Principal, s: SessionFacts, facts: SessionIndex, apps: AppTable): Access {
	if (p.kind === "owner" || p.kind === "server") return ALL;
	if (p.kind === "worker") {
		if (p.session === s.id) return ALL;
		const own = facts.get(p.session);                                         // another session's agent asks as its creator
		return own === undefined ? NONE : access(creatorPrincipal(own.creator), s, facts, apps);
	}
	const shared = Object.hasOwn(p.sessions, s.id)
		? { see: true, send: p.sessions[s.id] === "write" } : NONE;
	const byApp = apps.get(s.app)?.access(p, s) ?? NONE;
	return { see: shared.see || byApp.see, send: shared.send || byApp.send };   // a share never lowers an app role
}
```

- **Where it runs:** the session worker's route `authorize` (synchronous: the server holds the session index and the
  composed `Apps` table; until both are loaded it refuses persons), every object's factory on the server, sending
  methods, HTTP handlers (downloads, exports). Read-only means every mutating method requires `send`: sending,
  steering, stopping, uploads.
- **In the worker: open question 2.** `Apps` and the facts are server-side; a worker factory cannot read them.
- **Who checks what for a person:** transcript, composer, artifacts, files, search, export, downloads, cross-session
  tools. Objects not about sessions serve only the principals they know (deny by default): terminals, mail and
  settings serve the owner and the host's own code (`server`, `worker`); a person holding them gets `forbidden`.
- **What a person sees:** their page opens the layout of their app (one app: straight in; several: a switcher). A
  person with only shared sessions lands on the shared session's transcript in the layout of the session's app, cut
  to that session; global panes dropped.

# Apps {#apps lede="An app is a plugin that contributes itself; it owns its sessions' rules and defaults."}

```ts
// PROPOSED · plugins/apps (defines and serves the registry; one app per id, a duplicate reported)
export type AppContribution = {
	readonly id: string;
	readonly title: string;
	readonly roles: readonly string[];
	readonly otherPlugins: "on" | "off";
	readonly layout: (principal: P3Principal) => Layout;                  // served to the page by `AppLayout { app }`
	readonly access: (principal: P3Principal, session: SessionFacts) => Access;   // synchronous: roles are in the principal
	readonly locks?: LockValues;                                          // the app's defaults for its sessions (chapter V)
};
export const Apps = defineRegistry<AppContribution, AppTable>("p3.apps", { version: 1 });
host.serve(Apps, { compose: (table, { report }) => keyedEntries(table, (app) => ({ [app.id]: app }), report) });
```

- **Belonging:** every session has exactly one app; sessions created without one belong to coding; the owner can move
  a session to another app (its rules switch with it).
- **Showing:** any app may show any session (an overview app listing all sessions, the family app showing Leo's
  robot session); the session's own app's rules apply wherever it is shown.
- **Creating sessions for persons:** through the app's own objects (a coach's `Matches.open`), never the owner's
  session service; the app passes the creator explicitly (`{ kind: "person", id }` from the principal its remote
  object got), because its local store acts as the server.
- **Reaching other plugins for persons:** a remote object keeps its caller's principal on `self.get` (Chord §4); only
  a `local` object acts as the host. So an app gives persons a slice of another plugin through its own local store;
  a plugin reused that way offers a `local` service (or a variant for `server`).

# Locks {#locks lede="A plugin declares what can be switched off or limited, registers it, and enforces it where it hands things out."}

```ts
// PROPOSED · @p3/v1
export type Lock<T> = {
	readonly id: string;                       // "coding.bash"
	readonly title: string;
	readonly schema: Schema<T>;                // JSON Schema underneath: the sheet and Radius build controls from it
	readonly open: T;                          // no restriction
	readonly closed: T;                        // the most restrictive value
	narrow(upper: T, lower: T): T;             // a lower layer only narrows
};
export function defineSwitch(id: string, title: string): Lock<boolean>;   // open true, closed false, narrow a && b
export function defineLimit<T>(id: string, shape: Omit<Lock<T>, "id">): Lock<T>;

/** Server registry: every lock of every loaded plugin (facets contribute; host-lifetime objects may, rarely). */
export const Locks = defineRegistry<readonly Lock<unknown>[], LockTable>("locks.locks", { version: 1 });

/** Worker: this session's effective value, all layers narrowed, live. */
export function lockValue<T>(self: Self, lock: Lock<T>): Readable<T>;
/** Server: the same for any session. */
export function lockValueFor<T>(self: Self, lock: Lock<T>, session: string): Readable<T>;

// Two string formats for values that name things (pi-schema has `str({ format })`; checked with compile's formats):
export const glob = () => str({ format: "p3.glob", minLength: 1 });                 // "linear__*"
export const ref = (kind: HostKind) => str({ format: `p3.ref:${kind.name}` });       // an id of that kind
```

## What a plugin writes

```ts
// plugins/coding-tools/contract.ts
export const BashLock = defineSwitch("coding.bash", "Shell commands (bash)");
// plugins/coding-tools/server.ts: registered with the server, so the sheet and Radius know it with no worker running
self.contribute(Locks, [BashLock]);
// plugins/coding-tools/worker.ts: enforced where the tool is handed out
host.serve(CodingTools, (_params, self) => {
	const bash = lockValue(self, BashLock);
	const extension = self.writable(codingExtension({ bash: bash.value }));
	self.on(bash, ({ value }) => extension.set(codingExtension({ bash: value })));
	self.contribute(HarnessExtensions, extension);
	return {};
});
```

## The locks discussed today

| Lock | Plugin | Value | Enforced where |
| --- | --- | --- | --- |
| `coding.bash` | coding-tools | switch | the extension leaves bash out |
| `conversations.reach` | conversations | `ref(Session)[]` or null | list shows only those; send refuses others |
| `terminals.use` | terminals | switch | `Terminals.open` (pane and agent tool both go through it); state `allowed` hides the button |
| `mcp.servers` | mcp | `ref(McpServer)[]` or null; project servers as `project:<name>` | placement starts only those |
| `mcp.tools` | mcp | `glob()[]` or null (`linear__*`) | the worker extension offers only those |
| `mcp.project` | mcp | switch | `.pi/mcp.json` servers placed at all |
| `prompt.instructions` | prompt | sources `instance` / `environment` / `project` | which AGENTS.md are loaded |
| `prompt.skills`, `prompt.templates` | prompt | `glob()[]` with source prefix (`project:*`) | loading, listing and `/name` expansion |
| `locations.places` | locations | `{ environment: ref(Environment), cwd }[]` | every move, every spawn with `cwd`/`env` |
| `subagents.use`, `subagents.environments` | subagents | switch; environments | spawn and moves of subagents |

- **Subagents** run in the session's worker, so every session lock applies to them too; their tool choice is a subset
  of the caller's.
- **cwd is not confinement:** a place decides which instructions and skills load; only an environment (a sandbox
  with that folder) confines.
- **Runtime things are values, not locks:** locks are declared statically (in the facet, so Radius's sandbox sees
  them); servers, tools, skills that exist only at runtime are values in them. A plugin may contribute locks from a
  host-lifetime object (`self.writable`) if it must; Radius then learns them only from reports.
- **A plugin that declares a lock but does not enforce it** is a bug in trusted code.

## How the sheet knows what to show

- The sheet's object on the server (`LockSheet { scope }`, owner only) serves every registered lock with its plugin,
  title and JSON Schema, the values per layer with who set them, the effective value, and stored values of locks no
  plugin declares now ("missing", no effect). `set({ lock, value })` checks the value against the schema.
- **Controls from the schema:** a switch is a toggle; `ref(Session)` uses a picker from `RefPickers` (contributed by
  the plugin that owns the kind: sessions, environments, MCP servers); a place combines the environment picker and a
  folder browser on that environment (text when it is unreachable); `glob()` is a text field. A plugin may contribute
  its own editor (`LockEditors`).
- **Every editor offers what it can render:** where no picker exists (Radius has no picker for a member's sessions),
  only `open` and `closed`.
- **The agent:** code-mode namespace `locks` (`locks_catalog`, `locks_set({ scope, lock, value })`), only from the
  owner's sessions; `locks.manage` is itself a lock.

# The Plugin Switch {#switch lede="Plugins outside Pi's own root can be switched off per app, as a whole, without declaring anything."}

- **Base or not** is where a plugin was loaded from: the kit's app root (`startServer({ root })`, shipped with Pi)
  or the user's root (`<dataDir>/plugins`, everything the owner or the agent installed, org plugins included).
- **Base plugins have no switch;** they declare locks for everything that matters (we maintain them).
- **Every other plugin has a switch per app,** declared or not, locks or not (locks come on top, for finer control
  where the plugin is on). An app's default for plugins it does not know is its `otherPlugins` flag; on every
  install the owner (or the agent) chooses the apps: "Enable weather in [x] Coding [ ] Robot", pre-filled from the
  flags; the choice is stored in each app's configuration.
- **What the switch does:** every worker still loads every plugin (Chord gives all workers of a kind one plugin set).
  The base leaves a switched-off plugin's contributions out of the registries it owns, for that session: the
  harness (extensions with tools, sections, hooks, wraps, tasks; environment and model providers) and the page
  (panes, slots, commands of panes of that session). The plugin's objects and routines still run; nothing reaches
  them through switched-off contributions, and persons are denied by default anyway. Owners of other registries use
  `pluginAllowed(self, plugin)`.

# Layers and Sheets {#layers lede="company > Pi > app > session; only narrowing; one sheet per scope."}

| Layer | Set by | Stored |
| --- | --- | --- |
| company | the org profile (Radius, signed; initial copy on disk) | the profile cache |
| Pi | the owner's Pi sheet ("no bash on this Pi") | server |
| app | the app's code (`locks`, `otherPlugins`), then the owner's app sheet over it | server, per app |
| session | the owner's session sheet | server, keyed by `Session` |

`effective = narrow(company, narrow(pi, narrow(app, session)))`, applied per lock; plugin switches the same way. The
owner may change an app's defaults in either direction within the company and Pi values; a session only narrows.
Every sheet shows the upper layers' values read-only next to its own.

# Companies {#company lede="The org profile is the top layer; Radius learns the locks."}

- **Enrollment** (from `org-managed/book.md`, still valid): an admin-owned file `/etc/p3/enrollment.json` (org,
  server, org key, allowed plugin sources; optionally an initial profile); the Pi stays locked until its first sync
  delivered a signed profile, then works from the cache and follows changes live. Gate states `unmanaged`,
  `pending`, `ready`, `stale`, `revoked`. Machine lock-down (service user, signed executable, gondolin sandboxes, a
  device key) as written there.
- **The profile:** the plugin list (`required`, `allowed`, `blocked`) and lock values by id:

```jsonc
// PROPOSED · part of Acme's profile for a member's Pi
{
  "plugins": { "required": ["@earendil/linear"], "blocked": ["@someone/drive"] },
  "locks": { "coding.bash": false, "subagents.environments": ["acme-sandbox"], "conversations.reach": null }
}
```

- **Applied on the Pi** as the company layer: a value is checked against the schema its own plugin declares; a value
  that does not match gives `closed`; an id no plugin declares stays "missing".
- **How Radius knows the locks:** member Pis report their `Locks` (id, plugin, version, title, JSON Schema) on every
  sync; and Radius loads selected plugins' server facets in a sandbox (as `testPlugin` collects contributions) to read
  their locks before anyone installed them; locks contributed at runtime by objects only come through reports.
- **Radius renders** switches and fixed lists; for references to a member's things (sessions) only `open`/`closed`.

# What the Kit Must Add {#kit lede="Six changes, with the review findings folded in; Chord's core stays."}

1. **Sign-ins name a subject; the app resolves the current principal at every use.** `SignIns.issue({ subject,
   label, kind })`; `startServer({ signIns: { resolve(subject, ctx) → P | null } })`, resolved through a registry the
   people plugin contributes (so it stays reloadable). The owner's sign-ins have the subject `{ owner: true }`.
2. **Revocation from plugins and in workers:** `revokedBy` for `startServer` and `startWorker` (the same function);
   a server-local `Revocations.revoke(r)`.
3. **No stale admission:** a link whose principal was resolved before a revocation must not be accepted after it:
   re-resolve right before `host.accept` (no gap) and close the link if the principal changed; HTTP requests check
   the current revision before protected work.
4. **Removing one device ends its open links:** the links endpoint records the sign-in per link (as it does for
   ephemeral sign-ins); `SignIns.revoke(id)` closes them.
5. **Pairing for any subject:** a signed-in principal confirms a pairing code for its own subject; the poll returns a
   bearer token (terminal) or completes with the sign-in cookie (browser).
6. **Authentication precedence** set in one place (the kit takes the first authenticator by plugin name today):
   identity providers redeem into the common sign-in; a direct Radius authentication, if kept, has a fixed order.

Separately in Chord (found by Sol, needed anyway): a variant change within one round trip (A → B → C before B is
acknowledged) can decode a call with the wrong method table (`remote/hold.ts #bindTo` keeps one previous binding);
fence per acknowledgement or do not send the next binding before the previous one is acknowledged.

# One App in Full: the Football Club {#club lede="Roles coach and player, a roster coaches change, match sessions everyone joins, locks for the agent."}

```ts
// PROPOSED · plugins/club/contract.ts
export const Club = defineApp("club", { roles: ["coach", "player"] as const, otherPlugins: "off" });
export const Player = obj({ id: str(), name: str(), position: str() });
export const Roster = remote("club.roster", { version: 1, params: {}, hostAddress: () => Server(), variants: {
	coach: { state: { players: arr(Player) }, methods: { put: method(Player), remove: method(obj({ id: str() })) } },
	player: { state: { players: arr(Player) } },
} });
export const Matches = remote("club.matches", { version: 1, params: {}, hostAddress: () => Server(), variants: {
	coach: { state: { sessions: arr(str()) }, methods: { open: method(obj({ title: str() }), str()) } },
	player: { state: { sessions: arr(str()) } },
} });
```

```ts
// PROPOSED · plugins/club/server.ts
const Players = defineTable("club.players", { version: 1, columns: { id: str(), name: str(), position: str() }, key: ["id"] });
const ROSTER_MAX = 200;                                                          // a club roster's size; the live query's limit

const ClubStore = local("club.store", { version: 1, params: {}, members: {
	players: arr(Player), sessions: arr(str()),
	put: method(Player), remove: method(obj({ id: str() })),
	open: method(obj({ title: str(), creator: str() }), str()),
} });

export default defineFacet((host) => {
	host.serve(ClubStore, (_params, self) => {
		const players = self.table(Players);
		const sessions = self.get(Sessions, {});
		self.contribute(Apps, {
			id: Club.id, title: "Football club", roles: Club.roles, otherPlugins: "off",
			layout: () => [{ kind: "club.home" }],
			access: (p) => (Club.roleOf(p) === undefined ? NONE : ALL),          // every club person talks in its match sessions
			locks: { "coding.bash": false, "prompt.instructions": ["project"], "locations.places": [{ environment: "club-box", cwd: "/srv/club" }] },
		});
		return {
			players: self.query(players, query(Players), ROSTER_MAX),
			sessions: sessions.byApp.at(Club.id),
			put: async (player, ctx) => { await self.tx(async (tx) => { tx.put(players, player); }, ctx); return null; },
			remove: async ({ id }, ctx) => { await self.tx(async (tx) => { tx.delete(players, { id }); }, ctx); return null; },
			open: async ({ title, creator }, ctx) =>
				(await sessions.create({ app: Club.id, title, creator: { kind: "person", id: creator } }, ctx)).id,
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
		const creator = principal.kind === "person" ? principal.id : "owner";
		return roleOf(principal) === "coach"
			? { variant: "coach", members: { sessions: store.sessions, open: ({ title }, ctx) => store.open({ title, creator }, ctx) } }
			: { variant: "player", members: { sessions: store.sessions } };
	});
});
```

```tsx
// PROPOSED · plugins/club/web.tsx
export default defineFacet((_host, self) => {
	self.contribute(WebViews, { "club.home": () => <ClubHome /> });
});
function ClubHome() {
	const roster = useHold(Roster, {});
	const matches = useHold(Matches, {});
	const players = useWatch(roster.players) ?? [];
	const sessions = useWatch(matches.sessions) ?? [];
	return (
		<Split>
			<List title="Team">{players.map((p) => <Row key={p.id} title={p.name} detail={p.position}
				actions={roster.variant === "coach" ? [{ label: "Remove", run: (ctx) => roster.remove({ id: p.id }, ctx) }] : []} />)}</List>
			<List title="Matches">{sessions.map((id) => <SessionRow key={id} session={id} />)}
				{matches.variant === "coach" && <Button onClick={(ctx) => matches.open({ title: "Next match" }, ctx)}>New match</Button>}</List>
		</Split>
	);
}
```

The club needs no worker facet: its sessions' agent is restricted by the locks it contributes (no bash, only the
club folder's instructions, one place) and `otherPlugins: "off"` (no third-party tool reaches a match session unless
the owner switches it on for the club).

**The flow:** the owner invites Max with club: player; Max opens the link, taps "Continue with Radius" (Google at
Radius), lands in the club: the team, the matches, no buttons. The owner makes him coach: revision up, Max's pages
reconnect, Remove and New match appear. Max holds `Terminals` directly: `forbidden`. A match session's transcript is
the ordinary one; the session check lets every club person send there; its agent has no shell.

# Review Findings {#review lede="The three reviews of the first edition (Opus, Astra, Sol), and where each went."}

| Finding | Where it went |
| --- | --- |
| `json` columns need `{ version }` | chapter III |
| removal must delete the row (or flag it), invalidate invites, revoke sign-ins | chapter III |
| `revokedBy` also for workers | kit change 2 |
| stale admission across a revocation | kit change 3 |
| removing one device leaves its links open | kit change 4 |
| browser pairing returns no cookie | kit change 5 |
| authentication precedence | kit change 6 |
| the worker cannot evaluate app rules | open question 2 |
| players got the owner's agent with bash | the club's locks and `otherPlugins: "off"` |
| a share lowered an app role | `access` takes the larger |
| returning people without an invite | `start(…, invite: null)`, `finish` finds the identity |
| match sessions had no creator | `Matches` passes it to `ClubStore.open` |
| methods returned `undefined` | `return null` |
| shared-session-only landing | chapter IV |
| roster query silently capped | `ROSTER_MAX`, named |
| `Apps` without a provider | chapter V |

# Open Questions {.epilogue}

1. **Slots of switched-on third-party plugins in reused views** (the drive button in the robot's transcript, when
   drive is on for the robot): the reviewers proposed "only for the owner unless the app names it", which conflicts
   with apps not naming other plugins. Alternative: shown to persons too; its backing object decides (a broken
   button where it serves only the owner).
2. **The session check in the worker:** (a) the session facts in the worker's start data and each app's `access` as a
   pure module the worker loads too; (b) a Chord change: a factory may read an already composed registry value; (c)
   the worker asks the server, persons get one variant and a check per call.
3. **The page with several sessions** must compose panes, slots and commands per session (plugin switches, locks):
   a mechanism of the page, not designed yet.
4. **Complexity:** the owner finds it "still overly complex". Candidates to cut: the Pi layer (the owner can set the
   same on each app), `LockEditors` (pickers only), runtime-contributed locks, `otherPlugins` (always off for apps
   that set locks?), separate `sessions` in the principal (a share as a one-session role?).
