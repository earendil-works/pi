// Batch apply (slice 6b §1.6, S5, S17): a replica takes commits `from..to` as an outbox gave them, in one backend
// transaction through the store's commit queue, each write applied with its commit's seq by the applier (a trust
// boundary), `lastSeq` and the allocator set from the last commit. Internal: the sync layer's entry point.

import type { Context } from "../../context/index.ts";
import type { SqliteExecutor } from "../../sqlite/index.ts";
import { invalid } from "../data/internal.ts";
import { IdAllocator } from "./allocator.ts";
import { applyWrite, Diverged } from "./applier.ts";
import { checkWrite } from "./archive.ts";
import { type TableRecord, writeCatalog } from "./catalog.ts";
import { OUTBOX_FORMAT, type OutboxCommit } from "./outbox.ts";
import { TABLES } from "./schema.ts";
import { Step } from "./step.ts";
import type { ChordStore, Replayed } from "./store.ts";

/**
 * Applies `commits` (from an outbox, in seq order) to `store`: refused while an owner holds a claim on it, once it
 * diverged, or when the first commit does not follow its `lastSeq` or one does not follow the one before; a write the
 * store's records refuse rolls the whole batch back (`invalid/args`); a recorded count the store does not reproduce
 * rolls it back and marks the store diverged, so every later batch is refused. Commits written to the store's outbox
 * too when it has one.
 */
export function applyBatch(store: ChordStore, commits: readonly OutboxCommit[], context: Context): Promise<void> {
	let checked: OutboxCommit[];
	try {
		checked = commits.map((commit, index) => checkCommit(commit, `batch: commit ${index}`, context));
	} catch (error) {
		return Promise.reject(error);
	}
	return store.replay(
		(executor, catalog) => replay(store, checked, executor, catalog),
		(error) => error instanceof Diverged,
	);
}

/** One commit's envelope and writes, checked (a trust boundary). */
function checkCommit(commit: OutboxCommit, what: string, context: Context): OutboxCommit {
	const { seq, nextId, writes } = commit as Partial<OutboxCommit>;
	if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(nextId) || !Array.isArray(writes)) {
		throw invalid("args", `${what}: not an outbox commit`);
	}
	return {
		seq: seq!,
		nextId: nextId!,
		writes: writes.map((write, index) => checkWrite(write, `${what}: write ${index}`, context)),
	};
}

/** The batch inside the store's turn: seqs continuous from `lastSeq`, allocator values never falling. */
async function replay(
	store: ChordStore,
	commits: readonly OutboxCommit[],
	executor: SqliteExecutor,
	catalog: ReadonlyMap<string, TableRecord>,
): Promise<Replayed> {
	const tables = new Map(catalog);
	const changed = new Map<string, TableRecord>();
	let lastSeq = store.lastSeq;
	let nextId = store.nextId;
	for (const [index, commit] of commits.entries()) {
		const what = `batch: commit ${index} (seq ${commit.seq})`;
		if (commit.seq !== lastSeq + 1) throw invalid("args", `${what}: does not follow seq ${lastSeq}`);
		if (commit.nextId < nextId) throw invalid("args", `${what}: its next id ${commit.nextId} is below ${nextId}`);
		const step = new Step(executor, commit.seq, new IdAllocator(commit.nextId), tables);
		for (const [position, write] of commit.writes.entries()) {
			const where = `${what}: write ${position} (${write.kind})`;
			if (write.kind === "document.create") checkCreated(write.record.id, commit.nextId, where);
			await applyWrite(step, write, where);
		}
		await writeCatalog(step);
		for (const [name, record] of step.tables) {
			tables.set(name, record);
			changed.set(name, record);
		}
		if (store.recordsOutbox) {
			await executor.run(
				`INSERT INTO ${TABLES.outbox} (seq, format, next_id, writes) VALUES (?, ?, ?, ?)`,
				commit.seq,
				OUTBOX_FORMAT,
				commit.nextId,
				JSON.stringify(commit.writes),
			);
		}
		lastSeq = commit.seq;
		nextId = commit.nextId;
	}
	await executor.run(`UPDATE ${TABLES.meta} SET last_seq = ?, next_id = ? WHERE singleton = 1`, lastSeq, nextId);
	return { lastSeq, nextId, tables: changed };
}

/**
 * A created document's id is below its commit's next id (the allocator never mints it again), or equal to a saturated
 * next id (`Number.MAX_SAFE_INTEGER` may be written, as import allows).
 */
function checkCreated(id: number, nextId: number, what: string): void {
	if (id < nextId || (nextId === Number.MAX_SAFE_INTEGER && id === nextId)) return;
	throw invalid("args", `${what}: id ${id} is not below the commit's next id ${nextId}`);
}
