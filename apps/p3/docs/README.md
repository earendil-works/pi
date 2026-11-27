# p3 (Pi Roam): start here

p3 is one Pi per person: a server on the person's machine, one worker process per session, and everything else as
plugins, built on Chord (`packages/chord`) and Durable (`packages/durable`). It lives in `apps/p3/` on main. Plans,
package briefs and decisions about packages live in Linear, one issue per package. This folder holds the guides an
agent needs while building, and the record of how p3 got here.

## Read before you build, in this order, in full

1. `process.md`: how a package goes from its Linear issue to the nightly; whose the base files are.
2. `chord-practices.md`: how p3 fits together and how a p3 plugin is built on Chord: the shape, the rules, the
   mistakes made and their fixes.
3. `kind-pattern.md`: how a kind plugin is built, file by file: the layout, the declaration, serving, the harness
   part and its tools, views and messages, refusals, tests, with the built-in plugin that shows each point.
4. `testing.md`: the tiers, what every package tests, the commands.
5. `performance.md`: the budgets, how to measure, the traps.
6. `names.md`: one name per thing; use these words in code, contracts and text.

For depth, only when a guide sends you there: Chord's design (`packages/chord/docs/design.md`; §3 hosts and links, §6
objects and admission, §§9-11 documents, tables, queries, lists, §17 registries, §21 reload, §23 HTTP, workers and
surfaces) and its plugin guide (`packages/chord/docs/plugin-authoring.md`).

## Reference (not instructions)

| Path | What it is |
| --- | --- |
| `decisions.md` | Mario's decisions up to the package split, newest last. Later entries win over earlier ones. Read the entries your package touches |
| `slices/` | the per-slice briefs written before the split. Read the ones in your package's area for p2's features, measurements and open points; the brief your package works from is its Linear issue |
| `slices/01-base-and-sessions/walkthrough/`, `slices/26-release/walkthrough/` | how slices 1 (base and sessions) and 26 (release, the `p3` command) were built, with the real code |
| `archive/` | older designs and notes; uses older names. Not a reference for building |

## The code, at a glance

| Path | What |
| --- | --- |
| `apps/p3/plugins/<name>/` | the built-in plugins; which to copy from, and what not to copy from each: "The examples", below |
| `apps/p3/src/api/v1/` | the API plugins import: `@earendil-works/p3/v1`, `/v1/server`, `/v1/worker`, `/v1/web` (web facets: the components plugins offer each other, the route, icons, and the built-in plugins' web contracts, the `layout` plugin's pane layout among them), and `/v1/testing` for their tests (`testPlugin`, `testServer`) |
| `apps/p3/src/` | the base: `bin.ts` (the `p3` command), `server.ts`, `worker.ts`, `supervisor.ts`, the Pis and their data directories (`files.ts`), the sockets that are the locks and the command's channel (`local-socket.ts`), what p3 is (`app.ts`: its API, facet kinds, principals) |
| `apps/p3/test/` | the tests of the base and of the whole, their harness (`topology.ts`, `support.ts`, `until.ts`) and the tests' probe plugin (`test/plugins/probe/`); a plugin's own tests, unit and end to end, sit in its `test/` folder |
| `apps/p3/bench/` | benchmarks, one per slice or package |
| `apps/p2/` | p2 (Pi Mobile), today's app: inspiration for what to build, never a source to copy |

## The examples

Copy the shape from these. Where `kind-pattern.md` says "being changed", or the mistakes table of
`chord-practices.md` says otherwise, follow those, not the example. "Still rough" is what the hackiness review of
2026-11-27 found in each and its cleanup has not yet removed: do not copy it.

| Plugin | The shape it shows | Still rough: do not copy |
| --- | --- | --- |
| `notes` (the reference), `checklist` | a kind with a store and a view | `useAction` and `failureText` copied into both views (use `useErrorText` of `plugins/things/contract.web.tsx`); a `gone` tombstone table in each store; notes' page cursor is a joined text (`<order>:<cursor>`) |
| `tools` | a flag kind with a harness part and no view | its part is tested with a stand-in reference (use `kindServer.giving`) and reads `ref.granted` where `HeldThing.granted` is meant |
| `prompt` | two kinds in one plugin | both parts are tested with stand-in references; `server.ts` compares `by.plugin` with its own package name written out (declare a `create.input` instead) |
| `environments`, `files` | a family of types; HTTP routes held as the person | the machine's worker part builds this device's environment itself, by the type's name; `files/transfers.ts` checks one right in four overlapping ways and races the request's body by hand; `files/test/server.test.ts` holds the routes' cases named after a review round |
| `sessions` | a workspace kind | a joined text key built by hand (`person:<id>` in `new-session.tsx`); a one-time rewrite of rows in `store.ts`; `serveStore` is one function of about 180 lines |
| every kind with a harness part | – | none has decision 142's nothing-held check yet (`kind-pattern.md`, section 6): write it in a new part |
| `canvas` | flag ticks, a people-only tick, live events | all of it, until its cleanup lands: it is not yet on the kind pattern (English in state and in the view, authors as text keys) |

Rules for this folder: the guides stay current (fix one the moment it is wrong or silent, in the commit that shows
it); the reference is not edited except to correct a fact.
