# Request to Durable: share the document transaction core

**Superseded:** p2 builds its own document store in Chord with a storage interface and adapts Durable's `Storage` in p2
(`target-design.md` §9). Only moving `OutputBuffer`/`Progress` to Chord is still under consideration.

From the Chord/p2 redesign (`target-design.md`). To be implemented on pi `main` (`packages/durable`, plus `packages/chord`
where noted), then merged into `private`.

## Why

p2 moves object state into transactional documents: drafts that record Chord ops, version plus `migrate` on read,
`checkpointWhen`, create and retire, one atomic storage batch per commit, adopt and publish afterwards. Durable's
`Transaction` already does exactly this and is battle-tested. p2 must reuse it instead of writing a second
implementation. Chord itself must stay free of a Durable dependency; p2 already depends on Durable and builds its object
store on top of it.

## What we need

1. **A document-only transaction core**, exported from Durable (for example `@earendil-works/pi-durable/documents`):
   - acquire a draft for a document address (`kind`, `scope`, optional `key`), creating it on first write
     (`initial()`), loading and migrating it through the host otherwise;
   - retire a document;
   - prepare every draft at settlement (revoking the drafts), plan the storage writes (`document.create` /
     `document.change` / `document.retire`, base or delta per `checkpointWhen`), discard on failure or abort;
   - adopt after the storage commit and return the publications (record, version, ops) so the caller can notify;
   - the existing rules: sealing (`Transaction has settled`), read-after-write, version mismatch handling (a token whose
     version differs from the cached value reloads; a stored version newer than the token is refused).

   Durable's `Transaction` then builds on this core and adds tasks, conversations, submissions and forks, so the core is
   covered by Durable's existing tests. The seam already exists: `TransactionHost` (`session/transaction.ts:99`);
   `conversationCreated` is its only Durable-specific member.
2. **Definitions usable outside a conversation:** `defineDoc` with `scope: "session"` already exists; the core needs to
   accept a session-scoped address with an arbitrary `kind` and `key` chosen by p2 (p2 maps an object's identity hash,
   the state name and the key into them). Confirm whether `kind` must be globally registered or may be dynamic.
3. **Move `OutputBuffer` and `Progress`** (`harness/output.ts`) to Chord (for example `@earendil-works/chord/progress`);
   Durable imports them from there and **re-exports** them under their current names, so nothing breaks.
4. **Review of p2's use of `Storage`:** p2's store calls the core and `Storage` directly (memory and SQLite backends),
   without a `Session`. It must uphold what `Session` guarantees to `Storage`: serialized commits (p2 serializes per
   host), create before change, no change after retire, ids from `mintId`, deltas against the stored version. We would
   like the Durable owners to confirm the list is complete.

## What p2 does with it (for context)

- One store per host. Documents are owned by one object identity; the mutation line is per object; storage commits are
  serialized per host. In-memory documents use the memory backend semantics without persistence; `persist: true`
  documents go to the host's SQLite storage.
- Commits notify local subscribers once and send one atomic `state` batch per hold on the wire.
- No eviction: a document's memory copy lives as long as its object; persisted documents stay on disk until retired.

## Out of scope

Tasks, conversations, submissions, forks, the harness and the scheduler stay as they are.
