# Slice 1: base and sessions

**Goal.** A p3 server with a worker per session, headless: the owner creates, lists, renames, archives and restores
sessions; each session's worker runs and follows its own facts from the server. The test tiers exist from here on, and
so do the numbers.

State: built 2026-11-14; review round 1 (Sol, Astra, Fable: no blocking findings) done and fixed; round 2 next. Not
committed. The owner accepted every recommendation of the plan (2026-11-14). The scaffold is committed (4cc9fd409).

As built, differences from the plan below:

- `SessionFacts` is in `contract.ts` (the worker facet holds it, so it cannot be a server-only contract file).
- `SessionWorker` is `SessionWorker` (`sessions.worker`), with only `facts` (round 1: `startedAt` was unused).
- A session's facts hold `SessionInfo` (title, app, creator, `createdAt`, `archivedAt`), no id: the address is the key,
  and a copy under another address rewrites keys, never JSON (round 1, all three reviewers). A list row is the id plus
  that info. Times are named `createdAt` and `archivedAt` (round 1).
- The creator is one `json` column; the table has an index on `createdAt` and the list maps rows with `mapShared` (round
  1: no full scan per write, unchanged rows stay the same objects).
- A new session's title is empty: each view shows its own "New session" in the viewer's language (round 1, decision
  open below). Titles take at most 200 characters.
- The kit exports `appInfoFacet` and `workerInfoFacet` (`packages/chord/src/node/app/index.ts`, README, CHANGELOG).
- `src/app.ts` holds `API`, `KINDS`, `PRINCIPALS` and `mayReachSession`; `server.ts` and the test topology both use them.
- The test topology fails its start when a server plugin fails to load (as the kit's required root), records a worker's
  load failures, and its hosts wait at most 5 s for an object.
- `tsconfig.json` sets `declaration: false`: p3 emits nothing, and declaration checks of contracts inferred through a
  workspace symlink fail with TS2883.

Measured on slayer (Linux x64, Node 24.4.1), `bench/slice-1.ts`, after round 1: server listening 45 ms after `startP3`
began (module loading not included); the server process (server and the bench's client) 111.3 MiB `RssAnon`; worker
start cold 292 ms (with the worker base's build), warm 99 ms (median of 10); an idle worker 29.5 MiB `RssAnon`. The
phone and p2's numbers follow once the code is on main (the phone deploys from git). Tests: 15, `npm test` about 1 s.

Decisions from round 1 for the owner (recommendations implemented where marked):

1. A new session's title: empty, each view renders "New session" in its viewer's language (recommended, implemented),
   or English text stored.
2. API v1 re-exports all of Chord's root (`export *`): keep, and record that v1 follows Chord's root (recommended), or an
   explicit list as the tutorial has.
3. "app" for p3 itself (`@p3/app`, `src/app.ts`, the kit's word) against `names.md`'s app: a line in `names.md`
   (recommended) or renaming to `@p3/api`.
4. Archive only sets `archivedAt`; stopping the worker (design §25) needs a way for plugins to stop a worker: carry it to
   the lifecycle slice with delete (recommended by Astra and Sol).

Carried from round 1: a hold of `SessionWorker` for an id never created starts a worker (the route's `authorize` cannot
ask the table: admission or the session service's `open` decides it); archive does not stop the worker (above); the list
is the newest 200, archived ones included, without paging.

## p2's features in this area

From `apps/p2/docs/p3-functions/sessions-access.md` and p2's `plugins/sessions/` (domains 1 and 2 of the map):

| p2 feature | p3 |
| --- | --- |
| create a session (local or remote, directory check, defaults) | built: create with a title; location and defaults come with slices 3 and 8 |
| a live list that never starts a worker | built: the newest 200, from the server's table |
| rename | built (owner); automatic and agent-set titles: slice 18 |
| archive, restore | built as a mark; stopping the worker, ending guest access and forwards: slice 18 |
| pin, relocate, clone, fork, delete, unread marks | slice 18 |
| list grouped by machine and directory | slice 15 (groupings) |
| start a worker on demand, one per store | built (the kit) |
| idle stop, a failed start kept until retried, crash reports, shutdown | built in the kit's workers component; checked by slice 18 |
| generation fence on worker reports | not needed yet: the worker reports nothing (the server owns the facts) |

## What is built

```text
apps/p3/
  server.ts                     startP3: startServer with p3's name, API, kinds, principals, one worker kind (session);
                                as a script: ~/.p3 on port 8789, prints the owner link
  worker.ts                     a session worker: startWorker
  src/principals.ts             owner | person { id, name } | worker { session } | server
  src/app.ts                    API, KINDS, PRINCIPALS, mayReachSession (the owner and the server reach a session's worker)
  src/api/v1/index.ts           Chord's root re-exported, defineFacet bound to the principal, Server, Session
  src/api/v1/server.ts          AppInfo (kit)
  src/api/v1/worker.ts          WorkerInfo (kit)
  plugins/sessions/
    contract.ts                 Creator, SessionInfo, SessionRow, Facts; Sessions (owner, server), SessionFacts
                                (a worker's own session, server), SessionWorker (owner, on the session's worker)
    server.ts                   SessionsStore: the table `sessions.rows` (index on createdAt) and the host-keyed facts
                                `sessions.facts-of`, written in one transaction; the newest 200 as a live query; the
                                views Sessions and SessionFacts
    worker.ts                   SessionWorker: follows SessionFacts, held as the worker
    sessions.test.ts            plugin tier (testPlugin)
  test/topology.ts              the test topology: server and workers in one process, linked in memory
  test/until.ts, client.ts      waiting for a value; an owner client over WebSocket
  test/sessions.test.ts         topology tier
  test/app.test.ts              end-to-end tier
  bench/slice-1.ts              the numbers
packages/chord/src/node/app/    index.ts exports appInfoFacet and workerInfoFacet (README, CHANGELOG)
```

The code is the reference; the walkthrough (`01-base-and-sessions/walkthrough/`) reads it in order. The plan's sketches
are in this file's history (c55ab367f).

## Tests

**Plugin tier** (`plugins/sessions/sessions.test.ts`, `testPlugin` on the server facet, `:memory:` store):
create, then the list shows it (title, `app: "coding"`, creator owner, `archivedAt: null`); rename; archive and
restore; a person and a worker get `forbidden` on `Sessions`; `SessionFacts` gives a worker its own session's facts and
an unknown session `null`.

**Topology tier** (`test/sessions.test.ts`), each test its own topology:

1. The owner creates a session; `SessionWorker { session }` goes live on that session's worker (one worker made), its
   facts equal the row without its id.
2. A rename on the server reaches `SessionWorker.facts` (the worker follows its facts live).
3. Two sessions: two workers, each sees only its own facts.
4. A person's hold of `SessionWorker` is refused by the route (`forbidden`); a person's `Sessions` is refused.
5. A worker cannot read another session's facts (`SessionFacts` is keyed by its principal).
6. Archive and restore change the row and the facts together (one transaction).
7. Server restart on the same store: the list and the facts are back; a new `SessionWorker` hold starts a new worker
   that sees them.
8. The list holds the newest 200: the 201st session pushes out the oldest (a bounded live query).
9. Renaming a session that does not exist is refused (`invalid`), writing nothing.

Every topology test checks that nothing failed in the background (a factory's refusal reports its activation; those are
the only errors allowed). Not tested (round 2, accepted): a topology whose server plugin fails to load closes what it
opened (a test would need a way to inject a broken plugin into the topology).

**End-to-end tier** (`test/app.test.ts`, the real app on a temporary data directory): `startP3`, a Chord client over
WebSocket with the owner token file's bearer token, create a session, hold `SessionWorker` (a forked worker answers),
close and start again on the same directory: the session is listed. Two tests at most; they run in the default suite
while they stay under two seconds together, else behind a flag.

## Numbers

`bench/slice-1.ts` prints, on slayer and on the phone:

- **worker start:** from the first `SessionWorker` hold to live, cold (first worker after the start: includes the worker
  base build) and warm (the next one), median of 10;
- **worker idle RSS:** `RssAnon` of the worker process from `/proc/<pid>/status` (anonymous memory: what Node does not
  share between processes), after the first answer;
- **server:** time to listen, `RssAnon` idle;
- **p2 on the phone:** the same worker start and `RssAnon` for a p2 session worker, to learn where p2's seconds go (the
  phone dev session runs it, or p2's startup traces).

Results go into this brief. No budget is set before the first measurement; slice 2 sets them from these.

## Read first, in full

`names.md`, `decisions.md`, `workflow.md`; `packages/chord/docs/design.md` (all; for this slice §3–§7, §9–§11, §16–§19,
§21 "The plugin model", §23 "The app kit" and "Workers", §29, §30); `packages/chord/docs/plugin-authoring.md`;
`packages/chord/docs/host-keyed/spec.md`; the kit: `packages/chord/src/node/app/README.md`, `app.ts`, `worker.ts`,
`info.ts`, `data.ts`, `index.ts`, `src/node/workers/README.md`, `src/node/plugins/README.md`, `testing.ts`;
`src/link/link.ts` (`memoryLinkPair`); examples `66-host-data.ts`, `24-keyed-members.ts`,
`packages/chord/test/examples/61-tutorial/` (start, worker, API, the lists plugin and its test). From the archive:
`map/book.md` (The Session Catalog: its rules; the worker-owned title is superseded), `base-inventory/explainer/book.md`
(Sessions and Their Data: the session service), `efficiency.md`.

**Also read (docs audit, 2026-11-14; "Chord dec." is `packages/chord/docs/decisions.md` by entry title and line, "archive" is `../archive/`, "research" is `/home/badlogic/chord-notes/research/p3-people-2026-11-13/` on slayer):**

- **decisions.md:** "Reloads first", "Keep the app kit", "Base entries are named after what they are" (conflict
  2.2 #3), "Startup building is measured", "Session data on the server as host-keyed documents", "Backups, not session
  sync", "Efficiency is a requirement", "Tests are isolated and deterministic", "The principal is identity only",
  "Apps and sessions" (`defaultApp`, moving sessions).
- **design:** §10 "Data belonging to a host" (line 1421), §21 "The plugin model" (2378), §23 "Workers" (2686),
  §25 "Apps: ownership and porting", §29 Telemetry, §30 Cost model.
- **Chord dec.:** "Documents and table rows can belong to a host" (2795), "Workers start from the base code the
  server booted with" (2690), "The kit's owner is a principal the app chooses" (2702), "Sign-ins, not sessions"
  (3528), "Slice 10's points" D9, R1, R2, Q3-Q5 (1895: keep-alive, never auto-restart, `stop` suspends an archived
  session), "The app kit, point 5" (2303), "p3 next to p2" (9), "No legacy data migration" (11), "p3 domain points".
- **source:** kit `src/node/app/data.ts`, `archive.ts`, `owner.ts`, `sign-ins.ts`, `README.md`;
  `src/node/workers/workers.ts`, `base.ts`, `README.md`; `src/node/plugins/README.md`; `docs/tutorial/book.md`;
  `docs/plugin-authoring.md`.
- **archive:** `map/book.md:465-618` (catalog rules, incarnation fence, review "a hold before the create"),
  `:811-815` and `:853-861` (open decisions 2-4), `step-0/book.md:129-161` (start options, owner link, bearer token),
  `model-stress/report.md:887-901` (lifecycle registry), `merged.md` §2 #2 and #15, efficiency §2.
- **p2:** `apps/p2/plugins/sessions/`, `apps/p2/src/runtime/worker.ts` (Liveness), `apps/p2/plugins/status/worker.ts`.

## Decisions of the plan (accepted by the owner, 2026-11-14)

1. **Start data in the topology:** the kit exports `appInfoFacet` and `workerInfoFacet` (recommended).
2. **Data directory and port:** `~/.p3` and 8789 (recommended; p2 has 8788).
3. **Session ids:** the server makes a random id at create (`crypto.randomUUID()`, recommended), so a page cannot pick
   one; or the page names it (`map/book.md` proposed it for instant UI: a new session shown before the round trip).
4. **Facts beside the row:** a session's facts as host-keyed documents written in the same transaction as its table row
   (recommended: the list needs a table, a worker and later admissions need a keyed pin; one owner, one commit).
5. **Not in this slice** (recommended): the always-`unmanaged` gate (slice 17), compression on kit hosts and the startup
   spans (measured from outside first; then decided with the budgets in slice 2), session delete, export, import, fork
   (later, with the lifecycle registry).

## Carried (not in this slice)

The session service's further shape (`create` idempotent by a key, `open: false`, fork, remove, the actor as data:
`archive/base-inventory/explainer/book.md` 194-256); a lifecycle registry so delete reaches every plugin's data
(`archive/model-stress/report.md` 887-901); Chord's "p3 domain points" (`SessionFiles`, delete, connection pools, config
files with one writer, versioned file formats, the terminal host process); acceptance tests of
`archive/base-inventory/merged.md` §5 (restore, export, import).
