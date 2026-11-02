---
title: The Plugin Model, a Primer: what a plugin depends on, and how mismatches are caught
cover: Plugins / from the Ground Up
kicker: A primer · Chord v2 · 2026-10-31
subtitle: One app, its own plugins and a stranger's plugin, followed through a year of changes, to show what the open decisions are about
stats:
  - 4 | things a plugin depends on
  - 3 | of them change without the plugin knowing
  - 8 | points still to decide
  - 1 | rule decided for base code: the version is in the import path
note: |
  Written by the redesign session for the owner, after the proposal `docs/next/plugin-model/` did not explain enough.
  Everything decided cites its decision in `decisions.md`; everything open is marked and ends with a recommendation.
  Built behaviour is slice 7c and slice 10 (`src/next-node/plugins/`).
colophon: The Plugin Model, a Primer · first edition · 2026-10-31
---

# Before we begin {.preface}

Acme builds a notes app on Chord. The app is a server, a worker per project and browser tabs. Most features are
plugins: Acme's own `notes` plugin keeps the notes, its `search` plugin searches them. Bob, who does not work at
Acme, writes a `stats` plugin that counts words per project and shows a panel. Bob wrote it in March. It is now
November.

Between March and November, three things changed without Bob: Acme released a new version of the app, Acme's `notes`
plugin changed what its notes look like, and Chord got a new release. Bob's plugin is still the March code. The
question this primer answers is the only question the plugin model has to answer:

**When a plugin written against one state of the world runs against another, what does it get, and who notices the
mismatch?**

The answer is different for each thing a plugin depends on, so the primer takes them one at a time.

## What a plugin is, in one picture

```text
plugins/stats/                     Bob's plugin
  package.json                     { "name": "@bob/stats", "dependencies": { "words-count": "2.1.0" } }
  worker.ts                        runs in each project's worker: counts words
  web.tsx                          runs in each tab: the panel
```

The server builds every plugin's files into one script per host kind (esbuild, a few milliseconds each). Each
process evaluates the scripts of its kind: the worker runs `worker.ts`'s script, a tab runs `web.tsx`'s. That much
is built (slices 7c and 10).

# Four Things a Plugin Depends On {#four lede="Who changes each one, and when the plugin finds out."}

Look at the top of Bob's `worker.ts`:

```ts
import countWords from "words-count";                       // 1. an npm package
import { defineFacet, Project } from "@acme/app";           // 2. the app's base code
import { obj, num, remote } from "@earendil-works/chord/next";   // 3. Chord
import { Notes } from "@acme/notes/contract";               // 4. another plugin
```

Each import is a different kind of dependency, and they behave differently over time:

| Import | Who changes it | What Bob's plugin gets today |
| --- | --- | --- |
| `words-count` | its npm author | the version installed in Bob's plugin directory, copied into his script: frozen until Bob updates it |
| `@acme/app` | Acme, when it releases the app | whatever the running app is: always the newest |
| `@earendil-works/chord/next` | Chord, through Acme's upgrade | whatever the running app ships: always the newest |
| `@acme/notes/contract` | Acme, whenever it edits `notes` | the running `notes` plugin's file, copied at Bob's next build: always the newest |

The first row is safe: npm packages are copied into the script at the version Bob installed, so they never change
under him. The other three rows always give the newest, and Bob's March code meets November's app. Whether that
works depends on what changed. The rest of the primer is about those three rows.

:::note | Why not copy base code and Chord into the script too
Because they must be shared. If Bob's script carried its own copy of Chord, its `defineFacet` would make facets the
worker's host does not recognize, and its `Project` host kind would be a different object from the app's. Base code
and Chord are **host packages**: the process provides one instance and every plugin uses it. That is decided and
built. It is also why they can change under a plugin.
:::

# Base Code: Versions in the Import Path {#base lede="Decided: a plugin says which app API it was written for, where it imports it."}

In June, Acme renames the host kind `Project` to `Workspace`. Bob's March plugin imports `Project`; it no longer
exists. Without any versioning, Bob's plugin builds (the build does not type check), then fails when it runs with
something like "Cannot read properties of undefined", deep inside his code.

Decided on 2026-10-31 (decision "API versions in the import path"): the app exposes only **API modules**, each with a
version in its path, and lists the versions it still provides.

```ts
// Bob, in March
import { defineFacet, Project } from "@acme/app/v2";

// Acme's app, after June
apiVersions: { "@acme/app/v3": apiV3, "@acme/app/v2": apiV2 }   // still provides v2, through a thin layer over v3
```

Now there are two cases, both visible:

- Acme still provides `/v2`: Bob's plugin gets the v2 module, in which `Project` still exists (Acme's thin layer maps
  it to `Workspace`). It works.
- Acme dropped `/v2`: Bob's plugin fails to build with "@acme/app/v2 is not available: this app provides v3". The
  plugin is left out (per plugin: nothing else breaks), and the message tells Bob, or an agent, exactly what to
  change.

Nothing outside the code says what Bob depends on: no `package.json` field, no version ranges. The import says it.

**What is still open here** is what goes into the API and how Chord relates to it. That is point 2 below.

# Other Plugins: the Contract Problem {#contracts lede="Why importing another plugin by name gives the wrong answer for a stranger's plugin."}

Bob's `stats` asks Acme's `notes` for the notes of a project. Plugins talk only through **contracts** (the type of an
object: its state and methods) and registries. A contract has its own version:

```ts
// plugins/notes/contract.ts (Acme), March
export const Notes = remote("notes", {
	version: 1,
	params: { project: str() },
	hostAddress: ({ project }) => Project({ id: project }),
	variants: { reader: { state: { list: obj({ items: arr(str()) }) } } },
});
```

Bob's plugin imports this file, and the build copies it into his script. When his plugin asks for `Notes`, it says
"version 1, this shape"; the provider (the `notes` plugin's code in the worker) checks that it can serve that version.

In September Acme changes notes: each note gets a timestamp, `items: arr(obj({ text: str(), at: int() }))`, and the
contract becomes version 2. Acme also writes an `accepts` mapping, so consumers of version 1 still get a list of
strings. Chord's contract versioning exists for exactly this case.

Now the question is: which version of the contract file ends up in Bob's script?

## Today: by name, the newest file

Decided this morning and built (decision "Plugins import each other by name"): `@acme/notes/contract` resolves to the
running `notes` plugin's `contract.ts`. Trace what happens at Bob's next build after September:

:::steps | A rebuild after Acme's change
+++ The build copies the new file
Bob's `stats` is rebuilt (a rollout, a restart, any edit anywhere). `@acme/notes/contract` is now the version 2 file,
and it is copied into Bob's script.
+++ Bob's plugin claims version 2
At runtime his plugin asks for `Notes` version 2. The provider serves version 2 gladly: no `accepts` is used.
+++ Bob's code reads version 1's shape
Bob's code does `list.items.join(" ")` and `countWords` on it. The items are now objects. He counts the words of
`"[object Object] [object Object]"`. Nothing fails; the panel shows wrong numbers.
:::

The contract version was supposed to protect Bob, and it did nothing: copying the newest file made Bob's plugin claim
a version his code was never written for.

## Proposed: the version Bob wrote against

The contract file must come from where Bob's code came from: the state of the world he wrote against. For a stranger's
plugin that is an npm dependency at a fixed version:

```json
// plugins/stats/package.json
{ "name": "@bob/stats", "dependencies": { "@acme/notes-contracts": "1.0.0" } }
```

Now Bob's script carries the March contract file forever (npm packages are copied at the installed version, as row 1
of the first table). His plugin asks for version 1; the provider maps it through `accepts`; Bob gets strings as
before. If Acme ever stops accepting version 1, Bob's plugin waits with "contract mismatch: v1, served v3", visible in
the UI, never wrong numbers.

For Acme's own plugins (`search` using `notes`) the problem does not exist: they live in one repository and change in
the same commit. They import each other by relative path, `../notes/contract.ts`, the same file at the same revision.
The by-name rule also needed path aliases in the TypeScript configuration for every plugin (six were added for the
tests and examples of slice 10); relative paths need none.

# The Open Points {#open lede="Eight decisions, each with the problem it answers and a recommendation."}

## 1. Reverse "import by name"

**Problem:** the trace above: a stranger's plugin silently claims a contract version it was not written for.
**Proposal:** the app's own plugins import each other relatively (`../notes/contract.ts`); everyone else gets
contracts as an npm dependency at a fixed version. Importing a running plugin by name is removed; a relative path
leaving the plugin's root stays a build error.
**Recommendation:** do it, in the plugin slice (slice 10 is committed with by-name imports; the change is small:
`build.ts` and the examples' imports).

## 2. What the app's API is, and Chord in it

**Problem:** a plugin imports two host packages that both change, `@acme/app/v3` and `@earendil-works/chord/next/v2`.
Acme must then say which combinations work: does a plugin importing app v3 and Chord v1 still run? Two version
numbers per plugin, and a matrix nobody tests.
**Proposal:** plugins import only the app's API. The app re-exports the part of Chord it supports:

```ts
// src/api/v3/index.ts (Acme's base code)
export { obj, arr, str, int, remote, local, defineRegistry } from "@earendil-works/chord/next";
export { Workspace, Panels, defineFacet } from "../../core.ts";
```

One number, the app's, describes everything a plugin gets from its host. When Acme upgrades Chord in a way that
breaks plugins, Acme bumps its API version, and decides whether `/v2` survives as a thin layer.
**Generations:** if the app provides `/v3` and `/v2`, a facet must import from one of them only, never both (the
build checks it), because `/v2`'s `Panels` and `/v3`'s `Panels` may be different registries.
**Recommendation:** yes; app kit apps get it for free (`chord/next/app` provides the API module).

## 3. The API split by host kind

**Problem:** the API module holds everything plugins need, including web things: a `Sheet` component, a theme, the
`Panels` registry whose entries are React components. A worker plugin imports `@acme/app/v3` for `Workspace`, and the
worker process has to load the module, so it loads React.
**Proposal:** `/v3` holds what every host may use (contracts, registry tokens, host kinds, principals) and imports no
UI library at runtime; `/v3/web` and `/v3/tui` hold UI pieces. A worker facet importing `/v3/web` is a build error.
**Recommendation:** yes.

## 4. Host kinds on registry tokens

**Problem:** Bob contributes his panel from `worker.ts` by mistake (`self.contribute(Panels, …)`). The worker has no
`Panels` registry; the contribution sits in a table nobody reads. Nothing fails; the panel never appears.
**Proposal:** a token names the kinds that serve it, `defineRegistry("app.panels", { version: 1, hosts: ["web"] })`;
contributing from another kind is a type error (the facet's `self` is typed per kind) and a load error.
**Recommendation:** yes; together with point 3, `Panels` lives in `/v3/web` anyway.

## 5. Contracts for third parties

**Problem:** with point 1, Bob needs Acme's plugins' contracts as an npm package. Which package?
**Options:** (a) the app's API exports the contracts of its own plugins that others may use (`@acme/app/v3` has
`Notes`): one place, versioned with the app; (b) Acme publishes its app package to npm and Bob depends on it; (c) each
plugin publishes its own contracts package. (c) is what the owner called unpleasant.
**Recommendation:** (a) for contracts Acme wants others to use: the API is the app's promise. Note: in (a) the
contract file comes with the API version, so Bob's v2 import keeps v2's contract files (the thin layer keeps them).

## 6. Testing a plugin alone

**Problem:** testing Bob's `stats` needs a worker with a `Notes` provider, an app API, a store.
**Proposal:** `testPlugin("plugins/stats", { kind: "worker", stubs: [notesStub] })` builds the plugin as production
does, loads it on an in-memory host with the kind's real host packages, and loads stub facets that serve the
contracts it uses. A stub is an ordinary facet (`host.serve(Notes, () => ({ list: constant({ items: ["a b"] }) }))`).
**Recommendation:** yes, in the app kit.

## 7. Single-file plugins

**Problem:** a plugin that adds one route needs a directory and a `package.json` with a name.
**Proposal:** `plugins/hello.server.ts` is a plugin named `hello` with one server facet, no dependencies; when it
needs a package or a second file, it becomes a directory.
**Recommendation:** yes, cheap; agents write many such plugins.

## 8. The app's own plugins follow the same rules

**Problem:** are Acme's built-in plugins special?
**Proposal:** no. They import the app's API like everyone (not base code's internals), import each other relatively
(point 1), are built at startup and reload like any plugin. The only difference: they change in the same commit as
base code, so they always use the newest API version.
**Recommendation:** yes. It keeps base code small and means every built-in plugin is an example of a correct plugin.

# What to Decide {.epilogue lede="In the order that makes each answer easier."}

1. Reverse "import by name" (recommended: yes, in the plugin slice).
2. Plugins import only the app's API; Chord is re-exported in it; one generation per facet (recommended: yes).
3. Split the API by host kind (recommended: yes).
4. Host kinds on registry tokens (recommended: yes).
5. Contracts for third parties through the app's API (recommended: (a)).
6. `testPlugin` with stub facets (recommended: yes).
7. Single-file plugins (recommended: yes).
8. Built-in plugins follow the same rules (recommended: yes).

Later, not part of these: project plugins (per working directory, with trust), and installing plugins from npm or git.

# Words {.appendix}

| Word | Meaning |
| --- | --- |
| base code | the app's own program, started by `node server.ts`; never reloads |
| API module | the part of base code plugins may import, one per version (`@acme/app/v3`) |
| host package | a module the process provides to every plugin (Chord, the API modules, React on the web) |
| contract | an object type: its state and methods, with a version; consumers name the version they use |
| `accepts` | the provider's mapping that serves an older contract version |
| registry token | an extension point (`Panels`); plugins contribute to it |
| facet | a plugin's code for one host kind (`worker.ts`) |
| generation | one set of API versions provided together (`/v3` with its web and tui modules) |
