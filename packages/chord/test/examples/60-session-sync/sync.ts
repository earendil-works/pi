// STAND-IN for the laptop's sync layer, not a Chord API: the decided handshake (ask Radius for `lastSeq`, send the
// outbox from `lastSeq + 1`, trim through the answer), the bootstrap from an archive, the eager upload of new commits
// after the last acknowledgement (S5), the split on an old epoch (S7) and the pull of Radius's commits. Built on
// Chord's real pieces: `store.outbox.read`/`trim`, `store.export`, `encodeJsonl`, and `applyBatch` (internal).
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { applyBatch } from "../../../src/store/apply-batch.ts";
import { encodeJsonl, type OutboxCommit, type Store } from "../../../src/store/index.ts";
import type { ChordStore } from "../../../src/store/store.ts";
import type { Batch, RadiusStandIn } from "./radius.ts";

/** A session on the laptop: its id, store, the epoch it drives in (a new session: 1) and the `lastSeq` Radius last acknowledged. */
export type LocalSession = {
	readonly id: string;
	readonly store: Store;
	epoch: number;
	acked: number;
	/** A split-off copy's origin: the session it was and the last seq they share (S7). */
	readonly origin?: { readonly id: string; readonly seq: number };
};

/** What a sync or a push did. */
export type Synced =
	| { readonly kind: "uploaded"; readonly from: number; readonly to: number; readonly lastSeq: number }
	| { readonly kind: "nothing"; readonly lastSeq: number }
	| { readonly kind: "bootstrapped"; readonly lastSeq: number; readonly bytes: number }
	| { readonly kind: "behind"; readonly lastSeq: number }
	| { readonly kind: "split"; readonly session: LocalSession }
	| { readonly kind: "refused"; readonly message: string };

const DRIVER = "laptop";

/** The handshake, then the outbox from Radius's `lastSeq + 1`; an archive when Radius has less than the outbox. */
export async function sync(session: LocalSession, radius: RadiusStandIn): Promise<Synced> {
	const { store } = session;
	const outbox = store.outbox!;
	const known = radius.handshake()[session.id];
	if (known === undefined && outbox.floor > 0) return bootstrap(session, radius);
	if (known !== undefined && known.lastSeq < outbox.floor) return bootstrap(session, radius);
	// Radius ahead: a pull-back (S3, same epoch) or a split (S7); step 6 pulls explicitly.
	if (known !== undefined && known.lastSeq > store.lastSeq) return { kind: "behind", lastSeq: known.lastSeq };
	session.acked = known?.lastSeq ?? 0;
	await outbox.trim(session.acked, context);
	return push(session, radius);
}

/** Uploads the outbox after the last acknowledgement, without asking first (an eager or resubmitted upload, S5). */
export async function push(session: LocalSession, radius: RadiusStandIn): Promise<Synced> {
	const { store } = session;
	const commits = await store.outbox!.read(session.acked, 10_000, context);
	if (commits.length === 0) return { kind: "nothing", lastSeq: session.acked };
	const batch: Batch = { from: commits[0]!.seq, to: commits.at(-1)!.seq, epoch: session.epoch, commits };
	const answer = await radius.upload(session.id, DRIVER, JSON.stringify(batch));
	switch (answer.kind) {
		case "applied":
			session.acked = answer.lastSeq;
			session.epoch = answer.epoch;
			await store.outbox!.trim(answer.lastSeq, context);
			return { kind: "uploaded", from: batch.from, to: batch.to, lastSeq: answer.lastSeq };
		case "refused":
			if (answer.reason === "batch") return { kind: "refused", message: answer.message };
			// S7: no rollback; this copy goes on as a new session that shares the old one's commits through `acked`.
			return {
				kind: "split",
				session: {
					id: `${session.id}~split@${session.acked}`,
					store,
					epoch: 1,
					acked: 0,
					origin: { id: session.id, seq: session.acked },
				},
			};
	}
}

/** Uploads the store's archive; Radius imports it and batches go on from its `lastSeq`. */
async function bootstrap(session: LocalSession, radius: RadiusStandIn): Promise<Synced> {
	const bytes = await archiveOf(session.store);
	const known = await radius.bootstrap(session.id, DRIVER, bytes);
	session.acked = known.lastSeq;
	session.epoch = known.epoch;
	await session.store.outbox!.trim(known.lastSeq, context);
	return { kind: "bootstrapped", lastSeq: known.lastSeq, bytes: bytes.length };
}

/** Applies Radius's commits after the local `lastSeq` (no host may be open on the store: its claims refuse a batch). */
export async function pull(session: LocalSession, radius: RadiusStandIn): Promise<{ from: number; to: number }> {
	const commits = JSON.parse(radius.pull(session.id, session.store.lastSeq)) as OutboxCommit[];
	const from = session.store.lastSeq + 1;
	await applyBatch(session.store as ChordStore, commits, context);
	// Batch apply writes the commits to this store's outbox too; Radius has them, so they are acknowledged.
	session.acked = session.store.lastSeq;
	await session.store.outbox!.trim(session.acked, context);
	return { from, to: session.store.lastSeq };
}

/** The store's archive as JSONL bytes (the commit queue held while it is read). */
export async function archiveOf(store: Store): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for await (const part of encodeJsonl(store.export(context))) parts.push(part);
	return Buffer.concat(parts);
}
