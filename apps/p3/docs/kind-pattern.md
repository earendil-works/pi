# The kind pattern: how every p3 kind plugin is built

One pattern for every feature built as a kind of thing, so each built-in plugin is an example for the next. It adds
nothing to the rules of the other guides; it says which file, which name, which helper, and names the place on main
that shows each point. Notes (`notes/`) is the reference kind: copy it to start a kind.

**How to read the examples.** Paths are under `apps/p3/plugins/`. `notes/store.ts:95-176` is a file and its lines on
main when this was last checked (2026-11-27); the name beside it (`serveStore`) finds the place once lines have moved.
"Guide 5.2" is a line of the checklist in [ERNDL-1148 10 · Guide: building features as
things](https://linear.app/earendil/issue/ERNDL-1148); decisions are cited by number (`decisions.md` and the issues).

**Where each topic is.** One place each; the other guides point here, and this one points at them:

| Topic | Place |
| --- | --- |
| files and their names | section 1; the names inside a plugin: `names.md`, "Names inside a plugin" |
| headers and comments | section 2 |
| declaring the kind | section 3 |
| serving it: `implement` and the hooks | section 4 |
| the store, its tables, migrations | section 5 |
| lists and reads | section 6 |
| settings and the Settings form | section 7 |
| the harness part and its tools | section 8 |
| the web facet: views, components, hooks | section 9 |
| messages | section 10 |
| errors and refusals | section 11 |
| HTTP routes | section 12 |
| tests, tier by tier | `testing.md`, "A kind's tests" |
| budgets and a kind's numbers | `performance.md`, "A kind's numbers" |
| the issue | section 13 |

**Being changed** (follow main until each lands; this guide is updated in the commit that lands it):

- **Imports of the things layer.** On main the built-in kinds import the things plugin's files by path
  (`../things/kind.ts`, `../things/serve.ts`, `../things/contract.worker.ts`, `../things/contract.web.tsx`), as notes
  does. The API already exports most of it (`defineThing` from `@earendil-works/p3/v1`, `serveThing` and the things
  store's contracts from `/v1/server`, the web registries and hooks from `/v1/web`), not yet the worker's
  (`thingHarnessPart`, `ThingHarnessParts`): a plugin of another root cannot write a harness part today. Decision 139:
  every built-in facet will import through the API, as a third party does, and the "never through `/v1/web`" comments
  go. Until then a built-in kind imports by path.
- **List members.** `listOf(Row)` and `whileFollowed(schema)` come with [ERNDL-1180 Chord: state no holder watches
  does not run or cross the link](https://linear.app/earendil/issue/ERNDL-1180) (decisions 138, 141): section 6.
- **Harness parts with nothing held** (decision 142, ERNDL-1193): section 8.
- **The Settings form** (`settingsOf`, `settingsForm`; decision 143): section 7.
- **`useAction`** becomes a shared hook of the web API: section 9.

## Starting a kind

1. **The folder.** A plugin is a folder in `apps/p3/plugins/` with a `package.json` (`{ "name":
   "@earendil-works/p3-<plugin>", "private": true, "type": "module" }`). The server builds every folder of that root
   when it starts: nothing registers a plugin. Copy `notes/` and rename it by `names.md`, "Names inside a plugin".
2. **The order of work,** each file with its test before the next: `kind.ts` and `messages.ts` (sections 3 and 10;
   `test/messages.test.ts`), `store.ts` (section 5; `test/store.test.ts`), `server.ts` (sections 4, 6, 7;
   `test/server.test.ts`), `worker.ts` (section 8; `test/worker.test.ts`), the view and `web.tsx` (section 9;
   `test/view.test.ts`), then `test/e2e.test.ts`. What each test file holds: `testing.md`, "A kind's tests".
3. **The store's named queries** go into the plans test (`apps/p3/test/plans.test.ts`).
4. **Run** one test file with the command of `testing.md`, "Setup and commands"; `npm run check` in `apps/p3` and at
   the repository's root before you report (`process.md`, Gates).
5. **Before you report,** go through "Before you report" at the end of this guide.

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
  contract.ts             only if another plugin imports data of this one: schemas, constants, tokens
  contract.server.ts      only if another plugin's server code reaches this one: registries, local contracts
  <concept>.ts            one more concept, named after it (a served object, a route, a registry)
  test/
    store.test.ts  server.test.ts  worker.test.ts  e2e.test.ts  messages.test.ts  view.test.ts  (+ one per <concept>.ts)
```

| Rule | Example |
| --- | --- |
| One concept per file, named after it. A second concept is the reason for a file, size never is (a file may be long; three files of four lines are one file) | `prompt/set.ts` (one served object), `files/places.ts` (where a path is), `canvas/pointers.ts` |
| `kind.ts` holds the `defineThing` and everything only the kind needs (its schemas, its `…_WRITES` constants). A plugin with several kinds names each `<noun>-kind.ts` | `notes/kind.ts`; `prompt/instructions-kind.ts`, `prompt/skills-kind.ts` |
| `contract.ts` exists only for what other plugins import, and imports nothing but the API | `environments/contract.ts` (`environments/contract.ts:10` `MACHINE_KIND`, imported by `terminals/kind.ts`) |
| The store's local contract lives in `store.ts` while only this plugin reads it; it moves to `contract.server.ts` as soon as another plugin or the API reads it (decision 120) | `notes/store.ts:38-64`; `providers/contract.server.ts` |
| `server.ts`, `worker.ts`, `web.tsx` are facets: they declare (`host.serve`, `serveThing`, `self.contribute`) and hold the kind's own part of that host; a view, a route, a second served object get a file | `notes/server.ts:23-64`, `notes/web.tsx:14-27` with `notes/notes-view.tsx` |
| A view that grows is split into components, one file each, named after what they draw | `canvas/board-view.tsx`, `canvas/toolbar.tsx`, `canvas/drawing.tsx` |
| Web-only files are `.tsx` beside `web.tsx`; views are `<thing>-view.tsx` ("view", never "pane": `names.md`) | `notes/notes-view.tsx`, `checklist/checklist-view.tsx` |
| Tests sit in the plugin's `test/`, one file per source file, plus `e2e.test.ts`; stand-ins shared by several test files are a file there without `.test` | `notes/test/`; `environments/test/fake-machine.ts` |

**The built-in plugins by shape** (what to copy from which, and what is still rough in each): `README.md`, "The
examples".

## 2. The file header and the comments

- **First line of every file: a `//` comment that says what the file is for**, in the plugin's own words: what the
  concept is, what it guarantees, which other file has the rest. Three to seven lines. The header of `kind.ts` is the
  plugin's front page: what a thing of the kind is, who makes it, where it is linked, each tick and what it gives,
  what a new link starts with. Example: `notes/kind.ts:1-4`, `notes/store.ts:1-4`; a file with a protocol:
  `files/transfers.ts:1-15`.
- **Every export has a doc comment** (`/** … */`, one line where one is enough) saying what it is or guarantees. A
  schema and its type share a name and each has one. Example: `notes/kind.ts:23-39`.
- **Every member of a contract that is not obvious has a doc comment** inside the declaration (methods: what it does,
  what it answers, when it refuses). Example: `notes/kind.ts:65-80`.
- **Inline comments say a why** (a cost, a race, a decided rule with its number), never what the next line does.
  Example: `notes/store.ts:107-109` (why `at` is made unique).
- **Every named query's builder names its index** in a comment. Example: `notes/store.ts:122`.
- **A cast or a runtime check carries its reason**: the invariant TypeScript cannot say, or the trust boundary it
  serves. Example: `notes/notes-view.tsx:123-124`, `terminals/attach.ts:36`.
- Order in a file: imports, exported types and schemas, the public entry first, its helpers below in the order used,
  constants right above their first user. In a facet file the `export default defineFacet` is the entry.
- Decisions are cited by number ("decision 97"), issues by key.

## 3. Declaring the kind (`kind.ts`)

**Worked example: notes.** The whole declaration is `notes/kind.ts:61-89` (`NotesKind`): its plain members and
Write's, the one tick, the default grants, the setting. Above it stand its schemas, each with its type
(`notes/kind.ts:14-48`), and the list of what the tick gives (`notes/kind.ts:54`, `NOTES_WRITES`), which the kind, the
view and the worker all use. Below it, the contract every holder imports: `notes/kind.ts:92`.

```ts
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

| Field | Rule | Example |
| --- | --- | --- |
| name | `<plugin>.<kind>`, lower case; the prefix is the plugin's name, which is also its messages namespace and the prefix of its stores and tables (guide 1.1) | `notes.notes`, `canvas.board`, `environments.machine` |
| `version` | the contract's; bumped with every change of members, never changed in place (guide 1.2, decision 125) | all |
| `makers` | always stated, chosen on purpose: `"anyone"` content; `"people"` a credential, money, outsiders, code; `"plugin"` only the kind's own plugin makes them, no person and no agent (guide 3.1) | `notes/kind.ts:63`; `providers/kind.ts:52` (people); `tools/kind.ts:12` (plugin) |
| `workspaces`, `stacking` | stated only when not the default (`"many"`, `"all"`). With `"all"` the part and the views handle several things; with `"nearest"` the part reads the last thing it gets | `files/kind.ts:52-53` (`"one"`, `"nearest"`) |
| members | plain members are what everyone let in may have: reads, and methods that change nothing stored. Say so in one comment in `ticks`, naming them (guide 1.13) | `notes/kind.ts:82-83` |
| `ticks` | named as verbs, never like a member (guide 1.11); each a `label` from `messages.ts` (`tick<Name>`); `for` only when not all; a tick's `gives` is an exported `as const` list when the view or the worker narrows by it; a tick without `gives` is a flag tick | one tick: `notes/kind.ts:84`; two: `checklist/kind.ts:37-41`; flag ticks and a people-only tick: `canvas/kind.ts:144-151`; agents-only flag ticks: `tools/kind.ts:14-19`; a member in two ticks: `terminals/kind.ts:68-74` |
| `defaultGrants` | `everyone`, `agents`: what a new link starts with; `[]` lets the party in with no tick. `guests` decided on purpose and written down: no key (not let in) or `[]` (plain members) (guide 2.3, 2.4) | `notes/kind.ts:86`; `environments/kind.ts:45` (`everyone: []`) |
| `settings` | names of state members; changed only through `configure` (section 7) | `notes/kind.ts:88`; `prompt/instructions-kind.ts:36` |
| `create.input` | the schema of what the create step hands over; the store checks it before the hook runs; the hook checks only what the schema cannot say (a family type's own settings). A kind without one takes no input | `providers/kind.ts:61` with its hook `providers/server.ts:65-71`; `environments/kind.ts:40` with `environments/machines.ts:138-152` |
| `ticksVersion`, `migrateTicks` | absent until a tick name changes meaning (guide 1.3 to 1.6) | `canvas/kind.ts:153-154`, tested in `canvas/test/server.test.ts`; `things/test/migration.test.ts` |
| the contract | `export const <Thing> = <Thing>Kind.contract`, the name every holder imports | all |

- **A seeded thing.** Any kind may seed one thing in Pi where it is served: `serveThing(…, { one: { name } })`; the
  name is data (people rename it), and server code reads the thing's id through `OneThing { kind }`. Example:
  `files/server.ts:65`, `prompt/server.ts:50` (a kind people make).
- **A create step.** A kind with a `create.input` needs a create step on the page, or nobody can make one there: its
  web facet gives `ThingParts` a `Create` component (`things/contract.web.tsx:82-86`: `workspace`, `input`,
  `onReady`). The component starts its form from `props.input` (so an apply of the plugin keeps what the person filled
  in) and reports the input with `onReady`; the add-thing dialog hands it to `Workspace.make`, and the store checks it
  against the schema before the kind's `create` hook runs. Without a `Create` component the dialog hands over no
  input, and a required schema refuses the make. Example: `sessions/web.tsx:15`, `sessions/new-session.tsx:28-31`. A
  kind without `create.input` needs none (notes).
- **A family** (machine, login: decision 117) is an ordinary kind whose plugin also owns a registry of types; the
  type's plugin contributes label, settings schema and implementation and declares no ticks. Example:
  `environments/contract.server.ts:98-111` (`MachineType`, `MachineTypes`), the first type
  `environments/this-device.ts:26-39`.
- **A workspace kind** is declared with `defineWorkspace` and gets the workspace ticks beside its own. Example:
  `sessions/kind.ts:29-60`.
- **Two kinds in one plugin:** a `<noun>-kind.ts` each, one `server.ts` serving both, one store with a table per kind.
  Example: `prompt/server.ts:22-69`, `prompt/store.ts:56-70`.

## 4. Serving it (`server.ts`)

**Worked example: notes.** `notes/server.ts:23-64` is the whole facet: it serves the store, then the kind. `implement`
(`notes/server.ts:29-49`) builds one notebook for one caller: it gets the store, makes the caller's list, and returns
every member, each a read or a call forwarded to the store with the thing's id and the caller as the author.
`configure` (`notes/server.ts:52-58`) forwards the settings, `delete` (`notes/server.ts:60-62`) clears the store.
Helpers follow below the facet in the order used (`notes/server.ts:70-128`).

| Point | Rule | Example |
| --- | --- | --- |
| hooks | in this order, the order of `ThingImplementation` (`things/serve.ts:30-55`): `implement`, `create`, `configure`, `delete`, `workspaceGone`, `one` | `prompt/server.ts:26-51` |
| `implement` | returns every member; a grantable state or event member is a builder `() => …`, a method a function (guide 5.1). It gets data and forwards to the store with the thing's id; no logic of the store in it | `notes/server.ts:29-49`; a builder: `terminals/server.ts:64-68` |
| no access check | no test of a principal, no table of who may, no second check of the caller's access to this thing (guide 5.2). A flag tick is read from `granted`. `caller` is data for authorship only (5.3), stored as the things plugin's `Caller` union, never as a text key | flags: `canvas/server.ts:60-67`; `notes/store.ts:29` (`author: Caller`) |
| a method naming another thing | the one exception (guide 5.2): it checks the caller's answer on that thing and refuses with a message. Files and Terminals do it for a machine | `environments/contract.server.ts:143-149` (`checkMachine`; `reachMachine` below it), used in `files/server.ts:29` |
| `create` | writes what a new thing needs under the new id, from an input the kind's `create.input` schema already checked; a throw makes nothing (guide 5.6) | `providers/server.ts:65-71` |
| `delete` | the store's `clear`; plus what the kind keeps outside its store (connections, programs) (guide 5.7) | `notes/server.ts:60-62`; `terminals/server.ts:104-106` |
| values | a value handed to Chord is never changed afterwards: an unchanged value is handed again as it is, a changed one is a new object (guide 5.8); no state in a module (5.9): what outlives a call is in an object, what others need in a registry | `notes/server.ts:128-135` |
| long-lived natives | a `local` with empty params that owns the native (`self.open` with its close), contributes it to a registry, and is held by a `contribute(host, "<plugin>.<what>-keep", …)` | `environments/terminal-host.ts:37-80` |

## 5. The store and its migrations (`store.ts`)

**Worked example: notes.** The contract `notes/store.ts:38-64` (`NotesStore`: a `local` with empty params,
`notes.store`) lists the named queries with their arguments and every write, each with a doc comment. The tables
follow: `notes/store.ts:67-72` (`notes.rows`, key `(notebook, id)`, one index per list's order),
`notes/store.ts:75-79` (`notes.settings`, one row per thing). `notes/store.ts:95-175` (`serveStore`) serves it: the
named queries (`notes/store.ts:118-128`: `map`, `reads`, and a comment naming the index), then one `self.tx` per write
(`notes/store.ts:144-152`; `notes/store.ts:153-158`: a `tx.update` that names its columns), and `clear`
(`notes/store.ts:165-172`), which removes everything of a thing in one transaction and is safe to run twice.

| Point | Rule | Example |
| --- | --- | --- |
| the object | a `local` with empty params, `<plugin>.store`; it owns the tables, keys every row by the thing's id, checks no caller, and says so in its header | `notes/store.ts:1-4` |
| tables | `<plugin>.<rows>`; index and order columns never optional; one index per list's order | `notes/store.ts:67-72`; `checklist/store.ts:49-54` |
| reads | named queries only, each a key or an index search with `reads` listed and the index named in a comment; a plan test proves it (`testing.md`) | `notes/store.ts:118-128` |
| writes | one `self.tx` each; a touch is a `tx.update`; a refusal is thrown inside the transaction, with a message (section 11) | `notes/store.ts:153-158` |
| bounds | a set read whole is bounded by a constant the write enforces (no hidden cap) | `checklist/store.ts:101-104` |
| order | what orders a list is made unique and monotonic in the write's transaction, not taken from the clock alone | `notes/store.ts:110-116` |
| a write after the delete | a write begun before `clear` and committed after must not recreate rows under a dead id: it is refused in its own transaction. Today each kind keeps a `gone` mark for it (a workaround; a shared answer from the things plugin is to replace it): keep the guard and its test | `notes/store.ts:101-105` with `notes/store.ts:88-92` |
| **migrations** | stored data survives updates (decision 125): a table, a `json` column or a document that changes shape is never changed in place. The old table definition stays; `evolveTable` makes the next version from it (`add`, `rename`, `drop`, `json`, and `rows` for what each old row becomes); a `json` column's or a document's value migrates with its `migrate(old, from)`. A test opens a store the old version wrote. The migrations are collapsed once before the first release ([ERNDL-1192](https://linear.app/earendil/issue/ERNDL-1192)) | a column added, filled from the old one, the old one dropped: `canvas/store.ts:63-81` (`ShapesV1`, `Shapes`), tested by `canvas/test/store.test.ts:135-205`; a `json` column's schema changed, then a column renamed: `sessions/store.ts:86-89`; a `json` value's `migrate`: `sessions/defaults.ts:172-182`; a document's: `packages/chord/src/documents/definition.ts:38-43` |
| a contract's change | bumps the kind's `version` (the wire's version): nothing stored migrates with it | section 3 |

## 6. Lists and reads

A held thing is one object per caller, and each reads for itself in `implement`. Chord shares identical live queries
(`self.liveQuery` of the same named query with the same arguments): a hundred holders of one checklist are one read of
its items. A `self.list` is each caller's own and runs once per holder.

**Worked example: notes' list.** The member is `list: NotesPage` (`notes/kind.ts:36`: `{ rows, moreAfter }`) with the
method `more`. `implement` makes the caller's list from the store's named query (`notes/server.ts:38`), hands out
`list.value` (here with the authors' names laid over, `notes/server.ts:114-125`) and forwards `more` to
`list.more(ctx)`. The view shows `list.rows` and a More button while `list.moreAfter` (`notes/notes-view.tsx:68-78`).
The agent's tool pages with `page`, a plain method read now (`notes/server.ts:80-99`), so its hold does not grow.

| What is read | How | Example |
| --- | --- | --- |
| a list that pages | `self.list` per caller, in `implement`: each caller has its own pages and its own runs (one per holder per write: the counted test pins the number); never a hand-made shared paging. **Being changed:** with ERNDL-1180 the member is declared `listOf(Row)` (which implies `whileFollowed`: it runs only while someone watches it), and a member derived from a list reads its own sources or is followed too (decisions 138, 141). Until then: `obj({ rows: arr(Row), moreAfter: bool() })` | `notes/server.ts:38` |
| a small set read whole | each caller's own `self.liveQuery`, with a bound the store's write enforces | `checklist/server.ts:21` |
| anything with a native (a folder watcher, a connection) | one `local` object per thing, `<plugin>.<what> { thing }`, in a file of its own; every caller's object hands out its members | `prompt/set.ts:22-68` (one folder watcher per set) |
| a page read now, not followed (an agent's tool) | a plain method over the named query's `.page` | `notes/server.ts:80-99` |
| names of persons | read by id, live, with `ThingsStore.persons.ofIds`; never copied into a row | `notes/server.ts:114-125` |
| the thing's own name | read live from the things store (`things.things.one`); `""` while it has none | `notes/server.ts:32` |

Each read has a counted-work test and a release test (`testing.md`, "A kind's tests").

## 7. Settings

A kind's settings are ordinary state members named in `settings`, kept in the kind's own store, keyed by the thing.
They are changed with Configure where the thing is linked: `Workspace.configure({ thing, settings })`
(`things/workspace-object.ts:106-110`), a member only whoever has Configure there gets, checks that the thing is
linked there and each value against its member's schema, and then calls the kind's `configure` hook. There is no
settings tick and no settings page of the kind's own (guide 4.3).

**Worked example: notes' order.** The member and its name in `settings`: `notes/kind.ts:64`, `notes/kind.ts:88`. The
table and the default an unset thing reads: `notes/store.ts:75-82`. The read (`notes/store.ts:129-136`) and the one
write, which merges what was given into the row inside one transaction (`notes/store.ts:137-143`). The hook forwards
(`notes/server.ts:52-58`), and `implement` reads the setting live (`notes/server.ts:33-34`). Its test:
`notes/test/server.test.ts:366-478` (it calls the hook as the server does; who may configure is the workspace's test,
`things/test/workspaces.test.ts:544-558`).

- Two kinds, two settings tables in one store: `prompt/store.ts:56-70`.
- A secret is never a setting, never state, never in a log (guide 4.4).
- **Being changed, not on main yet** (decision 143; the forms' change): the kind gives `serveThing` a
  `settingsOf(thing, self)` hook that reads its settings from its store, never by building the thing's object, and its
  web facet gives `ThingParts` a typed form, `Settings: settingsForm(Kind, <Thing>SettingsForm)`, in
  `settings-form.tsx`. The form gets `{ workspace, thing, value, save }` and never the thing's reference
  (`things/contract.web.tsx:93-98`): it is opened by whoever has Configure there, who may have no tick on the thing.
  On main no kind has a form yet, and the Settings view does not render one.

## 8. The harness part and its tools (`worker.ts`)

**Worked example: notes.** The facet registers one part (`notes/worker.ts:32-37`). The part gives one extension
(`notes/worker.ts:43-47`): `notes_list` and `notes_read` always, `notes_write` only while some held notebook gives
Write. `notes_list` (`notes/worker.ts:50-67`) names each notebook with its id and what the agent may do there, so the
other tools take an id and their descriptions are fixed text. `notes_write` (`notes/worker.ts:97-116`) takes a tagged
`change` (`notes/worker.ts:90-94`), reads the grant again at the call and refuses naming the notebook
(`notes/worker.ts:110`); an id that is none of the agent's is the model's mistake (`notes/worker.ts:141-145`). Every
tool calls the agent's held reference with the tool's context and answers JSON.

```ts
export default defineFacet((_host, self) => {
	self.contribute(ThingHarnessParts, thingHarnessPart(NotesKind, (things) => ({ extension: notesExtension(things) })));
});
```

| Point | Rule | Example |
| --- | --- | --- |
| the part | one per kind, registered from `worker.ts` with the one plain form `thingHarnessPart(Kind, (things, session) => …)`, not exported. No helper variants (decision 142). What a part registers replaces what it registered before | `notes/worker.ts:32-37`; `things/contract.worker.ts:127-134` |
| nothing held | decided (142): the harness calls every part on every change of what the agent holds, possibly nothing, and the part checks for none itself, first: `if (things.length === 0) return {};`, or for a nearest-stacking kind `const nearest = things.at(-1); if (nearest === undefined) return {};`. The harness keeps the kind's place: for a part that gives nothing it installs an empty extension under the kind's name (a kind appended again would change the prompt's order and lose the provider's prompt cache); only a kind whose part went is uninstalled. A part that gives tasks gives the same task objects always (`return { extension: { tasks: TASKS } };` with nothing held), its tools only while held and granted. **Being changed, not on main yet** (ERNDL-1193): on main the harness still skips a kind with nothing held, so not every part has the check (the sample above is main's: `notesExtension([])` would still offer `notes_list` and `notes_read`). Write the check in a new part now | the nearest form: `tools/worker.ts:17-25` |
| what it gives | `extension` (tools and prompt sections), `env`, `providers`, `ready`, `again`; state read at use, live (`ref.text.value` inside `render`) | `things/contract.worker.ts:89-107`; a prompt section: `prompt/worker.ts:40-46`; providers: `providers/worker.ts`; env: `environments/worker.ts` |
| `again` | a part whose tools follow live state that is no change of the held list gives `again: (refresh) => stop`: it calls `refresh` when that state changed and the harness gives only that kind again (decision 137). Terminals uses it: its tool is offered only while a machine opens terminals, a member's value | `things/contract.worker.ts:102-106`; `terminals/worker.ts:55-65`; pinned by `harness/test/agent-parts.test.ts:100-126` |
| extension name | none: a part gives `{ tools, sections }`; the harness installs it under the kind's name | `tools/worker.ts:23-24` |
| the grant | what decides which tools are offered reads `held.granted` (the grant as the held list has it); a tool's call reads the reference's members at the call | `tools/worker.ts:21-22` |
| tool names | `<plugin>_<verb>`, lower case: `notes_list`, `notes_read`, `notes_write`; in a plugin with several kinds, the kind's noun (`skills_read`). One tool with a tagged action where a kind has many actions (`terminal`, the subagents' tool). The coding tools keep Durable's names `read`, `write`, `edit`, `bash` (decision 120) | notes; `prompt/worker.ts`; `terminals/worker.ts` |
| which tools | `<plugin>_list` (each thing's `id`, `name` and what the agent may do there) and `<plugin>_read` always; one tool per kind of change, or one `<plugin>_write` with a tagged `change` when the changes are small. A kind with one thing (`nearest`) needs no list tool | `notes/worker.ts:43-47`; one tool per change: `checklist/worker.ts:30-36` |
| gating | a tool is offered only while some held thing has the member or flag, and reads it again at the call: withheld since, it refuses naming the thing (guide 7.2) | `notes/worker.ts:97-116` |
| calls | on the agent's held reference, with the tool's context (decision 120). `session.call(fn, context)` only when the tool needs a reference of its own | `notes/worker.ts:70-87` |
| answers | JSON text: `{ output: [{ type: "text", text: JSON.stringify(value) }] }`; a change answers `{ id }` or `{}`. Only a document the model reads as it is (a terminal's output, a skill's text) is answered as text | `notes/worker.ts:119-130` |
| refusals | thrown with the API's errors, a sentence the model can act on: `invalid("args", …)` for an id that is none of the agent's (naming the list tool), `forbidden(…)` where the tick is not given. Never `new Error`, never an error returned as an answer | `notes/worker.ts:141-145`; `checklist/worker.ts:114-116` |
| `replay` | `"safe"` on every tool that only reads | `notes/worker.ts:57` |
| descriptions | what it does, each parameter in backticks with where its value comes from, what it answers. English, never a message (prompts are not translated) | `notes/worker.ts:53-56` |
| cost | no heavy import in a worker facet; a library loads on first use | `providers/worker.ts` (`loadProvider`) |

## 9. The web facet: views, components, hooks (`web.tsx`, `<thing>-view.tsx`)

**Worked example: notes.** `web.tsx` only contributes (`notes/web.tsx:14-27`): the view to `Views`, the kind's title
and icon to `ThingParts`, the plugin's title to `PluginTitles`, the catalogs to `Translations`. The view
`notes/notes-view.tsx:33-82` (`NotesView`) holds the notebook as the person, narrows the reference by what Write
gives, and draws four states before the list: denied, unavailable, loading, empty. Its parts are components below it
in the same file (`notes/notes-view.tsx:133-166`, `notes/notes-view.tsx:169-230`); each change goes through one action
(`notes/notes-view.tsx:96-116`).

```tsx
export function NotesView(props: ThingViewProps) {
	const ref = useHold(Notes, { workspace: props.workspace, thing: props.thing });
	const live = useLive(ref);                                  // the reference while it is live; re-renders on a new grant
	const writer = withGranted(live, ...NOTES_WRITES);          // undefined without Write: no control is drawn
	const state = useRefState(ref);
	const list = useWatch(live?.list);
	const { t } = useMessages(messages);
	if (state?.kind === "failed" && state.cause.kind === "denied") return <p className={styles.note}>{t("denied")}</p>;
	if (state?.kind === "failed" || state?.kind === "ended") return <p className={styles.note}>{t("unavailable")}</p>;
	// … loading while `list === undefined`, empty while it has no rows
}
```

| Point | Rule | Example |
| --- | --- | --- |
| registries | `Views` (0 to n per kind), `ThingParts` once per kind from its own plugin, `PluginTitles`, and `Translations` (from `/v1`). The three things registries are imported from `../things/contract.web.tsx` by path on main; being changed to `/v1/web` (decision 139) | `notes/web.tsx:14-27`; the entries' types: `things/contract.web.tsx:55-70` (`ViewEntry`, `Views`), `things/contract.web.tsx:105-111` |
| the view | `function <Thing>View(props: ThingViewProps)` (`{ workspace, thing }`). It holds the thing as the person and narrows by members: `withGranted(live, ...NOTES_WRITES)`, `live?.addItem`. It never asks who the person is (guide 6.4). Controls exist only while their member does, on the same hold | `notes/notes-view.tsx:33-82`; two ticks: `checklist/checklist-view.tsx:35-36` |
| states | denied (`state.cause.kind === "denied"`), unavailable (failed or ended), loading (`live === undefined`), empty: each a message | `notes/notes-view.tsx:42-43` |
| what it draws | its thing only: no configuration, no list of who may, no navigation (guide 6.5) | notes |
| components | a part of the view is a function component below the view, in the same file while it is small; a view that grows is split into files, each component given only what it draws and callbacks. A component other plugins place is a `defineComponent` token, never a `Views` entry | `notes/notes-view.tsx:169-230`; split: `canvas/board-view.tsx:125-201` with `canvas/toolbar.tsx:31-79`; tokens: `things/contract.web.tsx:138` |
| hooks of the API (`/v1/web`) | `useHold(Contract, params)`, `useLive(ref)`, `useRefState(ref)`, `useWatch(member)`, `useMessages(messages)`, `usePageState(key, initial)` | `notes/notes-view.tsx:34-41` |
| shared hooks of the things plugin | `useErrorText()` (a failed call's text for the person: the refusal's message in their language, else the error's text), `useMessageText()` (a message that came as data), `useNames()` (a thing's or a party's name), `useScreenId()` (the id a list's params take) | `things/contract.web.tsx:196-203`, `things/contract.web.tsx:182`, `things/contract.web.tsx:223`, `things/contract.web.tsx:25` |
| changes | one action at a time: pending, error, run; the failure's text through `useErrorText()`. **Being changed:** `useAction` is still a local function in each view (the web API gets the shared one); until then write it as files does, on `useErrorText`. Notes and checklist carry an older copy with a `failureText` of their own: do not copy that one | `files/files-view.tsx:372-387` |
| state across reloads | what must survive an apply of the plugin (a half-typed text, a picked tool) is `usePageState("<plugin>.<what>", …)`; plain `useState` starts over | `canvas/board-view.tsx:138`; `transcript/composer.tsx` |
| test hooks | `data-<plugin>…` attributes on what the browser test finds: the view's mode on its root, one attribute per control | `notes/notes-view.tsx:48`, `notes/notes-view.tsx:156`; used by `canvas/test/view.test.ts:53-58` |
| phone and desktop | every view works on both (guide 6.6): one column on a phone, the app's variables only, no fixed colours, a CSS module beside the view. The browser test looks at both sizes (`PHONE` 390x844 with touch, `DESKTOP` 1280x900), light and dark | `notes/notes-view.module.css`; `chrome/test/browser.ts:28-31`; `canvas/test/view.test.ts:30-47` |
| controls and styles | controls are Elanor's components (`Button`, `TextArea`, `Input`, `Checkbox`, … from `@earendil-works/elanor-react`), icons come from `/v1/web`; React and Elanor are host packages, never in the plugin's `package.json`. Styles are a CSS module beside the view that uses Elanor's tokens (`var(--semantic-color-text-secondary)`, `var(--semantic-dimension-space-gap-small)`), never a fixed colour or size | `notes/notes-view.tsx:5`; `notes/notes-view.module.css:3-8` |
| names in state | a state member never holds a sentence or an English fallback: an unnamed thing's `name` is `""` and the view renders `t("untitled")`; an author is a tagged union the view names | `notes/server.ts:40`; `notes/notes-view.tsx:233-242` |

## 10. Messages (`messages.ts`)

**Worked example: notes.** One catalog, `notes/messages.ts:8-35`: `tickWrite` (the tick's label), `view`, `plugin` and
`untitled` (titles), the view's texts, one key per refusal a person can cause (`noNote`, `gone`), and a function for
what needs arguments or a date (`written`, through `formatTime`). The kind uses a message as the tick's label
(`notes/kind.ts:84`), the store as a refusal's message (`notes/store.ts:101-105`), the view renders with `t`
(`notes/notes-view.tsx:41`), and the web facet contributes the catalogs (`notes/web.tsx:26`). The test is two lines:
`notes/test/messages.test.ts:7-11` with `checkCatalog` (`things/test/catalog.ts:8-28`): every key has a text, and a
second catalog renders in its place.

- The namespace is the plugin's name. Keys are names (`tickWrite`, `noNote`), never English text.
- Nothing a person reads is written anywhere else (guide 4.1): not in a view, not in a state value, not in a thrown
  error's text (that text is English for logs; the person sees the message beside it).
- A message that travels as data (a tick's label, a refusal, a title in a registry) is `messages.message("key", …)`; a
  client renders it with `t.render(message)` or the things plugin's `useMessageText()`.
- Plurals, word order, dates and numbers are functions in the catalog (`formatTime`, `formatNumber`).
- Never translated: the model's prompts and tool descriptions, log lines, error codes.

## 11. Errors and refusals

**Worked example: a note that is gone.** The store refuses inside the write's transaction with the decided code, an
English text for logs and the message the person sees: `notes/store.ts:178-180` (`noNote`), thrown in
`notes/store.ts:153-158`. The call rejects in the view's action, which shows the message in the viewer's language:
`useErrorText` (`things/contract.web.tsx:196-203`), as files' view uses it (`files/files-view.tsx:372-387`; notes'
view still carries a local copy, `failureText`). The test asserts the code and the message's key with
`refused(promise, code, key)` (`things/test/kind-server.ts:240-248`).

| Who is refused | How | Example |
| --- | --- | --- |
| a caller without the tick | nothing to write: the grantable member does not exist on their object, the plain members stay. A caller given nothing here gets no object: the things plugin's admission denies with its message | `things/admission.ts:67` |
| a person's bad argument, or a state that refuses (a full list, a hidden path, a thing that is gone) | `invalid("args", "<plugin>: <English, for logs>", { message: messages.message("<key>", …) })`; one small function per refusal used twice | `notes/store.ts:178-180`; `files/places.ts:59-82` |
| a caller who may not use another thing | `forbidden("<plugin>: …", { message })` | `environments/contract.server.ts:143-149` |
| a result type from below (`Result<T, FileError>`) | one function turns it into the refusal the caller sees | `files/places.ts:76-79` with `files/places.ts:82-86` |
| the model, in a tool | section 8: thrown `invalid` / `forbidden`, English | `notes/worker.ts:141-145` |
| a route's caller | a status, never a body that says why: 400 for a query that names nothing, 403 for a caller not let in, 404 for what is not there | `terminals/attach.ts:35-46` |
| the plugin's own code or a peer (a missing host, a broken invariant) | `PluginError` with a code of the plugin's, or let it fail; a failure nobody awaits goes to `reportError("<plugin>: <what>", error, ctx)` | `environments/machines.ts:155-163` |
| a secret | never in an error, a log, a state or a transcript (guide 4.4): a provider's error text is mapped to a code before it is thrown | `providers/store.ts` (`nameOf`) |

Log and error texts start with `<plugin>: `. Runtime checks stand only at a trust boundary and name it (wire input, a
file people edit, another plugin's code).

## 12. HTTP routes

A route is for bytes a browser reads or sends directly (a download, an upload, a stream). Everything else is a member
of the thing.

**Worked example: a terminal's bytes.** The thing's method answers the address (`terminals/server.ts:69-71`: a path
whose query names the workspace, the thing and the terminal). The route is contributed from a file of its own
(`terminals/attach.ts:22-29`). Its handler (`terminals/attach.ts:35-73`) reads the query as the trust boundary it is,
**holds the thing as the person** in the request's scope (`ctx.get(Terminals, { workspace, thing })`), checks the
member (`ref.attach`), and calls it, so every rule of the thing applies to the route. The body then ends the moment
the hold loses what let the person in: `abortWhen` on the reference's state and on the list.

| Point | Rule | Example |
| --- | --- | --- |
| contributing | `self.contribute(Http, { routes: { "GET /<plugin>/<what>": { handler } } })` from a `contribute(host, "<plugin>.<what>", …)`, in a file named after the route | `terminals/attach.ts:22-29`; two routes: `files/transfers.ts:54-67` |
| who may | the request's scope holds the person's own reference to the thing; the route never decides access itself | `files/transfers.ts:199-229` |
| ending | a stream holds what lets its caller in and ends at once when that goes (the tick withheld, the person removed), a read under way included | `terminals/attach.ts:48-51` |
| cleanup | every way out (the end, a failure, a loss, a disconnect) releases what was opened, once | `files/transfers.ts:84-133` |
| the address | answered by a method of the thing (so only a holder with the tick learns it), built with `URLSearchParams` | `files/server.ts:31` |
| tests | called as the HTTP component calls them (plugin tier), and end to end with a browser's cookie | `files/test/server.test.ts:355-356`; `files/test/transfers.test.ts:84-145` |

**Plugin sockets** (a plugin's own WebSocket for a stream both ways, the terminal's) come with the PTY work
(ERNDL-1174) and are not on main; until they land, a stream to the browser is a route as above and what the person
types is a method call.

## 13. The issue

One issue per kind, the plan and the record (`process.md`). Sections in this order: Problem (with an example) · p2's
features and extension points · The kind (the declaration as code) · Serving it · The view · The harness part · One
request, traced · Files · Tests (case by case, with the guide's numbers) · Numbers to meet · Decided · Recommended, to
confirm · Known · As built (**Where**, **Commits**, **Tests**, **Gates**, **Numbers**, **Review rounds**, **Missing
before the push**) · Mockups · Handover. Example: [ERNDL-1166 7a · Notes (notes.notes): the reference
kind](https://linear.app/earendil/issue/ERNDL-1166). The numbers a kind reports: `performance.md`, "A kind's numbers".

No README per plugin: a plugin's own documentation is its headers and doc comments; its plan and numbers are its
issue.

## Before you report

- [ ] Every member is in a tick's `gives`, or is meant for everyone let in and named in the comment in `ticks`
  (section 3). `makers` and `guests` were chosen on purpose.
- [ ] No check of who calls anywhere in the kind's server code; `caller` only as an author (section 4).
- [ ] Every read is a named query with its index named and a plan test; every write is one transaction; `clear` runs
  twice; a changed stored shape has its migration and a test of it (section 5).
- [ ] The part checks for nothing held; tools are named `<plugin>_<verb>`, answer JSON, refuse with `invalid` or
  `forbidden`, and are gone when their tick is (section 8).
- [ ] The view draws denied, unavailable, loading and empty; a control exists only while its member does; nothing a
  person reads is written outside `messages.ts`; `data-<plugin>` hooks on what a test finds; it works at the phone's
  and the desktop's size (sections 9, 10).
- [ ] Every refusal a person can cause carries a message, and its test asserts the code and the key (section 11).
- [ ] The tests of `testing.md`, "A kind's tests": who gets what, a grant changed while held, hidden, delete twice,
  reload, GC, counted work, messages, the part through `giving`, the view in a browser.
- [ ] Every file starts with what it is for; every export has a doc comment; nothing is copied from another plugin
  that could be shared (section 2; `chord-practices.md`, "Mistakes we made").
- [ ] The numbers of `performance.md`, "A kind's numbers", in the issue.

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
| how settings are read for the form | a `settingsOf` hook on the kind, from its store | 143 |
| hook order | `implement`, `create`, `configure`, `delete`, `workspaceGone`, `one` | the pattern |
| which defaults are written | `makers` always; `workspaces` and `stacking` only when not the default | the pattern |
| stored shapes | never changed in place: a new version with a migration and its test | 125 |
