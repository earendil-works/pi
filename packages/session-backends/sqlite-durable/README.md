# @earendil-works/pi-session-backend-sqlite-durable

Cloudflare Durable Object SQLite session backend for `@earendil-works/pi-agent-core`.

Uses the same schema and `SqliteStorage` as `@earendil-works/pi-session-backend-sqlite-node`. The Durable Object isolate is the writer lock. Do not pass this factory into `SqliteSessionRepo`: that repository creates files, sets WAL, and calls `BEGIN`/`COMMIT`.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
	DurableSqliteSessionRepo,
	type DurableSqliteStorage,
} from "@earendil-works/pi-session-backend-sqlite-durable";

export class RoomActor {
	readonly #repo: DurableSqliteSessionRepo;

	constructor(ctx: { storage: DurableSqliteStorage }) {
		this.#repo = new DurableSqliteSessionRepo({ storage: ctx.storage });
	}

	async openOrCreate(id: string) {
		const existing = (await this.#repo.list(undefined, BACKGROUND_CONTEXT)).find((row) => row.id === id);
		if (existing) return this.#repo.open(existing, BACKGROUND_CONTEXT);
		return this.#repo.create({ id }, BACKGROUND_CONTEXT);
	}
}
```

`ctx.storage` must expose `sql.exec(query, ...bindings)` and `transactionSync`. Cloudflare SQL does not support host `BEGIN`/`COMMIT`; this backend uses `transactionSync`. Bindings are positional `?` only.

Default layout is one Session per isolate (`create` once with the Durable Object id). The schema still scopes rows by `session_id`, so one isolate may hold several Sessions. `SqliteSessionMetadata.path` is the sentinel `durable-object`, not a filesystem path.

`close()` on the wrapped database is a no-op. The isolate owns SQLite for its lifetime.
