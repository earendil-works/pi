---
title: The Plugin Model: what a plugin is, what it may import, and how versions meet
cover: The Plugin / Model
kicker: A design proposal · Chord v2 · 2026-10-31
subtitle: Plugins, base code, versioned APIs and contracts, in one place, as discussed with the owner on 2026-10-31
stats:
  - 4 | kinds of import a plugin may write
  - 1 | integer per API version, in the import path
  - 0 | package.json fields Chord reads besides name and dependencies
  - 0 | type checks in the build
note: |
  A proposal written by the redesign session after a day of discussion with the owner. It collects what was decided
  and what is proposed into one model. Decided points cite their decision in `decisions.md`; proposed ones are marked.
  Nothing here is built yet beyond slices 7c and 10.
colophon: The Plugin Model · proposal · 2026-10-31
---

# Before we begin {.preface}

An app built on Chord is mostly plugins. Its own features are plugins, users add plugins, and agents write plugins
while the app runs. A plugin uses the app (where things live, who calls, how to declare objects), uses other plugins
(their objects and extension points), and uses npm packages. Each of those can change on its own schedule: the app
gets a new version, a plugin it depends on changes its contract, a package publishes a fix.

The questions the owner kept asking were all versions of one: when a plugin is written against one state of the world
and runs against another, what does it get, and who notices a mismatch? This model answers it with one rule for each
kind of import, and versions that sit where the dependency is written: in the code.

## Eight things to know

:::findings
1. **A plugin is a directory, or a single file.** A directory has a `package.json` (its name, its npm dependencies)
   and one file per host kind; a single file `hello.worker.ts` is a plugin named `hello` with no dependencies.
2. **Base code is internal unless it is an API.** The app exposes only versioned API modules to plugins; everything
   else is unreachable.
3. **API versions are in the import path.** `import { Session } from "@acme/app/v3"`: the plugin says what it was
   written for where it imports it; an unavailable version is a build error.
4. **APIs are split by host kind.** A shared module holds what every host may use (contracts, registry tokens, host
   kinds); `/v3/web` and `/v3/tui` hold UI pieces; a worker never loads React.
5. **Contracts carry their own versions.** A plugin carries the contract version it was written for; the provider
   binds it if it accepts that version, else the plugin waits with a clear reason.
6. **A plugin imports four things:** its own files, host packages, its npm dependencies, and the app's own plugins by
   relative path. Nothing else.
7. **Settings are arguments, extensions are registries.** What the app decides at startup is passed to its components;
   what plugins add is contributed.
8. **No type checking in the build.** Types come from where imports come from; editors and agents check, the build
   only builds.
:::

## Words used throughout

**Base code** is the app's own program; its **API** is the part plugins may import, published as **API modules**,
one per version and host kind. A **host package** is a module the running process provides to every plugin (Chord,
the app's API modules). A **contract** is an object type's declaration; a **registry token** an extension point's.
A **facet** is a plugin's declarations for one host kind.

# What a Plugin Is {#plugin lede="A directory or a single file, named once, with one file per host kind."}

```text
plugins/notes/                     a directory plugin
  package.json                     { "name": "@acme/notes", "dependencies": { "slugify": "1.6.6" } }
  contract.ts                      the object types and registry tokens it offers
  worker.ts  server.ts  web.tsx    one facet per host kind it needs
plugins/hello.worker.ts            a single-file plugin "hello" with one worker facet
plugins/hello.web.tsx              the same plugin's web facet
```

A directory plugin's name is its `package.json` name; Chord reads only `name` and `dependencies` from it. A
single-file plugin's name is its file's base name; it has no dependencies and imports only host packages. When a
single file needs a package or a second file, it becomes a directory. Two roots with the same name: the first root
wins, the other is reported (slice 7c).

# Base Code: Internal and External {#base lede="What the app keeps to itself, what it exposes, and how exposure is versioned."}

The app's base code is everything that starts the process: settings, startup, core objects' implementations, the
session index, migrations. Plugins must not depend on any of it, or every refactoring of the app would break them.
So the app draws a line and exposes only its **API**:

```text
src/api/v3/index.ts       shared: host kinds, the principal type, defineFacet per kind, core contracts, registry tokens
src/api/v3/web.ts         web only: shared UI pieces (a Sheet, theme variables), React-typed registry tokens
src/api/v3/tui.ts         TUI only: its UI pieces
src/…                     internal: everything else
```

Each API module is a host package of the kinds that may use it: `@acme/app/v3` for every kind, `@acme/app/v3/web` for
the web kind only. A worker plugin importing `@acme/app/v3/web` is a build error, and a worker process never loads
React. The shared module stays free of runtime imports of UI libraries: a registry token that needs a React type names
it with `import type`, which the build erases.

:::note | Proposed
The split of the external API into a shared module and per-kind modules answers the owner's worry about "web, TUI,
worker, server things all in the same index.ts". Proposed, not yet decided.
:::

# Versions in the Import Path {#versions lede="A plugin says what it was written for where it imports it."}

The app's API changes over time: a host kind is renamed, a principal variant changes. A plugin written for an older
API must not silently get the new one. So every API module has a version in its path, and the app lists which versions
it still provides:

```ts
// plugins/stats/worker.ts
import { defineFacet, Session, Panels } from "@acme/app/v3";
import { remote, str } from "@earendil-works/chord/next/v2";
```

- The app provides `/v3`, its current API. If version 2 plugins still work unchanged against it, `/v2` is listed too,
  pointing to the same module. An app that needs a compatibility layer makes `/v2` a thin module over `/v3`.
- An import of a version the app no longer lists is a build error: "@acme/app/v1 is not available: this app provides
  v3, v2". The plugin keeps its old code, and the message tells an agent exactly what to change.
- Nothing to fill in elsewhere: no `package.json` field, no npm ranges. Skeletons and examples import the current
  version, so an agent copies it without thinking.
- Chord's own surface is versioned the same way (`@earendil-works/chord/next/v2`).

Decided: "the API version must be declared by the plugin in code" (owner, 2026-10-31); the import path is how.

# Contracts and Registries {#contracts lede="Finer versions inside the API, and what crosses between plugins."}

Contracts and registry tokens keep their own versions inside the API, because they evolve independently of the API as
a whole:

- **An object type**: the consumer carries the contract version it was written for; the provider binds it at that
  version if it accepts it (`accepts` maps arguments forward and results and state back), otherwise the consumer waits
  "contract mismatch: v1, served v3". Shapes are fingerprinted, so a changed shape without a version bump is caught.
- **A registry token**: a name, a version and TypeScript types for what is contributed and read. Values are in-process
  things (functions, components), which cannot be fingerprinted: bumping the version when they change is the defining
  plugin's rule, and its `accepts` adapts older contributions.
- **Host kinds on registries** (proposed): a token names the kinds that serve it (`hosts: ["web"]`), typed, so a worker
  facet contributing to a web registry is a type error and a load error, not a silent no-op.

A contract file imports only host packages at runtime (Chord, the app's API); native types it mentions are type-only.

# What a Plugin May Import {#imports lede="Four kinds of import, each with one rule."}

| Import | Resolved to | Versioned by |
| --- | --- | --- |
| its own files (`./store.ts`) | copied into its script | the plugin itself |
| host packages (`@acme/app/v3`, `@earendil-works/chord/next/v2`, `react`) | the running process's instance, shared | the path's version; the app lists what it provides |
| npm packages in its `dependencies` (`slugify`, a third party's contracts package) | its own `node_modules`, bundled | the installed version |
| the app's own plugins (`../notes/contract.ts`), in the same root | copied into its script | the same revision: one repository |

A third-party plugin that wants the app's plugins' contracts gets them through the app's API (core contracts) or the
app's published package, as an npm dependency at the version it was written for, never from the running plugin's
files. Anything else (a path into base code, an unlisted version, a package not in its dependencies) is a build error.

# Settings and Extensions {#settings lede="How the app configures its components without letting plugins override it."}

Decided ("Settings are arguments, extensions are registries"): what the app decides at startup is an argument to the
component's facet, which base code constructs, and plugins cannot change it:

```ts
const http = createHttp(server, { listen: { port: 8788 }, links: { path: "/chord", maxPayload: MiB }, closeTimeout: 10_000, onError }, ctx);
```

What plugins add while the app runs is a registry: routes, authenticators, tools, panels. A component may offer both
for one thing: the session index takes its indexer as an argument, and may also follow a registry of indexers if
plugins should supply them.

# Building and Evaluating {#build lede="Unchanged from slices 7c and 10: one build on the server, evaluation everywhere."}

Only the server builds, because only the server has the sources. `createPlugins` builds every kind and needs only
names: per kind its platform and its host package names. Each process evaluates the scripts of its kind with its own
module objects (the server's at `plugins.load`, a worker's in `workerMain`, a page's in its base bundle), so a plugin
shares that process's Chord and API. Base-code facets are passed beside the plugins; they are not plugins, because
they close over the process's own values and never reload.

# Types and Tests {#tools lede="Where types come from, and how a plugin is tested alone."}

Types come from where imports come from: relative files and npm packages resolve natively in TypeScript; the app's API
modules ship `.d.ts` per version in the app's package. There is no type checking in the build (the owner: seconds per
build is too slow); editors check as an author types, and an agent may run `tsc` as a tool.

Testing a plugin alone (proposed): `testPlugin(dir, { kind, stubs })` builds the plugin like production, loads it on an
in-memory host with the kind's real host packages, and loads stub facets that serve the contracts it depends on. A stub
is an ordinary facet; there is no mocking framework.

# Open Questions {.epilogue lede="What is proposed here and still to decide."}

1. The external API split by host kind (`/v3`, `/v3/web`, `/v3/tui`).
2. Host kinds on registry tokens, typed and checked at load.
3. Single-file plugins (`hello.worker.ts`, named by the file).
4. Contracts of the app's plugins for third parties: through the API modules only, or also the app's npm package.
5. `testPlugin` with stub facets.
6. Reversing "Plugins import each other by name" (2026-10-31, morning) in favour of relative paths within the app
   and npm dependencies across it.
