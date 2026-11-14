# Slice 1: base and sessions

**Goal.** A p3 server with a worker per session, headless: the owner creates, lists, renames and archives sessions;
each session's worker runs and knows its own facts. The tests' three tiers exist from here on, and so do the numbers.

**Builds:**

- `apps/p3/` as the workspace package `@p3/app` (scaffold built 2026-11-14, not committed): `package.json`,
  `tsconfig.json`, `biome.json`, `check` and `test` (`node:test`). `apps/*` is an npm workspace: the lockfile gains
  p3's entries (commit with `PI_ALLOW_LOCKFILE_CHANGE=1`).
- Base code: `src/principals.ts`, `src/api/v1/` (Chord's plugin surface re-exported once, `defineFacet` bound to the
  principal, the `Session` host kind), `server.ts` (`startServer`, one worker kind), `worker.ts` (`startWorker`).
- Plugin `sessions`: the sessions table on the server (id, title, app, creator, created, archived), the owner's view
  (list, create, rename, archive), a session's facts for its own worker (the title is the server's: one write,
  decision "Session data on the server as host-keyed documents"); a worker object that proves the session runs and
  follows its facts.
- Kit changes: compression at the origin on the server and worker hosts; startup spans and `app.startup`
  (`archive/startup-telemetry/book.md`).
- Tests: the test topology (server and workers in one process over memory links), the first plugin, topology and
  end-to-end tests.
- Numbers: worker start and idle RSS on slayer and the phone, and the same for a p2 worker on the phone, to learn
  where p2's seconds go before p3's worker is shaped (owner, 2026-11-14).

**Depends on:** nothing.

**Read first, in full:**

- `packages/chord/docs/design.md` (all; for this slice above all §3–§7, §9–§11, §16–§18, §19, §21 "The plugin model",
  §23 "The app kit" and "Workers", §29); `packages/chord/docs/plugin-authoring.md`; `packages/chord/docs/host-keyed/`.
- Kit: `packages/chord/src/node/app/` (`README.md`, `app.ts`, `worker.ts`, `info.ts`, `layout.ts`, `data.ts`,
  `index.ts`), `src/node/workers/` (`README.md`, `workers.ts`, `process.ts`, `child.ts`, `base.ts`),
  `src/node/plugins/` (`README.md`, `testing.ts`), `src/link/link.ts` (`memoryLinkPair`).
- The tutorial app `packages/chord/test/examples/61-tutorial/` (a complete kit app: start, worker, API, a plugin with
  its test).
- From the archive: `map/book.md` (What Runs Where, Starting, The Session Catalog: the earlier skeleton draft; its
  `user` principal, chat and worker-owned title are superseded); `step-0/book.md` (the base's layout, the API package);
  `base-inventory/explainer/book.md` (Sessions and Their Data: the session service; its metadata store is superseded
  by host-keyed documents); `efficiency.md` (§1 item 1 and §3 are built); `startup-telemetry/book.md`.

**Decided:** the kit is used for the real server; plugins import only p3's API. The principal is identity only. A
session belongs to one app (here always `coding`). Base entries are named after what they are (`server.ts`,
`worker.ts`). Chord decision "a moved session: blocked tasks shown with a reason and an abort" applies when sessions
move (later).

**Open:**

- In-process workers for the topology tests: the kit's workers component only forks, and `workerInfoFacet`,
  `hostDataFacet` and `startWorker`'s wiring are not exported. A kit entry for in-process workers, or p3 wires hosts
  itself (and its tests then run another wiring than production).
- Where a session's facts live exactly (the admission design's `SessionsStore.facts`, keyed).
- Data directory `~/.p3` and port 8789 (proposed in `map/book.md`, never decided); how session ids are made.

**Done when:** the tests pass in their tiers, the suite's time is reported, the numbers are in this brief.
