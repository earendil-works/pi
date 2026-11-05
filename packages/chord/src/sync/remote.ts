import type { Context } from "../context/index.ts";
import type { SyncBody } from "./batch.ts";

/** A store's commit sequence (`store.lastSeq`, an outbox commit's `seq`); 0 is before every commit. */
export type Seq = number;

/** A JSON object: a session's description on the remote. */
export type JsonObject = { [key: string]: unknown };

/** The sequence before every commit: a store without commits is at it. */
export const LOG_START: Seq = 0;

/**
 * A slot of a session's remote history: the batch of outbox commits after `after`, up to `to`, uploaded by `device`. A
 * store creates each slot once and never replaces it, so the device whose upload creates it continues the session from
 * `after`, and a device that finds it taken by another one holds a different history.
 */
export type BatchInfo = {
	readonly after: Seq;
	readonly to: Seq;
	readonly device: string;
	/** Folding dropped its commits into a snapshot; the slot stays taken. */
	readonly folded?: true;
	/**
	 * The body is a store archive at `to` instead of commits: the first upload of a session whose outbox does not reach
	 * back to its first commit. Only the slot after 0 can be one.
	 */
	readonly archive?: true;
};

/** What a remote store holds for one session. A snapshot is a store archive at its sequence, folded from batches. */
export type RemoteListing = {
	readonly batches: readonly BatchInfo[];
	readonly snapshots: readonly Seq[];
};

export type PutBatchResult =
	| { readonly type: "created" }
	/** The slot is taken; by this device, after an upload whose response was lost, or by another one. */
	| { readonly type: "exists"; readonly to: Seq; readonly device: string }
	/**
	 * No slot starts at `after`, and the history does not end there: a slot there would branch the chain inside a batch
	 * or leave a gap. The uploader's history is not the remote's from `after` on.
	 */
	| { readonly type: "not_head"; readonly head: Seq }
	/**
	 * The upload's `epoch` is not the session's current one: another device was given the right to write the session
	 * since this one was. Who grants it, and when, is the remote's (RFC 0074's single writer); Chord only reports it.
	 */
	| { readonly type: "stale_epoch"; readonly epoch: number };

/** A session as the remote's listing describes it. */
export type SessionSummary = {
	readonly id: string;
	/** Where its history ends; `LOG_START` for a session with a description and no history. */
	readonly head: Seq;
	readonly meta: JsonObject | undefined;
};

/** Sessions changed after a cursor, and the cursor to continue from. */
export type SessionChanges = {
	readonly sessions: readonly SessionSummary[];
	/** Pass it to the next call; opaque. */
	readonly cursor: string;
	/** More changes follow right away: call again with `cursor`. */
	readonly more: boolean;
};

/** The client's view of a remote store. Clients never delete or fold. */
export interface SessionSyncStore {
	/**
	 * Create the slot after `after` unless it exists or the history does not end at `after`. `body` is a stream read once;
	 * a remote that answers without reading it (`exists`, `not_head`) leaves it unread.
	 */
	putBatch(
		sessionId: string,
		after: Seq,
		to: Seq,
		device: string,
		body: SyncBody,
		context: Context,
		options?: {
			readonly archive?: boolean;
			/** The writer's epoch: a remote that issues epochs refuses a stale one (`stale_epoch`); others ignore it. */
			readonly epoch?: number;
		},
	): Promise<PutBatchResult>;
	/** A batch's body; `undefined` when its slot is folded or absent. */
	getBatch(sessionId: string, after: Seq, context: Context): Promise<SyncBody | undefined>;
	getSnapshot(sessionId: string, to: Seq, context: Context): Promise<SyncBody | undefined>;
	list(sessionId: string, context: Context): Promise<RemoteListing>;
	/**
	 * The sessions changed after `cursor` (all of them without one). A remote may also list sessions that did not change,
	 * so a caller compares what it gets with what it has.
	 */
	sessions(cursor: string | undefined, context: Context): Promise<SessionChanges>;
	/**
	 * The host's description of a session (title, location, which device started it), outside its history: the last
	 * write wins, and it may be ahead of or behind the batches.
	 */
	putMeta(sessionId: string, meta: JsonObject, context: Context): Promise<void>;
	getMeta(sessionId: string, context: Context): Promise<JsonObject | undefined>;
}

/** The remote's own side: folding history into snapshots, which clients never do. */
export interface SessionSyncMaintenance extends SessionSyncStore {
	putSnapshot(sessionId: string, to: Seq, body: SyncBody, context: Context): Promise<void>;
	/** Drop the bodies of these slots, keeping the slots taken so nobody can create them again. */
	foldBatches(sessionId: string, afters: readonly Seq[], context: Context): Promise<void>;
	deleteSnapshots(sessionId: string, snapshots: readonly Seq[], context: Context): Promise<void>;
}

/** What a copy applies to reach the remote's head. */
export type RemoteHistory = {
	/** The snapshot a restore starts from. */
	readonly snapshot?: Seq;
	/**
	 * The batches to apply in order. The first may start before the copy's head, when a pull stopped inside it; its
	 * commits at or below the head are skipped.
	 */
	readonly batches: readonly BatchInfo[];
	/** Where applying them ends. */
	readonly head: Seq;
};

/** The remote's history no longer continues from a copy's head, after folding: restore into a fresh store. */
export class HistoryUnavailableError extends Error {
	constructor(head: Seq) {
		super(`The remote history does not continue from ${head}`);
		this.name = "HistoryUnavailableError";
	}
}

/**
 * The history a copy at `from` applies, or a restore without `from`. Slots are created once, so at most one batch
 * starts at each sequence and the history is a single chain.
 */
export function remoteHistory(listing: RemoteListing, from?: Seq): RemoteHistory {
	const chain = new Map(listing.batches.map((batch) => [batch.after, batch]));
	let snapshot: Seq | undefined;
	let at: Seq;
	const batches: BatchInfo[] = [];
	if (from === undefined || from === LOG_START) {
		snapshot = listing.snapshots.length === 0 ? undefined : (Math.max(...listing.snapshots) as Seq);
		at = snapshot ?? LOG_START;
	} else {
		at = from;
		// A pull that stopped inside a batch finishes it; only one batch can contain the head.
		const inside = listing.batches.find((batch) => batch.after < from && from < batch.to);
		if (inside !== undefined) {
			batches.push(inside);
			at = inside.to;
		}
	}
	for (let next = chain.get(at); next !== undefined; next = chain.get(at)) {
		batches.push(next);
		at = next.to;
	}
	return { ...(snapshot === undefined ? {} : { snapshot }), batches, head: at };
}

/** The furthest head the remote's history reaches. */
export function remoteHead(listing: RemoteListing): Seq {
	const chain = new Map(listing.batches.map((batch) => [batch.after, batch]));
	let at: Seq = LOG_START;
	for (let next = chain.get(at); next !== undefined; next = chain.get(at)) at = next.to;
	return at;
}
