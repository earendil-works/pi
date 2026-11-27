# The kind pattern: how every p3 kind plugin is built

One pattern for every feature built as a kind of thing, so each built-in plugin is an example for the next. It adds
nothing to the rules of the other guides; it says which file, which name, which helper, and names the file on main
that shows each point. Paths are under `apps/p3/plugins/`. Notes (`notes/`) is the reference kind: where no other
example is named, the example is there. Copy it to start a kind.

"Guide 5.2" is a line of the checklist in [ERNDL-1148 10 · Guide: building features as
things](https://linear.app/earendil/issue/ERNDL-1148); "API §4" a section of [ERNDL-1141 0 · The API of things,
workspaces and access, complete, as code](https://linear.app/earendil/issue/ERNDL-1141); decisions are cited by number
(`decisions.md` and the issues).

**Being changed** (the text says so where it applies; follow main until the change lands):

- **Imports of the things layer.** On main a kind imports `../things/kind.ts`, `../things/serve.ts`,
  `../things/contract.worker.ts`, `../things/contract.web.tsx` by path. Decision 139: every facet will import them
  through `@earendil-works/p3/v1`, `/v1/server`, `/v1/worker`, `/v1/web`, as a third party does, and the "never
  through `/v1/web`" comments go.
- **List members.** `listOf(Row)` (a list member's shape) and `whileFollowed(schema)` (a member kept live only while
  someone watches it) come with [ERNDL-1180 Chord: state no holder watches does not run or cross the
  link](https://linear.app/earendil/issue/ERNDL-1180) (decisions 138, 141). Until then a list member is `obj({ rows:
  arr(Row), moreAfter: bool() })`, as notes' `NotesPage`.
- **Harness parts with nothing held** (decision 142): section 6, "nothing held".

## 1. Files

```text
plugins/<plugin>/
  package.json            { "name": "@earendil-works/p3-<plugin>", "private": true, "type": "module" }
  kind.ts                 the kind: its schemas, defineThing, `export const <Thing> = <Thing>Kind.contract`
  messages.ts             defineMessages("<plugin>", …): tick labels, view texts, refusals
  store.ts                the kind's server store: its local contract, tables, named queries, writes, serveStore
  server.ts               the server facet: serveStore(host); serveThing(host, Kind, { … })
  worker.ts               the worker facet: the kind's harness part and its tools
  web.tsx                 the web facet: contributions only (Views, ThingParts, PluginTitles, Translations)
  <thing>-view.tsx        the view (+ <thing>-view.module.css)
  settings-form.tsx       the Settings form, if the kind has settings
  contract.ts             only if another plugin imports data of this one: schemas, constants, tokens
  contract.server.ts      only if another plugin's server code reaches this one: registries, local contracts
  <concept>.ts            one more concept, named after it (a shared read, a route, a registry)
  test/
    store.test.ts  server.test.ts  worker.test.ts  e2e.test.ts  messages.test.ts   (+ one per <concept>.ts)
```

| Rule | Example |
| --- | --- |
| One concept per file, named after it. A second concept is the reason for a file, size never is (a file may be long; three files of four lines are one file) | `prompt/set.ts` (one served object: the shared read of a set), `files/places.ts` (where a path is), `environments/ring.ts` |
| `kind.ts` holds the `defineThing` and everything only the kind needs (its schemas, its `…_WRITES` constants). A plugin with several kinds names each `<noun>-kind.ts` | `notes/kind.ts`; `prompt/instructions-kind.ts`, `prompt/skills-kind.ts` |
| `contract.ts` exists only for what other plugins import, and imports nothing but the API | `environments/contract.ts` (`MACHINE_KIND`, `TerminalRow`, imported by `terminals/kind.ts`) |
| The store's local contract lives in `store.ts` while only this plugin reads it; it moves to `contract.server.ts` as soon as another plugin or the API reads it (decision 120) | `notes/store.ts`; `providers/contract.server.ts`, `environments/contract.server.ts` |
| `server.ts`, `worker.ts`, `web.tsx` are facets: they declare (`host.serve`, `serveThing`, `self.contribute`) and hold the kind's own part of that host; a view, a route, a second served object get a file | `notes/server.ts`, `notes/web.tsx` with `notes/notes-view.tsx` |
| Web-only files are `.tsx` beside `web.tsx`; views are `<thing>-view.tsx` ("view", never "pane": `names.md`) | `notes/notes-view.tsx`, `checklist/checklist-view.tsx` |
| Tests sit in the plugin's `test/`, one file per source file, plus `e2e.test.ts`; stand-ins shared by several test files are a file there without `.test` | `notes/test/`; `environments/test/fake-machine.ts` |

## 2. The file header and the comments

- **First line of every file: a `//` comment that says what the file is for**, in the plugin's own words: what the
  concept is, what it guarantees, which other file has the rest. Three to seven lines. The header of `kind.ts` is the
  plugin's front page: what a thing of the kind is, who makes it, where it is linked, each tick and what it gives,
  what a new link starts with. Example: `notes/kind.ts`, `environments/kind.ts`,
  `files/transfers.ts` (a file with a protocol).
- **Every export has a doc comment** (`/** … */`, one line where one is enough) saying what it is or guarantees. A
  schema and its type share a name and each has one: `/** A note (see \`Note\`). */`. Example: `notes/store.ts`.
- **Every member of a contract that is not obvious has a doc comment** inside the declaration (methods: what it
  does, what it answers, when it refuses). Example: `notes/kind.ts`, `files/kind.ts`.
- **Inline comments say a why** (a cost, a race, a decided rule with its number), never what the next line does.
  Example: `notes/store.ts` (why `at` is made unique), `terminals/server.ts`.
- **Every named query's builder names its index** in a comment: `// Index \`by_time\`: \`notebook\` fixed, in the order
  of \`at\`, then the key.` Example: `notes/store.ts`.
- **A cast or a runtime check carries its reason**: the invariant TypeScript cannot say, or the trust boundary it
  serves. Example: `things/serve.ts`, `terminals/attach.ts`.
- Order in a file: imports, exported types and schemas, the public entry first, its helpers below in the order used,
  constants right above their first user. In a facet file the `export default defineFacet` is the entry.
- Decisions are cited by number ("decision 97", "item 113"), issues by key.

## 3. Declaring the kind (`kind.ts`)

```ts
// The notes kind (`notes.notes`): notebooks. Anyone, people and agents, may make one; it may be linked in any number
// of workspaces, its notes the same in each. Reading is for everyone let in; the one tick Write adds, edits and
// removes notes. Its one setting is the order.

/** What Write gives: the members a writer of a notebook is granted. */
export const NOTES_WRITES = ["add", "edit", "remove"] as const;

/** A notebook: … (what each member is for, per tick; what a new link starts with; what guests get). */
export const NotesKind = defineThing("notes.notes", {
	version: 1,
	makers: "anyone",
	state: { name: str(), order: NotesOrder, list: NotesPage },
	methods: { more: method(), page: …, add: …, edit: …, remove: … },   // each with its doc comment
	ticks: {
		// Members no tick gives (`name`, `order`, `list`, `more`, `page`) are there for everyone let in: reading.
		write: { label: messages.message("tickWrite"), gives: NOTES_WRITES },
	},
	defaultGrants: { everyone: ["write"], agents: ["write"], guests: [] },
	settings: ["order"],
});

/** One notebook held in a workspace: `NotesKind`'s contract. */
export const Notes = NotesKind.contract;
```

Notes' declaration, shortened (`notes/kind.ts`).

| Field | Rule | Example |
| --- | --- | --- |
| name | `<plugin>.<kind>`, lower case; the prefix is the plugin's name, which is also its messages namespace and the prefix of its stores and tables (guide 1.1) | `notes.notes`, `canvas.board`, `environments.machine` |
| `version` | the contract's; bumped with every change of members, never changed in place (guide 1.2, decision 125) | all |
| `makers` | always stated, chosen on purpose: `"anyone"` content; `"people"` a credential, money, outsiders, code; `"plugin"` only the kind's own plugin makes them, no person and no agent (guide 3.1) | `notes` anyone; `providers/kind.ts` people; `tools/kind.ts` plugin |
| `workspaces`, `stacking` | stated only when not the default (`"many"`, `"all"`). With `"all"` the part and the views handle several things; with `"nearest"` the part reads the last thing it gets | `files/kind.ts` (`"one"`, `"nearest"`) |
| members | plain members are what everyone let in may have: reads, and methods that change nothing stored. Say so in one comment in `ticks`, naming them (guide 1.13) | `notes/kind.ts` |
| `ticks` | named as verbs, never like a member (guide 1.11); each a `label` from `messages.ts` (`tick<Name>`); `for` only when not all; a tick's `gives` is an exported `as const` list when the view or the worker narrows by it; a tick without `gives` is a flag tick | one tick: notes; two: `checklist/kind.ts`; flag ticks, a people-only tick: `canvas/kind.ts`; agents-only flag ticks: `tools/kind.ts`; a member in two ticks: `terminals/kind.ts` |
| `defaultGrants` | `everyone`, `agents`: what a new link starts with; `[]` lets the party in with no tick. `guests` decided on purpose and written down: no key (not let in) or `[]` (plain members) (guide 2.3, 2.4) | notes; `environments/kind.ts` (`everyone: []`) |
| `settings` | names of state members; changed only through `configure` (guide 4.3) | notes `["order"]`; `prompt/instructions-kind.ts` |
| `create.input` | the schema of what the create step hands over; the store checks it before the hook runs; the hook checks only what the schema cannot say (a family type's own settings: `environments/machines.ts`). A kind without one takes no input | `providers/kind.ts`, `environments/kind.ts` |
| `ticksVersion`, `migrateTicks` | absent until a tick name changes meaning (guide 1.3 to 1.6) | `things/test/migration.test.ts` |
| the contract | `export const <Thing> = <Thing>Kind.contract`, the name every holder imports | all |

Any kind may seed one thing in Pi where it is served: `serveThing(…, { one: { name } })`; the name is data (people
rename it), and server code reads the thing's id through `OneThing { kind }`. Example: `files/server.ts`,
`environments/server.ts`; `prompt/server.ts` seeds a kind people make.

A family (machine, login: decision 117) is an ordinary kind whose plugin also owns a registry of types; the type's
plugin contributes label, settings schema and implementation and declares no ticks. Example today:
`environments/contract.server.ts` (`MachineType`, `MachineTypes`), `environments/this-device.ts`.

## 4. Serving it (`server.ts`, `store.ts`)

```ts
export default defineFacet((host) => {
	serveStore(host);

	serveThing(host, NotesKind, {
		// One notebook for one caller. The things plugin admitted them and decides which members they get.
		implement: ({ thing }, { caller }, self) => {
			const store = self.get(NotesStore, {});
			const list = self.list("notes", [[store.notes.of, args]], { first: PAGE });
			return {
				list: withNames(list.value, things, self),
				more: (ctx) => list.more(ctx),
				add: ({ text }, ctx) => store.add({ notebook: thing, text, author: caller }, ctx),
				// …
			};
		},
		configure: async (thing, settings, ctx) => (await ctx.get(NotesStore, {})).configure({ notebook: thing, ...settings }, ctx),
		delete: async (thing, ctx) => (await ctx.get(NotesStore, {})).clear({ notebook: thing }, ctx),
	});
});
```

| Point | Rule | Example |
| --- | --- | --- |
| hooks | in this order, the order of `ThingImplementation` (`things/serve.ts`): `implement`, `create`, `configure`, `delete`, `workspaceGone`, `one` | `prompt/server.ts` |
| `implement` | returns every member; a grantable state or event member is a builder `() => …`, a method a function (guide 5.1). It gets data and forwards to the store with the thing's id; no logic of the store in it | `notes/server.ts`; a builder: `terminals/server.ts` |
| no access check | no test of a principal, no table of who may, no second check of the caller's access to this thing (guide 5.2). A flag tick is read from `granted` (`granted.has("removeAny")`). `caller` is data for authorship only (5.3), stored as the things plugin's `Caller` union, never as a text key | `canvas/server.ts`; `notes/store.ts` (`author: Caller`) |
| a method naming another thing | the one exception (guide 5.2, R41): it checks the caller's answer on that thing and refuses with a message. Files and Terminals do it for a machine through `reachMachine` / `checkMachine` | `files/server.ts`, `environments/contract.server.ts` |
| the store | a `local` with empty params, `<plugin>.store`; it owns the tables (`<plugin>.<rows>`), keys every row by the thing's id, checks no caller, and says so in its header. Reads are named queries (index named, `reads` listed), writes are one `self.tx` each, a touch is a `tx.update`. `clear` removes everything of a thing in one transaction and is safe to run twice. A change of a table's or a setting's shape is never made in place: `evolveTable` to a new version with a migration and its test, since stored data survives updates (decision 125; `chord-practices.md`, Data). Example: `sessions/store.ts` (`RowsV2 = evolveTable(RowsV1, …)`), tested in `sessions/test/store.test.ts` | `notes/store.ts`; `checklist/store.ts` |
| `create` | writes what a new thing needs under the new id, from an input the kind's `create.input` schema already checked; a throw makes nothing (guide 5.6) | `providers/server.ts` |
| `configure` | one store method that merges the given settings into the thing's row inside one transaction; the settings live in a table keyed by the thing, read through `settings.of`; an unset thing reads the default | `notes/server.ts`, `notes/store.ts` (`configure`, `DEFAULT_SETTINGS`) |
| `delete` | `store.clear`; plus what the kind keeps outside its store (connections, programs) (guide 5.7) | `terminals/server.ts`, `environments/server.ts` |
| values | a value handed to Chord is never changed afterwards: an unchanged value is handed again as it is, a changed one is a new object (guide 5.8); no state in a module (5.9): what outlives a call is in an object, what others need in a registry | `environments/terminal-host.ts` (a keeper object contributing its native to a registry) |
| long-lived natives | a `local` with empty params that owns the native (`self.open` with its close), contributes it to a registry, and is held by a `contribute(host, "<plugin>.<what>-keep", …)` | `environments/terminal-host.ts` |
| HTTP routes | a route holds the thing as the person (`ctx.get(Kind.contract, …)` in the request's scope), checks the member, and ends the moment the hold loses it (`abortWhen`) | `terminals/attach.ts`, `files/transfers.ts` |

## 5. Shared reads

A held thing is one object per caller, and each reads for itself in `implement`. Chord shares identical live queries
(`self.liveQuery` of the same named query with the same arguments): a hundred holders of one checklist are one read
of its items. A `self.list` is each caller's own and runs once per holder.

| What is read | How | Example |
| --- | --- | --- |
| a list that pages | `self.list` per caller, in `implement`: each caller has its own pages and its own runs (one per holder per write: the counted test pins the number); never a hand-made shared paging. Its member becomes `listOf(Row)` with ERNDL-1180 (being changed) | `notes/server.ts` |
| a small set read whole | each caller's own `self.liveQuery`, with a bound the store's write enforces (no hidden cap) | `checklist/server.ts` with `MAX_ITEMS` enforced in `checklist/store.ts` |
| anything with a native (a folder watcher, a connection) | one `local` object per thing, `<plugin>.<what> { thing }`, in a file of its own; every caller's object hands out its members | `prompt/set.ts` (one folder watcher per set) |
| a page read now, not followed (an agent's tool) | a plain method over the named query's `.page`, so the agent's hold does not grow | `notes/server.ts` (`page`) |
| names of persons | read by id, live, with `ThingsStore.persons.ofIds`; never copied into a row | `notes/server.ts` |
| the caller's answer on another thing | read from the index's memory, not a query | `files/server.ts` |

Each shared read has a counted-work test and a release test (section 9).

## 6. The harness part and its tools (`worker.ts`)

```ts
export default defineFacet((_host, self) => {
	self.contribute(ThingHarnessParts, thingHarnessPart(NotesKind, (things, session) => ({ extension: notesExtension(things) })));
});
```

| Point | Rule | Example |
| --- | --- | --- |
| the part | one per kind, registered from `worker.ts` with the one plain form `thingHarnessPart(Kind, (things, session) => …)`, not exported. No helper variants (decision 142). What a part registers replaces what it registered before | `notes/worker.ts`; nearest: `tools/worker.ts` |
| nothing held | decided (142): the harness calls every part on every change of what the agent holds, possibly nothing, and the part checks for none itself, first: `if (things.length === 0) return { extension: {} };`. An empty extension, never `{}`: under the kind's name it keeps the kind's place in Durable's registry (a kind appended again changes the prompt's order and loses the provider's prompt cache). A part that gives tasks gives them always: `return { extension: { tasks: TASKS } };` with nothing held. **Being changed, not on main yet:** on main the harness still skips a kind with nothing held and no part has the check, so the sample above is main's (`notesExtension([])` would still offer `notes_list` and `notes_read`). Write the check in a new part now | `things/contract.worker.ts` |
| what it gives | `extension` (tools and prompt sections), `env`, `providers`, `ready` (`HarnessContribution`); state read at use, live (`ref.text.value` inside `render`) | prompt: `prompt/worker.ts`; providers: `providers/worker.ts`; env: `environments/worker.ts` |
| `again` | a part whose tools follow live state that is no change of the held list (a terminal list, an MCP server's tool list) gives `again: (refresh) => stop`: it calls `refresh` when that state changed and the harness calls the part again (decision 137) | `things/contract.worker.ts` (`HarnessContribution`) |
| extension name | none: a part gives `{ tools, sections }` (`HarnessExtension`); the harness installs it under the kind's name | `notes/worker.ts` |
| tool names | `<plugin>_<verb>`, lower case: `notes_list`, `notes_read`, `notes_write`; in a plugin with several kinds, the kind's noun (`skills_read`). One tool with a tagged action where a kind has many actions (`terminal`, the subagents' tool). The coding tools keep Durable's names `read`, `write`, `edit`, `bash` (decision 120) | notes, `checklist/worker.ts`, `prompt/worker.ts`, `terminals/worker.ts`, `harness/subagents.ts` |
| which tools | `<plugin>_list` (each thing's `id`, `name` and what the agent may do there) and `<plugin>_read` always; one tool per kind of change, or one `<plugin>_write` with a tagged `change` (`{ kind: "add", … }`) when the changes are small. Tools take the thing's id from the list tool, so descriptions are fixed text. A kind with one thing (`nearest`) needs no list tool | `notes/worker.ts` |
| gating | a tool is offered only while some held thing has the member or flag (`ref.add`, `ref.granted.has("bash")`), and reads it again at the call: withheld since, it refuses naming the thing (guide 7.2) | `notes/worker.ts` |
| calls | on the agent's held reference, with the tool's context: `await ref.add({ text }, context)` (decision 120). `session.call(fn, context)` only when the tool needs a reference of its own | `notes/worker.ts` |
| answers | JSON text: `{ output: [{ type: "text", text: JSON.stringify(value) }] }`; a change answers `{ id }` or `{}`. Only a document the model reads as it is (a terminal's output, a skill's text) is answered as text | `notes/worker.ts` |
| refusals | thrown with the API's errors, a sentence the model can act on: `invalid("args", …)` for an id that is none of the agent's (naming the list tool), `forbidden(…)` where the tick is not given. Never `new Error`, never an error returned as an answer | `notes/worker.ts` |
| `replay` | `"safe"` on every tool that only reads | `notes/worker.ts` |
| descriptions | what it does, each parameter in backticks with where its value comes from, what it answers. English, never a message (prompts are not translated) | `notes/worker.ts` |
| cost | no heavy import in a worker facet; a library loads on first use (`loadProvider`) | `providers/worker.ts` |

## 7. Views and messages (`web.tsx`, `<thing>-view.tsx`, `messages.ts`)

```tsx
// web.tsx: contributions only
export default defineFacet((_host, self) => {
	self.contribute(Views, [{ view: NotesKind.name, title: messages.message("view"), area: "main",
		for: { kind: "thing", thingKind: NotesKind.name }, View: NotesView }]);
	self.contribute(ThingParts, [{ kind: NotesKind.name, title: messages.message("untitled"), Icon: DescriptionIcon }]);
	self.contribute(PluginTitles, { title: messages.message("plugin"), Icon: DescriptionIcon });
	self.contribute(Translations, messages.translations);
});
```

| Point | Rule | Example |
| --- | --- | --- |
| registries | `Views` (0 to n per kind), `ThingParts` once per kind from its own plugin, `PluginTitles`, and `Translations` (from `/v1`). The three things registries are imported from `../things/contract.web.tsx` by path on main; being changed to `/v1/web` (decision 139) | `notes/web.tsx` |
| the view | `function <Thing>View(props: ThingViewProps)` (`{ workspace, thing }`): `const ref = useHold(Kind.contract, props); const live = useLive(ref);` then narrows by members: `withGranted(live, ...NOTES_WRITES)`, `live?.addItem`. It never asks who the person is (guide 6.4). Controls exist only while their member does, on the same hold | `notes/notes-view.tsx`; `checklist/checklist-view.tsx` |
| states | denied (`state.cause.kind === "denied"`), unavailable (failed or ended), loading (`live === undefined`), empty, each a message | `notes/notes-view.tsx` |
| what it draws | its thing only: no configuration, no list of who may, no navigation (guide 6.5); one column on a phone | notes |
| changes | one action at a time through a small hook (`useAction`: pending, error, run); a failure is shown with the things plugin's `useErrorText()` (`things/contract.web.tsx`): the refusal's message in the viewer's language, else the error's text. `useAction` is still local to each view (the web API gets the shared one); notes and checklist also carry a local `failureText`: use `useErrorText` instead | `files/files-view.tsx` (`useAction` with `useErrorText`), `terminals/terminals-view.tsx` |
| the Settings form | `ThingParts.Settings`, gets `{ workspace, thing, value, save }` (`ThingSettingsProps`), never the thing's reference | `things/contract.web.tsx`; no kind has one yet |
| state across reloads | what must survive a plugin reload (a half-typed message) is `usePageState("<plugin>.<what>", …)` | `transcript/composer.tsx` |
| test hooks | `data-<plugin>…` attributes on what the browser test finds (`data-notes="writer"`, `data-note-add`) | `notes/notes-view.tsx` |
| styles | a CSS module beside the view, the app's variables only | `notes/notes-view.module.css` |
| `messages.ts` | `defineMessages("<plugin>", { en: { … } })`: `tick<Name>` for each tick, `view` (the view's title), `plugin`, `untitled`, the view's texts, one key per refusal a person can cause. Keys are names, never English. Plurals and dates are functions (`formatTime`). Nothing a person reads is written anywhere else (guide 4.1): not in a view, not in a state value | `notes/messages.ts`; refusals: `files/messages.ts` |
| names in state | a state member never holds a sentence or an English fallback: an unnamed thing's `name` is `""` and the view renders `t("untitled")`; an author is a tagged union the view names (`authorName`) | `notes/server.ts`, `notes/notes-view.tsx` |

## 8. Errors and refusals

| Who is refused | How | Example |
| --- | --- | --- |
| a caller without the tick | nothing to write: the grantable member does not exist on their object, the plain members stay. A caller given nothing here gets no object: the things plugin's admission denies with its message | `things/admission.ts` |
| a person's bad argument, or a state that refuses (a full list, a hidden path, an ended terminal) | `invalid("args", "<plugin>: <English, for logs>", { message: messages.message("<key>", …) })`; one small function per refusal used twice (`noNote`, `hidden`) | `files/places.ts`, `terminals/server.ts` |
| a caller who may not use another thing | `forbidden("<plugin>: …", { message })` | `environments/contract.server.ts` |
| a result type from below (`Result<T, FileError>`) | one function turns it into the refusal the caller sees (`must`) | `files/places.ts` |
| the model, in a tool | section 6: thrown `invalid` / `forbidden`, English | `notes/worker.ts` |
| the plugin's own code or a peer (a missing host, a broken invariant) | `PluginError` with a code of the plugin's, or let it fail; a failure nobody awaits goes to `reportError("<plugin>: <what>", error, ctx)` | `providers/store.ts`, `environments/machines.ts` |
| a secret | never in an error, a log, a state or a transcript (guide 4.4): a provider's error text is mapped to a code before it is thrown | `providers/store.ts` |

Log and error texts start with `<plugin>: `. Runtime checks stand only at a trust boundary and name it (wire input,
a file people edit, another plugin's code): `terminals/attach.ts`, `harness/agent-parts.ts`.

## 9. Tests

Helpers, in `things/test/`: `kindServer(plugin, Kind, context)` (`kind-server.ts`) is the plugin tier for a kind: the
kind's server facet beside the things plugin's on a counted host, with `person`, `workspace(session)`, `thingIn`,
`tick`, `holding`, `granted`, `holders`, `count`, `reload`, `giving` (the harness part, taken from the built worker
facet, given real references held as the session's worker) and `worker`; `refused(promise, code, key)`, `runTool`.
`kindE2E(context)` (`kind-e2e.ts`) is p3's real server on a copy of the built-in plugins with clients over `/chord`,
and `reload(folder, plugin)`, a real edit and apply. `checkCatalog(messages)` (`catalog.ts`) is the messages check.
`part.ts` gives stand-in held things for a part that needs no grant (a prompt section); a part whose tools depend on a
tick is tested with `kindServer.giving`.

| Case (guide §8) | Test | Example |
| --- | --- | --- |
| 8.1 who gets what | `server.test.ts`, `describe("who may do what …")`: a person put in, the agent, each tick alone, `@open` alone, the owner, nobody outside; assert `[...ref.granted].sort()` and the members. Guests: with shares (slice 8) | `notes/test/server.test.ts` "who may do what in a notebook"; each tick alone: `checklist/test/server.test.ts` "gives each tick its own member" |
| 8.2 a grant changed while held | the same hold loses or gains the member, live; removed from the workspace: denied | notes "follows the grants live, on the same hold" |
| 8.3 hidden | `setSwitch` in a workspace: denied there, live, still there where shown; no tool | notes "denies a notebook hidden in a workspace there" |
| 8.4 create and delete | content gone with the last link, only its own; `delete` run again; a failing `create` leaves nothing | notes "drops a notebook's notes …; its delete may run again"; a refusing create: `providers/test/server.test.ts` "making a login" |
| 8.5 plans | every statement the store runs searches a key or an index, no temporary B-tree | `providers/test/store.test.ts` "the store's statements"; the central `apps/p3/test/plans.test.ts` |
| 8.6 reload | plugin tier: `n.reload()` while held, pages and holds kept; end to end: `kindE2E.reload`, both holders rebind, `e.t.errors` empty | notes "keep each caller's pages across a reload of the plugin"; `notes/test/e2e.test.ts` |
| 8.7 GC | every hold released: `assert.ok(await collected([ref]))`; a shared read is released with its last holder | notes "a released notebook is collected"; `checklist/test/server.test.ts` "releases the shared read with its last holder" |
| counted work | `n.count("chord.query.runs")` per common action, the number pinned: a shared live query runs once however many hold it (checklist), a list once per holder (notes), nothing for what did not change (an author's name already shown) | notes "the cost of a notebook's read"; checklist "is one run of its items per tick, however many hold it" |
| 8.8 `migrateTicks` | a table of old tick lists per version | `things/test/migration.test.ts` |
| 8.9 messages | `messages.test.ts`: `checkCatalog(messages)` | `notes/test/messages.test.ts` |
| the store alone | `store.test.ts`: order, uniqueness, bounds, what a clock gone back does | `notes/test/store.test.ts` |
| the harness part | `worker.test.ts` through `n.giving`: the part is the facet's one part; the tools offered with 1 and 2 things and as ticks go; list, read, change; refused where the tick is not given, also when taken back after offering; an unknown id | `notes/test/worker.test.ts` |
| 7.2 a tick withheld mid-call | the call finishes, the next step has no tool | `harness/test/worker.test.ts` (the coding tools let go of during a call) |
| refusals | `refused(promise, code, key)`: the code and the message's key | `things/test/kind-server.ts` |
| routes | called as the HTTP component calls them, and end to end with cookies | `files/test/transfers.test.ts` |
| 8.10 the view | the browser test at 390x844 and 1280x900, light and dark, with and without the tick | `plugins/chrome/test/page.test.ts` (on main) |
| 8.11, 8.12 | the worker's memory before and after (the memory test is not ported: ERNDL-855); values frozen by the helper: not available yet | – |

Rules of form: the test file's header lists what it pins, in the words of the `it` names; one `describe` per
mechanism; an `it` reads as a sentence with its `describe`; a regression is named after the rule it pins, the reviewer
and round in a comment beside it; `until(member, done, within("what", ctx))` for effects, never a sleep; `afterEach(()
=> n.close())`. A harness part whose tools depend on a tick is tested with real references (`kindServer.giving`),
never with a stand-in object that imitates one.

## 10. The issue, the numbers, the docs

- **The issue** (one per kind, the plan and the record), sections in this order: Problem (with an example) · p2's
  features and extension points · The kind (the declaration as code) · Serving it · The view · The harness part · One
  request, traced · Files · Tests (case by case, with the guide's numbers) · Numbers to meet · Decided · Recommended,
  to confirm · Known · As built (**Where**, **Commits**, **Tests**, **Gates**, **Numbers**, **Review rounds**,
  **Missing before the push**) · Mockups · Handover. Example:
  [ERNDL-1166 7a · Notes (notes.notes): the reference kind](https://linear.app/earendil/issue/ERNDL-1166).
- **Numbers**, a table `| | target | measured |`; a number not measured says "not measured" and why; one above its
  target says so in bold:

  | Number | Target | How |
  | --- | --- | --- |
  | heap per held thing over Chord's own cost | at most 2 KiB | 200 holders, after GC, against the things plugin's bare test kind, kinds alternated, median of 5: `apps/p3/bench/machine-kinds.ts` |
  | the worker facet with the part loaded, idle | under 0.1 MiB (heap); the worker within 55 MiB USS | heap difference after GC; the memory test once ported (ERNDL-855) |
  | a change reaching the last of 100 holders | under 10 ms | median, cold run apart |
  | opening a thing: the first page | one index read | `count("chord.query.runs")` |
  | what the view adds to the page bundle | measured, gzipped | – |
  | the kind's own (a key typed reaching the terminal, one `authorize`) | set in the issue | – |
- **What an author reads.** No README per plugin. In this order: `apps/p3/docs/README.md` and its guides; this guide;
  `things.md` (the model and the full checklist, ERNDL-1148) once it is written; then the notes plugin, file by file,
  each file's header first. A plugin's own documentation is its headers and doc comments; its plan and numbers are its
  issue.

## Decided (where the plugins once disagreed)

| Question | The way | Decision |
| --- | --- | --- |
| where the `defineThing` lives | `kind.ts` (`<noun>-kind.ts` with several kinds); `contract.ts` only for what other plugins import | the pattern; all built-in kinds |
| where the store's contract lives | `store.ts`, until another plugin or the API reads it: then `contract.server.ts` | 120 |
| file names | plain (`store.ts`, `<thing>-view.tsx`); `*.<kind>.ts(x)` is for contract files only | 120 |
| how a tool calls | the held reference directly; `session.call` for a reference of the call's own | 120 |
| tool names | `<plugin>_<verb>`; the kind's noun in a plugin of several kinds; one tagged-action tool for many actions; the coding tools keep Durable's names | 120 |
| kind names | `<plugin>.<kind>`; `prompt.instructions` and `prompt.skills` live in the plugin `prompt`; `files.browser` and `terminals.pane` stay as recorded exceptions | 101, 120 |
| a seeded thing's name (`one: { name }`) | data, not a message: people rename it | 120 |
| a tool's refusals and answers | thrown `invalid` / `forbidden`; JSON answers | the pattern |
| how a part is registered | one plain form, called with what is held, possibly nothing; `again` for live state | 137, 142 |
| hook order | `implement`, `create`, `configure`, `delete`, `workspaceGone`, `one` | the pattern |
| which defaults are written | `makers` always; `workspaces` and `stacking` only when not the default | the pattern |
