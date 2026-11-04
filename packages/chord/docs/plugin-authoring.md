# Writing a Chord plugin

For agents and people writing plugins for an app built on Chord v2. Self-contained: everything a plugin author needs
is here. In the examples the app is "Acme", its API package `@acme/app`; replace it with your app's (its docs name the
package and the versions it provides).

## What a plugin is

A plugin is a feature of a running app: it serves objects (state plus methods) and contributes to the app's
registries (routes, panels, tools). The app loads it on its hosts (the server, its workers, browser pages, terminal
clients), reloads it when it is edited, and leaves it out alone when it is broken. Plugins talk to each other only
through object contracts and registries.

## Layout

A **directory plugin**, in one of the app's plugin roots:

```text
plugins/stats/
  package.json          { "name": "@bob/stats", "dependencies": { ... } }      required; the name is the plugin's
  server.ts             the server facet           one file per host kind the app has, each optional:
  worker.ts             the worker facet           <kind>.ts, .tsx, .js or .mjs; default export: a facet
  web.tsx               the web (page) facet
  tui.ts                the terminal client facet
  contract.ts           contracts every kind may import (data only)
  contract.web.tsx      contracts and tokens for web facets only (`contract.<kind>.ts(x)` per kind)
  *.ts, *.css, assets/  plain files of the plugin
```

- `package.json`: `name` (an npm package name, scoped or not) is the plugin's name; `dependencies` are bundled into
  its scripts; `"chord": { "external": ["better-sqlite3"] }` keeps named packages external in Node facets (native
  addons).
- A **package of several plugins** (a repository holding them) lists their folders in its own `package.json`:
  `"chord": { "plugins": ["./notes", "plugins/*", "!plugins/draft"] }` (paths, globs and `!` exclusions; `.` is the
  package itself; a listed folder inside another listed one is refused). Without the field, the package is one plugin
  when its top has facet files, else **every** subfolder with a `package.json` is a plugin: a repository with nested
  packages that are no plugins (a helper library, examples, fixtures) must list its plugins in `chord.plugins`.
- A plugin with no facet file holds contracts others import.
- A **single-file plugin** is a file at a root's top named `<name>.<kind>.ts` (or `.tsx`, `.js`, `.mjs`):
  `hello.server.ts` and `hello.web.tsx` are the plugin `hello` with two facets. No `package.json`, so no
  dependencies; it imports only the app's API and defines its contracts inline. When it needs more, make it the
  directory `hello/` with a `package.json` named `hello`: the app treats it as the same plugin.

## A facet

```ts
// plugins/stats/worker.ts
import { defineFacet, int, local, str } from "@acme/app/v3";
import { Indexers } from "@acme/app/v3/worker";
import { Notes } from "../notes/contract.ts";

const Stats = local("bob.stats", { version: 1, params: { project: str() }, members: { words: int() } });

export default defineFacet((host, self) => {
	self.contribute(Indexers, { name: "word count" });                 // a registry entry while the plugin is loaded
	host.serve(Stats, ({ project }, self) => {                          // a factory, run per object
		const notes = self.get(Notes, { project });                      // a dependency: Stats waits until Notes is live
		return { words: self.derive([notes.text], ([text]) => text.split(/\s+/).filter(Boolean).length) };
	});
});
```

A facet only declares (`host.serve`, `self.contribute`, `host.references`), synchronously. Everything at runtime
happens in objects: state in documents and tables, standing behaviour in a `local` object with empty params (it lives
as long as the host). Names are prefixed by the plugin (`bob.stats`).

## Tables shown live

A table has no watch. To show its rows live, the object owning it declares a live query with a limit:

```ts
host.serve(Store, (_params, self) => {                 // a local type with empty params: it may have tables
	const items = self.table(Items);
	const newest = self.query(items, query(Items).orderBy((i) => i.id, "desc"), 50);
	return { items: newest, add: async (row, ctx) => self.tx(async (tx) => tx.put(items, row), ctx) };
});
```

- Chord runs it before the object goes live and again in each commit of the object that writes the table; watchers get
  only what changed. A commit writing no such table runs nothing.
- Only the object's own tables, the query fixed for the object's attempt (decide it from params), the limit required
  (`invalid/args` without one).
- One query per writing commit, at most `limit` rows (for 100 rows about 60 µs more per commit, 80 µs when watched;
  `benchmarks.md`): there may be dragons for a table written hundreds of times a second. Keep a document for those.
- Never read a table in `self.open` to fill a window: that makes a native, and the object restarts at every reload of
  its plugin instead of swapping in place. A live query is no native.

## What a plugin may import

| Import | Resolves to |
| --- | --- |
| its own files (`./label.ts`, `./icon.svg?url` in web facets) | inlined into its script |
| the app's API, a version in the path: `@acme/app/v3`, its kind's module `@acme/app/v3/worker` | the app's own instance (a host package), never copied |
| another plugin of the same root (one repository): `../notes/contract.ts` | inlined (a copy, frozen at this build) |
| a package in `dependencies`: `@bob/notes`, `@bob/notes/web` | inlined from `node_modules` at the installed version, through the package's `exports` |
| a plugin inside a dependency on a whole repository of several: `@bob/plugins/notes/contract.ts` | inlined, as any package file |
| a `chord.external` package, a Node builtin (Node facets) | loaded when the script runs |
| `pluginFile` from `@earendil-works/chord/plugins` | the absolute path of a file of this plugin |

Refused at build, each with the file, line and rule:

- `@acme/app/v1` when the app does not list v1 ("@acme/app/v1 is not available: this app provides v3, v2");
  another kind's module (`@acme/app/v3/web` from a worker facet); two API versions in one facet.
- Chord itself (`@earendil-works/chord`): the app's API re-exports what plugins may use.
- A relative path leaving the plugin's root (base code, another root); a file of a directory that is no plugin.
- A file copied from another plugin importing anything but the API and its own plugin's files.
- A per-kind file (`contract.web.tsx`, `contract.Web.ts` alike) or another kind's facet file (`web.tsx`) reached from
  a facet of another kind, directly or through other files (the error names the chain). Files inside npm packages are
  checked only when the package is plugin code (its `package.json`, or one above it in the package, has a `chord`
  field); ordinary libraries name files as they like (`pdf.worker.mjs`).
- A package file whose real path is outside the plugin's own `node_modules` (a `file:` dependency linked elsewhere, a
  package importing `../src`).
- A copied file importing a Node builtin or a package.
- A package not in `dependencies`; `import.meta`, `__dirname`, `__filename`, a literal `import("x")`, top-level
  `await` (read files through `pluginFile`).
- In a single-file plugin, anything but host packages.

Contract files mention native things (React components, functions) only through `import type`; at runtime they import
only the API and the plugin's own data-only files.

## An app's API is a package

The app's API is a workspace package of the app's repository: a `package.json` named `@acme/app` with an `exports`
entry per module, listed in the repository root's `workspaces`, so `npm install` links it into `node_modules`:

```json
{
	"name": "@acme/app",
	"private": true,
	"type": "module",
	"exports": {
		"./v3": "./src/api/v3/index.ts",
		"./v3/web": "./src/api/v3/web.ts",
		"./v3/worker": "./src/api/v3/worker.ts"
	}
}
```

Plugins, tests and tools resolve it alike: a facet imports `@acme/app/v3`, and so do the app's base code, a test, and
a plugin's `contract.ts` that a test or a script imports. In a plugin's build it stays a host package (left out of the
script, the process's own instance passed in when the script is evaluated).

## Errors

Throw Chord's own errors where Chord's built-in checks would, from the API (it re-exports them):
`invalid("args", "a note needs a title")` for arguments a method refuses (`"params"` for params a factory refuses),
`forbidden("viewers only")` for a principal a factory or method refuses. The caller gets the same
`{ code: "invalid", reason: "args" }` or `{ code: "forbidden" }` across every link. For codes of the plugin's own throw
`new PluginError(code, message, details)`. Only the code, reason, message and JSON details cross a link, never a stack
or a cause.

## Contracts and versions

A plugin carries the contract it was written against. Plugins changing together (one root, one repository) import
each other's contract files by relative path. A plugin from another repository takes the contracts as a dependency
pinned to a version: an npm version, or a git ref (`"@bob/notes": "github:bob/notes#<commit>"`, `"git+https://...#v2"`).
The app's own contracts for third parties come with its API (`@acme/app/v3` exports `Notes`). When a contract
changes shape, bump its `version`; the provider serves older consumers through `accepts`, else they wait "contract
mismatch" (visible, never wrong data).

## How the app builds it

The server builds each facet with one esbuild call from source: TypeScript and TSX (JSX with the automatic React
runtime), JS, JSON, CSS (web facets: one stylesheet per facet), assets and WASM by URL (`import url from "./x.svg?url"`).
No type check, no build hooks, no `dist` needed; generated files are committed. The script is evaluated in each
process of its kind with that process's API modules. A failed build or evaluation leaves the plugin out (at startup)
or keeps its old code (at a reload), reported with the error.

## Styles, themes and state across reloads (web and terminal facets)

- A web facet's CSS is served with its script and swapped when the plugin reloads. Scope it with a **CSS module**: a
  file named `*.module.css` has its class names made unique to the plugin and the file, and its import is the mapping
  (`import styles from "./notes.module.css"; <div className={styles.card}>`). Plain CSS files still work; their class
  names should then start with the plugin's name.
- Read the app's look from its CSS variables (`var(--accent)`, `var(--bg)`, `var(--fg)`, `var(--muted)`, `var(--error)`,
  `var(--warning)`, `var(--success)`, and the app's own roles), never fixed colours: the active theme sets them.
- In a terminal facet, ask the app's theme lookup for a role (`theme.fg("accent", "Notes")`); never write raw colours.
- A reload of the plugin remounts its components (each is a new function): their `useState` starts over. Keep what
  must survive an update (a half-typed message, a scroll position) in page state, kept by the page's host under a key
  prefixed with the plugin's name: `usePageState("stats.draft", "")` instead of `useState("")` (from the app's web
  API); in a terminal facet `scope.pageState("stats.draft", "")` on the `TuiScope` it was given. Any value, never sent
  anywhere, gone with the page.
- A theme is data: contribute a `Theme` (`{ id, name, mode, colors, web?, tui? }`) to the kit's `Themes` registry,
  from a web facet and a terminal facet to reach both. Users pick one dark and one light theme.

## Messages

Text people read is written once, in code, and rendered in each viewer's language (design §23, "Messages and
languages"). From the app's API:

```ts
// plugins/stats/messages.ts: imported by every facet that renders, and by the worker when it builds messages as data
export const messages = defineMessages("bob.stats", {
	en: { title: "Stats", words: (n: number) => (n === 1 ? "1 word" : `${formatNumber(n)} words`), done: (by: string) => `${by} finished` },
	de: { title: "Statistik", words: (n) => (n === 1 ? "1 Wort" : `${formatNumber(n)} Wörter`), done: (by) => `${by} ist fertig` },
});
```

- The namespace is the plugin's name; keys are names (`title`), never English text; the English catalog comes first and
  annotates its functions' parameters, the others take them from it. A missing key, an unknown one or a wrong argument
  is a type error. Plurals and word order are functions; dates, times and numbers go through `formatTime` and
  `formatNumber` inside them (they follow the language being rendered).
- Every facet that renders contributes the plugin's own catalogs: `self.contribute(Translations, messages.translations)`
  (registries are per host; the host learns the languages offered from them).
- Render in the host's language: `const { t } = useMessages(messages)` in a component, `const t =
  scope.messages(messages)` in a terminal facet. The plain `messages(key, ...)` has no language of its own (outside a
  render: the first catalog); never use it in UI code.
- Objects never store sentences: a member typed `union([MessageSchema, nul()])` holds `messages.message("done", by)`
  (keys whose arguments are strings, numbers, booleans or `null`; a date as an ISO string), and each client renders it
  with `t.render(message)`, which shows the key of a message it does not know.
- A translation is a plugin: its catalogs typed `MessagesOf<typeof messages>` (a type-only import of the other plugin's
  `messages.ts`), partial allowed, in one shared file contributed as a list from each facet that renders:
  `self.contribute(Translations, [{ namespace: "bob.stats", locale: "fr", messages: statsFr }])`; `override: true`
  replaces the plugin's own catalog of that locale.
- Never translated: the model's prompts and answers, log lines, error codes.

## Installing

- `plugins.installPlugin({ git: "https://github.com/bob/stats.git", ref: "v1.2.0" }, root, ctx)`: a shallow clone of
  the branch, tag or commit into `<root>/stats`; its plugins are the folders its `chord.plugins` lists, else by
  convention. `{ npm: "@bob/stats", version: "1.2.0" }`: the package extracted into `<root>/@bob/stats`. Then their
  dependencies are installed (`npm install --omit=dev --ignore-scripts`; no lifecycle scripts run). Refused: a plugin
  name the app has already, an existing directory, a ref or name starting with `-`.
- Removing is deleting the directory. To update, install another ref (a new directory) or delete and install again.

## Testing a plugin alone

```ts
import { testPlugin } from "@earendil-works/chord/plugins";
import * as apiV3 from "@acme/app/v3";
import * as apiV3Worker from "@acme/app/v3/worker";

const Notes = apiV3.local("acme.notes", { version: 1, params: { project: apiV3.str() }, members: { text: apiV3.str() } });
const Stats = apiV3.local("bob.stats", { version: 1, params: { project: apiV3.str() }, members: { words: apiV3.int() } });
const notesStub = apiV3.defineFacet((host) => host.serve(Notes, () => ({ text: apiV3.constant("a b c") })));

const t = await testPlugin("./plugins/stats", {
	kind: "worker",
	kinds: ["server", "worker", "web"],                                  // the app's kinds (by default: those its files name)
	api: { name: "@acme/app", versions: ["v3"] },
	modules: { "@acme/app/v3": apiV3, "@acme/app/v3/worker": apiV3Worker },   // the real API modules
	stubs: [{ name: "@acme/notes", facet: notesStub }],                   // facets serving what it uses
	principal: { kind: "worker", project: "p1" },                          // the host's principal (optional)
}, ctx);
const stats = await t.host.get(Stats, { project: "p1" }, ctx);           // stats.words.value: 3
t.contributions(apiV3Worker.Indexers);   // its entries in a registry nobody serves (the helper collects them)
t.unserved();                            // contracts its requests wait for: stub these
await t.root(async (ctx) => ..., ctx, { principal: { kind: "user", id: "u1" } });
await t.close(ctx);
```

The plugin is built as production builds it and loaded on an in-memory host (a `:memory:` store). Stubs are ordinary
facets with fake data. A test imports the API by its package name and the plugin's own contracts from its
`contract.ts` (the build bundles its own copy; contracts are data: the same name, version and schema bind); contracts
of plugins it has no files of, it declares again, as `Notes` above.

## Checklist

1. `package.json` with a valid name (or a single file `<name>.<kind>.ts`).
2. One facet file per kind it runs on; each default-exports `defineFacet(...)`.
3. Imports: the app's API at one version, own files, same-root contract files by relative path, other repositories'
   by package name pinned in `dependencies`.
4. Contracts prefixed with the plugin's name; a version bump for every change of shape.
5. Live rows of a table through `self.query(table, q, limit)`, never a read in `self.open`.
6. Files of one kind named `*.<kind>.ts(x)`.
7. A test with `testPlugin` and stubs for every name `t.unserved()` lists.
8. Texts people read in `messages.ts` (`defineMessages`), its catalogs contributed from each facet that renders, state
   holding messages as data.
