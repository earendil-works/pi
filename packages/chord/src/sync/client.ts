// Session sync over a Chord store's outbox: upload the commits after the last sequence a copy shares with a remote
// into a slot the remote creates once, pull a copy forward with `applyBatch`, restore from an archive, fold history
// into snapshots, and decide when to upload. The remote and the host's sync state are interfaces (`remote.ts`).
//
// Bounded memory: bodies are streams (`batch.ts`). An upload reads the outbox a page at a time and stops a batch at
// `BATCH_BYTES`; a pull applies a batch in chunks of at most `APPLY_BYTES`; a snapshot is exported and imported as it
// streams. Nothing holds a whole batch, snapshot or store, so a Durable Object's isolate (128 MB) can run it.

import type { Context } from "../context/index.ts";
import { applyBatch } from "../store/apply-batch.ts";
import type { Backend } from "../store/backend.ts";
import { importStore } from "../store/import.ts";
import type { OutboxCommit } from "../store/outbox.ts";
import { type ChordStore, openStore, type Store } from "../store/store.ts";
import { decodeBatchLines, decodeSnapshot, encodeBatch, encodeSnapshot, type SyncBody } from "./batch.ts";
import {
	type BatchInfo,
	HistoryUnavailableError,
	LOG_START,
	type PutBatchResult,
	remoteHead,
	remoteHistory,
	type Seq,
	type SessionSyncMaintenance,
	type SessionSyncStore,
} from "./remote.ts";

/** Commits read from the outbox per page at most. */
const OUTBOX_PAGE = 100;
/** About how much one outbox page holds: the count of the next page follows the size of the commits read. */
const PAGE_BYTES = 1024 * 1024;
/**
 * Where an upload ends a batch: once its lines (before compression) reach this size. One commit larger than this is
 * a batch of its own.
 */
export const BATCH_BYTES = 8 * 1024 * 1024;
/** How much of a batch a pull holds before it applies it: commits are applied in chunks of about this size. */
export const APPLY_BYTES = 4 * 1024 * 1024;

/**
 * What a host keeps for each copy of a session it syncs: the last sequence the copy shares with the remote. Commits
 * after it are the copy's own and not uploaded yet. When this is lost, a copy without commits of its own takes the
 * remote's head; one with commits finds out by uploading.
 */
export type SyncState = {
	readonly syncedHead: Seq | undefined;
	/**
	 * Set while a pull applies a batch or snapshot ending here: a local head up to it holds the remote's commits, not
	 * the copy's own, even when the pull stopped partway.
	 */
	readonly pulling?: Seq;
};

/** The last sequence a copy shares with the remote, counting commits an interrupted pull applied. */
function sharedHead(state: SyncState | undefined, local: Seq): Seq {
	if (state?.pulling !== undefined && local <= state.pulling) return local;
	return state?.syncedHead ?? LOG_START;
}

export interface SyncStateStore {
	get(sessionId: string, context: Context): Promise<SyncState | undefined>;
	set(sessionId: string, state: SyncState, context: Context): Promise<void>;
}

/** A store's head as a sequence: `lastSeq`, 0 for a store without commits. */
export function storeHead(store: Store): Seq {
	return store.lastSeq;
}

/** The store keeps no outbox, or its outbox no longer holds the commits a sync needs. */
export class OutboxUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OutboxUnavailableError";
	}
}

function outboxOf(store: Store) {
	if (store.outbox === undefined) {
		throw new OutboxUnavailableError("The session's store has no outbox: open it with { outbox: true } to sync it");
	}
	return store.outbox;
}

/** The outbox commits after `after`, a page of at most `limit`. */
export async function readOutbox(store: Store, after: Seq, limit: number, context: Context): Promise<OutboxCommit[]> {
	const outbox = outboxOf(store);
	if (after < outbox.floor) {
		throw new OutboxUnavailableError(`The outbox starts after ${outbox.floor}, past the synced head ${after}`);
	}
	return outbox.read(after, limit, context);
}

export type UploadResult =
	| { readonly type: "uploaded"; readonly head: Seq }
	/** Nothing was committed since the last upload. */
	| { readonly type: "idle" }
	/**
	 * Another device continued the session from `at` first. This copy's commits after `at` are a different history:
	 * the host renames the copy to a new session (forked from this one at `at`) and uploads it there, and the session
	 * itself restores into a fresh store.
	 */
	| { readonly type: "diverged"; readonly at: Seq }
	/**
	 * The copy lost commits it had uploaded, for example to a power loss: its head is below `syncedHead`. Its next
	 * commits would reuse their sequences, so nothing is uploaded. Pull what it lost before the copy commits again; a pull
	 * applies from the local head.
	 */
	| { readonly type: "behind"; readonly head: Seq; readonly syncedHead: Seq }
	/**
	 * The remote refused this device's epoch: another device holds the right to write the session now. Like
	 * `diverged`, the copy's commits after `at` are a different history, so the host forks the copy (S7).
	 */
	| { readonly type: "stale_epoch"; readonly at: Seq; readonly epoch: number };

/**
 * Upload what this copy committed since it last shared the remote's history, from the store's outbox, and trim the
 * outbox through what the remote acknowledged. Every device continues a session as its own; whichever creates the slot
 * first continues the session, so an upload that is acknowledged stays.
 *
 * A session the remote does not have yet, whose outbox does not reach back to its first commit (turned on later, or
 * trimmed, as for a copy renamed after it diverged), starts with an archive slot: the store's `export()` at its head.
 *
 * A slot this device created already is an upload whose response was lost: the remote has the history up to its end,
 * and the upload goes on from there.
 */
export async function uploadSession(options: {
	readonly sessionId: string;
	readonly device: string;
	readonly source: Store;
	readonly store: SessionSyncStore;
	readonly state: SyncStateStore;
	/** The writer's epoch, from whatever grants it (the remote, Radius); sent with every slot. */
	readonly epoch?: number;
	readonly context: Context;
}): Promise<UploadResult> {
	const { sessionId, device, source, store, state, epoch, context } = options;
	const outbox = outboxOf(source);
	let synced = sharedHead(await state.get(sessionId, context), storeHead(source));
	let uploaded: Seq | undefined;
	while (true) {
		// Read again on every pass: a slot this device already holds may end past what the copy still has.
		const head = storeHead(source);
		if (head < synced) return { type: "behind", head, syncedHead: synced };
		let to: Seq;
		let body: SyncBody;
		let archive = false;
		let close: (() => Promise<void>) | undefined;
		if (synced === LOG_START && outbox.floor > 0) {
			const snapshot = await exportSnapshot(source, context);
			to = snapshot.to;
			body = snapshot.body;
			close = snapshot.close;
			archive = true;
		} else {
			const range = await outboxRange(source, synced, context);
			if (range === undefined)
				return uploaded === undefined ? { type: "idle" } : { type: "uploaded", head: uploaded };
			to = range.to;
			body = encodeBatch(outboxCommits(source, synced, to, context));
		}
		const after = synced;
		let result: PutBatchResult;
		try {
			result = await store.putBatch(sessionId, after, to, device, body, context, {
				...(archive ? { archive } : {}),
				...(epoch === undefined ? {} : { epoch }),
			});
		} finally {
			// A remote that answered without reading the archive leaves the export holding the commit queue.
			await close?.();
		}
		// A history that does not end at `after` is another one too: the remote never held this copy's past `after`.
		if (result.type === "stale_epoch") return { type: "stale_epoch", at: after, epoch: result.epoch };
		if (result.type === "not_head") return { type: "diverged", at: after };
		if (result.type === "exists" && result.device !== device) return { type: "diverged", at: after };
		synced = result.type === "created" ? to : result.to;
		await state.set(sessionId, { syncedHead: synced }, context);
		const trimmable = Math.min(synced, source.lastSeq);
		if (trimmable > outbox.floor) await outbox.trim(trimmable, context);
		if (result.type === "created") uploaded = to;
	}
}

/**
 * Where the next batch after `after` ends: the outbox read a page at a time, holding one page, until the lines reach
 * `BATCH_BYTES` (one commit at least). Undefined when the outbox has nothing after `after`.
 */
async function outboxRange(store: Store, after: Seq, context: Context): Promise<{ readonly to: Seq } | undefined> {
	let to: Seq | undefined;
	let bytes = 0;
	const pages = new OutboxPages(store, after, context);
	for (let page = await pages.next(); page.length > 0; page = await pages.next()) {
		for (const commit of page) {
			if (to !== undefined && bytes + encodedSize(commit) > BATCH_BYTES) return { to };
			bytes += encodedSize(commit);
			to = commit.seq;
		}
		if (bytes >= BATCH_BYTES) break;
	}
	return to === undefined ? undefined : { to };
}

/** The outbox commits after `after` through `to`, a page at a time, as the body is read. */
async function* outboxCommits(store: Store, after: Seq, to: Seq, context: Context): AsyncGenerator<OutboxCommit> {
	const pages = new OutboxPages(store, after, context);
	let at = after;
	while (at < to) {
		const page = await pages.next();
		if (page.length === 0) throw new OutboxUnavailableError(`The outbox ends at ${at}, before ${to}`);
		for (const commit of page) {
			if (commit.seq > to) return;
			yield commit;
			at = commit.seq;
		}
	}
}

/**
 * Pages of the outbox after a sequence, each about `PAGE_BYTES`: the outbox reads by count, so the next page's count
 * follows the commits read so far (`OUTBOX_PAGE` to start, one commit at least). A run of large commits reads one at a
 * time instead of `OUTBOX_PAGE` of them at once.
 */
class OutboxPages {
	readonly #store: Store;
	readonly #context: Context;
	#after: Seq;
	#limit = OUTBOX_PAGE;
	#done = false;

	constructor(store: Store, after: Seq, context: Context) {
		this.#store = store;
		this.#after = after;
		this.#context = context;
	}

	async next(): Promise<OutboxCommit[]> {
		if (this.#done) return [];
		const page = await readOutbox(this.#store, this.#after, this.#limit, this.#context);
		if (page.length < this.#limit) this.#done = true;
		if (page.length === 0) return page;
		this.#after = page.at(-1)!.seq;
		const average = page.reduce((size, commit) => size + encodedSize(commit), 0) / page.length;
		this.#limit = Math.max(1, Math.min(OUTBOX_PAGE, Math.floor(PAGE_BYTES / average)));
		return page;
	}
}

/** A commit's line size before compression, as `BATCH_BYTES` counts it. */
function encodedSize(commit: OutboxCommit): number {
	return JSON.stringify(commit.writes).length + 64;
}

/** A snapshot of a store being exported: where it ends, its body, and `close()` for when the body is not read to the end. */
type ExportedSnapshot = { readonly to: Seq; readonly body: SyncBody; close(): Promise<void> };

/**
 * The store's state as a streamed snapshot body. The export holds the store's commit queue from its first part until
 * the body is read to the end or `close()` is called, so `to` (its manifest's `lastSeq`) is exactly what it holds.
 */
async function exportSnapshot(store: Store, context: Context): Promise<ExportedSnapshot> {
	const parts = store.export(context);
	const first = await parts.next();
	if (first.done || first.value.kind !== "manifest") {
		await parts.return?.(undefined);
		throw new Error("A store export does not start with its manifest");
	}
	const manifest = first.value;
	return {
		to: manifest.lastSeq,
		body: encodeSnapshot(
			(async function* () {
				yield manifest;
				yield* parts;
			})(),
		),
		close: async () => {
			await parts.return?.(undefined);
		},
	};
}

/**
 * Apply a batch body to `store` as it streams, in chunks of about `APPLY_BYTES`, skipping the commits the store has
 * (a pull resuming inside a batch). Each chunk is one `applyBatch()` transaction; a pull stopped between chunks
 * resumes after the last applied one.
 */
async function applyBody(store: ChordStore, body: SyncBody, context: Context): Promise<void> {
	let chunk: OutboxCommit[] = [];
	let bytes = 0;
	for await (const line of decodeBatchLines(body)) {
		if (line.commit.seq <= store.lastSeq) continue;
		chunk.push(line.commit);
		bytes += line.bytes;
		if (bytes >= APPLY_BYTES) {
			await applyBatch(store, chunk, context);
			chunk = [];
			bytes = 0;
		}
	}
	if (chunk.length > 0) await applyBatch(store, chunk, context);
}

/** This copy has commits it has not uploaded: upload them first, which may find that the copy diverged. */
export class UnsyncedCommitsError extends Error {
	constructor(sessionId: string, localHead: Seq, syncedHead: Seq) {
		super(
			`This copy of session ${sessionId} is at ${localHead}, past what it shares with the remote (${syncedHead})`,
		);
		this.name = "UnsyncedCommitsError";
	}
}

/** The copy a pull applies to: an open store, or an empty backend to restore the session into. */
export type LocalCopy =
	| { readonly kind: "store"; readonly store: Store }
	| { readonly kind: "empty"; readonly backend: Backend };

/**
 * Apply what the remote has after the local head; into an empty backend, that restores the session (from an archive
 * when the history starts with one) and opens its store with an outbox. Resolves with the store, which the caller
 * owns and closes. Nothing may hold the store's claims (no `StoreStorage`, no Harness): `applyBatch()` refuses then.
 *
 * A copy with commits it has not uploaded rejects with `UnsyncedCommitsError` instead of getting the remote's commits
 * spliced onto its own. A copy whose history folding removed rejects with `HistoryUnavailableError` and restores into
 * a fresh backend.
 */
export async function pullSession(options: {
	readonly sessionId: string;
	readonly store: SessionSyncStore;
	readonly local: LocalCopy;
	readonly state: SyncStateStore;
	readonly context: Context;
}): Promise<{ readonly store: Store; readonly head: Seq }> {
	const { sessionId, store: remote, local, state, context } = options;
	const listing = await remote.list(sessionId, context);
	let target: Store | undefined = local.kind === "store" ? local.store : undefined;
	const at = () => (target === undefined ? LOG_START : storeHead(target));
	const synced = sharedHead(await state.get(sessionId, context), at());
	if (at() > synced) throw new UnsyncedCommitsError(sessionId, at(), synced);
	const history = remoteHistory(listing, at());
	try {
		const bodies: { readonly to: Seq; readonly archive: boolean; read(): Promise<SyncBody | undefined> }[] = [];
		if (history.snapshot !== undefined) {
			const snapshot = history.snapshot;
			bodies.push({ to: snapshot, archive: true, read: () => remote.getSnapshot(sessionId, snapshot, context) });
		}
		for (const batch of history.batches) {
			bodies.push({
				to: batch.to,
				archive: batch.archive === true,
				read: () => remote.getBatch(sessionId, batch.after, context),
			});
		}
		for (const body of bodies) {
			if (body.to <= at()) continue;
			const bytes = await body.read();
			if (bytes === undefined) throw new HistoryUnavailableError(at());
			await state.set(sessionId, { syncedHead: at(), pulling: body.to }, context);
			if (body.archive) {
				// An archive restores a whole store: only into an empty backend.
				if (target !== undefined || local.kind !== "empty") throw new HistoryUnavailableError(at());
				target = await importStore(local.backend, decodeSnapshot(bytes), context, { outbox: true });
			} else {
				if (target === undefined) {
					if (local.kind !== "empty") throw new Error("unreachable: a store copy always has a target");
					target = await openStore(local.backend, context, { outbox: true });
				}
				await applyBody(target as ChordStore, bytes, context);
			}
			await state.set(sessionId, { syncedHead: at() }, context);
		}
		if (target === undefined) {
			if (local.kind !== "empty") throw new Error("unreachable: a store copy always has a target");
			target = await openStore(local.backend, context, { outbox: true });
		}
		const head = at();
		if (head < remoteHead(listing)) throw new HistoryUnavailableError(head);
		await state.set(sessionId, { syncedHead: head }, context);
		// What the remote holds needs no upload: the outbox keeps only this copy's own commits.
		const outbox = target.outbox;
		if (outbox !== undefined && head > outbox.floor) await outbox.trim(head, context);
		return { store: target, head };
	} catch (error) {
		// A store this pull opened is the caller's only on success.
		if (local.kind === "empty" && target !== undefined) await target.close(context).catch(() => {});
		throw error;
	}
}

/**
 * Fold a session's history into one snapshot: restore it into `scratch` (an empty backend; a file or a Durable Object's
 * SQLite storage, not `:memory:`, so the restored store is not held in memory), upload its `export()` as a snapshot, drop the commits of the batches it covers, keeping their
 * slots taken, and delete older snapshots. The remote runs this, not clients.
 */
export async function foldSession(options: {
	readonly sessionId: string;
	readonly store: SessionSyncMaintenance;
	readonly scratch: Backend;
	readonly context: Context;
}): Promise<Seq | undefined> {
	const { sessionId, store, scratch, context } = options;
	const listing = await store.list(sessionId, context);
	const history = remoteHistory(listing);
	if (history.batches.length + (history.snapshot === undefined ? 0 : 1) < 2) return undefined;
	const restored = await pullSession({
		sessionId,
		store,
		local: { kind: "empty", backend: scratch },
		state: new ScratchState(),
		context,
	});
	try {
		const snapshot = await exportSnapshot(restored.store, context);
		try {
			await store.putSnapshot(sessionId, snapshot.to, snapshot.body, context);
		} finally {
			await snapshot.close();
		}
		await store.foldBatches(
			sessionId,
			history.batches.filter((batch: BatchInfo) => batch.to <= snapshot.to).map((batch) => batch.after),
			context,
		);
		await store.deleteSnapshots(
			sessionId,
			listing.snapshots.filter((at) => at < snapshot.to),
			context,
		);
		return snapshot.to;
	} finally {
		await restored.store.close(context);
	}
}

/** Sync state for a restore nobody continues. */
class ScratchState implements SyncStateStore {
	#state: SyncState | undefined;
	async get(): Promise<SyncState | undefined> {
		return this.#state;
	}
	async set(_sessionId: string, state: SyncState): Promise<void> {
		this.#state = state;
	}
}

export type FlushSchedulerOptions = {
	readonly flush: () => Promise<unknown>;
	/** Arms a timer and returns its disarm. */
	readonly setTimer: (callback: () => void, delayMs: number) => () => void;
	readonly now: () => number;
	/** A failed flush; the scheduler retries it with backoff. */
	readonly onError: (error: unknown) => void;
	/** Delay of an ordinary flush after a commit. Default 5 seconds. */
	readonly intervalMs?: number;
	/** Delay of a flush after an urgent commit. Default 200 milliseconds. */
	readonly urgentMs?: number;
	/** First retry delay after a failed flush, doubling up to `maxRetryMs`. Default 1 second. */
	readonly retryMs?: number;
	/** Default 1 minute. */
	readonly maxRetryMs?: number;
};

/**
 * Decides when to flush: some time after a commit, sooner after an urgent one, one flush at a time. Commits that arrive
 * during a flush keep their urgency and schedule the next one when it ends. A failed flush is retried with backoff
 * until one succeeds, so the last commits of a turn do not wait for the next commit.
 */
export class FlushScheduler {
	readonly #options: FlushSchedulerOptions;
	#due: number | undefined;
	#disarm: (() => void) | undefined;
	#running: Promise<void> | undefined;
	/** When the commits that arrived during a flush want the next one. */
	#pendingDue: number | undefined;
	#failures = 0;
	#closed = false;

	constructor(options: FlushSchedulerOptions) {
		this.#options = options;
	}

	/** A commit landed. */
	notify(urgent: boolean): void {
		if (this.#closed) return;
		const due = this.#options.now() + (urgent ? (this.#options.urgentMs ?? 200) : (this.#options.intervalMs ?? 5000));
		if (this.#running !== undefined) {
			this.#pendingDue = Math.min(this.#pendingDue ?? due, due);
			return;
		}
		this.#arm(due);
	}

	/** Flush now, after a flush underway, and stop scheduling. A failure rejects. */
	async close(): Promise<void> {
		this.#closed = true;
		this.#disarm?.();
		this.#disarm = undefined;
		this.#due = undefined;
		await this.#running;
		await this.#options.flush();
	}

	#arm(due: number): void {
		if (this.#due !== undefined && this.#due <= due) return;
		this.#disarm?.();
		this.#due = due;
		this.#disarm = this.#options.setTimer(() => void this.#run(), Math.max(0, due - this.#options.now()));
	}

	#run(): Promise<void> {
		this.#disarm = undefined;
		this.#due = undefined;
		this.#running = (async () => {
			let retry: number | undefined;
			try {
				await this.#options.flush();
				this.#failures = 0;
			} catch (error) {
				this.#options.onError(error);
				const delay = (this.#options.retryMs ?? 1000) * 2 ** this.#failures;
				this.#failures++;
				retry = this.#options.now() + Math.min(delay, this.#options.maxRetryMs ?? 60_000);
			} finally {
				this.#running = undefined;
			}
			if (this.#closed) return;
			const pending = this.#pendingDue;
			this.#pendingDue = undefined;
			// A retry waits for its backoff even when commits arrived: they flush with it.
			const due = retry ?? pending;
			if (due !== undefined) this.#arm(due);
		})();
		return this.#running;
	}
}
