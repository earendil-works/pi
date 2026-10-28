import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "./database.ts";

/** Values a Durable Object SQL binding accepts and returns. */
type DurableObjectSqlValue = ArrayBuffer | string | number | null;

/**
 * The parts of a SQLite-backed Durable Object's `ctx.storage` this adapter uses, typed structurally so the package
 * needs no Workers type dependency.
 */
export type DurableObjectSqliteStorage = {
	readonly sql: {
		exec(
			query: string,
			...bindings: DurableObjectSqlValue[]
		): {
			next():
				| { readonly done?: false; readonly value: Record<string, DurableObjectSqlValue> }
				| { readonly done: true; readonly value?: undefined };
			toArray(): Record<string, DurableObjectSqlValue>[];
		};
	};
	transaction<T>(closure: () => Promise<T>): Promise<T>;
};

/** Runs synchronous operations immediately when idle and holds queued calls behind a transaction. */
class SerialQueue {
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;

	run<T>(operation: () => T | Promise<T>): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		try {
			return Promise.resolve(operation());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	hold<T>(operation: () => Promise<T>): Promise<T> {
		return this.enqueue(operation);
	}

	private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
		this.pending++;
		const result = this.tail.then(operation).finally(() => {
			this.pending--;
		});
		this.tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}
}

const storageQueues = new WeakMap<DurableObjectSqliteStorage, SerialQueue>();

function queueFor(storage: DurableObjectSqliteStorage): SerialQueue {
	let queue = storageQueues.get(storage);
	if (queue === undefined) {
		queue = new SerialQueue();
		storageQueues.set(storage, queue);
	}
	return queue;
}

/** Durable Object SQL binds numbers as doubles: a `bigint` outside the safe integer range would lose precision. */
function bindValue(value: SqliteValue): DurableObjectSqlValue {
	if (value instanceof Uint8Array) return value.slice().buffer as ArrayBuffer;
	if (typeof value !== "bigint") return value;
	if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError(`Durable Object SQL cannot bind ${value} without losing precision`);
	}
	return Number(value);
}

const bind = (params: readonly SqliteValue[]): DurableObjectSqlValue[] => params.map(bindValue);

/** A row as returned, with `BLOB` columns converted to `Uint8Array` in place; no other copy is made. */
function row<T>(row: Record<string, DurableObjectSqlValue>): T {
	for (const key in row) {
		const value = row[key];
		if (value instanceof ArrayBuffer) (row as Record<string, unknown>)[key] = new Uint8Array(value);
	}
	return row as T;
}

/** Executes SQL through `ctx.storage.sql`, which has no separate prepare step. */
class DurableObjectSqliteExecutor implements SqliteExecutor {
	protected readonly storage: DurableObjectSqliteStorage;

	constructor(storage: DurableObjectSqliteStorage) {
		this.storage = storage;
	}

	async exec(sql: string): Promise<void> {
		this.check();
		this.storage.sql.exec(sql);
	}

	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		this.check();
		this.storage.sql.exec(sql, ...bind(params));
	}

	async runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
		this.check();
		this.storage.sql.exec(sql, ...bind(params));
		// The cursor's `rowsWritten` is a billing count that includes index writes; SQLite's own count is exact.
		const counted = this.storage.sql.exec("SELECT changes() AS changes").next();
		return counted.done ? 0 : Number(counted.value.changes);
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		this.check();
		const result = this.storage.sql.exec(sql, ...bind(params)).next();
		return result.done ? undefined : row<T>(result.value);
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		this.check();
		return this.storage.sql
			.exec(sql, ...bind(params))
			.toArray()
			.map((value) => row<T>(value));
	}

	/** Throws when this handle may no longer run SQL. */
	protected check(): void {}
}

/** The handle a transaction callback receives; invalid once the callback settles. */
class DurableObjectSqliteTransaction extends DurableObjectSqliteExecutor {
	active = true;

	protected override check(): void {
		if (!this.active) throw new Error("SQLite transaction handle is no longer active");
	}
}

/**
 * `SqliteDatabase` adapter for the SQLite storage of a Cloudflare Durable Object. Adapters given the same storage
 * object share a queue; direct calls to the underlying storage bypass it. Integers are JavaScript numbers; binding a
 * `bigint` outside the safe integer range throws.
 */
export class DurableObjectSqliteDatabase extends DurableObjectSqliteExecutor implements SqliteDatabase {
	private readonly queue: SerialQueue;

	constructor(storage: DurableObjectSqliteStorage) {
		super(storage);
		this.queue = queueFor(storage);
	}

	override exec(sql: string): Promise<void> {
		return this.queue.run(() => super.exec(sql));
	}

	override run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.queue.run(() => super.run(sql, ...params));
	}

	override runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
		return this.queue.run(() => super.runCounted(sql, ...params));
	}

	override get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.queue.run(() => super.get<T>(sql, ...params));
	}

	override all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.queue.run(() => super.all<T>(sql, ...params));
	}

	/** `ctx.storage.transaction()` commits when the callback resolves and rolls back when it rejects. */
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.queue.hold(() =>
			this.storage.transaction(async () => {
				const transaction = new DurableObjectSqliteTransaction(this.storage);
				try {
					return await callback(transaction);
				} finally {
					transaction.active = false;
				}
			}),
		);
	}

	/** Waits for queued work. The Durable Object owns its storage, so nothing else closes. */
	close(): Promise<void> {
		return this.queue.run(() => {});
	}
}
