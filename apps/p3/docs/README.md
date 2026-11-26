# p3 (Pi Roam): start here

p3 is one Pi per person: a server on the person's machine, one worker process per session, and everything else as
plugins, built on Chord (`packages/chord`) and Durable (`packages/durable`). It lives in `apps/p3/` on main. Plans,
package briefs and decisions about packages live in Linear, one issue per package. This folder holds the guides an
agent needs while building, and the record of how p3 got here.

## Read before you build, in this order, in full

1. `process.md`: how a package goes from its Linear issue to the nightly; what you must never change.
2. `chord-practices.md`: how p3 fits together and how a p3 plugin is built on Chord: the shape, the rules, the
   mistakes made and their fixes.
3. `testing.md`: the tiers, what every package tests, the commands.
4. `performance.md`: the budgets, how to measure, the traps.
5. `names.md`: one name per thing; use these words in code, contracts and text.

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
| `apps/p3/plugins/<name>/` | the built-in plugins; `sessions` is the model plugin |
| `apps/p3/src/api/v1/` | the API plugins import: `@earendil-works/p3/v1`, `/v1/server`, `/v1/worker`, `/v1/web` (web facets: the components plugins offer each other, the route, icons, and the built-in plugins' web contracts, the `layout` plugin's pane layout among them), and `/v1/testing` for their tests (`testPlugin`, `testServer`) |
| `apps/p3/src/` | the base: `bin.ts` (the `p3` command), `server.ts`, `worker.ts`, `supervisor.ts`, the Pis and their data directories (`files.ts`), the sockets that are the locks and the command's channel (`local-socket.ts`), what p3 is (`app.ts`: its API, facet kinds, principals) |
| `apps/p3/test/` | the tests of the base and of the whole, their harness (`topology.ts`, `support.ts`, `until.ts`) and the tests' probe plugin (`test/plugins/probe/`); a plugin's own tests, unit and end to end, sit in its `test/` folder |
| `apps/p3/bench/` | benchmarks, one per slice or package |
| `apps/p2/` | p2 (Pi Mobile), today's app: inspiration for what to build, never a source to copy |

Rules for this folder: the guides stay current (fix one the moment it is wrong or silent, in the commit that shows
it); the reference is not edited except to correct a fact.
