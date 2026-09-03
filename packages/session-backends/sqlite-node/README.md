# @earendil-works/pi-session-backend-sqlite-node

Node `node:sqlite` Session backend for `@earendil-works/pi-agent-core`.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
  createNodeSqliteFactory,
  SqliteSessionRepo,
} from "@earendil-works/pi-session-backend-sqlite-node";

const repository = new SqliteSessionRepo({
  directory: "/var/lib/pi/sessions",
  databaseFactory: createNodeSqliteFactory(),
});

const session = await repository.create({}, BACKGROUND_CONTEXT);
const main = await session.createBranch("main", null, BACKGROUND_CONTEXT);
await main.appendMessage(
  { role: "user", content: "hello", timestamp: Date.now() },
  BACKGROUND_CONTEXT,
);
await session.close(BACKGROUND_CONTEXT);
await repository.close(BACKGROUND_CONTEXT);
```

The default layout creates one file per Session under `directory`. IDs containing only ASCII letters, digits, `_`, and `-` retain `{sessionId}.sqlite`; every other ID uses a `~`-prefixed base64url encoding of its UTF-16 code units. The durable ID is unchanged, and returned/listed metadata contains the canonical physical path. Pass `databasePath` to place multiple Sessions in one supported shared container; its parent is created when needed.

The database factory distinguishes intentional creation, no-create read-write open, and no-create read-only open. Session `open()` and deletion reject metadata outside the configured repository and never create a missing database. Listing is read-only and best-effort. Forking deliberately permits a foreign source metadata path: it reads that exact existing container read-only and never substitutes an active local Session with the same ID.

The host lifecycle, not this backend, guarantees one writable owner per Session. Directly opening the same Session for writes in another process is unsupported. The repository rejects overlapping local create/open/fork/delete ownership for one ID, but implements no cross-process lease, lock, fence, heartbeat, or takeover. The host must close a worker before deletion.

A fork of a source open in the same repository queues its snapshot on that source's commit queue. Any other source, including one held open by a live Session worker, uses an independent read-only connection and one deferred WAL transaction; later worker commits may complete while that snapshot remains open. Shared-container deletion removes only the selected Session's rows. Repository close waits for every open Session cleanup attempt before reporting errors. The package does not export a search service or FTS index; search is the separate S3 projection.
