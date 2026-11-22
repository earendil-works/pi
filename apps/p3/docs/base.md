# p3's base (branch `skeleton`, 2026-11-22)

What the base gives every plugin, so the team builds the Pi Next features on it and anyone writes an app as plugins.
Decided by Mario's agent with Fable and Astra, on Mario's request ("you make all the decisions"). The skeleton on
main (`7e0e34563`) is the starting point; this branch changes it where needed. Everything below is PROPOSED until
the section "Built" lists it.

## Words

| Word | Means |
| --- | --- |
| **owner** | the person who owns the Pi, a person with the owner flag; reaches and changes everything |
| **person** | anyone who signs in, the owner among them |
| **group** | persons, made by an app for one of its roles (coaches, players) |
| **app** | a plugin that owns the page below the top bar, and its sessions |
| **session** | one agent working in one folder of one environment, with its members and its things. The page may call it a workspace; in code it is the session, one id |
| **member** | a person or a group in a session, who reads or writes |
| **thing** | something a plugin brings that a session can have: a tool, a model login, an MCP server. Added with options |
| **view** | a React component a plugin offers for something to show; apps place views |
| **environment** | a machine sessions work on. This device is made at the server's first start |
| **location** | where a session works: an environment and a folder |

## Working in a session, and managing it

Working is reading or writing: seeing the transcript, sending, using the views of its things. Managing is choosing
who is in it, what it has and where it works (members, things, location, title, archive).

- **The owner** is a person whose row in the people plugin says so (made at the server's first start, named after
  the OS user, never removed). They work in and manage every session, and are a member of groups and sessions like
  anyone, with options of their own. Owner rights are data read live (`SessionAccess`, `AppAccess`, `admitOwner`):
  no plugin tells the owner apart by the principal, which is a person's like everyone's.
- **Any other person** works in a session as one of its members says: `write` wins over `read`, a direct membership and one
  through a group count alike. A person who writes may also **bring their own things** into it (their mail, their
  calendar: records a kind's plugin says are theirs), and withdraw or set the options of what they brought. A person
  manages nothing else (members, the location, the owner's things).
- **What anyone brings, everyone in the session uses**, through its views and through the agent: a guest who writes
  can have the agent read the mail another member brought. What each person sees and may do in a thing's view is that
  thing's admission (`admitThing`: their access and the options that apply to them). Removing a member removes the
  things they brought.
- **An app manages its sessions in its server code** (`SessionsStore`, server only), and gives its people the
  narrower actions it wants as objects of its own ("a player starts a chat with the coaches").
- **A session's worker** works in its own session only.

`Sessions.create({ app, title, location, members, things })` writes the session, its members and its things in one
commit. An app's server code may leave out the location: the session then works on this device in a folder the
sessions plugin makes for it.

**An app's own objects** (the club's board, "a player starts a chat with the coaches") use `admitApp(app)`: the
factory gets `{ kind: "person", id, owner, groups }`: whether they are the owner, and the names of the app's groups
they are in (their roles); a person who may not enter the app is denied. The owner's own objects (`Sessions`,
`People`, `Environments`, ...) use `admitOwner`: allowed while the caller's row says owner.

## One question for every object: `admitSession`

A plugin never reads a principal. A session's object declares the admission value `SessionAdmission` (`{ access:
"read" | "write" }`) and `admitSession` as its admission; its factory gets the caller's access:

```ts
export const Notes = remote("notes.notes", { version: 1, params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }), admission: SessionAdmission,
	variants: { reader: { … }, writer: { … } } });
host.serve(Notes, (params, _principal, { access }, self) => (access === "write" ? writer : reader), { admit: admitSession });
```

The sessions plugin answers it (`SessionAccess`, live). A member removed, a group changed, a session archived: the
caller's object is rebuilt or denied at once (Chord's admission).

**The route asks the same question before it starts anything** (`src/server.ts`): no worker starts for a caller who
would be denied; a worker never reaches another session's worker; the server's waker reaches a session that is not
archived. An archived session starts for the owner only.

## Things (decided with Mario, 2026-11-23; BEING BUILT, replaces the per-kind records model)

- **A thing has one id.** It is a record of its kind (a canvas, a notebook, a login, an inbox, this machine's coding
  tools). Its kind's plugin keeps its content, keyed by that id. It has a name (on the thing, the same everywhere).
- **A thing belongs to a person, a group, the Pi, or nobody.** Ownership is the base's (the sessions plugin's things
  store), never a kind's: no kind keeps an owner column. A group's members may create, bring and manage the group's
  things; only the owner manages the Pi's.
- **A session uses things:** a link `(session, thing)`. Per link: who brought it, and its options per party. The same
  thing may be in several sessions (the same canvas, the same drawing), with different options in each.
- **Content and resources.** Canvases and notes are made all the time, mostly by the agent: they belong to nobody and
  live in the sessions that use them; a thing nobody owns is gone when no session uses it. Logins, inboxes, machines
  are made on purpose for a person, a group or the Pi, often with a creation step (a sign-in).
- **Creating:** one "Add" in the session sheet: a new thing of a kind (the base's creation dialog; a kind may bring
  its own creation view, e.g. a sign-in), for nobody (this session's content, the default), me, one of my groups, or
  (the owner) the Pi; or an owned thing of mine, my groups' or (the owner) the Pi's, picked by the session it is in or
  by search. The coding tools are one Pi-owned thing the tools plugin creates at install.
- **Giving an owner ("keep"):** a writer in a session that has an unowned thing gives it to themselves, a group they
  are in, or (the owner) the Pi; it stays in the session. After that only its owner renames, deletes or gives it away.
- **The agent** creates things (each kind's create tool), for nobody by default, or for a person or group that is a
  member of the session, or the Pi when the owner is a member; a base tool lists whom it may create for; the server
  checks again. It may keep unowned things under the same limits. It never sets options.
- **Options** belong to the link: one whole object per party (everyone, the agent, a member), typed by the kind;
  exactly one applies (own, first group in member order, everyone; the agent its own). New links get the kind's
  initial options. A reader is always a reader; what an option means for a writer is the kind's one line (a base
  helper makes it hard to get wrong). Unknown versions give nothing; `migrate` as before.
- A thing's objects take `{ session, thing }` and use `admitThing(Kind)` (access and the options that apply).

## What the agent gets

The agent is Durable's harness in the session's worker (plugin `harness`). **It gets exactly its session's things**:
each kind's plugin contributes `ThingExtensions` (`thingExtension(Kind, (things, agent) => ({ extension, providers }))`:
one Durable extension for all the session's things of the kind, its tools taking a thing's id (a list tool, `canvas_list`,
names them; descriptions are fixed text), and model providers; `agent.call(fn, context)` runs
`fn` as the session's worker, so a tool reaches its plugin's objects). Installing a plugin gives no session anything; there is no global tools registry. A session without
a login thing has no model.

The selection is applied before the harness resumes and before every submit: work starts only through the harness
(`SessionHarness.submit`), which waits until the agent's tools match what the server last said. A thing removed
while a tool call runs: that call finishes; no task phase that starts after the worker applied the removal sees the
tool (Durable resolves tools per task phase). A worker whose kind's plugin is of another version than the stored
options gives that thing nothing (no tools, no providers) until they agree. A session's location never changes while
a tool call runs. An archived session's worker opens its transcript without scheduling any work. The session is
reported `working` before Durable accepts an input, so a crash in between leaves it for the waker.

## Apps and the page

- **Server:** `Apps` (id, title, `chrome: "bar" | "button"`). A person may enter an app when they are in one of its
  groups or a member of one of its sessions; the owner enters every app. `AppCatalog` gives each caller the apps they may enter.
- **Page:** `AppPages` (app id, `Page` component). Everything below the top bar is the app's: it composes views and
  services (the session list, new session, the transcript, a session's things).
- **The top bar** (plugin `chrome`): app switcher, person menu, connection state. An app chooses statically: the full
  bar (`bar`) or one corner button (`button`, Leo's robot). An app that throws shows its error below the bar; the bar
  stays.
- **Routing:** `/<app>/<rest>`; the chrome owns the first segment, the app gets `useRoute()` and `navigate()` for the
  rest.
- **Views** are typed tokens: `defineView<Props>(name)` in a contract file, one `Views` contribution per view,
  `useView(Token)` returns its component. A kind's views: `ThingViews`; `<ThingView session thing />` renders the
  right one, so an app never knows kinds. What a session holds is a view an app opens on demand (`SessionThingsView`),
  never an always-shown strip.

## Registries

| Registry | Host | Contributed by |
| --- | --- | --- |
| `Apps` | server | each app |
| `ThingKinds` | server | each kind's plugin: its title and the things of the kind a caller may add |
| `ThingExtensions` | worker | each kind's plugin: the agent's extension and providers for one thing |
| `ExecutionEnvironments` | worker | the environments plugin: an `ExecutionEnv` for a location |
| `SessionHarness` | worker | the harness: the open Durable harness, for the transcript and others |
| `AppPages`, `Views`, `ThingViews` | page | apps, views' plugins, kinds' plugins |
| `PageRoot` | page | the chrome (the one component the base renders) |
| (base, as on main) `WorkerRunners`, `WorkerRunnerWraps`, `WorkerBusy`, `ServerCommands`, `LinkOpened` | | |

## Plugins

| Plugin | Owns |
| --- | --- |
| `sign-in` | sign-ins; the owner link (as on main, with the reload gap closed) |
| `people` | persons and groups; `Me`; invite links that make a person and sign them in |
| `environments` | environments; this device; `ExecutionEnvironments` |
| `sessions` | sessions (app, title, location, state), their members and things; `SessionAccess`; the waker |
| `apps` | `Apps`, `AppCatalog` |
| `harness` | Durable in the worker, `ThingExtensions`, the activity report |
| `transcript` | a session's conversation as people see it; its view |
| `tools` | the coding tools as a kind of thing (`tools.coding`, options `{ shell: boolean }`) |
| `chrome` | the page's frame: the top bar and the chosen app's page |
| `coding` | the coding app: its sessions, new session, the transcript |
| `runner`, `control` | as on main |

## The page

Elanor as Inkling uses it, from npm, pinned together (`@earendil-works/elanor-react` 0.1.1, `design-tokens` 0.1.0,
`elanor-fonts` 0.1.0, `elanor-icons-react` 0.1.0): the base's stylesheet declares `@layer reset, elanor;`, Elanor's
component styles from `elanor.min.css`, plugins' CSS modules unlayered and winning; the server serves Elanor's fonts
at `/fonts/elanor/` and the `pi` brand tokens at `/tokens.css` as stable files (the owner link's page links
them too); light and dark follow the system. React, Elanor and its icons are host packages of the `web` kind, so a
third party's plugin type-checks against the versions p3 ships.

## Out of the base, for later packages

Sharing UI and guest links beyond invites (ERNDL-717, ERNDL-706); real provider logins (ERNDL-705); layouts with
splits and drag (ERNDL-696); the file, diff and terminal views (ERNDL-796); MCP (ERNDL-725). Each plugs into the
registries above without a base change.

## Two examples (PROPOSED until the acceptance test wrote them)

A kind of thing, notes, with a view and a tool:

```ts
// notes/contract.ts
export const NotesKind = defineThing("notes.notes", { version: 1, options: obj({ edit: bool() }), initial: { edit: true } });
export const Notes = remote("notes.view", { version: 1, params: { session: str(), thing: str() },
	hostAddress: ({ session }) => Session({ id: session }), admission: thingAdmission(NotesKind),
	variants: { reader: { state: { text: str() } }, editor: { state: { text: str() }, methods: { write: method(str()) } } } });
// notes/worker.ts
host.serve(Notes, ({ thing }, _p, { access, options }, self) =>
	access === "write" && options.edit ? editor(thing, self) : reader(thing, self), { admit: admitThing(NotesKind) });
self.contribute(ThingExtensions, thingExtension(NotesKind, (thing, agent) => ({ extension: defineExtension({
	name: "notes", tools: [defineTool({ name: "notes_write", parameters: obj({ text: str() }),
		execute: async ({ text }, _api, context) => { await agent.call(async (ctx) => (await ctx.get(NotesStore, {})).write({ thing: thing.thing, text }, ctx), context); return {}; } })] }) })));
// notes/web.tsx: self.contribute(ThingViews, { kind: NotesKind.name, View: NotesView })
```

An app, a club without a sidebar: coaches and players are its groups; a player's chat is a session with the coaches.

```ts
// club/server.ts
self.contribute(Apps, { id: "club", title: "Club", chrome: "bar" });
host.serve(Club, (_params, _p, who, self) => ({ variant: "club", members: {
	startChat: async (_args, ctx) => {
		if (who.kind !== "person" || !who.groups.includes("players")) throw forbidden("players start chats");
		const store = self.get(SessionsStore, {});
		const coaches = await (await ctx.get(PeopleStore, {})).group({ app: "club", name: "coaches" }, ctx);
		return store.create({ app: "club", title: "Chat", members: [{ kind: "person", id: who.id, access: "write" },
			{ kind: "group", id: coaches, access: "write" }], things: [thingOf(NotesKind, { name: "Plan" })] }, ctx);
	} } }), { admit: admitApp("club") });
// club/web.tsx: self.contribute(AppPages, { app: "club", Page: ClubPage }) — ClubPage places TranscriptView and <ThingView>.
```

## Acceptance

A fresh agent gets only the installed `/v1` API and this file and writes, in `test/plugins/`, an app without a
sidebar and one kind of thing with a view and a tool. Then the test reloads it while two people are connected,
removes one person, and restarts the server mid-call. A base edit or a plugin-specific permission check fails it.

## Decided, from the reviews (2026-11-22)

- Fable 1, Astra 3: whole options objects, one applies, no merging, no fallback to defaults on unknown data.
- Fable 2: `admitSession` and `admitThing` are the whole admission; params `{ session }` and `{ session, thing }`.
- Fable 3, Astra 4: no global extensions registry; the agent gets its things.
- Fable 4: `ThingKinds` lists; making and removing a thing's record stays in its plugin.
- Fable 5, Astra 6: views as typed tokens registered once; `ThingViews` per kind; `<ThingView>`.
- Fable 6: the top bar's form is static per app.
- Fable 7, Astra 2: the route asks the session's access before it starts a worker; `admitSession` of `src/server.ts`
  becomes `admitRoute`; `Creator` and `CODING` go; `names.md` changes with this branch.
- Astra 1: working and managing are separate; creation is one commit.
- Astra 2: the sign-in reload gap (a link opened while the plugin reloads is tracked by nobody) is closed: the link
  hook reads the request's token itself.
- Astra 5: the waker skips archived sessions and starts at most four workers at once.
- Fable, review of the contracts: `admitApp` for an app's own objects (the apps plugin answers `AppAccess`);
  `thingExtension(Kind, give)` typed, with `agent.call`; the location optional for apps; `ThingKindCatalog` for the
  page (records of a kind come with logins, ERNDL-705) and `thingOf(Kind, { name?, options?, ref? })`; a kind's `migrate`; one
  `Party` for who a member is; `Harness`, `StoreStorage`, `createRegistry`, `createModels` in `/v1/worker` are p3's
  own and outside the promise.
- Mario (2026-11-22): write members bring their own things and views; `BringThings`, `ThingKinds.records`, a
  thing's `by`; a removed member's brought things go with them.
- Astra, review of the contracts: anyone may ask the access answer about themselves (an admission asks as its
  object's caller); `ThingAccess` and `admitThing` carry the thing's `ref`; a worker matches its kind's version
  before it gives a thing anything; work starts only through `SessionHarness.submit`; an archived session opens
  without scheduling; a signed-in link no sign-in tracks is closed at once (`src/server.ts`); the page's rollout step
  always runs (the paged switch could leave a page on old scripts); a direct session member enters its app.
- Fable's cuts: per-key merging, owner-made groups, a deployment theme file.
