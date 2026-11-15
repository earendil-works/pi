# Slice 14: admission with a value, named live queries, lists, joins by key

Status: fifth version (2026-11-16), after review rounds 1 to 4 and the decisions taken on them. **Built in parts.**
Built (2026-11-16, not committed): parts B (named queries, `self.liveQuery`, `self.count`, the skip test and the
probe), C for one source (`self.list`), D (column sets, `exists`, the join) and E's conditions as data, with their
tests, examples 70, 71 and 72 and the bench; code review rounds 1 and 2 are fixed (2026-11-16). Not built yet: lists over several sources, A (admission, route
admission), `deleteHostData({ plugin })`; `slices.md`, "Carry-over", lists them with what the built parts left.
p3 calls it "slice 0": the Chord changes it needs before its first slice is redone (`apps/p3/docs/decisions.md`,
"Slice 0 changes Chord first"). The changes to `design.md` are in `slice-14-design.md`.

**Read first, in full:** `design.md` (all), `admission/design.md`, `host-keyed/spec.md`, `slices.md`, the root
`AGENTS.md` section "Chord v2 Code Style"; the source: `src/store/{query,expression,evaluate,sql,live-query,table,
table-handle,table-changes,step,store,backend,host-data}.ts`, `src/documents/transaction.ts`, `src/host/{attempt,
object,dependencies,parked,staging,members,reference,reference-source,route,host-data,presence}.ts`,
`src/remote/{hold,provider,remote-object,relay,path}.ts`, `src/node/workers/workers.ts`, `src/link/{message,binary,
text}.ts`, `src/data/failure.ts`, `src/contracts/{declare,schema,evolve}.ts`, `src/watch.ts`.

**Done when** every test of §10 passes, the existing tests of `self.query` and p2's own check and suites pass
unchanged, and every item of the acceptance list (§9) runs as its example and meets its number. An item that misses
its number is not done.

## 1. What it builds

| Part | In one sentence |
| --- | --- |
| A. Admission | a remote type's provider reads data about the caller before the factory runs and hands the factory a typed value that selects its variant and members; a route asks before it starts or reaches a host |
| B. Named queries | a store names queries, their argument schemas in its contract; any object on the store's host reads one live with `self.liveQuery(namedQuery, args, { first })` or counts it with `self.count` (expensive); a commit that cannot affect a read skips it, by what it assigns or by one keyed probe |
| C. Lists | `self.list(name, sources, { first })`: a list a screen loads more of, over one named query or several of one order merged; pages between fixed bookmarks, tiled; only diffs cross a link |
| D. Column sets, `exists`, the one-to-one join | a contract declares the columns of a table others may use; a condition may test `exists` in another plugin's set, a query may join one row of it; tables are matched only by a key or a declared index |
| E. Conditions as data | `compile`, `whereNode` and `existsNode`; a host-data delete limited to one plugin's tables |

Across links nothing is added except the failure kind `denied`. Not in this slice: the app kit (copied into p3).

**Vocabulary** (design §2): *admission* (the decision before a factory, with its value); *named query* (a query a
store offers, with arguments); *live query* (rows kept current: the owner's own window with `self.query`, or a
named query read with `self.liveQuery`); *list* (named queries a screen loads more of); *probe* (one keyed statement that asks whether a written row can be
in a read); *bookmark* (a cursor a
page of a list is bounded by: order values and the key); *column set* (the columns of a table its contract declares
for other plugins).

## 2. A. Admission

### 2.1 API

```ts
export const Transcript = remote("transcript", { version: 1, params: { session: str(), conversation: int() },
	hostAddress: ({ session }) => Session({ id: session }),
	admission: obj({ mode: oneOf("read", "write", "owner", "server") }),   // a JSON schema; not part of the wire fingerprint
	variants: { viewer: { … }, participant: { … } } });

host.serve(Type, factory, { admit });
export type Admission<T> = { readonly kind: "allow"; readonly value: T } | { readonly kind: "deny"; readonly reason: string };
export const allow = <T extends JsonValue>(value: T): Admission<T> => ({ kind: "allow", value });
export const deny = (reason: string): Admission<never> => ({ kind: "deny", reason });
/** Runs first in every attempt. Declares only references (with keyed pins), registries, derives and live queries. */
type Admit<C, P> = (params: ParamsOf<C>, principal: P, self: AdmitSelf<P>) => Watchable<Admission<AdmittedOf<C>>>;
type AdmittedFactory<C, P> = (params: ParamsOf<C>, principal: P, admitted: AdmittedOf<C>, self: Self<P>) => Implementation<C>;
```

- **Remote types only.** A `local` object has no caller and gets none. `admission` without `admit`, the reverse,
  or either on a `local` type is a declaration error.
- `AdmitSelf` has `get` (and `at(key)` on what it gets), `registry`, `derive`, `liveQuery`. Nothing else.
- **The value selects the variant and the members, nothing else.** It is small and changes rarely (a mode, a role).
  What a list shows is not in it (§4).
- **No jobs in an admitted object** (`self.job` there is a declaration error, in staging too). Work for a person
  lives in a `local` store, carries the person in its arguments, and asks the person's access again on every run.
- The value is plain JSON, never validated at runtime. `deny`'s reason reaches the denied caller: it is user-facing.

### 2.2 Semantics

1. **Admit.** An attempt of an admitted type runs `admit` before its factory and parks on its requests with the
   existing parking (design §6). The admission phase does not wait for the previous attempt's teardown; only the
   factory phase does. It starts one microtask after a seal.
2. **Decide.** With every request live and hydrated the decision is read: `deny` parks the attempt and the object
   shows `failed { kind: "denied", error: forbidden(reason) }`; `allow(value)` runs the factory with `value`.
3. **Watch.** The attempt follows the decision and its sources through the host's publication, not through an
   application watch. A change takes effect in the flush of the batch that changed it, before the object serves
   another call or publishes: also while the attempt opens its natives, and on an old attempt that drains for a
   reload. A commit admitted before the cut stays durable; the sealed attempt publishes nothing after it.

   | What happens | The attempt | Calls running on it | Holders |
   | --- | --- | --- | --- |
   | an equal value (canonical JSON) | nothing | | |
   | a source is loading: its provider restarts, a link is down | **keeps its last decision** | go on | unchanged |
   | another allowed value | sealed, a new attempt admits | rejected `unavailable` | `loading`, then `bound` |
   | `deny` | sealed, the new attempt parks denied | rejected `forbidden/revoked` | `failed { denied }` |
   | a source failed or ended; reading the decision throws | sealed, the new attempt parks on the source | rejected `unavailable` | `failed { waiting }` |

   No drain on a seal. A call that crossed a seal on the wire runs on the next attempt under its value.

   Two limits, accepted. A source whose successor fails or parks after a reload seals every object that reads it
   (a transient failure with its one-second backoff included). A source whose new contract the readers' version
   does not fit (`contract_mismatch`) is failed, not loading: in a rollout, server first, every admitted object on
   a worker is sealed until that worker's step. Keeping the decision there would leave a withdrawal undelivered
   for the gap. **The guide requires admission sources to `accept` their previous version.**
4. **A rebuild keeps the admission's references** until the successor's own admission requests bound.
5. **What a denial removes.** The denied object's references and replicas hold no value: a read throws `forbidden`,
   a watch gets one `failed` call, `ref.variant` is `undefined`, a derive over a member fails as a member until the
   next allow. Over a link the consumer drops its replicas. **Data already delivered to application code is not
   retracted** (a `WatchHandle`'s `value`, a rendered value, a method's answer). A UI hides what `ref.state` says is
   denied.
6. **Dependents.** An attempt parked on a denied dependency shows `denied`, stays parked, and goes on when access
   returns (`host/dependencies.ts`: `denied` is checked before `healsNever`'s `forbidden`). `parked_long` does not
   report a denial. `ref.retry()` on a denied object only passes on to the admission's failed dependencies.
7. **Presence:** a holder is listed from its first allow until a denial or its end. **Linger:** a lingering object
   without holders whose decision changes ends.

### 2.3 Routes ask before anything starts

```ts
host.route(Session, { authorize, resolve,
	admit: (principal, address, self: AdmitSelf<P>) => Watchable<Admission<null>> }, context);
createWorkers(host, Session, { …, admit });        // passed through (src/node/workers/workers.ts:49, :144)
```

- Asked once per (principal key, address) with holds on the route, after `authorize`, shared by those holds,
  released with the last. Before its first allow a hold is `loading` and **nothing is resolved or forwarded**. A
  `resolve` already running for another principal finishes; nothing of a principal not yet allowed is forwarded.
- **Its `admit` reads only contracts the app's API owns.** A route is base code: it never reloads and keeps the
  contract tokens it was built with, so a plugin's own contract, bumped without `accepts`, would fail every
  decision until a restart. A plugin serves the contract. The admission's references act as the host. It may not hold a type placed behind its own
  route (it would wait on itself): that hold fails `invalid/cycle`. A throwing `admit` fails the hold `broken`.
- **`deny`:** the principal's holds to that address show `failed { denied }`; the relay releases them upstream and
  rejects their calls in flight and waiting `forbidden/revoked`.
- **Deny, then allow: a fence, no new id.** The denial sent `release` upstream. On the next allow the relay sends
  a `ping` and forwards the hold again, under its id, only after that ping's `pong`. A link is ordered and a peer
  answers a `ping` after everything sent before it (`src/link/channel.ts:59-61`), so every reply of the released
  hold has arrived, and was dropped (state messages still acknowledged), before the hold exists again. The channel
  counts pings and pongs, so a liveness `pong` in transit does not end the fence. A denial before the `pong` ends
  it; a lost link forwards under the current decision on the next one. Ids are not renumbered (design §3). **The
  fence relies on `resolve` returning the link to the final provider that serves the address,** as the route
  contract requires. A resolver that returns an intermediate relay voids it: that relay can answer the `ping`
  before the final provider's old replies have drained.
- **A failed or ended source** fails new holds `failed { waiting }` and leaves bound ones alone. Loading keeps the
  last decision (2.2).
- **`RouteHandle.retry(address)`** (a rollout reaching workers calls it) resolves nothing while every hold of that
  address is denied or undecided. A new link of the route forwards a hold again only under its current decision.
  A reload of an object behind the route is an ordinary rebind on the open link: nothing is asked or resolved.
- A route's decision lives with its holds on the routing host. It takes no fate in a reload; its references follow
  the reference rules (design §7).

### 2.4 Wire

`denied` is a new cause kind of `failed` (`data/failure.ts`; both codecs). `PROTOCOL_VERSION` stays 1 until p3
ships (design §22). Getters reject at once for it; a denied hold stays in the sharing table; the waiting index and
the backoff ignore it. Rapid changes need the binding fence per acknowledgement in `remote/hold.ts`: one `{ names,
until }` per unacknowledged `bound`.

### 2.5 Staging and reload

- Staging runs the new `admit` against the recording `self`. It rehearses the new factory with the object's current
  value only when the old and new tokens' `admission` fingerprints are equal. `evolve` replaces the schema with
  `admission(schema)`.
- **A limit, accepted:** a factory that is not rehearsed (another fingerprint; an object denied, parked or failed at
  the reload) loses staging's checks. Its declaration errors, the refusal of `self.job` among them, appear at its
  activation after the commit and are reported there; they do not keep the plugin on its old code. Its requests are
  not recorded, so the closure rule cannot keep it old beside a provider that was kept old.
- The commit restarts the object as today; the successor runs the new `admit`, then the new factory. A decision
  change during the old attempt's drain seals it at once.

## 3. B. Named queries

### 3.1 API

```ts
// contract (local): the queries others may read, each with its argument schema (part of the fingerprint)
sessions: queries(SessionRow, { visible: obj({ condition: unknown(), app: str() }), one: obj({ condition: unknown(), id: str() }) }),

// provider: the table's owner (StoreSelf) gives one builder per listed query; the handle implements the member
const sessions = self.queries(rows, { map: rowOf, reads: ["id", "title", "app", "state", "lastTouch"] }, {
	visible: ({ condition, app }) => query(Rows).where((s) => eq(s.app, app)).whereNode(SessionColumns, condition)
		.orderBy((s) => s.lastTouch, "desc").orderBy((s) => s.id, "desc"),                  // index byApp (app, lastTouch)
	one: ({ condition, id }) => query(Rows).where((s) => eq(s.id, Session({ id }))).whereNode(SessionColumns, condition),
});

// reader: any factory or admission on the store's host
self.liveQuery(store.sessions.one, args, { first: 1 })      // Watchable<{ rows: readonly Item[]; more: boolean }>
self.count(store.sessions.visible, args)                    // Watchable<number>: expensive, see below
// `args` may be a watchable of the arguments. Anywhere, not live:
await store.sessions.visible.page(args, n, ctx, { after });  // { items, next? } as TableHandle.page (src/store/table-handle.ts:28)
```

- **Argument schemas are the contract's.** A reader's arguments are typed, a changed schema changes the fingerprint
  (`contract_mismatch`, `accepts`, the closure rule, as for any member), and arguments are checked against it as
  method arguments are. The provider gives a builder for every listed name and no other schema for it; a missing
  or extra builder is a declaration error. A query the contract does not list is private to its owner and brings
  its schema: `name: [argsSchema, builder]`.
- **Two forms, one mechanism.** `self.query(table, q, limit)` stays as the owner's private unnamed read: range
  `{ first: limit }`, its value the rows as today. It is kept in the same index and maintained like any read, so it
  refuses nothing (`exists` and `join` work in it). p2 and the examples use it unchanged, and its existing tests
  (`test/store/live-query.test.ts`, the reload cases of `test/host/object.test.ts`) are its acceptance test. `self.liveQuery` reads a named query: another object's through its reference, or the
  owner's own through the handle `self.queries` returned (a query not listed in the contract is private to its
  owner). An owner's own reads, of either form, open in its activation after its tables are prepared, as today,
  and are no dependency on itself. `self.query` given a named query, or `self.liveQuery` given a table, throws at
  declaration naming the other. The guide: `self.query` for your own windows, `self.liveQuery` for other objects.
- **`map` gets only the declared columns:** the row projected to `reads` (and the partner to `partnerReads`, §5),
  typed as such; a column not listed is absent, at once and visibly. All columns when omitted. An item object is
  kept only when neither its row's nor its partner's projected values changed.
- A builder is a pure function of its arguments and returns a `Query` of its table. It runs when a read opens. A
  `queries` member cannot be re-exposed.
- **`{ first: n }`** is the first `n` rows of the order; `more` says whether a further row exists (the read fetches
  `n + 1`). It is the only range of `self.liveQuery`; pages between bookmarks belong to lists (§4).
- A read is shared per provider instance by (member or handle, query name, canonical JSON of the arguments, range),
  counted by its readers.
- **`self.count` is exact and expensive: know what you are doing.** One run is a `count(*)` over the query's
  condition and reads every matching row; nothing caps it. A count keeps no rows, so it re-runs on every write to its
  tables except an `update` that assigns none of its condition's or match columns (3.3). The guide: count what a
  key or an index bounds (a team's sessions), never behind a hot condition column; a number of loaded rows is
  free (`rows.length`, with "+" while `more`).

### 3.2 How a live query runs

- **Open.** `self.liveQuery` on another object's query is a declared dependency of the reader's attempt, as a keyed
  pin is (design §6). Derives that compute arguments are evaluated in the parked phase, once their references,
  registries and earlier reads have values. The provider checks the arguments, calls the builder, validates and
  compiles (§5, §6). The read is entered into the store's index **before** its first run.
- **The first run** adopts unless a commit overtook it (the adoption counter of `LiveQuery.load`,
  `src/store/live-query.ts:212-222`). If it fails (a column set not served, a row the code cannot read), the reader
  parks `failed { waiting }` on the read and goes on when a later run succeeds. Arguments the contract's schema or
  the builder refuses fail the reader `broken` (its own code).
- **Re-run.** The store keeps the index from a table's SQL name to the reads over it (the owner's `self.query`
  windows included; it moves from the table handle's owner, `src/store/table-handle.ts:41-49`). **A commit chooses
  the reads it refreshes inside its commit step**, from the index at that moment, not when its transaction staged
  (today `documents/transaction.ts:553-558`): a read opened while a commit waited in the queue is refreshed by it.
  Re-runs happen after the commit's writes and adopt in its batch (design §11, W1).
- **Arguments that follow a value.** On a change (canonical JSON) the reader opens the read for the new arguments
  and shows the old result until the new one's first run is adopted, then switches in one frame. A failed new read
  makes the member failed, with its last rows as last value. A change while one loads keeps only the newest.
- **A provider's restart.** Its readers' factories do not re-run (design §21). While the old attempt drains, its
  reads stay in the index and old work's commits reach the readers. **They leave the index only when every commit
  admitted before the seal has settled** (a drain that timed out seals with a step still running; that step
  refreshes them and its result is the outgoing instance's last publication, design §21), and before the successor
  prepares its tables. A read member then keeps its last rows, and a `more` called now parks on the loading
  reference. When the successor is live, each read rebinds to it by member and query name with its current
  arguments, as references move, and gives one frame: a diff from its last rows, including whatever another owner
  committed in the gap.
- **Staging has no effects:** `self.queries`, `self.liveQuery`, `self.list` and `self.table` hand out inert handles;
  a recorded `exposes` makes or changes no binding, a recorded list reads and writes no bookmark.
- The store's backend interface gains nothing (`src/store/backend.ts`): no `RETURNING`, nothing SQL-specific. A
  probe (3.3) is an ordinary compiled read.

### 3.3 The skip test

A read **depends on** these columns. Own table: its condition's, its order's, the ones `map` gets (`reads`), and
the ones a join or an `exists` matches by. An `exists` set's table: the matched columns and the inner condition's.
A joined set's table: its key and the partner columns of the read's condition, order and `partnerReads`. A count
depends on condition and match columns only.

A read keeps the keys of the rows it fetched, **the one past its bound included**, and for each of them the values
of the own columns it matches other tables by (for a join: the partner's key). Its **range** is its bookmarks, cut
at the position of the row past its bound when there is one. A row that is none of the fetched rows and pairs with
none of them did not decide the result.

**A skip proves the result unchanged by the row before the write and by the row after it.** Before: the kept keys
and matched values. After: **the probe**, R's own statement, its condition and its range, with one equality added
that limits its own table to the rows the written row pairs with, asking for one row. For a write to the own table
that is the own key; for a write to a joined or `exists` table, the own columns matched to it. No row: after the
write nothing the written row pairs with is in R. It is exact, because the database evaluates the real condition;
there is no second evaluator. It is used only where that equality is keyed: the matched columns, after the columns
R's own `where` terms fix with `eq` or `inArray`, are a leading prefix of the own table's key or of one of its
indexes (decided when the read is compiled; a read without it re-runs). It runs in the commit step after the
writes and counts as `chord.query.probes`. The team page: a touch of session S asks "is there a team row `(Y, S)`
whose session passes this page's condition?", one key lookup, instead of reading the team's 300 rows.

A single-key write of key K is **skipped** for read R when R has a result (a read loading or failed is never
skipped) and one of these holds, by the table's role in R:

| The table is R's | Skipped when |
| --- | --- |
| any | an `update` that assigns none of the columns R depends on in that table |
| own table | K is not among R's keys, and: an `update` that assigns none of R's condition, order or match columns (the row cannot enter); or the probe by K finds no row |
| `exists` set | **every matched set column is part of the set's key** (the row pairs with the same own rows before and after), none of R's fetched rows has those values, and the probe by them finds no row |
| joined set | K is no partner key of R's fetched rows, and: an `update` that assigns no partner column of R's condition or order; or the probe by K finds no row |

- **Where the value before is unknown and matters, R re-runs.** A matched set column outside the set's key may
  have been re-pointed by an `update` or a replacing `put`: the rows it paired with before are unknown. Round 3's
  case: a pin moved from S1 to S2 must re-run the read of S1.
- An `exists` matched on a joined partner's key pairs through that key; on another partner column, or inside
  another `exists`, it is unknown: R re-runs.
- A table R uses more than once (two `exists`; own and `exists`) is skipped only when every use is.
- A count has no keys: only the row "any" skips it.
- R's keys are those of its latest result **in this commit group** (S18): a read re-run in an earlier step of the
  group has that step's result; a rolled-back group discards them, the solo replays compute their own.
- `updateWhere`: skipped when it assigns none of the columns R depends on in that table. `deleteWhere`, a host data
  import or delete: every read of the table re-runs.
- The guide: an `update` tells readers which columns changed; a `put` tells them nothing, so each read probes. A
  touch is an `update` of the columns it changes.

A skipped read's rows and `more` are exact; test 13a checks every skip against a fresh run. Round 1's blocker as a
case: members joined with their project, mapped to its description; an update of the description alone re-runs (a
partner column `map` gets, the project a partner key of a row). Round 2's: re-pointing a member to another project
assigns a match column, so it re-runs.

## 4. C. Lists

**Problem.** "Load more" must send only the new rows, loaded rows must stay live, and a reorder (a list by last
touch) must leave no gap and no duplicate. A range by count or position cannot do that: when a row moves to the
top, "the first 50" loses its old last row to no page. And a person who sees few of many rows (a guest with two
shares, a member of one small team) must not pay for the many: a list filtered by `exists` walks the whole app on
every run.

**Solution.** Pages are bounded by fixed bookmarks and tile the order. A list reads one named query or several of
one order, each driven from what the person has, merged into one list.

```ts
// one remote object per screen: `view` is the screen's own id (a fresh id is a fresh list)
export const SessionsList = remote("sessions.list", { version: 1, params: { app: str(), view: str() }, hostAddress: () => Server(),
	variants: { list: { state: { list: listOf(SessionRow) }, methods: { more: method() } } } });
host.serve(SessionsList, ({ app }, principal, _admitted, self) => {
	const me = personOf(principal), access = self.get(PersonAccess, { person: me });                      // §8
	const list = self.list("sessions", [
		// the member's rule in this app: dense, by the app's own index; `NOTHING` (an empty `or`) for a person who is no member
		[self.get(SessionsStore, {}).sessions.visible, self.derive([access.rules], ([rules]) => ({ app, condition: rules[app] ?? NOTHING }))],
		// the person's shares: few rows, joined with their sessions
		[self.get(PeopleStore, {}).shares.sessionsOf, self.derive([access.condition], ([condition]) => ({ app, person: me, condition }))],
	], { first: 50 });
	return { variant: "list", members: { list: list.value, more: (ctx) => list.more(ctx) } };
}, { admit: signedIn, linger: 30_000 });
```

- **`list.value`** is `Watchable<{ rows, moreAfter }>`: the pages' rows joined, in order; an ordinary state member.
- **Sources** are `[namedQuery, args]` pairs of one item type; `args` may follow a value. With several, every
  query's order has the same column types and directions and **ends in the key of one column set they share** (of
  its own table when that exposes the set, of the set it joins otherwise). Rows equal in every order value are
  then one row, wherever they come from (a session in two of the person's teams, or shared and also in a team);
  the first source's item is kept. Checked when the list opens (`invalid/args`). One source needs no such order.
- **The driver finds, the condition decides.** Each source is driven from rows the person has (their teams, their
  shares, what they created) and applies the person's whole condition to the session (§6). A stale row of a side
  table grants nothing. The guide: an `exists` is never the selective part of a list.
- **Bookmarks** are values of the order (with the own key last for one source, as cursors today,
  `src/store/query.ts:83-118`). The object keeps them by the list's name (unique per object) across its attempts,
  so they survive a reload and an admission rebuild (built as the object's own memory, not as a document).
- **Pages.** Page 1 is `(start, b1]`, page 2 `(b1, b2]`, and so on; **the last page has no upper bookmark**. A page
  is one live read per source between its bookmarks, registered with the store with them and shared by nobody
  else; the reads' rows are merged in the adoption. `through` is the inclusive mirror of `after`
  (`src/store/sql.ts:168-189`). One code path: one source, one page and an empty list are tiled like any.
- **The last page** reads `first + 1` rows per source after the last bookmark and shows the merge up to its
  `first`-th row, never past the last row of a source its limit cut. An empty list and a short one are a last page
  with no or few rows: a row that arrives behind them is in its range. When a run finds a row behind what the page
  shows, its bound is fixed at its last shown row, `moreAfter` turns true, and the list ends in a bounded page
  until `more` is called. **`moreAfter` true may be stale** (the row behind was deleted since): the `more` that
  loads nothing turns it false and leaves an empty last page, open at its end.
- **`more()`** opens the next last page: one read of `first + 1` rows per source. Calls run one at a time per list;
  while the last page is open there is nothing more to load.
- **A reorder.** A row touched in page 3 leaves page 3's range and enters page 1's; both re-run in that commit and
  adopt in its batch; the joined value changes by one move.
- **Splits and merges happen in the adoption, from the rows just read, with no I/O,** so no frame loses a loaded
  row. A bounded page with more than `2 × first` rows is cut into pages of `first` at its own rows. Neighbours
  with at most `first` rows together become one, an open last page with its neighbour too.
- **A run belongs to the interval it read, not to a page.** Its adoption replaces that source's rows of that
  interval in whatever pages cover it now, then pages split and merge. In a commit group every run is computed
  before any adoption: when the first commit's adoption merges pages P and Q, the second commit's run for Q's old
  interval replaces Q's part of the merged page and nothing else; after a split it is cut the same way.
- **Overflow.** A read returns at most `max = 4 × first` rows. A run that reaches it (a bulk write) is cut as above,
  and the rest of its range becomes one further page that loads next. Until it has, **the list's value ends at the
  cut and `moreAfter` is true**: a prefix, never a hole. Pages behind the cut stay open and return with it.
- **Arguments that follow a value, and a provider's restart:** that source's reads re-open with their bookmarks
  kept, and the list switches in one frame once each has its first result; one failure fails the list's value,
  with its last rows. When the new query's order is not the bookmarks' (the cursors are refused), the list starts
  again with a first page.
- **Reload of the list's object.** A `more` running at the commit is old work: it finishes on the old attempt and
  its bookmark is in the document before the seal; a page load still running at the seal is dropped. The successor
  finds the document by name, checks the bookmarks against the queries' order, opens the pages and goes live once
  each read has its first result: holders get one frame, never an empty list or a first page alone. The old
  attempt's pages are released only after the successor's bound, so a provider held only by them does not end
  (design §21), also when the provider reloads in the same commit. A plugin whose staging failed keeps its list
  untouched.
- **A re-hold sends everything the list has loaded** (accepted). A screen that wants less takes a new `view` id.
- The sources are fixed in the factory; only their arguments follow values (R22).

## 5. D. Column sets, `exists`, the one-to-one join

**The bounding rule.** Two tables are matched only by equality to the other set's key, or to an index it declares
(a leading prefix of either for `exists`, the whole key for a join). No other condition between two tables.

```ts
// the owning plugin's contract file, once
export const SessionColumns = defineColumns("sessions.columns", {
	columns: { id: host(Session), app: str(), title: str(), creator: str(), private: bool(), state: str(), lastTouch: int(), archivedAt: opt(int()) },
	key: ["id"] });
export const TeamSessions = defineColumns("club.team-sessions", {
	columns: { team: str(), session: host(Session) }, key: ["team", "session"], indexes: { ofSession: ["session"] } });
// its server file: the table spreads the public columns in and says so
const Rows = defineTable("sessions.rows", { version: 3, columns: { ...SessionColumns.columns, cwd: str() },
	key: ["id"], indexes: { byApp: ["app", "lastTouch"] }, exposes: SessionColumns });

exists(TeamSessions, { session: s.id }, (t) => inArray(t.team, teams))            // matched by the declared index `ofSession`
existsNode(SessionColumns, { id: n.session }, node)                               // the inner condition as data (§6)
query(TeamRows).where((t) => eq(t.team, team)).join(SessionColumns, (t) => ({ id: t.session }))
	.where((_t, session) => eq(session.app, "club")).orderBy((_t, session) => session.lastTouch, "desc")
```

- A column set names scalar columns, its **key** and the **indexes** others may match by. `defineTable` checks
  `exposes` at declaration (columns with the same definition, the same key, each index a leading prefix of one of
  the table's). **Two tables exposing one set name is a declaration error** naming both. No versions.
- **The binding** (set name to SQL table) follows the committed code: made when the owner first declares the
  table, kept across its reloads, moved or dropped at a reload's commit when the new code exposes the set from
  another table or not at all. A read over a set nobody serves fails `unavailable` and re-runs when one appears.
  The closure rule does not cover sets: they are checked when a read opens. The binding holds a table's name and
  definition, never an attempt's handle: nothing of a sealed attempt is reachable through it.
- **While a bound table is not ready**, reads of other owners over it are held: not run, their rows kept. Not
  ready is: not created yet (the set moved to a table its successor has not prepared), or migrating (`evolveTable`,
  design §10, by the catalog's durable `state: "migrating"`, `src/store/catalog.ts:15`, so a failed migration stays
  held). A migration's chunks are not a transaction's writes, and a commit of another owner between two chunks
  would read a half-migrated table. When the table is ready, every open read over it is revalidated (each
  column it uses, by name and type; a mismatch fails it `invalid/args` naming the column), recompiled and run once. A compile
  or validation error never reaches the backend. A migration that fails leaves its owner failed (design §9) and
  those reads held, their rows kept, until a later reload makes the table ready (built so; showing them failed
  `unavailable` is carry-over). A host data import or delete waits for the migration, as an activation's load
  phase does.
- **`exists`** is true for a row when the set's table has a row equal in the matched columns that satisfies the
  condition (optional). No duplicates; `not(exists(…))` is its negation; it may be nested (within `whereNode`'s
  depth bound). Its match is a leading prefix of the set's key or of a declared index. A `NULL` in a matched
  column (an `opt` column) matches nothing: the `exists` is false and a join drops the row.
- **`join`** pairs each row with the one row of that key: an inner join, driven from the query's own table (the SQL
  is rendered so the planner cannot reorder it). The partner's columns may be compared, ordered by and handed to
  `map` (`partnerReads`). The match covers the set's whole key; a set is joined at most once per query.
- In both, matched columns have the same type (host columns the same kind); anything else is `invalid/args` naming
  the column and listing the set's key and indexes. Compiled form: `{ exists: [setName, [[setColumn, column], …],
  WhereNode | null] }`; a partner's column is `setName:column` in conditions, orders and cursors.
  `updateWhere`, `deleteWhere` and conditions inside a transaction take neither.
- A commit of any table a read reads may re-run it, in that owner's step. Host data import and delete re-run every
  read over a table with a host column of the address's kind.

## 6. E. Conditions as data

```ts
compile(SessionColumns, condition): WhereNode            // over compileWhere (src/store/expression.ts:218): plain JSON data
query(Table).whereNode(SessionColumns, node)             // in a builder; `SessionColumns` is the query's own table's set or a joined one
existsNode(SessionColumns, match, node)                  // in a builder: `exists` with a node as its inner condition
```

- `whereNode` applies the node to whichever side of the query is that set. On a joined set its columns become the
  partner's, and an `exists` inside it is matched on the partner's column.
- `existsNode` is for a row that may point at something the person must be able to see (a notification with an
  optional session, §8).
- **A trust boundary.** `whereNode` and `existsNode` validate the whole node before anything is rendered: one known kind per node,
  operand shapes and types, encoded host operands, every column in the set, every `exists` match rule, a depth
  bound. A failure is `invalid/args`.
- **Conditions are built by server code only.** Clients send values (an app id, a team); the guide says so.
- **No substring filter.** The only text operator is `prefix`. Filtering as you type goes through the search
  plugin's method, its hits read with a named query (§9); the guide says so, and says never to read everything and
  filter in a derive.
- **A host-data delete limited to one plugin:** `host.deleteHostData(address, ctx, { plugin })` removes the
  address's records and rows only in what that plugin's objects own, in one commit.

## 7. Cost and garbage

A bound limits the rows a run **returns**. What it **reads** depends on the index its order and condition can use,
and every run blocks its host: the store's backend is synchronous.

| Where | Work |
| --- | --- |
| a commit writing a table nothing reads live | one map lookup per written table (as today) |
| a commit writing a table with R reads | the skip test per read: a set lookup, then at most one keyed probe (about 2 µs in SQLite, measured); a run per read not skipped; `chord.query.runs`, `chord.query.probes`, `chord.query.skips`. Linear in the reads the assigned columns cannot rule out |
| a page of a list | one seek in the order's index, then every row of the table between its bookmarks the index cannot exclude |
| `exists` | one index probe per row tested, which may pass several rows of that prefix before its inner condition holds |
| a join | the own rows the own condition admits, one key lookup each, a sort when the order uses a partner column |
| a list | a read per page and source; a touch re-runs the page left and the first page |
| a count | every row matching its condition, on each re-run |
| an admitted object | its admission's references and derives; one more attempt per changed value |
| a route admission | one decision per (principal, address) with holds |

- **The index rule.** A named query names, in a comment, the index its order and its condition's selective part run
  on. Whether a query scans is checked by plan tests against the SQLite backend and by §9's numbers; `chord.query.
  rows` (rows returned to Chord) measures output only.
- **An `inArray` on one column with an order on another walks the order's index.** Measured: a sidebar's "working,
  waiting or failed, by last touch" read 10,000 rows in 2.3 ms; ordered by state, then last touch, 0.07 ms. Every
  named query of §8 has a plan test.
- A list ordered by a partner's column (the team page) reads and sorts all its driver's rows on each run. A write
  of that column elsewhere in the partner's table costs it one probe, not a run. No value is copied into the
  list's own row for this.
- GC tests: after the last reader ends, nothing of a read, a page, a list, a dropped binding or a route decision is
  reachable.

## 8. Worked examples (p3's code, shown to test the design)

**Access: one rule per app, as a condition; no list of ids, no cap.**

```ts
export type AppEntry = { readonly id: string; readonly shares: boolean;
	visible(member: Member, s: typeof SessionColumns.refs): Condition | undefined;       // undefined: all of the app's sessions
	mode(member: Member, session: PublicSession): "read" | "write" };
// family: private is private to its creator, parents included
self.contribute(Apps, { id: "family", shares: true, visible: (m, s) => or(eq(s.private, false), eq(s.creator, m.person)), mode: () => "write" });
// club: the sessions of the member's teams, and what the member created
self.contribute(Apps, { id: "club", shares: false,
	visible: (m, s) => or(eq(s.creator, m.person), exists(TeamSessions, { session: s.id }, (t) => inArray(t.team, teamsOf(m)))), mode: (m) => (m.role === "coach" ? "write" : "read") });

host.serve(PersonAccess, ({ person }, self) => {                         // local, on the server
	const members = self.liveQuery(self.get(PeopleStore, {}).members.ofPerson, { person }, { first: 100 });   // one row per app
	const mine = self.derive([members], ([m]) => {
		if (m.more) throw new Error("apps: more memberships than this reads");            // a source of access fails closed
		return m.rows; });
	const app = SessionColumns.refs.app, apps = self.registry(Apps);
	return { members,
		// app id -> the member's rule alone: what a list's dense source walks (§4)
		rules: self.derive([mine, apps], ([rows, all]) => Object.fromEntries(rows.map((m) => [m.app, compile(SessionColumns, ruleOf(all, m))]))),
		// everything the person may see: what every source and every single read is checked by
		condition: self.derive([mine, apps], ([rows, all]) => compile(SessionColumns, or(
			...rows.map((m) => and(eq(app, m.app), ruleOf(all, m))),
			and(inArray(app, sharing(all)), exists(Shares, { session: SessionColumns.refs.id }, (x) => eq(x.person, person)))))) };
});
```

A new share changes no condition: the share row is written, and by §3.3's `exists` clause only that person's reads
re-run.

**One session's answer, the hop to its worker, the route.**

```ts
host.serve(SessionAnswer, ({ session, person }, self) => {               // local, on the server
	const access = self.get(PersonAccess, { person });
	const people = self.get(PeopleStore, {});
	const one = self.liveQuery(self.get(SessionsStore, {}).sessions.one,
		self.derive([access.condition], ([condition]) => ({ condition, id: session })), { first: 1 });
	const share = self.liveQuery(people.shares.one, { person, session }, { first: 1 });
	return { admitted: self.derive([one, share, access.members, self.registry(Apps)], ([found, x, m, apps]) =>
		found.rows.length === 0 ? deny("no access") : allow({ mode: modeOf(found.rows[0], m.rows, x.rows[0], apps) })) };
});
// the app's API owns the contracts the worker and the route read (`SessionAdmission`, `SessionRoute`); the sessions plugin serves them
host.serve(SessionAdmission, ({ session, person }, principal, self) => {  // remote on the server
	if (principal.kind !== "worker" || principal.session !== session) throw forbidden("the session's worker only");
	return { variant: "worker", members: { admitted: self.get(SessionAnswer, { session, person }).admitted } };
});
host.serve(PersonHere, ({ session, person }, self) => ({ admitted: self.get(SessionAdmission, { session, person }).admitted }));   // local, on the worker
const inSession = ({ session }, principal, self) =>
	principal.kind === "owner" ? constant(allow({ mode: "owner" })) : principal.kind === "server" ? constant(allow({ mode: "server" }))
	: principal.kind === "person" ? self.get(PersonHere, { session, person: principal.id }).admitted : constant(deny("no access"));
host.serve(Transcript, ({ conversation }, _principal, admitted, self) =>
	admitted.mode === "read" ? { variant: "viewer", members: viewer(conversation, self) } : { variant: "participant", members: participant(conversation, self) },
	{ admit: inSession });
// base code (the workers component's `admit`): nobody denied starts a worker; `SessionRoute` is local, on the server, over `SessionAnswer`
admit: (principal, address, self) => principal.kind === "person"
	? self.derive([self.get(SessionRoute, { session: address.params.id, person: principal.id }).admitted], ([a]) => (a.kind === "allow" ? allow(null) : a))
	: constant(allow(null)),
```

Max removed from the family: his member row goes, his condition changes, `one` re-opens and is empty, the answer is
`deny`: his transcript is sealed, its calls reject `forbidden/revoked`, the route unbinds his holds.

**The club: a member's list and the team page,** both driven from the club's side table, ordered by the sessions'
last touch, the session's current app checked. The team page's team comes from the admission.

```ts
const teamSessions = self.queries(teamRows, { map: (_row, session) => sessionItem(session), reads: [], partnerReads: ["id", "title", "state", "lastTouch"] }, {
	ofTeams: ({ teams, condition }) => query(TeamRows).where((t) => inArray(t.team, teams))  // key (team, session): a probe by session is one lookup per team
		.join(SessionColumns, (t) => ({ id: t.session }))
		.where((_t, session) => and(eq(session.app, "club"), isNull(session.archivedAt)))   // a session that moved to another app is gone at once
		.whereNode(SessionColumns, condition)                                              // the person's access, on the joined side
		.orderBy((_t, session) => session.lastTouch, "desc").orderBy((_t, session) => session.id, "desc"),
});
host.serve(ClubSessions, (_params, principal, _admitted, self) => {      // a member's sessions: their teams', and what they created
	const me = personOf(principal), access = self.get(PersonAccess, { person: me });
	const list = self.list("mine", [
		[self.get(ClubStore, {}).teamSessions.ofTeams, self.derive([access.members, access.condition], ([m, condition]) => ({ teams: clubTeams(m.rows), condition }))],
		[self.get(SessionsStore, {}).sessions.createdBy, self.derive([access.condition], ([condition]) => ({ app: "club", person: me, condition }))],
	], { first: 50 });                                                  // a session in two of the teams, or created and in a team, is one row
	return { variant: "list", members: { list: list.value, more: (ctx) => list.more(ctx) } };
}, { admit: signedIn });
const inTeam = ({ team }, principal, self) => principal.kind === "owner" ? constant(allow({ team }))
	: self.derive([self.get(PersonAccess, { person: principal.id }).members], ([m]) =>
		clubTeams(m.rows).includes(team) ? allow({ team }) : deny("not your team"));
host.serve(TeamPage, (_params, principal, admitted, self) => {
	const teams = self.get(ClubStore, {}).teamSessions.ofTeams;
	const args = self.derive([conditionOf(self, principal)], ([condition]) => ({ teams: [admitted.team], condition }));
	const list = self.list("team", [[teams, args]], { first: 50 });
	return { variant: "list", members: { list: list.value, more: (ctx) => list.more(ctx),
		count: self.count(teams, args) } };                             // "u12 · 300 sessions": reads the team's rows on each re-run
}, { admit: inTeam });
```

Per run of one page, for a team of T sessions in a club of C (SQLite alone, in memory, on the development server;
Chord's decoding and diffing come on top):

| | Driven from the team's rows (above) | `exists`, walking the club by last touch |
| --- | --- | --- |
| reads | T rows, T lookups, a sort of T | about 50 × C / T rows, a probe each |
| T = 20, C = 3,000 | 0.02 ms | 1.1 ms |
| T = 300, C = 3,000 | 0.21 ms | 0.26 ms |
| a guest with 2 shares among 3,000, driven from the shares | 0.003 ms | 0.85 ms |
| a touch of a session elsewhere in the club | one probe (under 0.003 ms) | one probe |
| re-runs its first page on | a team row written; a session of the team touched | a visible session touched |

**The sidebar's working set:** four small lists merged in memory, not one `or` (which no index serves).

```ts
host.serve(Sidebar, (_params, principal, _admitted, self) => {
	const hour = self.writable(hourNow());
	self.onLive(async (ctx) => { for (;;) { await sleep(untilNextHour(), ctx); hour.set(hourNow()); } });
	const condition = conditionOf(self, principal), sessions = self.get(SessionsStore, {}).sessions, me = personOf(principal);
	const mine = self.derive([condition], ([c]) => ({ person: me, condition: c }));
	const lists = {
		active: self.list("active", [[sessions.inStates, self.derive([condition], ([c]) => ({ condition: c, states: ["working", "waiting", "failed"] }))]], { first: 50 }),
		recent: self.list("recent", [[sessions.since, self.derive([condition, hour], ([c, h]) => ({ condition: c, since: h - WINDOW }))]], { first: 50 }),
		pinned: self.list("pinned", [[self.get(Pins, {}).pins.ofPerson, mine]], { first: 50 }),
		unread: self.list("unread", [[self.get(Reads, {}).marks.ofPerson, mine]], { first: 50 }) };
	return { variant: "person", members: {
		sections: self.derive([lists.active.value, lists.recent.value, lists.pinned.value, lists.unread.value, self.registry(Groupings)], sectionsOf),
		more: (which, ctx) => lists[which].more(ctx) } };
}, { admit: signedIn });
// Pins (Reads alike): the person's own rows drive, the condition decides, the order is the row's own column
ofPerson: ({ person, condition }) => query(PinRows).where((p) => eq(p.person, person))      // key (person, session)
	.join(SessionColumns, (p) => ({ id: p.session })).whereNode(SessionColumns, condition).orderBy((p) => p.pinnedAt, "desc"),
// sessions.inStates orders by state, then last touch: index (state, lastTouch); by last touch alone it walks every session (§7)
```

- Pins and marks are **the person's**: `person` is an argument the factory takes from the principal, never read out
  of the condition. Another person's pin or mark is another key prefix and re-runs nothing here.
- The sidebar is a bounded summary. `sectionsOf` groups the merged rows and passes each list's `moreAfter` on; `more`
  loads a list's next page. **The unread count per section is counted from the rows of `unread`**, and is a lower
  bound ("3+") while that list has more.
- `active` and `recent` walk what is active now and what was touched in the window, for every person, a sparse one
  included: that grows with activity, not with history (§9 measures the guest's). Driving them from a person's
  teams and shares needs sources that follow a value (carry-over).

**A notification feed** hides items whose session the person can no longer see, and keeps those without one:

```ts
forPerson: ({ person, condition }) => query(Notes).where((n) => and(eq(n.person, person),
	or(isNull(n.session), existsNode(SessionColumns, { id: n.session }, condition)))).orderBy((n) => n.at, "desc"),
```

**A session moves to another app:** the sessions plugin updates the row, then calls `deleteHostData(address, ctx,
{ plugin: oldApp })`. Between the two commits the club's lists already exclude it (`session.app = "club"`).

## 9. Acceptance: p3's ordinary screens

**Data.** 10,000 session rows: a club of 3,000 (ten teams of 300 and one of 20), a family of 3,000, 4,000 archived
elsewhere; 200 working, waiting or failed; 330 touched in the sidebar's window; one session with 5,000 subagents.

**Open at once (the mix),** all on the server:
- 10 family members: a sidebar (four lists) and the family's list (§4) each;
- 10 club members, each in two of the ten teams: a sidebar, the club's list and both team pages each, so **20 team
  pages**, two per team;
- a guest with 2 shares in the family, and a member of the team of 20: a sidebar and a list each (and its team page);
- 20 workers, each following its session.

**The event** is a touch: `update(S, { lastTouch, state })` of a club session in one team of 300 (an `update`,
not a `put`), S on the first page of its team's pages and lists, pinned and unread by nobody.

| Reads over the session table | Open | The touch causes |
| --- | --- | --- |
| team pages, first page | 21 | 2 runs (S's team), 19 probes |
| team pages' counts | 21 | nothing (no condition column assigned) |
| club lists, source "teams" | 11 | 2 runs, 9 probes |
| club lists, source "created" | 11 | 11 probes |
| family lists, source "rule" | 11 | 11 probes |
| family lists, source "shares" | 11 | 11 probes |
| sidebars: active, recent | 44 | 4 runs, 40 probes |
| sidebars: pinned, unread | 44 | nothing (order and condition columns not assigned, S not among their rows) |
| workers | 20 | 1 run (the others: an `update` of no condition or order column of a row they do not show) |
| **all** | | **9 runs, 101 probes** |

**Budgets,** on the development server (`test/bench/slice-14.ts` fails when one is missed; a phone is taken as 5
times slower). Two kinds, so a miss says which went wrong:
- **per run:** the first load or a re-run of a page of 50 rows at most **2 ms**; of a page whose driver has at most
  20 rows at most **0.2 ms**; a probe at most **0.02 ms**;
- **the number of runs and probes** an event causes: exactly the table's (`chord.query.runs`, `chord.query.probes`);
- and their sum: **an ordinary commit's step at the mix at most 5 ms.** The step at ten times the mix is reported
  without a budget (probes are linear in the open reads).

**Measured** (2026-11-16, `benchmarks.md`, with each source of a list over several sources as a list of its own
until those are built): 9 runs, 101 probes, 3.5 ms for the touch; a probe 4 µs; every kind of read inside its
per-run budget; ten times the mix 31 ms; the subagents' list: first page 0.64 ms, a message 0.6 ms, 26 pages for
1,000 loaded rows after 10,000 touches. The estimate this was planned from: SQLite alone (node:sqlite in memory, this data, 2026-11-15) takes about 1.6 ms for the 9
runs (a team page 0.21 ms, a club list's teams source over 600 rows 0.40 ms, a sidebar list under 0.1 ms) and under
0.3 ms for the 101 probes (0.6 to 2.6 µs each). Chord's decoding, mapping and diffing are not measured. Without the
probe the same touch runs about 110 reads: 14 ms.

| # | Screen | Code | Example | Must hold |
| --- | --- | --- | --- | --- |
| 1 | sidebar: recent, sections, unread count per section | §8 `Sidebar` | `73-sidebar.ts` | first load within 4 × 2 ms, for the guest too; a touch of a session the person does not see: 0 runs; another person's pin or mark: 0 runs, one probe; with 120 marks over three sections the counts are lower bounds until `more` loaded them |
| 2 | a member's list in an app with a dense rule | §4 `SessionsList` | `71-lists.ts` | first page 2 ms; `more` sends only inserts; a session shared and visible by the rule is one row |
| 3 | **sparse persons:** a guest with 2 shares among 3,000; a member of one team of 20 in a club of 3,000 | §4, §8 `ClubSessions` | `71-lists.ts`, `72-exists-and-joins.ts` | first page 0.2 ms (walking the app takes 1 ms and fails it); a touch of a session they do not see: 0 runs |
| 4 | the team page, the session's app checked, with its count | §8 `TeamPage` | `72-exists-and-joins.ts` | first page 2 ms at T = 300; the table's numbers; a session moved to another app leaves in the frame of the move; the count re-runs on an archive, not on a touch |
| 5 | a worker following its session | `self.liveQuery(sessions.one, …, { first: 1 })` behind `SessionAdmission` | `69-admission.ts` | a write to any other session: 0 runs, 0 probes |
| 6 | a session's 5,000 subagents | a list over `children.ofSession` | `71-lists.ts` | first page 2 ms; a message (one child to the top) 5 ms with 20 pages loaded; the page count stays bounded over 10,000 touches |
| 7 | a share link revoked with lists open | `deleteWhere` on shares (§8) | `74-access.ts` | the commit within 10 ms, every read over the shares table re-run (reported); only the affected persons' values change; their open transcripts of that session are denied |
| 8 | reconnect after sleep | a re-hold of the list object | `71-lists.ts` | within `linger`: one `bound` with what was loaded; after it: a first page |
| 9 | reload of the store, of a column set's publisher (with a migration), and of the list's object, with lists open | §3.2, §5, §4 | `75-reload.ts` | one frame per holder each; no failed member; no row lost or doubled; a commit during the migration runs no read over that table |
| 10 | a session moving apps | §8 | `74-access.ts` | each commit within 10 ms; the old app's rows gone; the club's lists and the old app's lose it, the new app's gain it |
| 11 | a notification feed | §8 `forPerson` | `74-access.ts` | an item whose session the person lost leaves in that commit; one without a session stays; a touch: 0 runs, 0 probes (no inner-condition column assigned) |

Reported without a budget: a touch of a session every open list shows; an archive of a club session (the 21
counts re-run, 0.06 ms each in SQLite). If the first is ever judged too high, the carry-over's "maintain a page
from the written rows" is the answer.

Outside the list: the transcript (Durable's entries: the same tiling by entry id, old pages a method's answers,
only the tail live; it depends on Durable's windowed view, `slices.md` "Any slice"), and search and filtering as
you type (the search plugin's method, its hits filtered with `sessions.visibleAmong` read by `page`).

## 10. Tests (one file per source file, one `describe` per mechanism; cost guards through the in-memory telemetry adapter)

**`contracts`**: `queries(...)` in a remote contract refused, re-exposed refused; a contract without `queries`
keeps its fingerprint, a query's argument schema is in it, `admission` is not; a listed query without a builder, a
builder with a schema for a listed name, a private query without a schema: each refused; `evolve`'s `admission`; `defineColumns` (key and indexes name its
columns, `json` refused); `exposes`: a missing column, another type, another key, an index the table lacks, two
tables exposing one name: each refused at declaration.

**`store/expression`, `sql`, `evaluate`, `query`**: `exists` with and without an inner condition, nested, negated;
matched by the key, a prefix, a declared index, a `str` key, a composite key; **a match on a column that is none of
those refused, naming it**; other types or host kinds refused; `exists` and `join` refused in `updateWhere`,
`deleteWhere`, `tx.page`; `join`: a match short of the whole key refused, a set twice refused, a row without a
partner dropped, a partner column in `where` and `orderBy`, cursors of a joined order; the plan drives from the own
table (a plan test on the SQLite backend); `through` (inclusive, with `after`, descending, composite); the
full-row `matches` and `applySet` unchanged; `whereNode`: an
unknown kind, two kinds in a node, a wrong operand type, an unencoded host operand, a column outside the set, a
broken match rule, too deep: each `invalid/args`, none reaches the backend; `whereNode` on a joined set, with an
`exists` matched on the partner; `existsNode` validated as `whereNode`; a `NULL` in a matched column matches
nothing (`exists` false, the joined row dropped); the probe's statement is keyed (plan tests for an own key, a
join's match after an `eq` prefix, an `exists` match), and a read without a keyed probe is compiled without one.

**`store/live-query`**:
1. open: rows before the reader is live; `more`; **a read opened while a commit waits in the queue is refreshed by
   it**; a commit between registration and adoption (the newer result stays); a first run that fails parks the
   reader `failed { waiting }` and heals; refused arguments break it.
2. `self.query` (old form) and a named read over one table: each re-run once by a commit; the wrong form of each
   call throws naming the other; an owner's private named query; an owner's own read opens in its activation.
3. shared: two readers, one read, the same rows object; the last release frees it (GC).
4. projection: `map` gets only `reads`; an unlisted column is absent; an update of an unlisted column is skipped for
   a row in the read; of a listed one re-runs.
5. skip, own table: another key of a `one` read (one probe, no run); an update of a non-condition, non-order
   column of a row not in the read (no probe); a put that cannot match and a put past the row beyond the bound (a
   probe miss); a put inside re-runs; a delete of a key not among the keys (a probe miss); a delete of the row past
   the bound re-runs; a loading and a failed read re-run.
6. skip, `exists`: **a pin moved from S1 to S2 by `update` and by a replacing `put` re-runs the reads of S1 and of
   S2, also under `not(exists(…))`**; a share written (its matched column in the key) for a session of another
   app: the probe skips that app's list; for a row in the read re-runs; an `update` of a set column outside match
   and inner condition skipped without a probe; an `exists` matched on a partner's key probes through it, on
   another partner column re-runs; a table used twice is skipped only when both uses are.
7. skip, joins: **an update of a partner column only `map` gets re-runs and that item alone is a new object**; a
   partner update changing the order: **the team page of another team is skipped by one probe, the session's team
   re-runs**; a partner column outside condition, order and `partnerReads` skipped; **re-pointing a row to another
   partner (`reads: []`) re-runs**; a partner deleted drops the row; a read whose probe is not keyed re-runs.
8. `updateWhere` unrelated skipped, related re-run; `deleteWhere` and host data import and delete re-run all.
9. group commit: two owners' commits in one group, each order, for an `exists` read and a joined read (a row
   re-pointed in the first, that partner updated in the second); a failed earlier run; rollback and solo replays.
10. arguments that follow a value: parked until the source has a value; the old result until the new is adopted; A,
    B, C with B failing; a failed new read is a failed member; a first argument derive that throws.
11. column sets: not served, then served; a column of another type fails the read at open. (Reloads: 17, 18.)
13. two persons: one cannot get the other's rows by any params (the condition comes from the admission's sources);
    with the same sessions and different pins and marks each sees only their own, and the other's write runs and
    probes nothing.
13a. **the oracle, written before the skip code:** in a randomized run of writes (`put`, `update`, `delete`, group commits) over own, joined and
    `exists` tables, with reads of every shape of §8, every skipped read equals a fresh run of its statement.
13b. `self.count`: exact; an `update` of no condition or match column is
    skipped, every other write of its tables re-runs it; arguments that follow a value; no cap.

**`host/list`**: a first page from one read; `more` adds only inserts; two `more` calls run in turn; a row moving
between pages is one move; **after every published frame of a randomized run** (touches, inserts, deletes, bulk
writes of 20 × `first`, group commits, rollbacks, one and three sources) the value is a gapless, duplicate-free
prefix of the true order, and the whole order when `moreAfter` is false; a split at `2 × first` and a merge change
no row; overflow shows a prefix with `moreAfter`; the page count stays bounded.
- the last page: an empty list, a short one, exactly `first` rows (`moreAfter` false; a row appended behind each
  appears, or bounds the page and turns `moreAfter` true); the row behind a bounded last page deleted: `moreAfter`
  stays true, a `more` loads nothing and turns it false, a new row behind then appears.
- several sources: merged in order; a row of two sources, and a row twice in one source, appears once; a source
  cut by its limit bounds the page before the others' later rows; more than `first + 1` rows of one source with
  one session key, with and without a later session (progress, one row, `moreAfter`); a re-run of one source
  changes only its rows;
  orders of different columns or directions, or not ending in one shared set's key, refused when the list opens;
  one source's arguments change (one frame).
- commit groups, deterministic: C1 leaves P with `[A]` and Q with `[B, C]`, C2 changes C; **C1's adoption merges P
  and Q, C2's run for Q's old interval updates C and nothing else**; both orders; split, then a run for the old
  page; a merge with the last page; rollback and solo replays; complete rows compared, not ids.
- arguments changing switch every page in one frame, one failing page fails the value; another order starts again;
  everything released when the object ends (GC). (Reloads: 19.)

**`host/attempt`, `object`, `dependencies`, `staging`, `reference`, `route`; `remote/relay`; `node/workers`**:
14. admission: deny then allow through a direct hold and a dependent's `self.get` (it heals); each row of 2.2's
    table; a source whose successor parks (readers sealed, then rebuilt); a source's contract bumped without
    `accepts` in a server-first rollout seals its readers, with `accepts` seals nothing; an unrehearsed admitted
    factory with a declaration error is reported at its activation; `denied` shown before the old teardown finished; what a denial removes, and that a `WatchHandle`'s value
    stays; references kept until the successor bound; `self.job` refused; declaration errors; rehearsal by
    fingerprint, none for a denied-only type; presence; linger; `parked_long` silent; `ref.retry()`.
15. route admission: no `resolve` and no forward before the first allow; a denied hold starts no host; allow later
    binds; deny unbinds and rejects calls in flight `forbidden/revoked`; **allow, deny, allow with the old `bound`,
    `state`, `event` and call replies in transit on the same link: all dropped before the `pong`, the hold forwarded
    after it under its id, a second hold of any id undisturbed**; a liveness `pong` in transit does not end the
    fence; a denial before the `pong`; the link lost before it; deny and allow three times in a row; two principals on one address; a failed source leaves
    bound holds and fails new ones; `RouteHandle.retry` with
    only denied holds starts no host; an admission holding a type behind its route fails `invalid/cycle`; `createWorkers` passes `admit`; one decision for several holds (GC).
16. host data: `deleteHostData` with `plugin` leaves other plugins' data, in one commit; reads over its tables
    re-run.

**Reload** (`test/host/reload-reads.test.ts`; each case also in the page, server and worker reload suite of
design §21): no consumer factory runs again in any of them.
17. the store's plugin alone, under two unchanged readers sharing a read, a list of three pages and another owner's
    joined read: one frame, none when equal; a write of old work during the drain is delivered; **a write admitted
    before the seal and paused across it** still refreshes the outgoing reads, is published as the old instance's
    last, and no old statement runs on the migrated table; a commit of an `exists` table's owner between the seal
    and the successor's first run is in the reader's one frame; a late first run or teardown of the old attempt
    does not replace or remove the successor's registration; the new builder is used; each later commit runs each
    read once; equal results send nothing; a reorder across pages during the handover leaves no gap or duplicate; a
    group commit crossing the restart; old handles and registrations collect. The same with a table migration.
18. a publisher's plugin alone, under an `exists` reader and a joined reader of another, unchanged provider: pure
    code; an unused column added; a used column renamed, dropped, retyped (`invalid/args` before any SQL, the store
    usable); an eager migration held between chunks with a third owner's commit (no read over the table runs, one
    frame after `ready`); a migration that fails (`unavailable`, held after its announcement is gone, ready after
    a fixing reload); a set moved to a table its successor has not created yet (held, then one frame); `exposes`
    removed and restored; the type removed and served again; staging
    failed (the old binding still serves); host data import and delete during the migration; no old attempt kept.
19. a list's plugin alone, its provider alone, and both in one reload, with three pages loaded, one split, its
    boundary row deleted and a `more` begun: the bookmark document is the same, every range is registered exactly
    once, the rows equal the true ranges after every frame, no first-page collapse; a write into each range gives
    one update; a second list added by the reload; a `more` called in the gap or crossing a seal; staging failed (nothing changes); a group rolled back leaves no bookmark; another order starts the
    list again; a re-hold within `linger` gets the restored pages; old pages and closures collect.
20. an admission source's plugin alone, with a method of the admitted object running: an equal decision (the method
    completes, the factory and its natives are not rebuilt, the source never loses its last holder); a changed
    value, a denial, a failed and a removed source, each also while the admitted object's own old attempt drains and
    while it opens a native; a commit in flight at the cut stays durable and nothing is published after it; a
    denial between staging and activation; staging: `admit` recorded without effects, rehearsal with an equal
    fingerprint that passes and one that throws (the plugin stays old, the closure rule applies), none for another
    fingerprint or no value, a dependency found only by the newly admitted branch parks after the commit.
21. a route admission across reloads, with a live worker link, two principals and shared holds: the source's
    plugin reloaded to an equal allow (no `resolve`, no new upstream hold, calls complete); to a denial (only that
    principal's holds); to a denial and back (the fence); failed; removed and restored; reloaded while a `resolve` is pending; an object behind the
    route reloaded (no decision asked); a new link of the route asks the current decision; decisions released with
    the last hold and old source attempts collect. A server restart with a new `admit` uses it (integration).
22. the old and the new form together: one owner with a `self.query` window and a named query read through
    `self.liveQuery` and `self.list` by unchanged consumers; commits before, during and after the owner's reload;
    each value keeps its shape, each read runs once per commit, old registrations collect; staging failures of each.

**`remote/hold`, `link/*`, `data/failure`**: `denied` in both codecs; A, B, C before acknowledgements with a call
between; a denied hold joined by a second reference; `host.revoke` of a denied principal.

**Examples:** `69-admission.ts`, `70-named-queries.ts`, `71-lists.ts`, `72-exists-and-joins.ts`, `73-sidebar.ts`,
`74-access.ts`, `75-reload.ts` (§9 says what each shows). **Benchmark:** `test/bench/slice-14.ts`, results in
`benchmarks.md`.

## 11. Where it touches the source

`contracts/schema.ts`, `declare.ts`, `evolve.ts`; a new `contracts/columns.ts`; `store/expression.ts`, `sql.ts`,
`evaluate.ts`, `query.ts`, `table.ts`; `store/live-query.ts` (named reads, counts, bounds, sharing), a new `store/skip.ts` (the skip test and the
probe), the index and the set bindings in `store/store.ts`; `documents/transaction.ts` (the refresh chosen in the step); a new
`host/list.ts`; `host/attempt.ts`, `object.ts`, `dependencies.ts`, `parked.ts`, `staging.ts`, `members.ts`,
`reference.ts`, `reference-source.ts`, `presence.ts`, `route.ts`, `host-data.ts`; `remote/hold.ts`,
`remote-object.ts`, `relay.ts`; `node/workers/workers.ts`; `link/message.ts`, `binary.ts`, `text.ts`, `channel.ts` (the fence);
`data/failure.ts`; `telemetry.ts`; `docs/plugin-authoring.md` and the host and store READMEs. Existing callers of
`self.query` do not change.

## 12. Carry-over entries this slice adds (`slices.md`), each with the case that brings it back

- Sources of a list that follow a value: a sidebar driven from a person's teams and shares, when the active set
  outgrows a walk.
- A probe for counts (they re-run on every write of a condition column): the first count behind a hot column.
- A live `moreAfter` (a one-row read behind a bounded last page): a screen where a stale "more" is noticed.
- An in-memory evaluator before the probe: a commit step measured as dominated by probes.
- `{ offset, count }` ranges: a screen that must jump to a position.
- A list opened at a bookmark, `more` towards the start, `reset`: a screen that jumps to a row in a long list.
- `evolve` and `accepts` edits for named queries: the first released contract with a `queries` member that changes.
- Maintaining a page from the written rows instead of a re-run: §9's worst-case number, if judged too high.
- A left join; aggregates; `matches`: a screen that needs one.
- Bump `PROTOCOL_VERSION` for `denied` with p3's first release.
