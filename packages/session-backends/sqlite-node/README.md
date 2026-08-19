# @earendil-works/pi-session-backend-sqlite-node

Node sqlite session backend for `@earendil-works/pi-agent-core` sessions. Provides the
`node:sqlite` adapter (`SqliteDatabase` implementation), SQLite session repository,
migrations, materialized views, and optional FTS search.

```ts
await using repository = new SqliteSessionRepository(options);
const search = createSqliteSessionSearch(options);
const session = await repository.create({ cwd });
await session.appendMessage(message);

const hits = [];
for await (const hit of search.search("needle")) hits.push(hit);
```

The repository lazily owns one shared database connection. Search is an independent
service over the same canonical database: repositories do not expose `search()`.
The FTS table and triggers are created lazily on the first non-blank search; when
FTS is first created, search performs a one-time rebuild from canonical entries.
After that, SQLite triggers keep FTS in sync with canonical entry inserts, deletes,
and payload updates.
