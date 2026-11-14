# Slice 1: base and sessions

**Goal.** A p3 server with a worker per session, headless: the owner creates, lists, renames and archives sessions;
each session's worker runs and knows its own facts. The tests' three tiers exist from here on, and so do the numbers.

**Builds:**

- `apps/p3/` as a workspace package `@p3/app`: `package.json` (exports `./v1`, `./v1/server`, `./v1/worker`),
  `tsconfig.json`, scripts `check` and `test`.
- Base code: `src/principals.ts` (`owner`, `person { id, name }`, `worker { session }`, `server`; nothing makes a
  person yet), `src/api/v1/` (Chord's plugin surface re-exported once, `defineFacet` bound to the principal, the
  `Session` host kind), `start.ts` (`startServer`, one worker kind), `worker.ts` (`startWorker`).
- Plugin `sessions`: the sessions table on the server (id, title, app, creator, created, archived), the owner's view
  (list, create, rename, archive), a session's facts for its own worker; a worker object proving the session runs and
  follows its facts.
- Tests: the topology harness (server and workers in one process over memory links), the first plugin, topology and
  end-to-end tests.
- Numbers: worker start and idle RSS on slayer and the phone, and the same for a p2 worker on the phone, to learn
  where p2's seconds go before p3's worker is shaped (owner, 2026-11-14: p2's worker starts on the phone take
  seconds).

**Depends on:** nothing.

**Read first:** `packages/chord/docs/design.md` §3–§7, §10 (data belonging to a host), §16–§18, §23 (the app kit,
workers); the kit's `src/node/app/` (`app.ts`, `worker.ts`, `info.ts`) and `src/node/workers/`; the tutorial app
`packages/chord/test/examples/61-tutorial/` (a complete kit app); `src/node/plugins/testing.ts`.

**Decided:** the kit is used for the real server (`startServer`, `startWorker`); plugins import only p3's API. The
principal is identity only (decisions of 2026-11-13). A session belongs to one app (here always `coding`).

**Open:** where the session facts live exactly (the admission design's `SessionsStore.facts`, keyed) is settled in
the details.

**Done when:** the tests pass in their tiers, the suite's time is reported, the numbers are in this brief.
