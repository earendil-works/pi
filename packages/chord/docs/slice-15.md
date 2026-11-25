# Slice 15: grantable members and flags, denials with a message, the commit index, stale holders, lazy queries

Status: first version (2026-11-25), written from the drafts of 2026-11-24 (`/tmp/primitives/issues/01` to `06`,
`/tmp/primitives/chord.md`, decisions of 2026-11-24 items 1 to 5) and built in the same night on branch `chord-core`
(from main). Points the drafts left open are decided here by the builder and marked **(B)**: the owner reviews them.
Every decision is folded into `design.md` (§5, §6, §7, §22, §23, §10) and listed in `decisions.md` ("Slice 15").

**Read first, in full:** `design.md` (all), `slices.md`, the root `AGENTS.md` section "Chord v2 Code Style"; the
source: `src/contracts/{declare,contract,history,evolve,accepts,fingerprint,schema}.ts`, `src/host/{admission,attempt,
members,object,reference,reference-source,reference-events,adapted,staging,named-query}.ts`, `src/remote/{hold,provider,
remote-object,replica}.ts`, `src/link/{message,binary,text}.ts`, `src/react/hooks.ts`, `src/tui/scope.ts`,
`src/store/{reads,read,skip,read-plan}.ts`, `src/host/host.ts` (the heartbeat), `src/link/channel.ts`.

**Done when** every test of §7 passes, Chord's suite, `npm run check`, apps/p3's and apps/p2's checks and suites pass
with no variant left (`grep -rn variant packages/chord/src apps/p3 apps/p2` finds history notes only), and the
benchmarks of §6 are recorded in `benchmarks.md` before and after.

## 1. Grantable members and flags replace variants

**The problem.** A remote contract lists variants, one whole shape per audience; admission or the factory picks one.
Every combination of rights needs a variant (draw × moderate: four), code tests a variant's name instead of the right
it needs, and a right that is no call on the object (may this agent export?) has no place.

**The rule.** One shape for everyone. A member marked `grantable(...)` exists for a caller only if its admission
granted it; a plain member is there for every admitted caller. **Flags** are rights that are no member. A name is a
member or a flag, never both (the types refuse it, and the declaration).

```ts
export const Canvas = remote("canvas.board", {
	version: 1,
	params: { canvas: str() },
	hostAddress: () => Server(),
	state: { shapes: arr(ShapeRow), history: grantable(arr(Change)) },
	events: { motion: Motion, reported: grantable(obj({ shape: str(), by: str() })) },
	methods: { point: method(Point), add: grantable(method(obj({ shapes: arr(Shape) }), arr(str()))), clear: grantable(method()) },
	flags: { export: "Export as image" },
});
type Names = GrantableName<typeof Canvas>; // "history" | "reported" | "add" | "clear" | "export"
```

### 1.1 Contracts

- `remote(name, { version, params, hostAddress, admission?, state?, events?, methods?, flags? })`. `variants` is gone.
  `grantable(schema)` in `state` and `events`, `grantable(method(...))` in `methods`; `flags: { name: label }`, the
  label an English text for the access UI (not a message: flags are declared by code, the UI renders it as given) **(B)**.
- `local(...)` is unchanged: a local object has no audiences; `grantable` there is a declaration error.
- `granted` is reserved (a reference has it) and `variant` no longer is. Flag names follow member names' rules.
- **The fingerprint** covers the members, which of them are grantable, and the flag names, never the labels:
  `{ kind: "remote", params, members, grantable, flags }` with the two lists sorted. `NORMAL_FORM_VERSION` stays 2
  **(B)**: documents' stored fingerprints carry it (a bump would refuse every stored document), and the remote node's
  new shape changes remote fingerprints by itself. Contract versions are not bumped for the change: every remote
  fingerprint changes, so an old consumer meets `contract_mismatch` and reloads once.
- **Old releases are refused, not accepted (B):** versions declared with variants cannot be declared any more, and
  their fingerprints differ, so an app's `accepts` for them (p2 binds 11 such older versions) is dropped. An old
  page, terminal client or worker is refused `contract_mismatch` on its first hold and takes the app's stale-client
  path (p2: the page reloads, a terminal client says to update, a worker is replaced by the rollout).
- **`evolve`**: the remote editor is the local one without keyed members (no variant argument): `state(member, s)`,
  `addState`, `removeState`, `addMethod`, `args`, `result`, `method`, `removeMethod`, `event`, `addEvent`,
  `removeEvent`, `admission`. An `add…` edit takes `grantable(...)` for a new grantable member. **Whether a member is
  grantable, and the flags, never change across a history (B)**: an older consumer's reference type says which members
  are always there, and a member that became grantable would vanish under it; a change of either is a new base.
- **`accepts`** for a remote contract is flat, as a local one's: `state: { member: mapping }`, `events`, `methods`.

### 1.2 Admission hands the factory `granted`

- A contract with grantable members or flags is served with `admit`, as one that declares an `admission` (staging and
  `serve` refuse it otherwise). Its admission's value is an object: `allow({ granted: [...], ...data })`, `granted`
  typed `readonly GrantableName<C>[]` and optional (none granted), `data` the fields the contract's `admission` schema
  declares. A declared `admission` schema is therefore an `obj(...)` without a field `granted` **(B)**.
- Chord sorts and dedupes `granted` before comparing (canonical JSON as before): the same names in another order are
  the same decision, no rebuild.
- A name in `granted` that is no grantable member or flag of the contract (a plain member too: **a plain member is
  never granted**, the drafts' lean, decided) breaks the attempt: `broken`, the error naming the contract and the
  name, reported as `activation_failed` once. No silent drop.
- The factory gets the admitted value with `granted` as a `ReadonlySet<GrantableName<C>>`:
  `(params, principal, admitted, self)`; a contract with neither `admission` nor grantables keeps
  `(params, principal, self)`.

### 1.3 The factory and the attempt

- The factory returns every member. A grantable state or event member is a **builder** `() => watchable` (`() =>
  EventMember`), called right after the factory returns, with declarations still open (it may `self.derive`,
  `self.liveQuery`, `self.get`), and only if granted. A grantable method is a function, exposed only if granted.
- A member nobody was granted is never built, never checked beyond "a function", never sent.
- The member check runs against the granted shape: the plain members and the granted ones.
- A call to a grantable method not granted fails `forbidden` (message `… has not granted "add"`), never
  `invalid/member`: the member exists. Over a link it can only arrive across a rebinding (the fence decodes it by the
  old names).
- **A factory wires a dependency's grantable members (B):** a `self.get` reference is unbound while the factory runs;
  until a reference was first live it has every grantable member (below), so a derive over one, or its re-exposure as
  a builder `() => ref.history!`, is declared as for any member; once the dependency binds without the grant, the
  member fails `forbidden` (reads throw, watches get one `failed` call).

### 1.4 References

```ts
type Reference<C> = PlainMembers<C> & { readonly [M in Grantable]?: Member<M> } & {
	readonly granted: ReadonlySet<GrantableName<C>>;
	readonly state: NativeWatchable<RefState>; retry(): void; release(): void;
};
```

- Plain members always; a grantable member is the member while the reference's binding granted it, else `undefined`;
  until the reference was first live, every grantable member is there **(B)** (a factory's `self.get`, a `host.hold`
  before it binds: calls park, the binding decides, `forbidden` without the grant); `granted` is the set of names the
  binding was given (members and flags). Each member keeps its identity across bindings (the same object when granted
  again).
- `granted` is empty before the first binding and while denied; while loading or failed it is the last binding's (the
  members keep their last values, as before).
- `Held<C>` and `RefIn<C, V>` are gone: `host.hold` returns `Reference<C>`. `ref.variant` is gone.
- Over a link the `bound` message carries `granted` (indexes into the hold version's sorted list of grantable member
  names and flags) in place of the variant; member indexes point into the granted shape's sorted names as they pointed
  into a variant's. Only granted state members are snapshotted and followed; only granted events are tapped.
- **When the decision changes** (the mechanics of a variant change, unchanged): an equal value does nothing; another
  allowed value seals the object (calls in flight `unavailable`) and rebuilds it with the new `granted`; the reference
  rebinds on the same hold, `granted` and the members changing in one batch (the new members' first values land in
  the same `bound`); a denial ends in `failed { denied }`, no value kept, calls `forbidden`; allowed again, it comes
  back with no new hold.

### 1.5 UI bindings

- `useLive(ref)` (`chord/react`, the drafts' name, decided): `ref` while it is live, and while it loads again after
  having been live (a rebind, a link drop: the tools stay up, calls park) **(B: also across a link drop)**; else
  `undefined` (no reference, its first load, failed, denied, ended). Re-renders when that changes and when `granted`
  changes (the snapshot is the reference's `granted` set, a new set per binding that changes it).
- `useWatch(undefined)` and `useEvents(undefined, …)` do nothing (built already).
- `TuiScope.live(ref)` returns the same reader for the terminal client (`() => ref | undefined`), following the
  reference's state until `dispose`.
- `useVariant`, `TuiScope.variant`, `VariantRef`, `VariantOf`, `InVariant` are removed.

## 2. `deny(reason, message?)`

- `deny(reason, message?)`: `reason` English, for logs and the error's message; `message` a message as data
  (`{ namespace, key, params }`, `MessageData`), what the person sees, rendered by their client. `MessageData` and
  `MessageSchema` move from `surfaces` to `data` (both re-exported where they were): the kernel names them now.
- The denied object shows `failed { denied }` with `forbidden(reason, { message })`; a call on it fails `forbidden`
  with the same `details.message`; `forbidden/revoked` for calls running at the seal carries it too.
- A denial whose message changed is a new decision: the holder sees the new failure, nothing is rebuilt, no new hold.
- A message that is not a valid `MessageData` (checked against `MessageSchema`: an admission is plugin code) breaks
  the attempt like a value that is no decision, reported once.
- **The message travels as the error's `details.message` (B):** no new field in a failure or on the wire; `details`
  crosses links already, and a failure's cause compares its details (`sameCause`), so a changed message wakes the
  holders. No size limit beyond what `MessageSchema` says (none): a message is a key and a few parameters.

## 3. The commit index for live reads

**The problem.** After a commit, Chord tests every open read of every written table against every written row
(`store/reads.ts`, `#refresh`). Bench round 1: 0.3 µs per (read, row), a commit of 3,549 rows with 4,020 reads blocked
4 s; a session state change skip-tested about 20,000 reads of other sessions.

**The rule.** A pure speedup: a commit tests a read only if a written row could be in its result before or after the
write; every candidate still goes through `skips()` as today. Per table, an index (`store/read-index.ts`, used only by
`reads.ts`) keeps:

1. **Equality buckets:** a read whose bound plan has, on this table, `column = value` conditions on a set of columns
   is filed under `(columns, values)`; `in (…)` up to 32 values files it once per value combination **(B: 32 total
   combinations)**; above, unindexed.
2. **Kept keys:** the keys of the rows of its last result (the skip test's rows before the write), mapped to the reads
   holding them.

A read with no equality condition on the table (or a join side without one, or over the limit) is unindexed there and
always a candidate. Candidates of a keyed change: the reads holding its key ∪ the reads whose bucket matches the row
after the write ∪ the unindexed reads; a `bulk` change (no key) makes every read of the table a candidate. The probe
limit (`PROBES_PER_READ`, 8) counts a read's candidate rows, not every written row. A read re-files itself when it
re-runs (its arguments or its kept keys changed).

- **Differential test:** ~~both paths in one process over the same commits (a test-only switch on the store's reads,
  `everyRead`)~~ **(B, changed in the build):** no switch (the code style has no test modes); the check is the skip
  test's oracle (slice 14): after every commit every read equals a fresh run of its statement, which is what both
  paths must give. "Every read the old path re-ran is a candidate" does not hold literally: the old path ran a read
  whose probe limit ran out on rows that could not concern it; results are equal; generated tables, reads (equality, `in`, range, none, joins, watchable arguments) and commits
  (`put`, `update`, `delete`, `bulk`, 1 to 5,000 rows) over a fixed seed list; a mutation check (an index that skips
  one bucket lookup fails it).

## 4. Holders left silently stale after a long-blocked commit

Reproduce first (a host with `heartbeat: { ping: 50, close: 100 }`, holders over real links, the server's loop
blocked 300 ms inside a commit step, then a change every holder must see); then fix what the reproduction shows.
The invariant, tested: after any stall every hold either has the provider's current value or is not live (`loading`,
or `failed` with a reason). **A blocked host keeps its links (the drafts' lean, decided):** a heartbeat timer that
fired late by more than `ping` measures nothing, so the stall is never counted as the peer's silence. Every link the
heartbeat closes is reported once through `onError` (`link_closed { reason: "heartbeat" }`) and counted in
`chord.links.closed` with a `reason` attribute. The fix itself is recorded in §8 once found.

## 5. A reference builds its named queries on first use

Today every `Binding` builds one `ReferenceQuery` per name of every `queries` member of its contract, each with a label
string, in its constructor (bench round 2: 8.6 KiB per reference to a store with 23 named queries; the label is read
only on error paths). Now a `queries` member of a reference is an object whose named queries are made on first access
and kept by it; `ReferenceQuery.label` is built when asked. A heap test: a reference to a contract of 23 named queries,
none read, keeps no `ReferenceQuery`.

## 6. Benchmarks

Before and after on the same machine, recorded in `benchmarks.md` ("Slice 15"): `links`, `shared-holds`, `events`,
`live-query`, `slice-14`, `calls`, `derives`, `state-binding`, `store`; new: `test/bench/commit-index.ts` (one write
to one session's row with 10,000 open reads of other sessions: candidates, skips, probes, runs, ms) and the heap of a
store reference (§5).

## 7. Tests

1. Contracts: a grantable state, event, method and a flag declare; a name both member and flag fails (types and
   runtime); `GrantableName` lists exactly the grantable members and flags (type tests); the fingerprint changes with
   grantability and flag names, not labels; `grantable` in a local contract fails; `evolve` adds grantable members.
2. A caller granted nothing gets the plain members only; nothing of the others crosses the link (asserted on the wire).
3. A builder of a member nobody was granted is never called (a counter stays 0).
4. A call to a grantable method not granted fails `forbidden`, locally and over a link.
5. `granted` naming something the contract lacks, or a plain member: the attempt breaks, the error names the contract
   and the name.
6. The same names in another order cause no rebuild.
7. Types: a grantable method is optional on the reference; a plain one needs no check.
8. A page (React) holding a canvas: granted `add` appears and vanishes on the same hold; no remount; no render shows
   `granted.has("history")` with `history`'s value undefined; `useLive` keeps the old reference while the rebind loads;
   deny then allow: `undefined`, then back, with no new `useHold`.
9. A call in flight across a rebind fails `unavailable`; the same call on the rebound reference succeeds.
10. GC: a released hold frees its granted members' watches; the grant cache holds no contract.
11. `deny` with a message: the holder's failure carries both; without one, none; a call on the denied object carries
    it; a changed message is a new failure without a rebuild; an invalid message breaks once.
12. The commit index: the differential test with its mutation check; the store suite unchanged; a write to one
    session's row with 10,000 open reads of other sessions tests none of them; a closed read leaves no entry.
13. The stall: the reproduction fails before the fix and passes after (0 holders live with an old value); a stall
    shorter than `close` closes nothing; the metric and `onError` per closed link. **(B, the build):** the
    reproduction passed before any change (§8), and "shorter than `close`" is "shorter than `close − ping`": a link
    may have been quiet for up to `ping` when the stall began.
14. Lazy queries: the heap test of §5; a named query read through a reference after first use works as before.

Examples: `77-grantable.ts` (the canvas: plain, grantable state, event, method, a flag, a rebind on a role change)
and `78-denial-messages.ts`.

## 8. What the build found

- **§4, the stale holders: no holder was live with an old value.** The reproduction (`test/link/channel.test.ts`, "a
  stall of the server": a forked server with `heartbeat { ping: 50, close: 100 }`, 5 client hosts with 10 holders each
  over socket links, the server's loop blocked 300 ms, a change in the same turn) passed before any change: the
  server's own late tick already counted the stall as no silence and closed nothing (decision "A pause of the process
  is no silence"); each client, which did run, found the server silent past `close` and closed its link, and its
  holders went `loading` and stayed there. A new link brings every holder back with the current value. Bench round 1's
  "stale" holders are this: two commits of about 24.7 s ran back to back with no I/O between them, so the server was
  silent 49 s, past the clients' 30 s `close`; the bench's load process connects with `host.connect` and never
  reconnects, and its holders watched values, not `ref.state`, so they kept their last values while `loading`; and
  nothing was reported. **The fix is the report:** the channel knows why a link closed (`LinkCloseReason`), the host
  counts every close in `chord.links.closed { reason }` and reports a heartbeat close once through `onError`
  (`link_closed { reason: "heartbeat", role }`). Reconnecting is the app's (a page's connection does; p2's does).
- **§4, a stall shorter than `close` can close a link:** the peer's silence includes the quiet time before the stall
  (up to `ping`, when the last ping was answered), so only a stall shorter than `close − ping` is sure to close
  nothing (tested with `close` 600 and a stall of 300 ms). Not changed: `close` keeps its meaning (silence, the
  handshake included).
- **§3, no `everyRead` switch:** the differential check is the skip test's oracle (every read equal to a fresh run
  after every commit), shared with `skip.test.ts` (`test/store/read-world.ts`), over commits of 1 to 5,000 writes, with
  a mutation check (an index without its bucket lookups leaves reads stale). The old path also ran reads whose probe
  limit ran out on rows that could not concern them; the index does not (`skip.test.ts`' cost case now writes rows of
  the read's bucket).
- **§2:** a denial's message travels as the `forbidden` error's `details.message` (no new field in a failure or on the
  wire); `sameCause` compares details, so a changed message reaches the holders.
