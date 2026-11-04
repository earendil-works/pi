---
title: One Session, Many Stores: exporting and syncing a p3 session
cover: Many / Stores
kicker: A discussion book · p3 session data · 2026-10-21
subtitle: How a session whose plugins keep their own SQLite files can be exported, imported and continued on another machine without coming apart
stats:
  - 4 | kinds of storage in one session directory
  - 1 | position counter per session, shared by all stores
  - 54 B | changeset of a two-row SQL UPDATE (measured, Node 24)
  - 0 | Chord changes beyond a wrappable storage
note: |
  A proposal for discussion, not a decision. Written for the owner after the discussion of 2026-10-21 (option E in
  `apps/p2/docs/p3-reviews/session-data-scenarios.md`). Assumes the open proposals P1 (a session is self-contained)
  and P3 (persisted documents only in input-less `local` objects). The SQLite changeset behaviour was checked on
  slayer with Node 24.4.1 (`node:sqlite`); everything else is design. Notes marked *review* are open points.
colophon: One Session, Many Stores · first edition · 2026-10-21 · based on session-data-scenarios.md and the redesign log
---

# Before we begin {.preface}

Mario works in session S1 on his laptop. The agent edits files, and a plugin called **file-history** remembers every
edit: which file, which entry of the conversation made it, the content before and after. It keeps those rows in its
own SQLite database, `history.sqlite`, because it needs SQL: "every version of `src/app.ts`", "every file the last
turn touched", "the directory `a/` was renamed to `b/`, update ten thousand rows".

In the evening Mario wants to continue S1 on his desktop. Or he exports S1 to a file and imports it on another p3
instance. Either way the desktop must end up with the conversation (Durable), the plugins' documents (Chord), the
artifact contents (blobs) and `history.sqlite`, and all four must agree with each other. A row in `history.sqlite`
says "entry 812 made this edit"; entry 812 must exist on the desktop and be the same entry.

Copying files does not do that. A live SQLite file copied while it is written is not a consistent database, and
`session.sqlite` and `history.sqlite` copied a moment apart do not agree with each other. Shipping only the
conversation and rebuilding the rest works for indexes, not for `history.sqlite`: its rows exist nowhere else.

## Seven things to know

:::findings
1. **A session is a directory of stores.** The log (`session.sqlite`), blobs, plugin databases and derived caches all
   live in `sessions/S1/`.
2. **Immutable and derived data are easy.** Blobs are written before the document that names them; derived data is
   rebuilt. Export and import need nothing else for them.
3. **Mutable plugin stores are the problem.** Two stores changing side by side can arrive on another machine at
   different points in time, and then they disagree.
4. **One position counter fixes the order.** Every change in every store of the session takes the next position from
   one counter. Positions say what happened before what, across stores.
5. **Each store records its own changes in its own transaction.** The change and its outbox record commit together,
   so a crash can never lose one without the other.
6. **SQLite can record its own changes.** Its session extension turns any SQL write into a compact changeset of rows,
   which another database applies. A plugin writes plain SQL.
7. **Chord only provides a wrappable storage.** The counter, the outboxes, the batches and the store kinds are app
   layer (p3's sync layer).
:::

## Words used throughout

A **store** is one place where a session keeps data: Durable's and Chord's storage (`session.sqlite`), the blob
directory, a plugin's SQLite database, an append-only JSONL file. A **change** is one committed transaction of one
store. A **position** is a number from the session's counter that every change takes when it commits. An **outbox**
is where a store records its changes with their positions, inside the same transaction as the change. A **batch** is
all changes of all stores up to one position, shipped together. The **driver** is the instance that writes the
session; a **replica** is a copy on another instance that applies batches.

# What a Session Holds {#holds lede="The four kinds of data in a session directory, and which of them are hard."}

Everything of S1 lives under one directory on the instance that runs it. The server keeps only mirrors (the catalog)
and its own instance data (shares, devices, settings).

:::flow wide | The session directory of S1. Accent marks the store that makes export and sync hard.
row "Log" blue
box log "session.sqlite" "Durable entries, tasks, documents; Chord documents"
row "Content" muted
box blobs "blobs/" "artifact versions, uploads; named by hash, never changed"
row "Plugin stores" accent
box history "history.sqlite" "file-history: rows exist nowhere else" accent
box index "search index" "derived from the log, rebuildable" dashed
note "The server holds only mirrors (catalog) and instance data (shares, devices, settings)."
:::

| Kind | Example | Changes | Export and sync |
| --- | --- | --- | --- |
| log | conversation, documents | append and update | must ship, in order |
| blob | artifact v3 contents | never | ship the file |
| derived | full-text index | rebuilt | never ship, rebuild |
| plugin store | `history.sqlite` | update in place | the open problem |

# The Easy Cases {#easy lede="Why blobs and derived data need no machinery, and what that teaches about the hard case."}

The artifacts plugin saves a new version. It writes the content as a blob first, then commits a document that names
the blob's hash. The order is the whole trick.

:::sequence animate | Saving artifact "chart" version 3. The blob exists before anything refers to it.
actor tool "artifact tool"
actor blobs "blobs/" muted
actor log "session.sqlite" blue
tool -> blobs: write sha256:9f3a… (tmp, fsync, rename)
tool => log: seq 41: chart.versions[2] = { blob: "sha256:9f3a…" }
tool => log: seq 42: entry 812 "chart v3 saved"
:::

An export reads the log at some head, say 42, and copies every file in `blobs/`. Any blob a record up to 42 refers to
was written before that record, so it is in the directory. The session does not have to stop. An import replays the
log into a fresh `session.sqlite`, copies the blobs and checks their hashes.

## Derived data rebuilds itself

The artifacts plugin also keeps a full-text index over artifact contents, in its own SQLite file under
`derived/artifacts/`, because searching documents one by one is too slow. The index holds nothing of its own: every
row can be recomputed from the `artifact` documents and the blobs they name. So it is never exported or synced. A
routine compares the index with the documents whenever the object starts and fills in whatever is missing:

```ts
const Artifact = defineState("artifact", {
  schema: obj({ title: str(), type: str(), versions: arr(obj({ blob: str(), size: int(), at: int() })) }),
  version: 1, keyed: true, persist: true,                         // key = artifact name
  initial: () => ({ title: "", type: "text", versions: [] }),
  checkpointWhen: () => true,
});

host.serve(ArtifactStore, (_, self) => {                          // local, input-less
  const artifacts = self.state(Artifact);
  const blobs = self.get(SessionBlobs, {});                       // app layer: the session's blob store
  const info = self.get(SessionInfo, {});
  const index = self.open(async () => openIndex(join(info.init.value.dir, "derived/artifacts/index.sqlite")),
    (db) => db.close());

  self.routines.loop("catch-up", async (ctx) => {                 // the index repairs itself
    for await (const name of artifacts.keys()) {
      const a = await artifacts.get(name);
      if (a && index.value.versions(name) !== a.versions.length)
        index.value.put(name, a.versions.length, await blobs.read(a.versions.at(-1)!.blob, ctx));
    }
  });

  return {
    save: async ({ name, title, type, content }, ctx) => {
      const bytes = utf8(content);
      const blob = await blobs.put(bytes, ctx);                   // 1. content first
      await self.tx(ctx, async (tx) => {                          // 2. the document naming it
        const a = await tx.draft(artifacts, name);
        a.title = title; a.type = type;
        a.versions.push({ blob, size: bytes.length, at: Date.now() });
      });
      const version = (await artifacts.get(name))!.versions.length;
      index.value.put(name, version, content);                    // 3. derived, best effort
      return { version };
    },
    search: ({ query }) => index.value.search(query),
  };
});
```

The same routine covers three situations without any special code:

:::steps | One routine, three situations
+++ Normal save
`save` writes the blob, commits the document, then updates the index. The routine finds nothing to do.
+++ Crash after the commit
The process dies between step 2 and step 3. The document says version 3, the index still has version 2. On the next
start the routine sees the difference, reads the blob of version 3 and indexes it.
+++ Import or sync
On the desktop `derived/artifacts/` does not exist. `openIndex` creates an empty index; the routine finds every
artifact missing and indexes them all from the documents and blobs that came with the session.
:::

:::note | Cost of the catch-up
This routine visits every artifact on each start: fine for hundreds, slow for millions. A large derived store would
keep the last position it applied and read only the changes after it (the outboxes of chapter V give exactly that).
:::

Both cases work because nothing ever changes in place: a blob is final when written, and a derived index has no data
of its own. `history.sqlite` breaks both assumptions. Its rows change in place, and they are the only copy.

# Two Stores, No Common Order {#problem lede="What goes wrong when history.sqlite and the log travel separately."}

Suppose every store ships its own changes to the desktop as it pleases: `session.sqlite` in batches of commits,
`history.sqlite` as a stream of its own. The agent edits `x.ts`; the edit is recorded in both stores.

:::steps | One edit, two stores, shipped separately
+++ On the laptop
The tool records the edit in `history.sqlite` (row: path `x.ts`, entry 812), then Durable commits entry 812 at seq
42. On the laptop both exist and agree.
+++ The history stream arrives first
The desktop has received the `history.sqlite` changes, including the row, but the log only up to seq 41. The row
says entry 812 made the edit; the desktop has no entry 812.
+++ Mario takes over now
The laptop's lid is closed; the desktop becomes the driver. Its agent writes the next entry, which gets id 812: a
different message. The row now points to the wrong entry, permanently.
+++ The opposite order
If the log arrives first instead, entry 812 says "x.ts edited" and the history has no row for it. Either way the
desktop holds a state the laptop never had.
:::

The fault is not in either store. Each one is consistent on its own. What is missing is an order **across** stores:
which change of `history.sqlite` happened before which commit of the log.

# One Counter for the Session {#counter lede="A single sequence of positions that every store takes from when it commits."}

The session gets one counter, kept in memory by p3's sync layer on the driver. Every store, in the transaction that
commits a change, takes the next position and writes the change with that position into its own outbox. Positions
increase across all stores of the session, so they order everything.

:::sequence animate | The same edit with positions. Each store writes its outbox inside its own transaction.
actor tool "edit tool"
actor counter "counter" "sync layer, memory" accent
actor history "history.sqlite" "plugin store"
actor log "session.sqlite" blue
tool -> history: BEGIN; INSERT row (x.ts, entry 812)
history -> counter: next()
counter --> history: 7
history => history: outbox row (7, changeset); COMMIT
tool -> log: commit entry 812
log -> counter: next()
counter --> log: 8
log => log: seq 42 with position 8, same transaction
:::

After the edit the two outboxes look like this:

| Store | Position | Change |
| --- | --- | --- |
| `history.sqlite` | 7 | changeset: insert row (x.ts, entry 812) |
| `session.sqlite` | 8 | seq 42: entry 812 |

The sync layer cuts a **batch** at a position P: every change of every store with a position up to P. A replica
applies a batch in position order, store by store as the positions say. After applying a batch it holds exactly the
state the driver had at P, for all stores together. The bad states of the previous chapter cannot happen: a replica
has position 8 only together with position 7.

:::flow wide animate | Shipping. Batches are cut across stores; the replica applies them in position order.
row "Driver" accent
box ho "history outbox" "7, 11, 12"
box lo "log outbox" "8, 9, 10, 13"
box cut "cut at 12" "nothing ≤ 12 still committing" accent
row "Replica" blue
gap
box apply "apply in order" "history 7, log 8 9 10, history 11 12"
box batch "batch ≤ 12" "7 8 9 10 11 12" blue
arrow ho -> cut
arrow lo -> cut
arrow cut -> batch "upload"
arrow batch -> apply
note "Position 13 waits for the next batch, together with whatever else comes after 12."
:::

**Cutting needs one rule.** The counter hands out position 12 to a store whose transaction has not committed yet,
while position 13 already committed elsewhere. A cut at 13 would miss 12. So the counter remembers the positions it
handed out that are not committed yet, and a cut goes only up to just below the smallest of them. A transaction that
fails gives its position back as a gap; gaps are fine, order is what counts.

# Capturing a SQLite Change {#sqlite lede="How a plugin writes plain SQL and still produces a change record another database can apply."}

A plugin store must turn its writes into change records. For JSONL that is the appended lines themselves. For SQLite
it would be a burden on every plugin, except that SQLite has the **session extension**: it watches tables and turns
whatever SQL ran into a **changeset**, a compact list of row inserts, updates and deletes. Another database applies
it. `node:sqlite` exposes it. This ran on slayer with Node 24.4.1:

```js
import { DatabaseSync } from "node:sqlite";
const laptop = new DatabaseSync(":memory:"), desktop = new DatabaseSync(":memory:");
// both: CREATE TABLE edits(id INTEGER PRIMARY KEY, path TEXT); CREATE TABLE outbox(pos INTEGER PRIMARY KEY, cs BLOB)

const session = laptop.createSession({ table: "edits" });
laptop.exec("BEGIN");
laptop.exec("UPDATE edits SET path = 'b/' || substr(path, 3) WHERE path GLOB 'a/*'");  // plain SQL
const cs = session.changeset();                                                      // 54 bytes for two rows
laptop.prepare("INSERT INTO outbox VALUES (?, ?)").run(7, cs);                       // same transaction
laptop.exec("COMMIT");

desktop.applyChangeset(cs);   // desktop now has b/x and b/y
```

So p3 could offer plugins a session SQLite as a store kind. The plugin opens it, writes SQL in transactions, and the
wrapper does the rest: start a session on the plugin's tables, take a position before `COMMIT`, write the changeset to
the outbox table, commit. The plugin never sees positions or outboxes.

:::review | Limits of changesets
**Rows, not commands.** Renaming `a/` to `b/` over ten thousand rows is ten thousand row changes in the changeset
(tens of bytes each), not one command. Still logical rows, never database pages.
**No schema changes.** `CREATE TABLE` and `ALTER TABLE` are not in changesets. A plugin's schema migrations must be
versioned and run on every replica before changes made with the new schema are applied.
**Cloudflare.** The Durable Object SQLite API may not expose the session extension; not checked.
:::

# Crashes {#crashes lede="Why the outbox lives inside each store, and how the counter restarts."}

Why not one shared outbox file for all stores? Because the change and its record must commit together. With a shared
file, the plugin commits its rows, the process dies before the changeset reaches the shared file, and the changeset
is gone: it existed only in memory. The rows are on disk and will never be shipped. Each store therefore keeps its
outbox inside itself, in the same transaction as the change: an outbox table in a SQLite database, the record in
`session.sqlite`'s commit, the lines themselves in a JSONL file.

:::steps | The laptop dies in the middle of a turn
+++ Before the crash
Positions 1 to 14 are handed out. 7, 11, 12 committed in `history.sqlite`; 8, 9, 10, 13 in `session.sqlite`; 14 was
still in a `history.sqlite` transaction. Batch ≤ 12 was uploaded.
+++ The crash
Position 14's transaction never committed, so neither its rows nor its outbox record exist. Nothing half-done is
left in any store.
+++ Restart
The sync layer reads the highest position in every outbox (12 and 13) and starts the counter at 14. Position 13 is
committed and not yet uploaded; it goes into the next batch.
+++ Nothing is lost or reordered
Every committed change has its record; every record has its change. The next batch continues at 13.
:::

# What Each Store Needs, and What Chord Provides {#kinds lede="The store kinds p3 would offer plugins, and the small part that falls to Chord."}

| Store kind | Change record | Applied on a replica by | Snapshot (export, compaction) |
| --- | --- | --- | --- |
| Durable/Chord storage | the commit's writes | `replay` | `export()` |
| blob directory | "added hash" plus the bytes | writing the file | the files |
| append-only JSONL | the appended lines | appending | the file |
| plugin SQLite | changeset, in the same transaction | `applyChangeset` | `VACUUM INTO` |
| files changed in place | none | none | cannot sync: derived data only |

**Export and import** use the same pieces. An export takes a snapshot of every store at one cut position P (the
log's `export()`, `VACUUM INTO` for each plugin database, the blob files, the JSONL files) and writes them into one
archive with P in its manifest. An import restores each snapshot into a fresh session directory. Later changes, on a
replica, continue from P.

**Chord's part** is small. Its storage (and Durable's) must be wrappable: the sync layer sees every commit's writes
in order and gets a hook inside the commit to take a position and write the outbox record in the same transaction.
And the storage needs `export()`, `replay()` and `head()`. The counter, outboxes, batches, store kinds and the
session directory are p3's.

One consequence for an open question: ordering no longer needs Chord's documents to live in Durable's storage. If
they had their own file, it would be one more store with its own outbox, ordered by the same counter. Sharing the
storage would only save a file.

# Open Questions {.epilogue lede="What this proposal needs decided before anything is built."}

The proposal: a session is a directory of stores; p3's sync layer orders every change of every store through one
position counter; each store kind records its changes in its own transaction; plugins get store kinds (SQLite through
changesets, JSONL, blobs) in the session directory; files changed in place may hold only derived data. Chord provides
a wrappable storage with `export`, `replay` and `head`.

## Needs a decision

- **The direction.** Is this the model for p3 sessions?
- **Store kinds.** Which kinds p3 offers plugins at first (SQLite and blobs, or JSONL too).
- **Shared storage.** Whether Chord's persisted session documents still share Durable's storage, now that ordering
  does not need it.

## To verify

- The session extension's cost on large tables and wide updates (a benchmark of the 10k-row rename).
- Whether Cloudflare's Durable Object SQLite exposes changesets; if not, what a plugin store means there.

# Glossary {.appendix}

**Batch:** all changes of all stores up to one position. **Blob:** a file named by the hash of its content, never
changed. **Changeset:** SQLite's record of the rows a transaction inserted, updated or deleted. **Cut:** choosing the
position a batch ends at; never past a position still committing. **Derived data:** data rebuilt from other stores,
never shipped. **Driver:** the instance that writes a session. **Outbox:** a store's own record of its changes with
positions, written in the same transaction. **Position:** a number from the session's counter, taken by every change.
**Replica:** a copy of a session on another instance that applies batches. **Store:** one place a session keeps data.
