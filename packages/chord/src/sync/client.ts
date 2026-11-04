// Session sync over a Chord store's outbox: upload the commits after the last sequence a copy shares with a remote
// into a slot the remote creates once, pull a copy forward with `applyBatch`, restore from an archive, fold history
// into snapshots, and decide when to upload. The remote and the host's sync state are interfaces (`remote.ts`); a
// directory-backed pair for Node is in `./node`.

import type { Context } from "../context/index.ts";
import { applyBatch } from "../store/apply-batch.ts";
import type { Backend } from "../store/backend.ts";
import { importStore } from "../store/import.ts";
import type { OutboxCommit } from "../store/outbox.ts";
import { type ChordStore, openStore, type Store } from "../store/store.ts";
import { decodeBatch, decodeSnapshot, encodeBatch, encodeSnapshot } from "./batch.ts";
import {
	type BatchInfo,
	HistoryUnavailableError,
	LOG_START,
	remoteHead,
	remoteHistory,
	type Seq,
	type SessionSyncMaintenance,
	type SessionSyncStore,
} from "./remote.ts";

/** Commits read from the outbox per uploaded batch. */
const BATCH_COMMITS = 1000;

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
	| { readonly type: "behind"; readonly head: Seq; readonly syncedHead: Seq };

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
	readonly context: Context;
}): Promise<UploadResult> {
	const { sessionId, device, source, store, state, context } = options;
	const outbox = outboxOf(source);
	let synced = sharedHead(await state.get(sessionId, context), storeHead(source));
	let uploaded: Seq | undefined;
	while (true) {
		// Read again on every pass: a slot this device already holds may end past what the copy still has.
		const head = storeHead(source);
		if (head < synced) return { type: "behind", head, syncedHead: synced };
		let to: Seq;
		let body: Uint8Array;
		let archive = false;
		if (synced === LOG_START && outbox.floor > 0) {
			const snapshot = await exportSnapshot(source, context);
			to = snapshot.to;
			body = snapshot.body;
			archive = true;
		} else {
			const commits = await readOutbox(source, synced, BATCH_COMMITS, context);
			if (commits.length === 0)
				return uploaded === undefined ? { type: "idle" } : { type: "uploaded", head: uploaded };
			to = commits.at(-1)!.seq;
			body = await encodeBatch(commits);
		}
		const after = synced;
		const result = await store.putBatch(sessionId, after, to, device, body, context, archive ? { archive } : {});
		// A history that does not end at `after` is another one too: the remote never held this copy's past `after`.
		if (result.type === "not_head") return { type: "diverged", at: after };
		if (result.type === "exists" && result.device !== device) return { type: "diverged", at: after };
		synced = result.type === "created" ? to : result.to;
		await state.set(sessionId, { syncedHead: synced }, context);
		const trimmable = Math.min(synced, source.lastSeq);
		if (trimmable > outbox.floor) await outbox.trim(trimmable, context);
		if (result.type === "created") uploaded = to;
	}
}

/** The store's state at its head as a snapshot body. `export()` holds the commit queue, so the head cannot move. */
async function exportSnapshot(
	store: Store,
	context: Context,
): Promise<{ readonly to: Seq; readonly body: Uint8Array }> {
	let to: Seq | undefined;
	const parts = store.export(context);
	const body = await encodeSnapshot(
		(async function* () {
			for await (const part of parts) {
				if (part.kind === "manifest") to = part.lastSeq;
				yield part;
			}
		})(),
	);
	if (to === undefined) throw new Error("A store export has no manifest");
	return { to, body };
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
		const bodies: { readonly to: Seq; readonly archive: boolean; read(): Promise<Uint8Array | undefined> }[] = [];
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
				target = await importStore(local.backend, await decodeSnapshot(bytes), context, { outbox: true });
			} else {
				if (target === undefined) {
					if (local.kind !== "empty") throw new Error("unreachable: a store copy always has a target");
					target = await openStore(local.backend, context, { outbox: true });
				}
				const from = target.lastSeq;
				const commits = (await decodeBatch(bytes)).filter((commit) => commit.seq > from);
				if (commits.length > 0) await applyBatch(target as ChordStore, commits, context);
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
 * Fold a session's history into one snapshot: restore it into `scratch` (an empty backend, for example an in-memory
 * SQLite database), upload its `export()` as a snapshot, drop the commits of the batches it covers, keeping their
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
		await store.putSnapshot(sessionId, snapshot.to, snapshot.body, context);
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
