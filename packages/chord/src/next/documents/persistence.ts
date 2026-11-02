// Persisted documents' store side (slice 6a §8, §10): a slot's address in the documents engine, what is stored of each
// loaded document (Durable's `LoadedDocument` fields), its loads with the version and fingerprint checks and the
// checked `migrate`, and the writes one commit stages for a changed or retired document.

import type { Context } from "../../context/index.ts";
import type { Op, Prepared } from "../../delta/index.ts";
import {
	changeDocument,
	createDocument,
	type DocumentAddress,
	type DocumentContent,
	findDocument,
	listDocumentKeys,
	loadDocument,
	retireDocument,
	type StoredDocument,
} from "../store/engine.ts";
import type { StagedWrite } from "../store/step.ts";
import type { ChordStore } from "../store/store.ts";
import type { JsonObject } from "./definition.ts";
import type { AnyDefinition } from "./slot.ts";

/** What is stored of a loaded document: its record's id and revision, its base's version, the deltas after it. */
export type Stored = {
	readonly id: number;
	readonly revision: number;
	/** The version of the stored base: below the definition's, the next change stores a base (rule 1). */
	readonly version: number;
	readonly deltasSinceBase: number;
};

/** A live document found without loading it: what is stored of it and the fingerprint it was stored with. */
export type FoundDocument = { readonly stored: Stored; readonly fingerprint: string };

/** A loaded document: its value at the definition's version, and what is stored of it. */
export type Loaded = { readonly value: JsonObject; readonly stored: Stored };

/** One transaction's change of one document: its prepared draft (if changed), and whether it retires it. */
export type DocumentChange = { readonly prepared: Prepared<JsonObject> | undefined; readonly retires: boolean };

/** A run state's held ops (D8), stored before the next change's own; `base` when a held change asked for a base. */
export type Held = { readonly ops: readonly Op[]; readonly base: boolean };

/**
 * What one commit stores of a document, in the store writes' words: a retirement (nothing stored after it), a
 * creation whose id the step assigns (`create`: `created.id` once it applied), a change of the record `stored` was
 * prepared on, or nothing yet (`held`: a deferred change of a run's state, D8, kept in memory over `stored`).
 */
export type StoredChange =
	| { readonly kind: "retire" }
	| { readonly kind: "create"; readonly version: number; readonly created: { id: number } }
	| { readonly kind: "change"; readonly stored: Stored }
	| { readonly kind: "held"; readonly stored: Stored; readonly withinMs: number };

/**
 * The documents of one persisted name on one object: `(<object type>, namespace, name, key)`, the namespace `chord` for
 * `self.state`, `chord.jobs` and `chord.job-states` for persisted job runs (slice 6b D5).
 */
export class Persistence {
	readonly store: ChordStore;
	readonly #address: Omit<DocumentAddress, "key">;

	/** `owner` is the object's type (R2); `kind` the definition's or the job's name. */
	constructor(store: ChordStore, owner: string, namespace: string, kind: string) {
		this.store = store;
		this.#address = { owner, namespace, kind };
	}

	/**
	 * The stored document at `key`, `undefined` when absent: found and loaded with plain reads (a store error rejects
	 * as the store's). Counted (`chord.store.loads`).
	 */
	async read(key: string, context: Context): Promise<StoredDocument | undefined> {
		const address = this.at(key);
		const document = await this.store.read(async (executor) => {
			const record = await findDocument(executor, address);
			return record === undefined ? undefined : loadDocument(executor, record);
		}, context);
		if (document !== undefined) context.telemetry.metrics?.counter("chord.store.loads").add(1);
		return document;
	}

	/**
	 * `document` as `definition` reads it: a stored version newer than the code's, or the same version with another
	 * fingerprint (D9), throws; an older one is migrated and the result checked once (R8). What throws here is the
	 * code's (a failing `migrate` too, whatever it throws), never the store's.
	 */
	decode(document: StoredDocument, definition: AnyDefinition, context: Context): Loaded {
		const { record, deltasSinceBase } = document;
		checkReadable(record, definition);
		// The engine stores what commits gave it: JSON objects of the record's version.
		const stored = document.value as JsonObject;
		const value =
			record.version === definition.version ? stored : definition.migrate(stored, record.version, context);
		return {
			value,
			stored: { id: record.id, revision: record.revision, version: record.version, deltasSinceBase },
		};
	}

	/**
	 * What is stored of the live document at `key` without loading it (a retirement's find) and the schema fingerprint
	 * it was stored with (`checkReadable` takes both), `undefined` when absent.
	 */
	async find(key: string, context: Context): Promise<FoundDocument | undefined> {
		const record = await this.store.read((executor) => findDocument(executor, this.at(key)), context);
		if (record === undefined) return undefined;
		// The change counter is all a retirement needs; `deltasSinceBase` is not read for one.
		const stored = { id: record.id, revision: record.revision, version: record.version, deltasSinceBase: 0 };
		return { stored, fingerprint: record.fingerprint };
	}

	/** Up to `limit` keys of live documents after `after`, in code point order. */
	keys(after: string | undefined, limit: number, context: Context): Promise<string[]> {
		return this.store.read((executor) => listDocumentKeys(executor, this.#address, after, limit), context);
	}

	/**
	 * Stages one commit's writes of the document at `key` into `writes` (rule 8: serialized here, before the queue):
	 * its retirement when `retired` is stored, then its creation, or the change of `stored` (a base when created, when
	 * the stored version is older, or when `checkpointWhen` asks; a delta otherwise), `held` ops stored before the
	 * change's own (D8: a held base makes it a base). Returns what the commit stores.
	 */
	stage(
		key: string,
		definition: AnyDefinition,
		stored: Stored | undefined,
		change: DocumentChange,
		writes: StagedWrite[],
		held?: Held,
	): StoredChange {
		const { prepared, retires } = change;
		if (retires && stored !== undefined) writes.push(retireDocument(stored.id, stored.revision));
		if (prepared === undefined) return { kind: "retire" };
		const { version, fingerprint } = definition;
		if (retires || stored === undefined) {
			const base = { version, fingerprint, value: prepared.value };
			const created = { id: 0 };
			const write = createDocument(this.at(key), base, JSON.stringify(prepared.value), (id) => {
				created.id = id;
			});
			writes.push(write);
			return { kind: "create", version, created };
		}
		const info = { deltasSinceBase: stored.deltasSinceBase };
		const base =
			held?.base === true ||
			stored.version !== version ||
			definition.checkpointWhen(prepared.value, prepared.ops, info);
		const ops = held === undefined ? prepared.ops : [...held.ops, ...prepared.ops];
		const content: DocumentContent = base
			? { kind: "base", version, fingerprint, value: prepared.value }
			: { kind: "delta", version, ops };
		const text = JSON.stringify(base ? prepared.value : ops);
		writes.push(changeDocument(stored.id, stored.revision, content, text));
		const deltasSinceBase = base ? 0 : stored.deltasSinceBase + 1;
		return { kind: "change", stored: { id: stored.id, revision: stored.revision + 1, version, deltasSinceBase } };
	}

	/** The address of `key`: a singleton's (`""`) has no key. */
	at(key: string): DocumentAddress {
		return key === "" ? this.#address : { ...this.#address, key };
	}
}

/**
 * Throws when `definition` cannot read a document stored at `stored`'s version and fingerprint: a newer version than
 * the code's, or the same version with another fingerprint (D9). A load and a retirement check alike (R15).
 */
export function checkReadable(
	stored: { readonly version: number; readonly fingerprint: string },
	definition: AnyDefinition,
): void {
	const { name, version, fingerprint } = definition;
	if (stored.version > version) {
		throw new Error(`${name}: stored at version ${stored.version}, newer than the code's ${version}`);
	}
	if (stored.version === version && stored.fingerprint !== fingerprint) {
		throw new Error(`${name}: stored with another schema at version ${version} (a schema changed without a bump)`);
	}
}

/** What is stored after a commit's `change` was adopted. */
export function storedAfter(change: StoredChange): Stored | undefined {
	switch (change.kind) {
		case "retire":
			return undefined;
		case "create":
			return { id: change.created.id, revision: 1, version: change.version, deltasSinceBase: 0 };
		case "change":
		case "held":
			return change.stored;
	}
}
