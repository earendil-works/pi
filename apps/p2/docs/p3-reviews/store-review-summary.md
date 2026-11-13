# Store proposal review (Fable, Astra), 2026-10-21: summary for the owner

Source: `store-proposal.md` at `931df40ea`. Both: direction right; disk, outbox and export order are the seq order by
construction (one serial commit step, rows plus outbox record in one backend transaction). The remaining "seq 40 after
seq 50" cases are outside the backend. Astra's invariant: **each published head denotes one complete committed prefix,
not merely the largest seq somebody has seen.** Nothing below is decided; one at a time.

| # | Sev. | Finding | Proposed fix | Source |
| --- | --- | --- | --- | --- |
| S1 (decided 2026-10-21: `Storage.commit(writes, adopt, context)`, log "S1") | high | In-memory adoption after the step: A commits 40, B commits 41, B's continuation adopts first; a routine on 41 reads A at 38/39 (Durable adopts after `await storage.commit`, `session.ts:750-765`) | `store.commit(prepare, adopt)`: synchronous adoption inside the step before the next starts; listeners after; needs a small Durable Session integration (the `Storage.commit` signature alone cannot give it) | both |
| S2 (decided 2026-10-21: covered by the existing transaction rule, one sentence in the guide) | high | Forward references across owners: a row at 40 references entry 812 created at 50; a valid prefix (40) dangles, and the id may be reused | reference only committed data (the tool-call entry), or write both in one owner transaction, or an explicit unresolved token | Astra |
| S3 (decided 2026-10-21: terminal success, staged memory, ambiguous stops, pull-back) | critical | Backend request success is not commit completion (IndexedDB puts succeed, the transaction aborts later; IndexedDB `complete` is not durable) | finish the step only on the backend transaction's terminal success; memory backend stages and swaps; ambiguous outcome stops the queue; after restart pull back own uploaded batches | both |
| S4 (decided 2026-10-21: export pauses commits; multi-query reads in one read transaction; no global snapshots) | high | Export or multi-query reads across commits give a state that never existed | export takes one read snapshot inside the queue (or pauses writers at first); document materialization in one read transaction | both |
| S5 (decided 2026-10-21: atomic batch apply; parallel uploads, resubmit until acknowledged, trim after ack; apply only when from = applied head, later batches wait; sync layer) | critical | Replica apply: per-record apply splits a commit; out-of-order batches advance `applied` past a gap; acks advance by max | apply one batch atomically with the applied frontier; validate batch coverage; contiguous ack frontier | both |
| S6 (decided 2026-10-21: covered by S5) | high | Compaction keeps only last ops per (table, key): intermediate states inside a compacted range are not real | a compacted range is one transition: nothing published or taken over mid-range | Astra |
| S7 (decided 2026-10-21: no rollback; the local copy becomes a separate session with a new id) | major | Takeover: a commit already queued lands after the epoch changed | epoch checked inside the step; `not_driver` refuses (not `storage_failed`); the worker goes read-only and restarts from the server copy | Fable |
| S8 (decided 2026-10-21: app concern; §14 non-overlapping handlers; guide patterns) | medium | Slow reaction to 40 overwrites the result of the reaction to 50 | app pattern: coalesce or reject stale results by source revision in the destination owner's transaction | Astra |
| S9 (decided 2026-10-21: persist head, drop Sequencer) | high | Prototype: head derived from the outbox resets after trimming; position counter and safe cut are unnecessary with a serial step | persist the head with the commit; delete `Sequencer` | both |
| S10 (decided 2026-10-21: narrow the contract, derive the counter at open, no reservations) | high | `mintId`: a minted id must not be reused after reopen; neither "max stored id" nor "a row on the next commit" gives that (existing SQLite storage has the same contract gap) | persisted id reservations (blocks) before handing out ids | Astra |
| S11 (decided 2026-10-21: StoreStorage resolves copies before the step, Durable unchanged) | decision | `document.copy` (fork copies a document): Fable: resolve on Durable's Session line before the step (the step must not replay revisions while every owner waits); Astra: resolve inside the transaction as today (no extra layer) | owner chooses | both |
| S12 (decided 2026-10-21: DSL without join, groupBy, select at first) | cut | Start the DSL without `join`, `groupBy`, `select` (aggregate in JS over indexed scans); add on demand | | Fable |
| S13 (decided 2026-10-21: one documents engine in the store, opaque owner; API in the log) | cut | One document engine: Chord's persisted documents as Durable-shaped documents through the same adapter (deletes Chord's own storage layer, tags, `retireByTag`, ~1,000 lines) | | Fable |
| S14 (decided 2026-10-21: one transaction API, self.tx) | cut | One transaction API for tables and documents (not `table.transaction` next to `self.tx`) | | Astra |
| S15 (decided 2026-10-21: kept) | decision | Durable's existing storages: keep (owner) vs `StoreStorage` as the only production storage later (Fable) | | Fable |
| S16 (decided 2026-10-21: real tables; JS/UTF-16 order, SQLite indexed text as UTF-16BE BLOBs; Astra's design) | open points | Generic rows (Astra: choose them); eager migration with a readiness gate, primary keys preserved (both); one key codec for string order and IndexedDB key limits (Fable) | | both |
| S17 (decided 2026-10-21: bulk operations and migrations, log "S17") | cost | Full-row puts: renaming 10k 4 KB rows logs ~40 MB before compression (not 259 KB); revision pruning emits one delete per row; the "short step" is not short for bulk writes, migrations or copies | document; bulk operations later if needed | Astra |

## S16 notes (2026-10-21, in progress)

- Owner: real tables (definitions and changes in the outbox); store-maintained index entries rejected (cost).
- String order options: (1) backend-native, (2) UTF-16 everywhere (extra order column in SQLite), (3) code point =
  UTF-8 byte order everywhere (owner leans to it; sent to both reviewers). Measured (Node 24.4.1, 200k path-like keys,
  70% ASCII, CJK, fullwidth, emoji): code point comparator equals UTF-8 byte order (verified); sort 113.5 ms (JS
  default) vs 139.9 ms (code point comparator, no allocation) vs 182.5 ms (pre-encoded `Buffer.compare`); 100k binary
  searches 105.6 vs 123.9 ms; encoding 200k keys to UTF-8 120.9 ms (IndexedDB binary keys). SQLite: no cost (native
  order).

## S16 cost: indexed text as UTF-16BE BLOB vs UTF-8 TEXT (Node 24.4.1, 100k rows, index (path, at, id))

| operation | TEXT | BLOB | |
| --- | --- | --- | --- |
| insert 100k rows, one transaction (incl. encoding) | 185.7 ms | 259.5 ms | +40% |
| 20k lookups `path = ?`, newest 20 (incl. decoding results) | 54.7 ms | 71.3 ms | +30% |
| 2k prefix ranges of 100 rows (incl. decoding 200k values) | 78.5 ms | 185.2 ms | +136% |
| page through all, 200 pages of 500 (incl. decoding) | 38.5 ms | 75.1 ms | +95% |
| 2k prefix ranges, rows read from the JSON column (no BLOB decode) | 135.9 ms | 140.7 ms | +4% |
| file size | 9.6 MB | 15.6 MB | +62% |

SQLite itself is barely slower on BLOBs (+4%); the overhead is the JS encode/decode (`Buffer.from(s, "utf16le").swap16()`)
and twice the bytes for ASCII. Reads that take logical values from the row's JSON instead of decoding the indexed
columns avoid the decode cost; writes and query bounds still encode.
