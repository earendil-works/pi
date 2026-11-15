# Slice 14: the changes to `design.md`, and what they supersede

Status: fifth version (2026-11-16), with `slice-14.md`. Nothing here is folded into `design.md`,
`decisions.md` or `slices.md` yet; that happens in the commit that records the owner's decision (with the slice's
row in `slices.md`'s table and feature map). Line numbers are `design.md`'s at the time of writing.

## 1. Decisions and rules this slice changes

| Where | Rule today | After this slice |
| --- | --- | --- |
| Decision "Live queries over an object's own tables" (`decisions.md`, 2026-11-03); design §11 (line 1470) | `self.query(table, q, limit)`: the owner's own table, fixed for the attempt, a limit required | **Kept, and extended.** `self.query` stays the owner's private unnamed read. Named queries are added: `self.queries` in the owner, `self.liveQuery(namedQuery, args, { first })` in any object on its host, `self.count` (expensive), `self.list` for lists over one or several named queries. Both forms are one mechanism. A read may test `exists` in, or join one row of, another owner's column set. Kept: a bound is required; a run in the commit step, adopted in the commit's batch; a failed run is a failed member; "Rejected: a window document written beside the table" |
| The same decision: "only it writes them, so its commits are the exact invalidation"; the reads a commit re-runs are chosen when its transaction stages | | **Replaced.** The store keeps which reads read which table; a commit of any owner of such a table chooses the reads it refreshes inside its commit step and re-runs those the skip test cannot rule out: by the columns the commit assigns, or by one keyed probe per read. No value is mirrored into another table to make a read cheap |
| Design §9 (line 1108): "No live key list: a collection shown live is a singleton; large collections are methods returning pages" | | **Superseded in part.** A large collection shown live is a list (`self.list`) over a named query. Keyed documents still have no live key list. Paged methods stay for jobs and scripts; a screen does not chain them |
| Design §7 (line 1038): "there is no async activation guard"; design §3 "Routes": `authorize` is a route's only check | | **Superseded:** a type's admission is that guard; a route may have an admission, asked before anything is resolved or forwarded |
| Design §3 "Relays": "Ids are not renumbered" | | **Unchanged.** A hold a route's admission denied and allows again is fenced: `release`, a `ping`, forwarded again after its `pong` |
| Design §1, principle 3, and §6 "The factory principle": a factory decides from params and principal | | **Extended:** an admitted type's factory also gets the admitted value |
| Design §15: jobs in any object | | **Narrowed:** no jobs in an admitted object |
| Design §9 "Rules across owners" (line 1273): "Data crosses plugins only through state and methods" | | **Extended:** and through a column set a plugin's contract declares, which another plugin's condition or join may read inside the store. Nobody writes through one |
| Design §10 (line 1430): a `host(...)` column is compared "with `eq`, `ne`, `inArray` only" | | **Extended:** it may also be matched in `exists` and `join`, as any column of a set's key or declared index |
| Design §10, host data delete: every record and row of the address | | **Extended:** `deleteHostData(address, ctx, { plugin })` limits it to one plugin's tables and documents |
| Design §21 "Staging": every affected object's new factory is rehearsed; the closure rule covers every changed plugin's requests | | **Two stated limits:** an admitted factory is rehearsed only with a value of an equal `admission` fingerprint; column sets are checked when a read opens, not by the closure rule |
| R22 (design line 899): "A `get` with params computed after activation is added only if a real case needs it" | | **Unchanged.** Arguments that follow a value exist for live queries and lists only |
| Carry-over "Incremental maintenance of a live query's result" (`slices.md`) | | **Reworded** (`slice-14.md` §12): the skip test is built; maintaining a page from the written rows stays later |
| `admission/design.md` §2 to §7 | | **Replaced** by `slice-14.md` §2; the file is kept as the record. Its §0's "every object type, an app's own stores included" is decided otherwise: remote types only |

## 2. §31 "Rejected": what this slice touches and what it does not

| Rejected item | Touched? |
| --- | --- |
| "generic JSON rows and store-maintained index entries" | no: column sets name real columns of real tables |
| "op-rewriting projections and a view algebra" | no: a read re-runs and diffs its rows; `exists` and one inner join by key are parts of one statement |
| "plugins' own databases holding source data"; "optimistic transactions"; no transactions across owners (§9) | no: a join reads another owner's rows inside one commit step and writes nothing |
| "a factory trial", "a consumer contract check during staging" | no: staging still only records |
| "principal field patterns and re-stamping for revocation" | no |
| "count limits that refuse calls or holds" | no: a bound limits what a run returns, a page past `max` is cut and continued; neither refuses |
| "relays … id renumbering at relays" | no: a denial and a later allow are fenced by `ping` and `pong` |
| "object restart for state changes" | **yes, narrowly:** an admitted object restarts when its admitted value changes. The value is the caller's standing, kept small by rule. To be added to §31's wording as the one exception |
| "a stream type in Chord" | no: a list is a state member whose value is its pages joined |

To add to §31: a left join; a condition between two tables other than equality to a key or a declared index; a
query language or a condition sent by a client over a link; reading a registry inside a query builder; raw SQL in
any plugin-facing API, and `RETURNING` or other SQL-specific calls in the store's backend interface; totals inside
a page; a cap on a count; column-set versions; a value copied into another table to order or filter a list by; a
substring filter in a query (filtering as you type is the search plugin's).

## 3. The text changes, section by section

**§2 Concepts.** Replace the `live query` row and add:

| Concept | What it is |
| --- | --- |
| named query | a query a store offers, its argument schema in the contract (`queries`, `self.queries`, section 11) |
| live query | rows kept current by commits: the owner's own window (`self.query`), or a named query read by any object on the store's host (`self.liveQuery`) (section 11) |
| list | one or several named queries of one order, merged, that a screen loads more of: pages between fixed bookmarks, tiled (`self.list`, section 11) |
| probe | one keyed statement by which a commit asks whether a written row can be in a read, before re-running it (section 10) |
| column set | the columns of a table its contract declares for other plugins' conditions and joins (`defineColumns`, section 10) |
| admission | a remote type's, or a route's, decision before anything is built or started: a typed value for the factory, or a denial (sections 3, 6) |

**§3 Hosts and links.**

- "Routes": the signature gains `admit?(principal, address, self): Watchable<Admission<null>>`. Add `slice-14.md`
  §2.3 as "**A route's admission**", including: it reads only contracts the app's API owns; `RouteHandle.retry`
  resolves nothing while every hold of the address is denied or undecided.
- "Relays": add "A hold released by a route's denial is forwarded again, under its id, only after the `pong` of a
  `ping` sent on the allow: every reply of the released hold has arrived and was dropped by then. This relies on
  `resolve` returning the link to the final provider of the address".
- §23 "Workers": `createWorkers(…, { admit })` passes a route admission through.

**§5 Object types.**

- Row "factory": `remote` becomes "`(params, principal, self)`, or `(params, principal, admitted, self)` for a type
  with an admission".
- After "Keyed state members": "**Named queries** (slice 14; `local` contracts only): `members: { sessions:
  queries(SessionRow, { visible: argsSchema, one: argsSchema }) }`, the argument schemas part of the fingerprint; the
  provider returns the handle of `self.queries(table, { map, reads }, { name: builder })`. A consumer on
  the same host declares `self.liveQuery(ref.sessions.one, args, { first })`, `self.count(…)` or `self.list(…)` in
  its factory, or calls `ref.sessions.visible.page(args, n, ctx, { after })` anywhere. A query the handle has and
  the contract does not list is private to its owner and brings its schema (`name: [argsSchema, builder]`). A `queries` member
  cannot be re-exposed. Across links a list is an ordinary remote object, one per screen."
- After "Variants": "**Admission** (slice 14): a remote contract may declare `admission: schema`, the JSON value
  its factory is handed about a caller. It selects the variant and the members; it is not part of the fingerprint
  and is never validated at runtime. `local` types have none."

**§6 Objects.**

- The lifecycle drawing gains `admitting` before `activating`, and `failed (denied)`.
- "Activation": prepend "an attempt of an admitted type first runs its `admit` (below);"; and "derives that compute
  the arguments of a live query are evaluated while the attempt is parked, once their inputs have values".
- "Parked on its dependencies", the table: add "one denied | `denied` with that error: it stays parked and goes on
  when the dependency is admitted"; a denial is checked before the `forbidden` row. Add "a live query's first run
  failed | `failed { waiting }`, woken by its next good run".
- The failure cause union gains `| { kind: "denied"; error: ChordError }   // its admission, a dependency's or a
  route's refused the caller: no backoff, woken by the decision`.
- Add the subsection "**Admission**" with `slice-14.md` §2.1, §2.2 and §2.5 as written, including "Data already
  delivered to application code is not retracted" and the two accepted limits of 2.2.
- "The factory principle": "… what must be read about the caller before it runs is the admission's"; "`self.job` is
  not declared in an admitted type's factory".

**§7 References.**

- The getters paragraph: "only `failed { broken }` and `failed { denied }` reject at once".
- The situations table gains "denied | reject at once with `forbidden` | none: reference members and replicas hold
  no value; what application code already has stays with it".
- Replace the bullet "Authority checks …" (line 1038) with: "**Authority** is decided before the factory by the
  type's admission where it depends on data, in the factory where the principal alone decides, in a method where
  it depends on the call's arguments, and by a route's `authorize` and admission before a host is reached."

**§9 Documents.**

- "Keyed" (line 1108): "No live key list: keyed documents are read by key. A collection shown live is a table with
  a named query, read as a list (section 11); a small one may still be a singleton."
- "Rules across owners" (line 1273): append "A plugin's contract may declare a column set of a table (section 10);
  another plugin's condition or join may read those columns, in queries only."

**§10 Store and storage.** After "`host(Kind)` columns" add:

- "**Column sets** (slice 14): `defineColumns(name, { columns, key, indexes? })` in a contract file names the
  scalar columns of a table others may use, its key, and the indexes others may match by. The table spreads
  `...Set.columns` into its columns and declares `exposes: Set`; `defineTable` checks both at declaration, and two
  tables exposing one name is a declaration error. No versions: the columns a read uses are checked by name and
  type when it opens. The store's binding of the name to a table follows the committed code. While a bound table
  is not ready (not created yet, or migrating), other owners' reads over it are not run and keep their rows; when it is ready they are revalidated,
  recompiled and run once."
- "**`exists` and `join`** (slice 14): `exists(Set, { setColumn: column, … }, (t) => condition)` is true for a row
  when the set's table has a row equal in the matched columns that satisfies the condition; `existsNode(Set, match,
  node)` takes the condition as data. A `NULL` in a matched column matches nothing.
  `query(Table).join(Set, (row) => ({ keyColumn: row.column, … }))` pairs each row with the one row of that key, as
  an inner join driven from the query's own table; the partner's columns may be compared, ordered by and handed to
  the mapping. **Two tables are matched only by equality to the set's key or to one of its declared indexes** (a
  leading prefix for `exists`, the whole key for `join`). `updateWhere`, `deleteWhere` and reads inside a
  transaction take neither."
- "**Conditions as data** (slice 14): `compile(Set, condition)` gives a condition as plain data; a builder takes one
  with `query(Table).whereNode(Set, node)`, for the query's own set or a joined one, which validates the whole node
  before anything is rendered. Conditions are built by server code, never taken from a client. There is no
  substring filter."
- "**`through`** is the inclusive upper bound that mirrors `after`; a page of a list is every row between two such
  cursors."
- "Live queries in the commit step" (line 1339): replace its first sentence by "a transaction that writes a table
  some live query reads (as its own table, a joined one or an `exists` one, whoever owns the read) re-runs, in its
  commit step, the reads chosen there that the skip test cannot rule out (`slice-14.md` §3.3)"; append "The test
  uses the written keys and assigned columns. Where they do not decide, one keyed probe (the read's own
  statement, limited to the rows the written row pairs with) does; there is no second evaluator. A skip holds for the row before
  the write and after it; where the value before is unknown and matters, the read re-runs. The store's backend
  interface gains nothing SQL-specific."
- "Data belonging to a host": "`deleteHostData(address, ctx, { plugin? })`: with `plugin`, only that plugin's tables
  and documents"; "live queries re-run" becomes "every live query over a table with a host column of the kind
  re-runs, `exists` and joined tables included".

**§11 Kinds of state.** Replace the `live query` row by:

| Kind | For | API |
| --- | --- | --- |
| live query (own) | the owner's own bounded window | `self.query(table, q, limit)` |
| named query | a store's records as others read them | `queries(...)`, `self.queries` |
| live query (named) | the first `n` rows of a named query, live | `self.liveQuery(namedQuery, args, { first })` |
| count | the exact number of rows of a named query: every matching row read on each re-run | `self.count(namedQuery, args)` |
| list | named queries a screen loads more of | `self.list(name, [[namedQuery, args], …], { first })` |

Keep the paragraph "**Live queries**" for `self.query`, with "only the object's own tables … the query is fixed for
the attempt" reworded to "its own unnamed read; other objects read named queries", and "run … in the commit step of
every commit of the object whose staged writes touch that table" replaced by the commit-step rule above. Add
`slice-14.md` §3.1 to §3.3 as "**Named queries**" and §4 as "**Lists**". The cost sentence becomes: "A bound limits
the rows a run returns; what it reads depends on the index its order and condition can use, and every run blocks
its host (the store's backend is synchronous). **There may be dragons** for a table written hundreds of times a
second with many live queries the skip test cannot skip."

**§15 Jobs.** Add: "A job is not declared in an admitted object (slice 14). Work for a person lives in a `local`
store, carries the person in its arguments, and asks the person's access again on every run."

**§16 The facet.** `host.serve(Type, factory, { linger?, accepts?, admit? })`.

**§19 Presence.** Add: "A holder of an admitted object is listed from its first allow until a denial or its end."

**§21 Reload and rollout.**

- "Staging": add "the new `admit` of an admitted type; its factory is rehearsed with the object's current value
  when the old and new `admission` fingerprints are equal, else not at all: an unrehearsed factory's declaration
  errors appear at its activation and its requests are outside the closure rule"; "a recording `self` makes no
  column-set binding and touches no list's bookmarks"; "a column set is checked when a read opens, not by the
  closure rule".
- "Fates": a restarted provider of named queries: "its readers do not restart; their reads leave the old attempt when the
  commits admitted before its seal have settled, rebind to the successor by member and query name and give one
  frame"; a list: "its bookmarks are an in-memory document found by the
  list's name; its pages open again and switch in one frame; bookmarks of another order start the list again"; a
  restarted owner of a table with `exposes`: "the binding follows the commit and holds no attempt's handle; while
  the table is not ready (not created yet, or migrating), other owners' reads over it are held, and a failed migration fails them
  `unavailable` until the table is ready"; "a route's admission takes no fate: its references follow the reference
  rules, and a new link of the route forwards a hold only under its current decision".
- The table "What a user sees during a reload" gains: "code that serves an admission source | nothing while the
  source only reloads (the last decision is kept); a successor that fails or parks, or a contract the readers'
  version does not fit, seals the objects that read it until it heals | rejected `unavailable` on a seal |
  unchanged". And to "Rollout across hosts": "admission sources `accept` their previous version".

**§22 Wire.** The `failed` row: "`kind`: `transient`, `broken`, `waiting` or `denied` (slice 14)". Add: "A consumer
that receives `failed { denied }` drops the hold's replicas." and "**Bindings are fenced per acknowledgement**
(slice 14): a hold keeps one `{ names, until }` per unacknowledged `bound` and decodes a call by the newest
acknowledged one."

**§27 Versions and adapters.** In the table: "column set | none | checked by column name and type when a read
opens, and again after its table migrated"; "admission | none on the wire | `evolve`'s `admission(schema)`; staging
compares its fingerprint". A contract with a `queries` member versions as any contract; edits and `accepts` for
named queries are carry-over.

**§29 Telemetry.** `chord.query.skips` and `chord.query.probes` beside `chord.query.runs`; `chord.query.rows` (rows returned to Chord: output,
not what the backend scanned); an admission's decision is an event of its attempt's activation span
(`chord.admit { outcome }`), a route's of its `chord.relay` span.

**§30 Cost model.** Add the rows of `slice-14.md` §7.

**§26 Decisions needed.** None from this slice: its open points were decided in review (the join stays; a list's
re-hold sends what it loaded; the old `self.query` stays over the new mechanism; the two reload limits of
admission are accepted; no mirrored values, a probe instead; counts exist, marked expensive; a fence, not a new
id, after a route's denial).
