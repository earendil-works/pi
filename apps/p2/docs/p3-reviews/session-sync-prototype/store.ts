// Prototype for discussion (rule 1): a session store whose change records commit in its own transaction.
// Not product code. Run: node demo.ts (Node 24).
import { DatabaseSync } from "node:sqlite";

/** One per session: hands out global positions; knows which are still inside an open transaction. */
export class Sequencer {
	#next: number;
	readonly #inFlight = new Set<number>();
	constructor(start: number) {
		this.#next = start;
	}
	take(): number {
		const pos = this.#next++;
		this.#inFlight.add(pos);
		return pos;
	}
	release(pos: number): void {
		this.#inFlight.delete(pos);
	}
	/** The highest position P such that nothing at or below P is still committing. */
	safeCut(): number {
		return this.#inFlight.size > 0 ? Math.min(...this.#inFlight) - 1 : this.#next - 1;
	}
}

export type Change = { pos: number; change: Uint8Array };

/**
 * A plugin's own SQLite database in the session directory, made syncable. The plugin writes plain SQL inside
 * `transaction`; the store records the changed rows (SQLite session extension) in `_outbox`, in the same transaction.
 */
export class SessionSqlite {
	readonly db: DatabaseSync;
	#sequencer: Sequencer | undefined;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS _outbox(pos INTEGER PRIMARY KEY, change BLOB NOT NULL) STRICT;
			CREATE TABLE IF NOT EXISTS _applied(id INTEGER PRIMARY KEY CHECK (id = 0), pos INTEGER NOT NULL) STRICT;
		`);
	}

	/** Driver: the session's sequencer, attached once every store is open (it starts above all their heads). */
	attach(sequencer: Sequencer): void {
		this.#sequencer = sequencer;
	}

	/** Driver: run `fn` in one transaction; its rows and their change record commit together or not at all. */
	transaction<T>(fn: (db: DatabaseSync) => T): T {
		const sequencer = this.#sequencer;
		if (!sequencer) throw new Error("not the driver: no sequencer attached");
		const session = this.db.createSession(); // tracks every table with a primary key
		let pos: number | undefined;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn(this.db);
			const change = session.changeset(); // taken before the outbox insert, so it holds only fn's rows
			if (change.length > 0) {
				pos = sequencer.take();
				this.db.prepare("INSERT INTO _outbox (pos, change) VALUES (?, ?)").run(pos, change);
			}
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK"); // the rows and the record vanish together; the position becomes a gap
			throw error;
		} finally {
			session.close();
			if (pos !== undefined) sequencer.release(pos);
		}
	}

	/** Driver: change records after `pos`, for upload. */
	changesSince(pos: number): Change[] {
		return this.db
			.prepare("SELECT pos, change FROM _outbox WHERE pos > ? ORDER BY pos")
			.all(pos)
			.map((row) => ({ pos: Number(row.pos), change: row.change as Uint8Array }));
	}

	/** Driver: drop records the server has. */
	trim(upTo: number): void {
		this.db.prepare("DELETE FROM _outbox WHERE pos <= ?").run(upTo);
	}

	/** Replica: apply one change; idempotent through `_applied`. */
	apply({ pos, change }: Change): void {
		if (pos <= this.applied()) return;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.applyChangeset(change);
			this.db.prepare("INSERT INTO _applied (id, pos) VALUES (0, ?) ON CONFLICT(id) DO UPDATE SET pos = excluded.pos").run(pos);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	applied(): number {
		return Number(this.db.prepare("SELECT pos FROM _applied WHERE id = 0").get()?.pos ?? 0);
	}

	/** Highest position this store has seen (as driver or replica): the sequencer restarts above the maximum of all stores. */
	head(): number {
		const outbox = Number(this.db.prepare("SELECT max(pos) AS pos FROM _outbox").get()?.pos ?? 0);
		return Math.max(outbox, this.applied());
	}

	close(): void {
		this.db.close();
	}
}

export type Batch = { upTo: number; records: { store: string; pos: number; change: Uint8Array }[] };

/** Sync layer, driver side: every store's records after `uploaded`, up to the safe cut, merged by position. */
export function cutBatch(stores: Record<string, SessionSqlite>, sequencer: Sequencer, uploaded: number): Batch {
	const upTo = sequencer.safeCut();
	const records: Batch["records"] = [];
	for (const [store, s] of Object.entries(stores))
		for (const r of s.changesSince(uploaded)) if (r.pos <= upTo) records.push({ store, ...r });
	records.sort((a, b) => a.pos - b.pos);
	return { upTo, records };
}

/** Sync layer, replica side: apply in global position order, interleaving the stores. */
export function applyBatch(stores: Record<string, SessionSqlite>, batch: Batch): void {
	for (const r of batch.records) stores[r.store].apply(r);
}
