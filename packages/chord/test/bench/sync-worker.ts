// The Durable Objects of the sync memory benchmark (`sync-memory.ts`), one Chord store each on the object's own SQLite
// storage (`chord/sqlite/cloudflare`), as a deployment has them:
//   - `Origin`: the copy that commits and uploads, and the remote, its slots and bodies in its SQLite (`SqlRemote`);
//   - `Replica`: a copy restored by a pull, through the origin's remote over RPC;
//   - `Folder`: folds the origin's history into a snapshot, its scratch store on its own SQLite.
// Bodies cross objects as byte streams and are stored in parts, so what an object holds is what the sync layer holds.
// The benchmark drives the objects over `fetch` and reads the isolate's heap through the inspector.

import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, str } from "../../src/contracts/index.ts";
import { DurableObjectSqliteDatabase } from "../../src/sqlite/cloudflare.ts";
import { sqliteBackend } from "../../src/store/backend.ts";
import { LiveQueries } from "../../src/store/live-query.ts";
import type { StagedWrite } from "../../src/store/step.ts";
import { type ChordStore, openStore } from "../../src/store/store.ts";
import { defineTable } from "../../src/store/table.ts";
import { TableChanges } from "../../src/store/table-changes.ts";
import { TableHandle } from "../../src/store/table-handle.ts";
import { prepareTables } from "../../src/store/table-migration.ts";
import {
	type BatchInfo,
	foldSession,
	type JsonObject,
	type PutBatchResult,
	pullSession,
	type RemoteListing,
	remoteHead,
	type Seq,
	type SessionChanges,
	type SessionSyncMaintenance,
	type SyncBody,
	type SyncState,
	type SyncStateStore,
	uploadSession,
} from "../../src/sync/index.ts";

// The parts of the Workers runtime this bench uses, typed here: full Workers types would clash with the repository's
// Node types, and `DurableObject` (packages/codemode/src/cloudflare-modules.d.ts) leaves `ctx` untyped.
type SqlValue = string | number | null | ArrayBuffer | Uint8Array;
type SqlCursor<T> = { toArray(): T[]; one(): T };
type SqlStorage = { exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T> };
type ObjectStorage = {
	readonly sql: SqlStorage;
	transaction<T>(closure: () => Promise<T>): Promise<T>;
	transactionSync<T>(closure: () => T): T;
};
type ObjectState = { readonly storage: ObjectStorage };
type ObjectId = unknown;
type Namespace<T> = { idFromName(name: string): ObjectId; get(id: ObjectId): T };

/** A Durable Object of this bench: the runtime's base class with its `ctx` typed. */
const BenchObject = DurableObject as unknown as abstract new (
	ctx: ObjectState,
	env: Env,
) => { readonly ctx: ObjectState; readonly env: Env };

type Env = {
	readonly ORIGIN: Namespace<Origin>;
	readonly REPLICA: Namespace<Replica>;
	readonly FOLDER: Namespace<Folder>;
};

const Rows = defineTable("rows", { version: 1, columns: { id: str(), n: int(), text: str() }, key: ["id"] });
const TABLE = "bench.sync:rows";
const OPEN = { admit: () => true, adopt: () => {} };
const owner = { label: "bench", scope: {}, queries: new LiveQueries(), assertLive: () => {}, fail: () => {} };
/** Where a stored body is split into rows: below the object's 2 MB value limit. */
const PART = 512 * 1024;

/** The isolate's own GC (the benchmark starts workerd with `--expose-gc`), so a step starts from a settled heap. */
const collect = (): void => (globalThis as { gc?: () => void }).gc?.();

/** A body as a byte stream, for RPC. */
function toStream(body: SyncBody): ReadableStream<Uint8Array> {
	const iterator = body[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = await iterator.next();
			if (next.done) controller.close();
			else controller.enqueue(next.value);
		},
		async cancel() {
			await iterator.return?.();
		},
	});
}

/** A byte stream from RPC as a body. */
async function* fromStream(stream: ReadableStream<Uint8Array>): SyncBody {
	const reader = stream.getReader();
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) return;
			yield next.value;
		}
	} finally {
		reader.releaseLock();
	}
}

type SlotRow = { after: number; upto: number; device: string; archive: number; folded: number };

/**
 * A remote in an object's SQLite storage, in tables of its own beside the store's: slots, and bodies written and read
 * back a part at a time as they stream.
 */
class SqlRemote implements SessionSyncMaintenance {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
		sql.exec(`CREATE TABLE IF NOT EXISTS r_slots (after INTEGER PRIMARY KEY, upto INTEGER, device TEXT, archive INTEGER, folded INTEGER);
			CREATE TABLE IF NOT EXISTS r_parts (kind TEXT, at INTEGER, part INTEGER, data BLOB, PRIMARY KEY (kind, at, part));
			CREATE TABLE IF NOT EXISTS r_snapshots (upto INTEGER PRIMARY KEY);`);
	}

	async putBatch(
		_session: string,
		after: Seq,
		to: Seq,
		device: string,
		body: SyncBody,
		_context: unknown,
		options: { readonly archive?: boolean } = {},
	): Promise<PutBatchResult> {
		const existing = this.#sql
			.exec<{ upto: number; device: string }>("SELECT upto, device FROM r_slots WHERE after = ?", after)
			.toArray()[0];
		if (existing) return { type: "exists", to: existing.upto, device: existing.device };
		const head = remoteHead(await this.list());
		if (after !== head) return { type: "not_head", head };
		await this.#write("batch", after, body);
		this.#sql.exec("INSERT INTO r_slots VALUES (?, ?, ?, ?, 0)", after, to, device, options.archive ? 1 : 0);
		return { type: "created" };
	}

	async getBatch(_session: string, after: Seq): Promise<SyncBody | undefined> {
		const slot = this.#sql.exec<{ folded: number }>("SELECT folded FROM r_slots WHERE after = ?", after).toArray()[0];
		return slot && !slot.folded ? this.#read("batch", after) : undefined;
	}

	async getSnapshot(_session: string, to: Seq): Promise<SyncBody | undefined> {
		return this.#sql.exec("SELECT 1 FROM r_snapshots WHERE upto = ?", to).toArray().length > 0
			? this.#read("snapshot", to)
			: undefined;
	}

	async putSnapshot(_session: string, to: Seq, body: SyncBody): Promise<void> {
		await this.#write("snapshot", to, body);
		this.#sql.exec("INSERT OR REPLACE INTO r_snapshots VALUES (?)", to);
	}

	async foldBatches(_session: string, afters: readonly Seq[]): Promise<void> {
		for (const after of afters) {
			this.#sql.exec("UPDATE r_slots SET folded = 1 WHERE after = ?", after);
			this.#sql.exec("DELETE FROM r_parts WHERE kind = 'batch' AND at = ?", after);
		}
	}

	async deleteSnapshots(_session: string, snapshots: readonly Seq[]): Promise<void> {
		for (const to of snapshots) {
			this.#sql.exec("DELETE FROM r_snapshots WHERE upto = ?", to);
			this.#sql.exec("DELETE FROM r_parts WHERE kind = 'snapshot' AND at = ?", to);
		}
	}

	async list(): Promise<RemoteListing> {
		const batches = this.#sql
			.exec<SlotRow>("SELECT after, upto, device, archive, folded FROM r_slots ORDER BY after")
			.toArray()
			.map(
				(slot): BatchInfo => ({
					after: slot.after,
					to: slot.upto,
					device: slot.device,
					...(slot.archive ? { archive: true as const } : {}),
					...(slot.folded ? { folded: true as const } : {}),
				}),
			);
		const snapshots = this.#sql
			.exec<{ upto: number }>("SELECT upto FROM r_snapshots")
			.toArray()
			.map((row) => row.upto);
		return { batches, snapshots };
	}

	async sessions(): Promise<SessionChanges> {
		return { sessions: [], cursor: "", more: false };
	}
	async putMeta(): Promise<void> {}
	async getMeta(): Promise<JsonObject | undefined> {
		return undefined;
	}

	/** Bytes the remote stores, all bodies together. */
	stored(): number {
		return this.#sql.exec<{ n: number }>("SELECT coalesce(sum(length(data)), 0) AS n FROM r_parts").one().n;
	}

	/** The body's chunks gathered into parts of `PART` bytes, one row each, as it streams. */
	async #write(kind: string, at: number, body: SyncBody): Promise<void> {
		this.#sql.exec("DELETE FROM r_parts WHERE kind = ? AND at = ?", kind, at);
		let part = 0;
		let pending: Uint8Array[] = [];
		let size = 0;
		const flush = () => {
			const data = new Uint8Array(size);
			let offset = 0;
			for (const chunk of pending) {
				data.set(chunk, offset);
				offset += chunk.length;
			}
			this.#sql.exec("INSERT INTO r_parts VALUES (?, ?, ?, ?)", kind, at, part++, data);
			pending = [];
			size = 0;
		};
		for await (const chunk of body) {
			pending.push(chunk);
			size += chunk.length;
			if (size >= PART) flush();
		}
		if (size > 0) flush();
	}

	/** The body's parts, read back one row at a time. */
	#read(kind: string, at: number): SyncBody {
		const sql = this.#sql;
		return (async function* () {
			for (let part = 0; ; part++) {
				const row = sql
					.exec<{ data: ArrayBuffer }>(
						"SELECT data FROM r_parts WHERE kind = ? AND at = ? AND part = ?",
						kind,
						at,
						part,
					)
					.toArray()[0];
				if (!row) return;
				yield new Uint8Array(row.data);
			}
		})();
	}
}

/** The origin's remote seen from another object: its calls over RPC, bodies as byte streams. */
class RpcRemote implements SessionSyncMaintenance {
	readonly #origin: Origin;

	constructor(origin: Origin) {
		this.#origin = origin;
	}

	async putBatch(): Promise<PutBatchResult> {
		throw new Error("The benchmark uploads only at the origin");
	}
	async getBatch(_session: string, after: Seq): Promise<SyncBody | undefined> {
		const stream = await this.#origin.getBatch(after);
		return stream === null ? undefined : fromStream(stream);
	}
	async getSnapshot(_session: string, to: Seq): Promise<SyncBody | undefined> {
		const stream = await this.#origin.getSnapshot(to);
		return stream === null ? undefined : fromStream(stream);
	}
	async putSnapshot(_session: string, to: Seq, body: SyncBody): Promise<void> {
		await this.#origin.putSnapshot(to, toStream(body));
	}
	async foldBatches(_session: string, afters: readonly Seq[]): Promise<void> {
		await this.#origin.foldBatches([...afters]);
	}
	async deleteSnapshots(_session: string, snapshots: readonly Seq[]): Promise<void> {
		await this.#origin.deleteSnapshots([...snapshots]);
	}
	async list(): Promise<RemoteListing> {
		return (await this.#origin.list()) as RemoteListing;
	}
	async sessions(): Promise<SessionChanges> {
		return { sessions: [], cursor: "", more: false };
	}
	async putMeta(): Promise<void> {}
	async getMeta(): Promise<JsonObject | undefined> {
		return undefined;
	}
}

class MemoryState implements SyncStateStore {
	#state: SyncState | undefined;
	async get(): Promise<SyncState | undefined> {
		return this.#state;
	}
	async set(_session: string, state: SyncState): Promise<void> {
		this.#state = state;
	}
}

/**
 * This object's SQLite storage as a store backend. Durable Object SQLite refuses `PRAGMA encoding` and
 * `pragma_encoding` (`SQLITE_AUTH`), which `openStore` reads for its UTF-8 check; its databases are always UTF-8, so
 * the benchmark answers that one query itself. (A store bug, to fix in `openStore` or the Cloudflare adapter.)
 */
function backendOf(storage: ObjectStorage) {
	const rewrite = (query: string) =>
		query
			.replace(/^PRAGMA encoding$/, "SELECT 'UTF-8' AS encoding")
			.replace(/pragma_encoding e\b/, "(SELECT 'UTF-8' AS encoding) e");
	const sql = storage.sql;
	const wrapped = {
		sql: { exec: (query: string, ...bindings: SqlValue[]) => sql.exec(rewrite(query), ...bindings) },
		transaction: <T>(closure: () => Promise<T>) => storage.transaction(closure),
		transactionSync: <T>(closure: () => T) => storage.transactionSync(closure),
	};
	return sqliteBackend(new DurableObjectSqliteDatabase(wrapped as never));
}

/** Deterministic text that compresses about as transcript text does (about 2:1), not to nothing. */
function text(size: number, seed: number): string {
	let state = seed * 2654435761 + 1;
	const words = ["the", "agent", "reads", "a", "file", "and", "writes", "tests", "for", "it", "then", "runs"];
	let out = "";
	while (out.length < size) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		out += `${words[(state >>> 0) % words.length]} ${(state >>> 8) & 0xffff} `;
	}
	return out.slice(0, size);
}

export class Origin extends BenchObject {
	#remote = new SqlRemote(this.ctx.storage.sql);

	/** `count` commits of one row of `size` characters each. */
	async fill(count: number, size: number): Promise<{ lastSeq: number }> {
		collect();
		const store = await openStore(backendOf(this.ctx.storage), context, { outbox: true });
		try {
			const chord = store as ChordStore;
			await prepareTables([{ definition: Rows, table: TABLE }], chord, OPEN, "bench.sync", context);
			const handle = new TableHandle(Rows, TABLE, chord, owner);
			for (let index = 0; index < count; index++) {
				const staged: StagedWrite[] = [];
				new TableChanges(handle, staged).put({ id: `r${index}`, n: index, text: text(size, index) });
				await chord.commit(staged, OPEN, context);
			}
			return { lastSeq: store.lastSeq };
		} finally {
			await store.close(context);
		}
	}

	async upload(): Promise<unknown> {
		collect();
		const store = await openStore(backendOf(this.ctx.storage), context, { outbox: true });
		try {
			const result = await uploadSession({
				sessionId: "s",
				device: "origin",
				source: store,
				store: this.#remote,
				state: new MemoryState(),
				context,
			});
			return { result, slots: (await this.#remote.list()).batches.length, stored: this.#remote.stored() };
		} finally {
			await store.close(context);
		}
	}

	async getBatch(after: number): Promise<ReadableStream<Uint8Array> | null> {
		const body = await this.#remote.getBatch("s", after);
		return body === undefined ? null : toStream(body);
	}
	async getSnapshot(to: number): Promise<ReadableStream<Uint8Array> | null> {
		const body = await this.#remote.getSnapshot("s", to);
		return body === undefined ? null : toStream(body);
	}
	async putSnapshot(to: number, stream: ReadableStream<Uint8Array>): Promise<void> {
		await this.#remote.putSnapshot("s", to, fromStream(stream));
	}
	async foldBatches(afters: number[]): Promise<void> {
		await this.#remote.foldBatches("s", afters);
	}
	async deleteSnapshots(snapshots: number[]): Promise<void> {
		await this.#remote.deleteSnapshots("s", snapshots);
	}
	async list(): Promise<RemoteListing> {
		return this.#remote.list();
	}
}

export class Replica extends BenchObject {
	/** Restores the session from the origin's remote into this object's empty storage. */
	async pull(origin: string): Promise<unknown> {
		collect();
		const remote = new RpcRemote(this.env.ORIGIN.get(this.env.ORIGIN.idFromName(origin)));
		const pulled = await pullSession({
			sessionId: "s",
			store: remote,
			local: { kind: "empty", backend: backendOf(this.ctx.storage) },
			state: new MemoryState(),
			context,
		});
		await pulled.store.close(context);
		return { head: pulled.head };
	}
}

export class Folder extends BenchObject {
	/** Folds the origin's history into a snapshot, restoring it into this object's empty storage as scratch. */
	async fold(origin: string): Promise<unknown> {
		collect();
		const remote = new RpcRemote(this.env.ORIGIN.get(this.env.ORIGIN.idFromName(origin)));
		return {
			folded: await foldSession({ sessionId: "s", store: remote, scratch: backendOf(this.ctx.storage), context }),
		};
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const run = url.searchParams.get("run") ?? "bench";
		const count = Number(url.searchParams.get("count") ?? 0);
		const size = Number(url.searchParams.get("size") ?? 0);
		const started = Date.now();
		let result: unknown;
		switch (url.pathname) {
			case "/gc":
				// Every object of the benchmark shares this isolate: one full GC here settles the heap for the next step.
				collect();
				return new Response("ok");
			case "/fill":
				result = await env.ORIGIN.get(env.ORIGIN.idFromName(run)).fill(count, size);
				break;
			case "/upload":
				result = await env.ORIGIN.get(env.ORIGIN.idFromName(run)).upload();
				break;
			case "/pull":
				result = await env.REPLICA.get(env.REPLICA.idFromName(run)).pull(run);
				break;
			case "/fold":
				result = await env.FOLDER.get(env.FOLDER.idFromName(run)).fold(run);
				break;
			default:
				return new Response("unknown step", { status: 404 });
		}
		return Response.json({ ms: Date.now() - started, result });
	},
};
