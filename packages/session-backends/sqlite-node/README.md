# @earendil-works/pi-session-backend-sqlite-node

Node sqlite session backend for `@earendil-works/pi-agent-core` sessions. Provides the
`node:sqlite` adapter (`SqliteDatabase` implementation), SQLite session repository,
migrations, materialized views, and optional FTS search.

```ts
await using repository = new SqliteSessionRepository(options);
const search = createSqliteSessionSearch(options);
const session = await repository.create({ cwd });
const hits = await search.search({ text: "needle" });
```

The repository lazily owns one shared database connection. Search is an independent,
query-only projection over the same canonical database.
