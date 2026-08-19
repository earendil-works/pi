# Session Search

Pi search is a small query interface over committed session entries. The shared contract returns only stable hit identity; implementations may extend hits with backend-specific display data.

## Core API

```ts
export interface SessionSearchHit {
  /** Logical identifier of the session that owns the entry. */
  readonly sessionId: string;

  /** Logical identifier of the entry within that session. */
  readonly entryId: string;
}

export interface SessionSearchOptions {
  /** Restrict results to specific canonical entry types. */
  readonly entryTypes?: readonly Entry["type"][];

  /** Maximum number of hits to return. Backends may return fewer, not more. */
  readonly limit?: number;

  /** Abort signal for cancellation, e.g. search-as-you-type. */
  readonly signal?: AbortSignal;
}

export interface SessionSearch<T extends SessionSearchHit = SessionSearchHit> {
  search(text: string, options?: SessionSearchOptions): AsyncIterable<T>;
}
```

The base hit is intentionally minimal: `(sessionId, entryId)` is the portable identity across JSONL, memory, SQLite FTS, and remote indexes. Snippets, timestamps, scores, metadata, offsets, and ranking semantics belong to concrete implementations.

## Why async iterable

`AsyncIterable` lets consumers render early results, stop iteration when they have enough, and cancel in-flight work with `AbortSignal`. Debouncing remains a UI/caller concern; the API only provides the cancellation primitive.

```ts
let currentAbortController: AbortController | undefined;

async function updateResults(query: string) {
  currentAbortController?.abort();
  const controller = new AbortController();
  currentAbortController = controller;

  try {
    for await (const hit of search.search(query, { limit: 10, signal: controller.signal })) {
      render(hit);
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  }
}
```

## Default implementations

### Scanning search

The reusable scanner adapts session-like readables (`getMetadata`, `findEntries`, and `getLabel`) into projected entries:

```ts
export interface SessionSearchCandidate {
  readonly entryId: string;
  readonly seq: number;
  readonly type: Entry["type"];
  readonly timestamp: number;
  readonly text: string;
  readonly fields?: Record<string, unknown>;
}

export interface ScanningSessionSearchHit extends SessionSearchHit {
  readonly timestamp: number;
  readonly snippet: string;
}
```

`SessionSearchCandidate` is pre-match scanner input: it contains searchable text, type, sequence, and optional projected fields. The scanner turns matching candidates into public hits.

Already-open sessions or storages can be scanned directly:

```ts
const search = createScanningSessionSearch(sessions);

for await (const hit of search.search("authentication", { limit: 10 })) {
  const session = sessionsById.get(hit.sessionId)!;
  const entry = await session.getEntry(hit.entryId);
  console.log(entry);
}
```

JSONL does not need a separate public search adapter. JSONL-backed code can keep discovery/loading local, then pass the loaded storages to the same scanner:

```ts
async function* jsonlReadables(jsonl: JsonlSessionRepoOptions, query: JsonlSessionListOptions = {}) {
  for (const metadata of await listJsonlSessionMetadata(jsonl, query)) {
    yield loadJsonlSessionStorage(jsonl, metadata);
  }
}

const search = createScanningSessionSearch((query) => jsonlReadables(jsonl, query));
```

A scanning source must not call `SessionRepo.open()` on a harness-owned session if that operation may claim a writer lease. JSONL should use read-only loading helpers; already-open sessions/storages can be scanned directly.

### SQLite FTS

SQLite search exposes an extended hit:

```ts
export interface SqliteSessionSearchHit extends SessionSearchHit {
  readonly metadata: SqliteSessionMetadata;
  readonly timestamp: number;
  readonly score: number;
}
```

```ts
const search = createSqliteSessionSearch({ env, sqlite, databasePath });

for await (const hit of search.search("auth", {
  entryTypes: ["message", "compaction"],
  limit: 20,
})) {
  console.log(hit.sessionId, hit.entryId, hit.score);
}
```

The FTS table and triggers are created lazily on first non-blank search. When FTS is first created, SQLite performs a one-time rebuild from canonical `entries`; after that, SQLite triggers keep FTS in sync with canonical entry inserts, deletes, and payload updates. This makes SQLite search fresh after commit, but it also means FTS trigger failures can roll back canonical SQLite writes while search is enabled for that database.

## Indexed backends

Search indexing is backend-owned derived state. The shared package only exports the query API; applications or backend packages may define their own writer/feed contracts when they need explicit index maintenance.

### JSONL sessions with Elasticsearch

This is application-owned glue. Core provides the query contract and JSONL session discovery; the Elastic writer contract is local to this adapter.

```ts
import { Client } from "@elastic/elasticsearch";
import {
  scanningEntries,
  type JsonlSessionMetadata,
  type JsonlSessionRepoOptions,
  type SessionSearch,
  type SessionSearchHit,
  type SessionSearchOptions,
} from "@earendil-works/pi-agent-core";

// JSONL-backed code can provide this locally from existing JSONL list/load helpers.
async function* jsonlReadables(jsonl: JsonlSessionRepoOptions, options: { cwd?: string } = {}) {
  for (const metadata of await listJsonlSessionMetadata(jsonl, options)) {
    yield loadJsonlSessionStorage(jsonl, metadata);
  }
}

interface SearchIndexWriter<TItem> {
  apply(items: TItem[]): Promise<void>;
  flush?(): Promise<void>;
}

interface IndexedSessionSearch<T extends SessionSearchHit, TItem>
  extends SessionSearch<T>, SearchIndexWriter<TItem> {}

type ElasticSessionFeedItem =
  | { type: "upsert"; id: string; body: ElasticSessionDoc }
  | { type: "delete"; id: string };

interface ElasticSessionDoc {
  sessionId: string;
  entryId: string;
  seq: number;
  timestamp: number;
  cwd: string;
  text: string;
  metadata: JsonlSessionMetadata;
  fields?: Record<string, unknown>;
}

interface ElasticSessionSearchHit extends SessionSearchHit {
  readonly timestamp: number;
  readonly snippet: string;
  readonly score?: number;
}

class ElasticSessionSearch
  implements IndexedSessionSearch<ElasticSessionSearchHit, ElasticSessionFeedItem>
{
  constructor(
    private readonly client: Client,
    private readonly index: string,
  ) {}

  async apply(items: ElasticSessionFeedItem[]): Promise<void> {
    const operations = items.flatMap((item) => {
      if (item.type === "delete") {
        return [{ delete: { _index: this.index, _id: item.id } }];
      }
      return [{ index: { _index: this.index, _id: item.id } }, item.body];
    });

    if (operations.length > 0) await this.client.bulk({ operations });
  }

  async flush(): Promise<void> {
    await this.client.indices.refresh({ index: this.index });
  }

  async *search(
    text: string,
    options: SessionSearchOptions = {},
  ): AsyncIterable<ElasticSessionSearchHit> {
    const result = await this.client.search<ElasticSessionDoc>({
      index: this.index,
      size: options.limit ?? 20,
      query: {
        bool: {
          must: [{ match: { text } }],
        },
      },
    });

    for (const hit of result.hits.hits) {
      if (!hit._source) continue;
      if (options.signal?.aborted) throw options.signal.reason;
      yield {
        sessionId: hit._source.sessionId,
        entryId: hit._source.entryId,
        timestamp: hit._source.timestamp,
        snippet: hit._source.text,
        score: hit._score ?? undefined,
      };
    }
  }
}
```

A catch-up/rebuild job can feed JSONL projections into Elasticsearch without taking a writer lease:

```ts
async function indexJsonlSessionsIntoElastic(
  jsonl: JsonlSessionRepoOptions,
  elastic: ElasticSessionSearch,
  options: { cwd?: string } = {},
): Promise<void> {
  for await (const session of jsonlReadables(jsonl, { cwd: options.cwd })) {
    const metadata = await session.getMetadata();
    for await (const candidate of scanningEntries(session)) {
      await elastic.apply([{
        type: "upsert",
        id: `${metadata.id}:${candidate.entryId}`,
        body: {
          sessionId: metadata.id,
          entryId: candidate.entryId,
          seq: candidate.seq,
          timestamp: candidate.timestamp,
          cwd: metadata.cwd,
          text: candidate.text,
          metadata,
          fields: candidate.fields,
        },
      }]);
    }
  }

  await elastic.flush();
}
```

## Correctness and failure boundaries

Search indexes are derived state for the shared API: applications can retry, rebuild, or mark search stale. Backend-specific choices may make different tradeoffs; SQLite FTS uses co-located triggers, so FTS failures can roll back canonical SQLite writes after search has initialized the triggers.

Scanning sources should fail fast if they yield duplicate `sessionId` values, because base hit identity is `(sessionId, entryId)`. Indexed backends usually enforce uniqueness in their storage/index layer.

Search opt-in still needs a sync/indexing layer. A follow-up should add a no-op-by-default search index sink (for example `NOOP_SEARCH_INDEX_SINK`) so canonical write sites can emit indexing events unconditionally, similar to how telemetry uses no-op implementations when telemetry is disabled.
