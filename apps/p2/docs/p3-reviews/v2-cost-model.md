# Chord v2: the cost model of the state path (before / after)

Sources: Fable's and Astra's measurements on committed HEAD `c990f587f` (500 KB chat-like value, one small change,
Node 24 on slayer), Durable's store and view (`packages/durable/src/session/transaction.ts`, `harness/view.ts`) and
Chord Delta (`packages/chord/src/delta/README.md`). "After" is the target; nothing here is built yet.

**Goal:** as little compute and memory as possible while staying correct. Delta was built for exactly this:
immutable revisions with structural sharing, exact ops, appliers that share containers. Its own primitives are
practically free (`diffRevisions` on shared subtrees 0.018 ms, `applyImmutable` per small change 0.004 ms). Almost
all measured cost comes from layers the v2 kernel added around it.

**Headline now:** one small change to a 500 KB value costs 35 ms with no viewer, 13 ms more per viewer (10 viewers:
130 ms); with SQLite 89 ms with no viewer. **Target:** O(size of the change) per commit and per viewer, independent of
the value's size; 500 KB is touched only when a new viewer takes its first snapshot.

---

## 1. Commit

**Before** (`documents/owner.ts:614-622`):
```ts
// per commit, per touched document
assertDocumentValue(value);                       // isJsonValue walk of the whole document: ~2 ms
assertValid("document", name, schema, value);      // schema check of the whole document: 6.7-8.5 ms
if (dev) freezeValue(value);                       // whole-document freeze: 1.7-2.6 ms
```
**After** (as Durable): Delta's `prepare()` already copied and checked the placed values (only the new data); the
commit adopts by pointer swap. No walk, no schema check, no freeze. The schema is checked by fingerprint (D9), once
per access, O(1).

| | Before | After |
| --- | --- | --- |
| one appended note to a 500 KB document | ~10-14 ms | O(new note), microseconds |

## 2. Reads in a transaction

**Before:** every access validates the whole document (`documents/owner.ts:160`, 6.7-8.5 ms, also for a read-only
transaction: 14.9 ms); `tx.get` after `tx.draft` copies the whole draft (`owner.ts:554`, 6.5 ms).

**After** (as Durable): only `tx.draft`; reading is drafting (Delta's overlay, no copy); an unchanged draft writes
nothing, also for an absent document (it is not created). Fingerprint check, O(1).

```ts
// before
const n = await tx.get(notes, id);      // copy if a draft is open, plus validation
// after
const n = await tx.draft(notes, id);    // the overlay; read it, change it or not; unchanged = no write
```

## 3. Storage

**Before** (`storage/sqlite/storage.ts:61-200`): every commit loads the base, replays every delta since it,
validates after each replay, builds a temporary `MemoryDocumentStorage` (copy, validate, freeze), and copies its
snapshot. Same tiny commit with 0 / 10 / 50 earlier deltas: **17 / 33 / 101 ms** (grows with history). The memory
storage copies every write and validates and freezes the whole resulting document (~3.5-5 ms). JSONL inherits that.

**After** (as Durable): the storage checks metadata only (incarnation, version, sequence, address) and writes the
delta row (or a base when the document's `checkpointWhen` says so). Replay only when loading, once. The memory
storage keeps values by reference (immutable by convention) and stores ops; no copy, no freeze.

| | Before | After |
| --- | --- | --- |
| tiny commit, SQLite, 50 earlier deltas | 101 ms | one INSERT of a small JSON row |
| tiny commit, memory | 3.5-5 ms | O(change) |

## 4. Publishing to subscribers on the same host

**Before:** the provider validates every exposed member on every change, per binding (`object.ts:360,570,576`,
6.7-8.5 ms each); per-principal views multiply that.

**After** (as `replicatedState`, which Durable uses): subscribers get the same value and ops by reference. No
validation, no copy.

## 5. Derives

**Before:** every recompute walks its result (`derive.ts:115`, `isValue`, 1.7-2.4 ms), then `diffValues` walks both
values (`isJsonValue` twice, 3.5 ms) before `diffRevisions`; with any byte leaf it falls back to `deepEqual` via
`canonicalJson`, recursively (10.6 ms instead of 3.2).

**After:** no walks; `diffRevisions` directly (structural, identity short-circuit; bytes are atomic leaves; equality
never by stringify). Rule for authors: derives reuse structure (memoize per element), so a recompute is pointer work:

```ts
// before: 2,000 new objects per commit, nothing shared, a full diff
self.derive("public", [notes], ([n]) => ({ list: n.list.map(({ by, ...rest }) => rest) }));

// after: 2,000 identical references plus one new one; diffRevisions emits exactly one insert
const redacted = new WeakMap<Note, PublicNote>();
self.derive("public", [notes], ([n]) => ({ list: n.list.map((x) => redacted.get(x) ?? memo(redacted, x, strip(x))) }));

// better still: model the data so no derive is needed (a document without the private field)
```

Large combined views (several documents plus entries, as Durable's `ConversationView`) are maintained by re-pathing the
sources' ops (`harness/view.ts:220-244`), never by recomputing; ops are never interpreted by application code.

## 6. Encoding and sending

**Before:** a state frame is planned and stringified twice per send (size check, then send) and four times when
queued; memory links stringify every frame to size it; snapshots are deep-cloned per viewer (`connection.ts:618,666,
894`, 1.2 ms each).

**After:** encode once per frame (Delta's `encoder()` per stream), take the size from the encoded bytes, keep it with
the queued frame. No clone of snapshots (immutable by convention; the transport serializes anyway).

| | Before | After |
| --- | --- | --- |
| 500 KB snapshot to one viewer | ~2 x 2 ms encode + 1.2 ms clone | ~2 ms encode, once |
| one small change to one viewer | dominated by validation (~13 ms) | microseconds |

## 7. Relays

**Before:** the server decodes and walks relayed frames like its own.

**After:** the relay reads the frame header (hold id, kind, route) and forwards the body opaquely; no decode, no walk,
no re-encode.

## 8. Receiving

**Before:** every received frame is walked fully (`isFrame` / `isValue`): five times on WebSocket (ping check, pong
check, `bye` check, decode, `#receive`), twice on IPC/memory; also for trusted server-worker frames. A 1 MiB byte leaf
costs 85 ms per check (`Reflect.ownKeys` enumerates every index).

**After:** `JSON.parse` already yields strict JSON, so no JSON-ness walk; frames are checked once by their header;
bytes are recognized in O(1) (type and prototype). Method arguments (and hold inputs) whose caller is not a host
principal are validated once, at the provider, with the provider's schema, also when relayed over trusted IPC;
schemas are compiled once and cached (TypeBox interpreted 5.6 ms vs. compiled 0.012 ms per check).

## 9. Applying at the consumer

**Before:** after applying, the consumer validates the whole value per change (`remote.ts:228,282`).

**After:** `decoder()` then `applyImmutable(replica, ops)`: a new revision sharing structure with the old; listeners
get it. No validation, no clone. 0.004 ms per small change.

## 10. Calls

**Before:** arguments: consumer strip, provider strip, validation, clone; results: validation at the provider and the
consumer, clone (full-value echo: 15.4 ms same host, 36.7 ms over memory links); the validation schema is rebuilt on
every check; every hold sends the full contract description, which is parsed and hashed (51 KB contract: 3.6 ms plus
frame walks).

**After:** arguments validated once at the provider when the caller is not a host principal (compiled schema); results
not validated in production; same-host calls pass values by reference (immutable by convention, as `local`), to be
decided; a hold sends the contract fingerprint and the provider fetches the description once per (link, fingerprint).

## 11. Memory

**Before:** per-principal views each hold their own derived copies; frames and snapshots are cloned per viewer; the
memory storage holds copied and frozen rows.

**After:** one authoritative value per document per host (the tracker); consumer replicas share structure with each
other; derived values share structure with their sources; views of the same variant use one value from the core;
extra copies only for adapted bindings (one cached value per binding).

---

## Decisions this needs

1. The model as a whole: Delta/`replicatedState` end to end (shared immutable values, ops passed through, opaque
   relays, one validation at untrusted ingress).
2. The store as a port of Durable's store design.
3. Only `tx.draft` (no `tx.get`); unchanged drafts write nothing, also for absent documents.
4. Derives reuse structure (documented rule); large combined views re-path ops; no op-rewriting `project`.
5. Same-host remote calls without a copy (immutable by convention), or keep the copy.
6. Argument validation at the provider by the caller's trust, with compiled, cached schemas.
7. Contract descriptions once per (link, fingerprint).
