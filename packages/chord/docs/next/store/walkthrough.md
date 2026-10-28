---
title: One Store
kind: walkthrough
kicker: A walkthrough · Chord v2 and p3 · 2026-10-21
subtitle: How one transactional store keeps a p3 session's transcript, documents and plugin tables consistent, taught one concept at a time
model: anthropic/claude-sonnet-5-5
sources:
  - packages/chord/docs/next/store/book.md
  - packages/chord/docs/next/decisions.md
  - apps/p2/docs/p3-reviews/store-review-summary.md
  - apps/p2/docs/p3-reviews/store-bulk-migrations.md
  - apps/p2/docs/p3-reviews/session-data-scenarios.md
  - apps/p2/docs/p3-reviews/store-proposal.md
  - packages/durable/src/storage/sqlite/storage.ts
  - packages/durable/src/session/session.ts
truth: The decision log (redesign-decisions.md, entries "The store", "S1" to "S17", "Context last") wins over everything; the book (book.md) is written from it; store-proposal.md and session-data-scenarios.md are earlier drafts and the discussion, superseded where the log differs; the Durable sources show today's code, before the S1 change.
---

:::tutor
Audience: the owner of p3 and Chord, who decided this design in one long discussion and wants to understand it end to
end, or a developer joining the work who knows TypeScript, SQLite and pi-durable but not this store. Use the book's
running example throughout: Mario's session S1 on his laptop, the file-history plugin with its `edits` table, entry
812, the rename of `a/` to `b/` over 10,000 rows, continuing on the desktop. Read the matching book chapter before each
concept and check decisions in the log. Be concrete: code, short traces with seq numbers, small tables. Short messages;
one figure per concept at most. When the reader asks why something was not done another way, answer from the book's
"What We Tried and Dropped" chapter and the log.
:::

:::intro
#### What this is about

A p3 session must be self-contained: everything it owns lives in its own store and directory, so it can be exported,
imported into another p3, synced to Radius and continued on another device. Three kinds of owners write into a
session: Durable (the transcript), Chord objects (persisted documents) and plugins (their own tables). This walkthrough
explains the store they all share and why it is built that way.

#### The example

Mario works in session S1 on his laptop. A plugin called **file-history** records every file edit in its table
`edits`: path, the conversation entry that made it (say entry 812), the time. He renames the directory `a/` to `b/`
(10,000 rows change). In the evening he continues S1 on his desktop; another day he exports it and a colleague imports
it. Every concept follows this session through one mechanism.

#### How it progresses

Eleven concepts in four parts: the problem and what was dropped; how the store writes (commit queue, seq, adoption,
completion); how it reads and stores documents and tables (text order, the documents engine, bulk operations and
migrations; blobs and derived data); and how a session moves (sync, takeover, export) plus the rules left to plugin authors.
:::

# The problem {#problem part="Why one store"}
Book "Before we begin" and chapter I. Must cover: P1 (a session is self-contained; the server only mirrors); three
owners (Durable, Chord objects, plugins); the trace where file-history's own `history.sqlite` and Durable's log sync
separately and entry 812 dangles or points to the wrong entry after takeover; what is missing is one order across
storages. A short trace or a steps figure helps.

:::check
1. Both of S1's storages are consistent on their own. Why can the desktop still end up in a state the laptop never had?
+++ answers
1. Because nothing orders the changes of one storage relative to the other: the desktop can receive history.sqlite up to the edit but Durable's log only up to the commit before it (or the reverse), a combination that never existed on the laptop.
:::

# What was dropped {#dropped}
Book chapter II; log entry "The store" (its list of rejected options) and S16. Must cover the main dropped options and
the reason for each: derived-only plugin data, opaque directories, export hooks, plugin record logs with apply, several
storages with a shared position counter, recorded SQLite statements, raw SQL reads, an IndexedDB-only API; inside the
store: generic JSON rows, store-maintained index entries, code point order with replaced surrogates, text equality only.
Point out what the final design kept from them (one order, recorded operations, a small query language).

:::check
1. Why was "record the plugin's SQL statements and replay them on the replica" dropped, while bulk operations are now recorded as operations and replayed?
+++ answers
1. Arbitrary SQL can produce different results on a replica (random(), datetime('now'), unordered INSERT ... SELECT, other SQLite versions); the store's bulk operations use only the store's own expressions, specified once and identical on every backend, plus a row count check.
:::

# The store and its tables {#store part="Writing"}
Book chapter III; log "The store", S14, S16. Must cover: layers (owners, store with documents engine, tables and commit
step, backends); a table belongs to one object (address host, object type, table name); `defineTable` with typed key
and indexed columns (`str` or `int`) in a flat `columns` record of real columns, nesting only inside `json<T>()` columns (typed but not queryable); one transaction API
`self.tx(fn, ctx)`; index definitions are recorded in the outbox (contents never travel); Durable keeps its storages and gains `StoreStorage`; context last.

:::check
1. In `edits`, which fields can a query filter on, and where does the rest of the row live?
+++ answers
1. Every scalar column (str, int, bool, num) is a real column and can be filtered; keys and indexes need str or int; json(...) columns hold JSON text, typed when read but not queryable or indexable.
:::

# Lines, the commit queue and the seq {#commit}
Book chapter IV; log S1, S3, S9, S10. Must cover: lines (per Chord object, per Durable Session) serialize whole
transactions, the commit queue serializes only the short final step; one seq per store, Durable sees gaps and only
compares seqs; adoption inside the step with `Storage.commit(writes, adopt, context)`; why (the trace where Durable
adopts 41 before file-history adopts 40); listeners still run afterwards and read a complete prefix; a commit is done
only on the backend's terminal success; ambiguous outcomes stop the store; ids derived at open. The book's sequence
figure of two objects and a Durable turn helps.

:::check
1. Object A commits seq 40 and Durable commits 41. Without S1, how could a routine see 41 but not 40?
2. Why is it harmless that Durable's seqs now have gaps?
+++ answers
1. Each owner adopted in its own continuation after the disk commit; Durable's continuation ran first, so a routine triggered by 41 read A's in-memory state still at 39. With S1 both adoptions run inside the commit step, in seq order.
2. Durable only compares seqs (created_at <= at, seq > base); it never computes seq + 1 to find a neighbouring commit.
:::

# Reading and text order {#reading part="Reading and storing"}
Book chapter V; log S4, S12, S16. Must cover: the small query language (where operators, orderBy, limit, cursor; no
joins, grouping, projections at first); JavaScript and SQLite order strings differently (the ～ vs 😀 example); the
decision: JavaScript order everywhere, SQLite stores key and indexed text as UTF-16 BLOBs (big-endian), lossless,
measured costs; no normalization; cursors carry direction and logical values; multi-query reads in one read
transaction, no global snapshot.

:::check
1. A plugin pages through `edits` by path with a cursor. Why would it break if SQLite stored paths as ordinary TEXT while the memory backend compared JS strings?
2. What does the UTF-16 BLOB encoding cost, according to the measurements?
+++ answers
1. SQLite would order by UTF-8 bytes and JS by UTF-16 code units; they disagree for characters between U+E000 and U+FFFF versus emoji, so a cursor taken from one order skips or repeats rows in the other (and tests on the memory backend would not show what SQLite does).
2. Mostly JS encoding and decoding plus twice the bytes for ASCII: about +40% on bulk inserts, +62% file size in the test; SQLite's own range scans are about 4% slower when values are not decoded from the BLOBs.
:::

# The documents engine {#documents}
Book chapter VI; log S11, S13. Must cover: Durable and Chord persist documents the same way, so the store has one
engine; address (namespace, owner, kind, key) with an opaque owner string filled by each adapter (Durable: session,
conversation:7, task:31; Chord: host/object type); find, load, list outside the step, create, change, retire inside it;
load reconstructs base plus deltas once, the engine keeps nothing in memory; Durable's Session caches and evicts as
today; fork copies are reconstructed by StoreStorage before the commit step.

:::check
1. Who decides that a conversation's documents fork and rewind with it: the documents engine or Durable's adapter?
+++ answers
1. Durable's adapter (StoreStorage): the engine only sees an opaque owner string such as "conversation:7"; the meaning of that owner stays with Durable.
:::

# Bulk operations and migrations {#bulk}
Book chapter VII; log S17; store-bulk-migrations.md. Must cover: the five writes (put, update, delete, updateWhere,
deleteWhere); the rename of a/ to b/ as one recorded operation with a row count (about 150 bytes instead of about 40
MB), compiled to one SQL UPDATE on the UTF-16 BLOB column; the replica runs the same operation and compares the count;
the set expressions and why they are limited (identical behaviour on every backend; no JSON operands yet); migrations:
changes inside json(...) columns on access via migrate(row, from), column changes as recorded alters, key and indexed columns eagerly by recorded table changes plus an update
step or a rows step (scan + tx.update in chunks, migrating then ready, resume after a crash). The book's migration steps
figure helps.

:::check
1. Version 4 of `edits` adds an indexed column `dir` computed with dirname(path). Why can this not migrate on access, and how does it run instead?
2. A replica applies the rename and affects 9,998 rows instead of 10,000. What happens?
+++ answers
1. An index over a column filled only on access would silently miss unmigrated rows; so it runs eagerly on the driver before the object goes live: a recorded alter adds the column, then a rows step scans in key order and writes dir with tx.update, chunk by chunk, until the table is marked ready.
2. The counts differ, so the replica stops applying that store and restores it from a snapshot: divergence is detected, not silent.
:::

# Blobs and derived data {#easy}
Book chapter VIII "The Easy Parts"; log "Blobs and derived data". Must cover: blobs are app-layer files named by the
hash of their content, written before the row or document that names them; export copies them, import checks hashes;
sync uploads every blob present and not yet uploaded before each batch (no reference tracking); no deletion before the
session is deleted; derived data is never shipped and is repaired by a catch-up routine (the artifacts full-text index
example: normal save, crash after commit, import).

:::check
1. Why does the sync layer not need to know which rows reference which blobs?
2. The process dies between the artifact document's commit and the index update. What fixes the index?
+++ answers
1. A blob is always written before the commit that names it, so uploading every blob present before each batch guarantees that any hash a batch names has its file on Radius already.
2. The catch-up routine on the next start: it compares the index with the documents, finds version 3 missing and indexes it from the blob.
:::

# Sync and takeover {#sync part="Moving a session"}
Book chapter IX; log S3, S5, S6, S7. Must cover: the outbox record is written in the same backend transaction;
parallel uploads, resubmit until acknowledged, trim after acknowledgement; a replica applies whole batches in order
(from equals its applied head), later batches wait; compaction is safe because batches apply whole; pull-back after a
power loss; losing the driver role splits the session (new id) without rollback, and why rollback is impossible.

:::check
1. The laptop committed 40 and 41 locally after the desktop took over. What happens to those commits?
+++ answers
1. Nothing is rolled back: when Radius refuses the laptop's upload for an old epoch, the laptop's copy becomes a separate session with a new id, keeps 40 and 41, and never syncs with S1 again; S1 continues on the desktop.
:::

# Export, import and the rules left to plugins {#export}
Book chapters IX ("Export and import") and X; log S2, S4, S8. Must cover: export holds the commit queue so the
archive is one head, includes tables of plugins that are not installed, never derived data; import restores into a
fresh store and the server mirrors the catalog; rules: nothing leaves a transaction before it commits (reference the
tool-call entry, not the tool-result entry); work that finishes out of order is the app's concern (routine handlers
never overlap: chain or drop stale results); text compares like JS strings; prefer updateWhere over loops of puts.

:::check
1. The file-history plugin wants to store which entry made an edit. Which entry can it safely reference, and why?
+++ answers
1. The assistant entry with the tool call: it is committed before the tool runs. The tool-result entry does not exist yet while the tool runs, and its id is handed out only inside the harness's later transaction.
:::

# What comes next {#next part="Where it stands"}
Book "What's Next"; log entries. Must cover: everything decided on 2026-10-21; the pi change (adopt argument, Session
rejection handling, mintId wording, traceIn context last); the store in packages/chord/src/next (about 1,650 lines
estimated); StoreStorage passing Durable's conformance suite; the sync layer later; open points (new id of a split
session, chunk size, whether IndexedDB is needed while sqlite-wasm covers the browser).
