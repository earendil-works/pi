// STAND-IN for Radius, not a Chord API: what example 60 needs of the server side of session sync, in memory. Per
// session id it keeps a replica store (SQLite in memory, as a Durable Object's SQLite would be), the commit log (what
// R2 would hold; the replica's outbox is moved into it and trimmed after every change), the driver and its epoch.
// Batches and archives cross a "wire" as JSON and JSONL bytes, so the replica checks them as a trust boundary.
// `checkEpochs = false` turns the epoch fence off, to show what the gap analysis warned about.
import { Readable } from "node:stream";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { ChordError } from "../../../src/data/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
// Internal: the sync layer's batch apply (exported from `chord` marked internal) takes the `ChordStore` that
// `openStore` returns behind the app-facing `Store` type.
import { applyBatch } from "../../../src/store/apply-batch.ts";
import {
	decodeJsonl,
	importStore,
	type OutboxCommit,
	openStore,
	type Store,
	sqliteBackend,
} from "../../../src/store/index.ts";
import type { ChordStore } from "../../../src/store/store.ts";

/** What the handshake reports per session: Radius's applied head, the epoch and who drives. */
export type Known = { readonly lastSeq: number; readonly epoch: number; readonly driver: string };

/** A batch as it travels: the commits `from..to` and the uploader's epoch (S5: every batch carries `from` and `to`). */
export type Batch = {
	readonly from: number;
	readonly to: number;
	readonly epoch: number;
	readonly commits: readonly OutboxCommit[];
};

/** An upload's answer: applied (the new head is the acknowledgement) or refused, for an old epoch or by the replica. */
export type Uploaded =
	| { readonly kind: "applied"; readonly lastSeq: number; readonly epoch: number }
	| { readonly kind: "refused"; readonly reason: "epoch"; readonly epoch: number }
	| { readonly kind: "refused"; readonly reason: "batch"; readonly message: string };

type Entry = {
	readonly replica: Store;
	/** The commit log (R2's part): every commit after `logFloor` (the seq it was bootstrapped at). */
	readonly log: OutboxCommit[];
	readonly logFloor: number;
	epoch: number;
	driver: string;
};

/** The stand-in: sessions by id, for one owner. */
export class RadiusStandIn {
	/** The epoch fence (S7); off only to show the divergence without it. */
	checkEpochs = true;
	readonly #sessions = new Map<string, Entry>();

	/** The handshake: every session Radius has, with its `lastSeq`, epoch and driver. */
	handshake(): Record<string, Known> {
		const known: Record<string, Known> = {};
		for (const [id, { replica, epoch, driver }] of this.#sessions)
			known[id] = { lastSeq: replica.lastSeq, epoch, driver };
		return known;
	}

	/** Applies an uploaded batch (JSON) to the session's replica; a first batch from seq 1 makes the session. */
	async upload(id: string, driver: string, wire: string): Promise<Uploaded> {
		const batch = JSON.parse(wire) as Batch;
		let entry = this.#sessions.get(id);
		if (entry === undefined && batch.from === 1) entry = this.#create(id, driver, await openReplica());
		if (entry === undefined) return { kind: "refused", reason: "batch", message: "unknown session: bootstrap first" };
		if (this.checkEpochs && batch.epoch !== entry.epoch)
			return { kind: "refused", reason: "epoch", epoch: entry.epoch };
		try {
			await applyBatch(entry.replica as ChordStore, batch.commits, context);
		} catch (error) {
			if (!(error instanceof ChordError)) throw error;
			return { kind: "refused", reason: "batch", message: error.message };
		}
		await this.#moveToLog(entry);
		return { kind: "applied", lastSeq: entry.replica.lastSeq, epoch: entry.epoch };
	}

	/** Makes the session from an archive (JSONL bytes): its replica imported, the log starting at its `lastSeq`. */
	async bootstrap(id: string, driver: string, bytes: Uint8Array): Promise<Known> {
		const backend = sqliteBackend(await openNodeSqliteDatabase(":memory:"));
		const replica = await importStore(backend, decodeJsonl(Readable.from([bytes])), context, { outbox: true });
		const entry = this.#create(id, driver, replica);
		return { lastSeq: replica.lastSeq, epoch: entry.epoch, driver };
	}

	/** "Continue on Radius": a new epoch, Radius drives; an upload at the old epoch is refused from now on. */
	takeOver(id: string): number {
		const entry = this.#entry(id);
		entry.epoch += 1;
		entry.driver = "radius";
		return entry.epoch;
	}

	/** Radius as the driver: `work` writes on the replica (a host on it, closed again), its commits go to the log. */
	async drive(id: string, work: (replica: Store) => Promise<void>): Promise<void> {
		const entry = this.#entry(id);
		if (entry.driver !== "radius") throw new Error(`radius: ${id} is driven by ${entry.driver}`);
		await work(entry.replica);
		await this.#moveToLog(entry);
	}

	/** "Back to the laptop": a new epoch for `driver`; Radius stops writing. */
	handBack(id: string, driver: string): number {
		const entry = this.#entry(id);
		entry.epoch += 1;
		entry.driver = driver;
		return entry.epoch;
	}

	/** The log's commits after `afterSeq` (JSON), for a pull. */
	pull(id: string, afterSeq: number): string {
		const entry = this.#entry(id);
		if (afterSeq < entry.logFloor) throw new Error(`radius: ${id}'s log starts after ${entry.logFloor}`);
		return JSON.stringify(entry.log.filter((commit) => commit.seq > afterSeq));
	}

	/** The session's replica, to read it in the example. */
	replica(id: string): Store {
		return this.#entry(id).replica;
	}

	/** The seqs the log holds, as `from..to`. */
	logRange(id: string): string {
		const { log, logFloor } = this.#entry(id);
		return log.length === 0 ? `empty after ${logFloor}` : `${log[0]!.seq}..${log.at(-1)!.seq}`;
	}

	/** Closes every replica. */
	async close(): Promise<void> {
		for (const { replica } of this.#sessions.values()) await replica.close(context);
	}

	#create(id: string, driver: string, replica: Store): Entry {
		const entry: Entry = { replica, log: [], logFloor: replica.lastSeq, epoch: 1, driver };
		this.#sessions.set(id, entry);
		return entry;
	}

	#entry(id: string): Entry {
		const entry = this.#sessions.get(id);
		if (entry === undefined) throw new Error(`radius: no session ${id}`);
		return entry;
	}

	/** The replica's new commits into the log (the DO writing its commit log to R2), then trimmed from its outbox. */
	async #moveToLog(entry: Entry): Promise<void> {
		const outbox = entry.replica.outbox!;
		entry.log.push(...(await outbox.read(outbox.floor, 10_000, context)));
		await outbox.trim(entry.replica.lastSeq, context);
	}
}

/** A replica as Radius makes it for a session uploaded from seq 1: empty, its outbox on. */
async function openReplica(): Promise<Store> {
	return openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context, { outbox: true });
}
