# Slice 1: base and sessions

**Goal.** A p3 server with a worker per session, headless: the owner creates, lists, renames, archives and restores
sessions; each session's worker runs and follows its own facts from the server. The test tiers exist from here on, and
so do the numbers.

State: built 2026-11-14, in review (round 1); not committed. The owner accepted every recommendation below
(2026-11-14). The scaffold (package, principal, API v1, `node:test`) is committed (4cc9fd409).

As built, differences from the plan below: `SessionFacts` is in `contract.ts` (the worker facet holds it, so it cannot be
a server-only contract file); the creator is one `json` column; the kit exports `appInfoFacet` and `workerInfoFacet`
(`packages/chord/src/node/app/index.ts`, README); `src/app.ts` holds `API` and `KINDS`; `server.ts` exports
`mayReachSession`, which the topology's route uses too.

Measured on slayer (Linux x64, Node 24.4.1), `bench/slice-1.ts`: server listening 46 ms after `startP3` began (module
loading not included); the server process (server and the bench's client) 120.8 MiB `RssAnon`; worker start cold 377 ms
(with the worker base's build), warm 99 ms (median of 10); an idle worker 37.3 MiB `RssAnon`. The phone and p2's
numbers follow once the code is on main (the phone deploys from git). Tests: 12 plugin and topology tests and 1 end-to-end
test, `npm test` 0.97 s wall.

## What is built

```text
apps/p3/
  server.ts                     the server: startServer, one worker kind (session)
  worker.ts                     a session worker: startWorker
  src/principals.ts             (built) owner | person | worker { session } | server
  src/api/v1/index.ts           (built) + the contract builders and helpers plugins use (re-exported once)
  src/api/v1/server.ts          AppInfo (kit)
  src/api/v1/worker.ts          WorkerInfo (kit)
  plugins/sessions/
    package.json                { "name": "@p3/sessions" }
    contract.ts                 SessionRow, Sessions (owner's view), SessionHere (on the worker)
    contract.server.ts          SessionFacts (a session's facts for its own worker)
    server.ts                   SessionsStore (table + facts), Sessions, SessionFacts
    worker.ts                   SessionHere
    sessions.test.ts            plugin tier
  test/topology.ts              the test topology: server and workers in one process
  test/sessions.test.ts         topology tier
  test/app.test.ts              end-to-end tier (real server, forked worker, WebSocket)
  bench/slice-1.ts              the numbers
```

### Base code

```ts
// apps/p3/server.ts (PROPOSED): what the app decides; the kit does the rest (design §23, the tutorial's start.ts)
export function startP3(dataDir: string, root: string, context: Context): Promise<App<P3Principal>> {
	return startServer<P3Principal>({
		name: "p3",
		dataDir,                                        // ~/.p3 by default (owner)
		root,
		listen: { host: "127.0.0.1", port: PORT },      // 8789; p2 keeps 8788 (owner)
		api: API,                                       // { name: "@p3/app", versions: ["v1"], modules }
		kinds: KINDS,                                   // server, worker (node)
		principal: {
			server: { kind: "server" },
			worker: (address) => ({ kind: "worker", session: String(address.params.id) }),
			owner: { kind: "owner" },
		},
		workers: [{
			kind: Session,
			entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
			execArgv: ["--conditions=source", "--no-warnings"],
			start: () => ({}),
			// Who may reach a session's worker: the owner and the server (persons come with admission, slice 5).
			authorize: (principal) => principal.kind === "owner" || principal.kind === "server",
		}],
		onError: (error) => console.error("p3:", error.kind, error.error),
	}, context);
}
// run as a script: startP3(argv[2] ?? ~/.p3, ./plugins), print app.ownerLink()

// apps/p3/worker.ts (PROPOSED)
startWorker<P3Principal>({ api: API, kinds: KINDS, onError: (error) => console.error("p3 worker:", error) });
```

`API` and `KINDS` live in `src/app.ts` (shared by both entries and the tests). `startServer`, `startWorker`, `App`,
`AppInfo`, `WorkerInfo` are the kit's (`packages/chord/src/node/app/`).

### The sessions plugin

```ts
// plugins/sessions/contract.ts (PROPOSED)
/** Who made a session: the owner, or a person (by id). */
export const Creator = union([obj({ kind: lit("owner") }), obj({ kind: lit("person"), id: str() })]);
/** A session as lists show it. `archived`: when it was archived, or null. */
export const SessionRow = obj({ id: str(), title: str(), app: str(), creator: Creator, created: num(),
	archived: union([num(), nul()]) });

/** The owner's sessions: the newest 200, and what the owner does with them. */
export const Sessions = remote("sessions.sessions", { version: 1, params: {}, hostAddress: () => Server(),
	variants: { owner: {
		state: { list: arr(SessionRow) },
		methods: {
			create: method(obj({ title: opt(str()) }), str()),          // the new session's id
			rename: method(obj({ id: str(), title: str() })),
			archive: method(obj({ id: str() })),
			restore: method(obj({ id: str() })),
		},
	} } });

/** A session's worker, as the owner sees it: its facts as the worker follows them, and when it started. */
export const SessionHere = remote("sessions.here", { version: 1, params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { owner: { state: { facts: Facts, startedAt: num() } } } });
// Facts = union([SessionRow, obj({ kind: lit("absent") })])

// plugins/sessions/contract.server.ts (PROPOSED): only server facets and the worker's request use it
/** A session's facts for its own worker (its principal names the session: §4, upward is a boundary). */
export const SessionFacts = remote("sessions.facts", { version: 1, params: {}, hostAddress: () => Server(),
	variants: { worker: { state: { facts: Facts } } } });
```

```ts
// plugins/sessions/server.ts (PROPOSED)
/** Every session, one row each; the row belongs to the session's host (export, import and delete carry it). */
const Rows = defineTable("sessions.rows", { version: 1, key: ["id"], columns: {
	id: host(Session), title: str(), app: str(), creatorKind: str(), creatorId: opt(str()), created: num(),
	archived: opt(num()) } });
/** A session's facts, keyed by its address: what its worker and (later) admissions pin. Written with its row. */
const Facts = defineState("sessions.facts", { schema: FactsSchema, version: 1, initial: () => ({ kind: "absent" }),
	keyed: Session, persist: true, checkpointWhen: () => true });

const SessionsStore = local("sessions.store", { version: 1, params: {}, members: {
	list: arr(SessionRow), facts: keyed(FactsSchema, Session),
	create: method(obj({ title: str(), creator: Creator }), str()),
	rename: method(obj({ id: str(), title: str() })), archive: …, restore: …,
} });

host.serve(SessionsStore, (_params, self) => {
	const rows = self.table(Rows);
	const facts = self.state(Facts);
	const newest = self.query(rows, query(Rows).orderBy((r) => r.created, "desc"), LIST);   // LIST = 200
	return {
		list: self.derive([newest], ([r]) => r.map(rowOf)),
		facts,
		create: async ({ title, creator }, ctx) => {
			const id = uuidv7();                             // (owner) how ids are made
			await self.tx(async (tx) => {
				tx.put(rows, { id: Session({ id }), title, app: "coding", … });
				Object.assign(await tx.draft(facts, Session({ id })), factsOf(id, title, creator));
			}, ctx);
			return id;
		},
		// rename, archive, restore: the row and its facts in one transaction
	};
});
host.serve(Sessions, (_params, principal, self) => {
	if (principal.kind !== "owner") throw forbidden("the owner's sessions");
	const store = self.get(SessionsStore, {});
	return { variant: "owner", members: { list: store.list,
		create: ({ title }, ctx) => store.create({ title: title ?? "New session", creator: { kind: "owner" } }, ctx),
		rename: (a, ctx) => store.rename(a, ctx), archive: …, restore: … } };
});
host.serve(SessionFacts, (_params, principal, self) => {
	if (principal.kind !== "worker") throw forbidden("a session's worker only");
	const store = self.get(SessionsStore, {});
	return { variant: "worker", members: { facts: store.facts.at(Session({ id: principal.session })) } };
});

// plugins/sessions/worker.ts (PROPOSED)
host.serve(SessionHere, ({ session }, principal, self) => {
	if (principal.kind !== "owner") throw forbidden("the owner's");
	const facts = self.get(SessionFacts, {});           // held as this worker (§4): its own session's facts
	return { variant: "owner", members: { facts: facts.facts, startedAt: constant(STARTED) } };
});
```

Real API used: `local`, `remote`, `keyed`, `method`, schema builders, `defineTable` with a `host(Session)` column,
`defineState` with `keyed: Session` (design §5, §9, §10; example 66), `self.table`, `self.query`, `self.state`,
`self.tx` with `tx.put` and `tx.draft`, `self.derive`, `ref.member.at(address)` (keyed pin), `constant`, `forbidden`,
`Server` (kit). `uuidv7` is Chord-internal (`src/host/uuid.ts`): p3 uses `crypto.randomUUID()` or the kit exports it
(owner, with the ids). `SessionHere`'s `startedAt` is a module constant of the worker facet (`Date.now()` at
evaluation; a reload changes it, which the tests may use).

### The test topology

```ts
// apps/p3/test/topology.ts (PROPOSED): the server and session workers as hosts in one process (design §3, "a test")
export async function topology(context: Context): Promise<Topology> {
	const server = createHost<P3Principal>({ address: Server(), principal: SERVER, store: await memoryStore(), onError });
	server.route(Session, {
		authorize: (p) => p.kind === "owner" || p.kind === "server",
		resolve: async (address) => {
			const [up, down] = memoryLinkPair();
			const worker = createHost<P3Principal>({ address, principal: workerOf(address), store: await memoryStore(), onError });
			worker.connect(up, { principal: SERVER, trusted: true }, context);
			void worker.load([workerInfo(address), ...WORKER_PLUGINS], context);
			return { link: down, principal: workerOf(address), trusted: true };
		},
	}, context);
	await server.load([appInfo(), ...SERVER_PLUGINS], context);
	const [toServer, fromOwner] = memoryLinkPair();
	const owner = createHost<P3Principal>({ onError });               // a client, as a page
	server.accept(fromOwner, { principal: OWNER }, context);
	owner.connect(toServer, { principal: SERVER }, context);
	await owner.load([], context);
	return { server, owner, workers, restart, close };
}
```

- Plugins are imported as modules (`import sessionsServer from "../plugins/sessions/server.ts"`): no esbuild in this
  tier, so a test costs milliseconds. The end-to-end tier builds them as production does.
- `restart()` closes the server and opens a new one on the same store file (a temporary file, not `:memory:`), for the
  restart cases.
- **(owner)** The kit serves `AppInfo` and `WorkerInfo` through `appInfoFacet` and `workerInfoFacet`, which it does not
  export. Recommended: export both (two lines in `packages/chord/src/node/app/index.ts`), so the topology loads the
  same start-data objects as production. Alternative: a kit entry for in-process workers (more code, closer to
  production), or p3 serves its own copies (drifts).

## Tests

**Plugin tier** (`plugins/sessions/sessions.test.ts`, `testPlugin` on the server facet, `:memory:` store):
create, then the list shows it (title, `app: "coding"`, creator owner, `archived: null`); rename; archive and restore;
a person and a worker get `forbidden` on `Sessions`; `SessionFacts` gives a worker its own session's facts and an
unknown session `absent`.

**Topology tier** (`test/sessions.test.ts`), each test its own topology:

1. The owner creates a session; `SessionHere { session }` goes live on that session's worker (one worker made), its
   facts equal the row.
2. A rename on the server reaches `SessionHere.facts` (the worker follows its facts live).
3. Two sessions: two workers, each sees only its own facts.
4. A person's hold of `SessionHere` is refused by the route (`forbidden`); a person's `Sessions` is refused.
5. A worker cannot read another session's facts (`SessionFacts` is keyed by its principal).
6. Archive and restore change the row and the facts together (one transaction).
7. Server restart on the same store: the list and the facts are back; a new `SessionHere` hold starts a new worker
   that sees them.
8. The list holds the newest 200: the 201st session pushes out the oldest (a bounded live query).

**End-to-end tier** (`test/app.test.ts`, the real app on a temporary data directory): `startP3`, a Chord client over
WebSocket with the owner token file's bearer token, create a session, hold `SessionHere` (a forked worker answers),
close and start again on the same directory: the session is listed. Two tests at most; they run in the default suite
while they stay under two seconds together, else behind a flag.

## Numbers

`bench/slice-1.ts` prints, on slayer and on the phone:

- **worker start:** from the first `SessionHere` hold to live, cold (first worker after the start: includes the worker
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

## Decisions for the owner

1. **Start data in the topology:** the kit exports `appInfoFacet` and `workerInfoFacet` (recommended).
2. **Data directory and port:** `~/.p3` and 8789 (recommended; p2 has 8788).
3. **Session ids:** the server makes a random id at create (`crypto.randomUUID()`, recommended), so a page cannot pick
   one; or the page names it (`map/book.md` proposed it for instant UI: a new session shown before the round trip).
4. **Facts beside the row:** a session's facts as host-keyed documents written in the same transaction as its table row
   (recommended: the list needs a table, a worker and later admissions need a keyed pin; one owner, one commit).
5. **Not in this slice** (recommended): the always-`unmanaged` gate (slice 16), compression on kit hosts and the startup
   spans (measured from outside first; then decided with the budgets in slice 2), session delete, export, import, fork
   (later, with the lifecycle registry).

## Carried (not in this slice)

The session service's further shape (`create` idempotent by a key, `open: false`, fork, remove, the actor as data:
`archive/base-inventory/explainer/book.md` 194-256); a lifecycle registry so delete reaches every plugin's data
(`archive/model-stress/report.md` 887-901); Chord's "p3 domain points" (`SessionFiles`, delete, connection pools, config
files with one writer, versioned file formats, the terminal host process); acceptance tests of
`archive/base-inventory/merged.md` §5 (restore, export, import).
