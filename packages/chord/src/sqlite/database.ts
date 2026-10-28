/** Values supported by the portable SQLite drivers. */
export type SqliteValue = null | number | bigint | string | Uint8Array;

/**
 * Asynchronous SQL operations shared by a database and its transaction handles.
 *
 * `exec` runs SQL text without bindings and may contain several statements. `run`, `get`, and `all`
 * execute one statement with positional bindings. `runCounted` runs one like `run` and resolves with the rows it
 * inserted, updated or deleted, as SQLite's `changes()` counts them (index writes and rows changed by triggers do not
 * count); it may cost a statement more than `run`, so callers that need no count use `run`. Adapters may cache
 * prepared statements by SQL text, so callers pass values as bindings instead of interpolating them.
 */
export interface SqliteExecutor {
	exec(sql: string): Promise<void>;
	run(sql: string, ...params: SqliteValue[]): Promise<void>;
	runCounted(sql: string, ...params: SqliteValue[]): Promise<number>;
	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined>;
	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]>;
}

/**
 * Minimal portable SQLite database facade.
 *
 * All operations are asynchronous so adapters may execute outside the caller's runtime.
 *
 * `transaction` passes the callback a transaction handle. All work in the transaction
 * must use that handle; the handle is invalid after the callback settles. Adapters must
 * queue unrelated operations and other transactions until the transaction finishes. The
 * returned promise settles after commit or rollback. Calling the database itself (including
 * `transaction` or `close`) from inside a callback therefore waits for that transaction and
 * never settles.
 *
 * When the callback rejects, the adapter must roll the transaction back before rejecting
 * with that same error. If rollback fails, it must reject with a different error (for
 * example an `AggregateError`) so callers cannot mistake the callback error for a
 * guaranteed rollback.
 */
export interface SqliteDatabase extends SqliteExecutor {
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}
