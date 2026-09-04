/** Cloudflare Durable Object SQL cursor subset used by this backend. */
export interface DurableSqlCursor<T extends Record<string, unknown> = Record<string, unknown>> {
	toArray(): T[];
	[Symbol.iterator](): IterableIterator<T>;
	readonly rowsRead?: number;
	readonly rowsWritten?: number;
}

/** Cloudflare `SqlStorage.exec` subset. Positional `?` bindings only. */
export interface DurableSqlStorage {
	exec<T extends Record<string, unknown> = Record<string, unknown>>(
		query: string,
		...bindings: unknown[]
	): DurableSqlCursor<T>;
}

/**
 * `DurableObjectStorage` subset: SQL plus synchronous transactions.
 * Cloudflare SQL does not support host `BEGIN`/`COMMIT`; use `transactionSync`.
 */
export interface DurableSqliteStorage {
	sql: DurableSqlStorage;
	transactionSync<T>(closure: () => T): T;
}
