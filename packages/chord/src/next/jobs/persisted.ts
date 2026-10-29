// A persisted job's run records in its object's store (slice 6b §4.1, D5): the record document of each unsettled run
// (namespace `chord.jobs`, kind the job name, key the run id, `history: none`), written whole in the transactions that
// change the run, and read once per object when it first activates; for a run of another job version, also what is
// stored of its state document (`chord.job-states`), never decoded, so its drop retires it whatever the code declares.

import type { Context } from "../../context/index.ts";
import type { JsonObject } from "../documents/index.ts";
import type { Persistence, Stored } from "../documents/internal.ts";
import { changeDocument, createDocument, retireDocument } from "../store/engine.ts";
import type { StagedWrite } from "../store/step.ts";
import { RUN_RECORD, recordOf, type StoredRun } from "./stored.ts";

/** A run record as a load found it: its run id, the record and what is stored of it. */
export type LoadedRecord = { readonly id: string; readonly record: StoredRun; readonly stored: Stored };

/** The keys a load reads per page. */
const KEYS_PAGE = 100;

/** The record documents of one persisted job's runs, and what is stored of each. */
export class PersistedRuns {
	readonly #records: Persistence;
	readonly #states: Persistence;
	readonly #stored = new Map<string, Stored>();
	/** What is stored of the state documents of runs of another job version, by run id. */
	readonly #blockedStates = new Map<string, Stored>();

	/** `records` and `states` are the job's record and state documents' store sides (`chord.jobs`, `chord.job-states`). */
	constructor(records: Persistence, states: Persistence) {
		this.#records = records;
		this.#states = states;
	}

	/**
	 * Stages run `id`'s record `record` into `writes` (rule 8: serialized now): its creation, or a new base of what is
	 * stored; returns the adoption, which takes what the commit stored.
	 */
	stage(id: string, record: StoredRun, writes: StagedWrite[]): () => void {
		const text = JSON.stringify(record);
		const stored = this.#stored.get(id);
		const { version, fingerprint } = RUN_RECORD;
		const value = record as unknown as JsonObject;
		if (stored === undefined) {
			const created = { id: 0 };
			writes.push(
				createDocument(this.#records.at(id), { version, fingerprint, value }, text, (made) => {
					created.id = made;
				}),
			);
			return () => this.#stored.set(id, { id: created.id, revision: 1, version, deltasSinceBase: 0 });
		}
		writes.push(changeDocument(stored.id, stored.revision, { kind: "base", version, fingerprint, value }, text));
		return () => this.#stored.set(id, { ...stored, revision: stored.revision + 1 });
	}

	/**
	 * Stages the retirement of run `id`'s record into `writes` (the run settled or was dropped), and of its state
	 * document when the run is of another job version; the adoption forgets them.
	 */
	stageRetire(id: string, writes: StagedWrite[]): () => void {
		const stored = this.#stored.get(id);
		if (stored !== undefined) writes.push(retireDocument(stored.id, stored.revision));
		const state = this.#blockedStates.get(id);
		if (state !== undefined) writes.push(retireDocument(state.id, state.revision));
		return () => {
			this.#stored.delete(id);
			this.#blockedStates.delete(id);
		};
	}

	/** Finds what is stored of run `id`'s state document (a run of another job version), keeping it for the drop. */
	async findBlockedState(id: string, context: Context): Promise<void> {
		const found = await this.#states.find(id, context);
		if (found !== undefined) this.#blockedStates.set(id, found.stored);
	}

	/** Every stored record of the job, in run id order, page by page with plain reads (activation holds the line). */
	async load(context: Context): Promise<LoadedRecord[]> {
		const loaded: LoadedRecord[] = [];
		let after: string | undefined;
		for (;;) {
			const keys = await this.#records.keys(after, KEYS_PAGE, context);
			for (const id of keys) {
				const document = await this.#records.read(id, context);
				if (document === undefined) continue;
				const { record: stored, value, deltasSinceBase } = document;
				const found = { id: stored.id, revision: stored.revision, version: stored.version, deltasSinceBase };
				this.#stored.set(id, found);
				loaded.push({ id, record: recordOf(value as JsonObject), stored: found });
			}
			if (keys.length < KEYS_PAGE) return loaded;
			after = keys.at(-1);
		}
	}

	/** The object's documents are dropped: nothing is known of the store any more. */
	drop(): void {
		this.#stored.clear();
		this.#blockedStates.clear();
	}
}
