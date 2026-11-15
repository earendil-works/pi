# Building p3 on Chord: practices

For whoever builds p3 (people, agents, the builder after a handoff). **Read in full before every slice**, with
`names.md`, `decisions.md` and `packages/chord/docs/design.md`. Chord's own plugin guide
(`packages/chord/docs/plugin-authoring.md`) has the generic rules (layout, imports, named queries, admission,
reloads, messages); this file is p3's: the shape a p3 plugin has, the rules we decided, and the mistakes we made,
each with its fix. Add to it whenever a slice teaches something.

## The shape of a p3 plugin (the sessions plugin, slice 1)

**One audience per contract.** The owner, a session's worker and the server never share a contract through
variants; variants are levels of one audience (`viewer`, `participant`). A worker reading its own session gets its
own contract.

```ts
// contract.ts: what other plugins and facets import
export const Sessions = remote("sessions.sessions", { version: 1, params: {}, hostAddress: () => Server(),
	variants: { owner: { methods: { create: method(obj({ title: opt(str(TITLE)) }), str()), rename: …, archive: …, restore: … } } } });
export const SessionsList = remote("sessions.list", { version: 1,
	params: { app: str(), set: oneOf("active", "archived"), view: str() },          // view: the screen's own id
	hostAddress: () => Server(),
	variants: { owner: { state: { list: obj({ rows: arr(SessionRow), moreAfter: bool() }) }, methods: { more: method() } } } });
export const SessionFacts = remote("sessions.facts", { version: 1, params: {}, hostAddress: () => Server(),
	variants: { worker: { state: { session: union([SessionRow, nul()]) } } } });   // the worker's own row: its principal names it

// contract.server.ts: the store, for server facets only; other objects read its named queries
export const SessionsStore = local("sessions.store", { version: 1, params: {}, members: {
	sessions: queries(SessionRow, { active: obj({ app: str() }), archived: obj({ app: str() }), one: obj({ id: str() }) }),
	create: method(obj({ title: str(), creator: Creator }), str()), rename: …, archive: …, restore: … } });
```

**The store owns the table; every write goes through it; reads are named queries.**

```ts
const Rows = defineTable("sessions.rows", { version: 1, columns: ROW, key: ["id"],
	indexes: { active: ["app", "archivedAt", "lastTouch"], archived: ["app", "archivedAt"] } });   // one index per list's order

host.serve(SessionsStore, (_params, self) => {
	const rows = self.table(Rows);
	const update = (id, change, ctx) => self.tx(async (tx) => {
		const key = { id: Session({ id }) };
		if ((await tx.get(rows, key)) === undefined) throw invalid("args", `sessions: no session ${id}`);
		tx.update(rows, key, change);                                // an update names its columns: readers that need none skip
		return null;
	}, ctx);
	return {
		sessions: self.queries(rows, { map: shown }, {
			// Index `active`: `app` and `archivedAt` fixed, in the order of `lastTouch`, then the key.
			active: ({ app }) => query(Rows).where((s) => and(eq(s.app, app), eq(s.archivedAt, 0))).orderBy((s) => s.lastTouch, "desc"),
			archived: ({ app }) => query(Rows).where((s) => and(eq(s.app, app), gt(s.archivedAt, 0))).orderBy((s) => s.archivedAt, "desc"),
			one: ({ id }) => query(Rows).where((s) => eq(s.id, Session({ id }))),
		}),
		rename: ({ id, title }, ctx) => update(id, { title }, ctx),
		archive: ({ id }, ctx) => update(id, { archivedAt: Date.now() }, ctx),
		// create, restore …
	};
});
```

**Views forward; lists are `self.list`; a worker follows its row with `self.liveQuery`.**

```ts
host.serve(Sessions, (_params, principal, self) => {
	if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
	const store = self.get(SessionsStore, {});
	return forward(store, Sessions, "owner", {                        // members taken from the store, by the contract's names
		create: ({ title }, ctx) => store.create({ title: title ?? "", creator: { kind: "owner" } }, ctx),   // one that needs the caller
	});
});

host.serve(SessionsList, ({ app, set }, principal, self) => {
	if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
	const list = self.list("sessions", [[self.get(SessionsStore, {}).sessions[set], { app }]], { first: 50 });
	return { variant: "owner", members: { list: list.value, more: (ctx) => list.more(ctx) } };
});

host.serve(SessionFacts, (_params, principal, self) => {
	if (principal.kind !== "worker") throw forbidden("sessions: a session's worker only");
	const found = self.liveQuery(self.get(SessionsStore, {}).sessions.one, { id: principal.session }, { first: 1 });
	return { variant: "worker", members: { session: self.derive([found], ([{ rows }]) => rows[0] ?? null) } };
});
```

**No worker starts for a session that does not exist.** The session route's admission reads data through a contract the API owns
(`SessionRoute`, `@p3/app/v1/server`), served by the sessions plugin (`src/app.ts`, `sessionExists`).

**Helpers in p3's API** (`src/kit/`): `forward(store, Remote, variant, own?)` (a view's members from a store,
by the remote contract's names; never derive a public contract from a store: it would publish whatever internal
member is added next); `contribute(host, name, register)` (an object that only contributes, when a contribution
needs a reference or a native). No stale-worker check exists or is needed (below).

## Rules

**Data**
- One owner per datum, written only through it. **No copies** of a value in a second place (no facts document beside
  a row, no last touch mirrored into another plugin's row): read it with a named query, a join or `exists`.
- **No hidden caps.** A list is `self.list` with `more`; a set that decides access is read whole or fails closed when
  it has more rows than it read. Never `{ first: 1000 }` and hope.
- Index and order columns are never optional (store "none" as 0, show `null`). Every named query says in a comment
  which index serves its condition and order, and a plan test (`EXPLAIN QUERY PLAN` on the statements Chord runs, as
  `apps/p3/test/plans.test.ts` does) proves it. A list's whole order, the key Chord appends included, must be its
  index's order, or SQLite sorts every page: one index per list's order. An `inArray` on one column with an order on
  another walks the order's index (order by the `inArray` column first).
- A write that changes a few columns is a `tx.update` (a touch, a rename), never a `put`: readers that depend on none
  of the columns skip, the others probe once.
- Hot details (tokens streaming, tool progress, timers) never reach a table a list reads. A session's row holds
  transitions only (state, last touch).
- Node's SQLite is synchronous: a query blocks the event loop. Offsets and counts read every row they pass:
  `self.count` is exact and expensive, used only where a key or an index bounds it; lists use "more".

**Lists**
- One remote object per screen, the screen's own id in its params; `self.list` tiles internally between fixed
  bookmarks, so rows that reorder leave no gap and no duplicate, and `more` sends only new rows. Never chain pages,
  never grow "the first n".
- Drive a list from what the person has (their teams, their shares, what they created), each a source of one
  `self.list`; an `exists` is never the selective part of a list.
- A screen composed from several plugins (the sidebar) is a server object per person composing small reads in
  memory; the client gets a range.
- An open list grows with what is created: a new row enters its first page, so a list can show more than one page
  without `more`. A test that wants "the first page, then `more`" opens the list after creating the rows.
- Reads are not shared between readers yet (Chord's carry-over): two objects reading the same named query with the
  same arguments are two reads, and a write runs both. When it matters, one local object per entity holds the read
  and the others read it.

**Access**
- A person's data comes from admission, never from params. Params only narrow inside what the admission allows
  (the club's team page takes its team from the admission).
- App-specific views check the session's **current** app: cleanup after a move is not an access boundary.
- Conditions are built by server code; clients send values. A condition passed as data is a trust boundary
  (`whereNode` checks it).
- Per-person rows (pins, unread marks) are filtered by the person, not only by the access condition.
- Admission values are small (a mode, a role); what a list shows is its query's argument, not the admitted value.
- No `self.job` in an admitted type: work for a person lives in a local store, carries the person, asks again on
  every run.

**Workers**
- Plugins never check whether a call comes from a worker that is gone: Chord's workers component closes an exiting
  worker's link and settles its queued commits before it publishes the exit or starts a successor. Data kept across a
  worker's runs is tagged with `ctx.incarnation`.

**Reload**
- Everything a plugin keeps across a reload is in its store's tables and documents; writables start over. A list's
  bookmarks are kept by its object in memory: they survive a reload, not a server restart (the screen opens it anew). Readers of a restarting store re-read on its successor; nothing is stale.
- Every slice edits and reloads each plugin it touches while it is used (a list open, a worker running), in a test:
  nothing lost, no error.

## Tests

- Three tiers: plugin (`testPlugin`), topology (server and workers in one process, `test/topology.ts`), end to end
  (the real `startP3`, a forked worker, a WebSocket client). Most coverage in the topology tier.
- One test per case of the brief; a test waits for an effect it caused (`test/until.ts`), never for a pattern that
  may already be there; nothing may fail in the background but the refusals the test asked for.
- **Every reproduction a reviewer writes becomes a regression test** in the repository.
- **Mutation check before reporting:** undo each fix and each rule one at a time in a copy under `/tmp`; a test must
  fail for each. A rule no test catches is untested.
- Where a rule is subtle (skip rules, tiling), a randomized test compares the optimized result with a fresh run,
  across several owners and group commits, checked after every frame.
- Numbers: `bench/slice-<n>.ts`, at the sizes the brief states (1k, 10k, 100k rows), medians of 20 or more runs,
  the first (cold) run reported apart, on slayer; a worker's memory as its private memory (USS), and its total for
  several workers at once.
- The mutation copy needs its own package links: copy `apps/p3` to `/tmp/x/apps/p3`, then link
  `/tmp/x/node_modules/@p3/app` to the copy and `/tmp/x/node_modules/@earendil-works` to the repository's (a plain copy
  resolves `@p3/app` back to the checkout, and mutations in `src/` take no effect).
- Reload tests reload every facet the slice touches while it is used: the server's (a list open) and the worker's (the
  owner holding the worker's object).

## Mistakes we made (and the fix)

| Mistake | Fix |
| --- | --- |
| The newest 200 as "the list" (slice 1, first build) | `self.list` with `more` |
| A facts document beside each row, written twice | the worker reads its row with `self.liveQuery` by id |
| Two page objects tiled by row number: a row moving to the top fell between them | one list per screen; pages bounded by bookmarks inside `self.list` |
| Growing a window ("first 100, then 150") re-sent every loaded row | `more` on the same object: only new rows travel |
| The team's id taken from the page's params | the team comes from the admission; params only narrow |
| The team page joined side rows without checking the session's current app | every app-specific view checks the current app |
| Pins read by the access condition only: Bob saw Alice's pins | per-person rows filter by the person |
| `{ first: 1000 }` for a person's shares | `exists(Shares, …)` in the condition, or read whole and fail closed |
| An `exists` as the selective part of a person's list: a guest's list walked the whole app | drive the list from the person's own rows |
| `inArray(state)` ordered by `lastTouch` walked all 10,000 rows | order by the `inArray` column first |
| Mirroring last touch into the team's row to make the order cheap | a keyed probe skips reads a write cannot affect; no copy |
| A count behind a hot column | count only what a key or an index bounds, never behind a column every touch writes |
| A whole store exposed as a remote contract | an explicit contract and `forward` |
| Seven plugins checking a worker's generation by hand | the workers component guarantees it |
| A list cost measured once, after a start (2.3 ms, cold) | medians of 20 or more runs (0.7 ms warm), the cold run apart |
| A mutation copy that still resolved `@p3/app` to the checkout | its own package links |
| One index for two lists: the archived list's tie-break on the key was not in its index, so SQLite sorted every page | one index per list's order, and a plan test |
| A revoked device's open socket kept working (inherited from Chord's kit) | a sign-in closes its own links (`links.opened`'s `close`), never `host.revoke` (it ends shared objects for every device) |

## How we work

`workflow.md` is the process; this is what it means for the builder:

- Read the brief's "Read first" list and this file in full before touching code. Never present an invented API: real
  with its file, or marked PROPOSED.
- Fill out the brief before building: p2's features first. Every decision goes to the owner, one at a time, with an
  example, options and a recommendation, and into `decisions.md` at once.
- Keep it small: copy only what a slice needs, cut what it does not use, split by concept.
- Commit only after the owner's review; docs may be committed earlier. Stage explicit paths, never `git add -A`.
