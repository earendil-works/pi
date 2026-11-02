// Document slots (slice 6a §1.2): one per declared document name on its object, across the object's attempts. A slot
// holds the documents' trackers, the version and definition its values are of, what is stored of persisted ones, and
// the watches; each attempt's handles are thin views of it. This file: what every slot is, and the singleton's slot
// (the keyed one is `keyed-slot.ts`).

import type { Context } from "../../context/index.ts";
import { type Prepared, type Tracker, track } from "../../delta/index.ts";
import { ChordError } from "../data/index.ts";
import type { StagedWrite } from "../store/step.ts";
import { AddressSource } from "./address-source.ts";
import type { CommitPersistence, JsonObject, StateDefinition } from "./definition.ts";
import type { Documents } from "./documents.ts";
import type { SealToken } from "./fence.ts";
import { type DocumentChange, type Persistence, type Stored, type StoredChange, storedAfter } from "./persistence.ts";

/** A document definition, whatever its value and keyedness. */
export type AnyDefinition = StateDefinition<JsonObject, boolean, boolean>;

/**
 * What a transaction drafts and adopts: documents of one object by key (a singleton ignores the key). The slots of
 * `self.state`, and Chord's own (a job's run state documents).
 */
export interface DocumentSlot {
	readonly owner: Documents;
	/** The tracker of the document at `key`, `undefined` while absent. */
	current(key: string): Tracker<JsonObject> | undefined;
	/** The value a draft of an absent document starts from. */
	initial(context: Context): JsonObject;
	/** The persisted slot's store side; `undefined` for documents in memory only. */
	readonly persisted: PersistedSlot | undefined;
	/** Adopts a commit of the document at `key` (inside the batch), with what the commit stored of it. */
	adopt(
		key: string,
		tracker: Tracker<JsonObject>,
		prepared: Prepared<JsonObject>,
		stored: StoredChange | undefined,
	): void;
	/** Retires the document at `key` (inside the batch). */
	retire(key: string): void;
}

/** What a transaction needs of a persisted slot (slice 6a §4, §10). */
export interface PersistedSlot {
	readonly persistence: Persistence;
	readonly definition: SlotDefinition;
	/** Whether the document at `key` may be stored without being in memory (a persisted keyed document not loaded). */
	cold(key: string): boolean;
	/** What is stored of the document at `key` as memory knows it; `undefined` when absent or cold. */
	stored(key: string): Stored | undefined;
	/**
	 * Stages one commit's writes of the document at `key` into `writes` (`was`: what is stored of it, a cold one's as
	 * the transaction found it); `persistence` is the transaction's (a deferred change of a run's state is held, D8).
	 */
	stage(
		key: string,
		change: DocumentChange,
		was: Stored | undefined,
		writes: StagedWrite[],
		persistence: CommitPersistence,
	): StoredChange;
	/**
	 * Loads the document at `key` (its caller holds the line): installed when present and still absent from memory,
	 * and, for a transaction's load (`token`), while the token is not sealed (a cut transaction released the line, so
	 * a successor may have changed or retired the key meanwhile).
	 */
	load(key: string, context: Context, token?: SealToken): Promise<void>;
}

/**
 * The definition a slot's values are of (the one that hydrated it last; the first declaration until then): the checks
 * of a new attempt's declaration and the old handles' version fence (R15).
 */
export class SlotDefinition {
	#current: AnyDefinition;
	#hydrated = false;

	constructor(definition: AnyDefinition) {
		this.#current = definition;
	}

	/** The definition the values are of. */
	get current(): AnyDefinition {
		return this.#current;
	}

	/** The definition the values were hydrated with, `undefined` before the first hydration. */
	get hydrated(): AnyDefinition | undefined {
		return this.#hydrated ? this.#current : undefined;
	}

	/**
	 * Checks a declaration of this name by a new attempt: a flipped `keyed` or `persist`, a version older than the values (old code)
	 * or the same version with another fingerprint (a schema changed without a bump) throw (the attempt fails broken).
	 */
	check(definition: AnyDefinition): void {
		const { name, version, keyed, persist, fingerprint } = this.#current;
		if (definition.keyed !== keyed) {
			throw new Error(`${name}: declared ${definition.keyed ? "keyed" : "singleton"}, its documents are not`);
		}
		if (definition.persist !== persist) {
			throw new Error(`${name}: declared ${definition.persist ? "persisted" : "in memory"}, its documents are not`);
		}
		if (definition.version < version) {
			throw new Error(`${name}: version ${definition.version} is older than its documents' (${version})`);
		}
		if (definition.version === version && definition.fingerprint !== fingerprint) {
			throw new Error(`${name}: the schema changed without a version bump (version ${version})`);
		}
	}

	/** Records the hydration with `definition`. */
	hydrate(definition: AnyDefinition): void {
		this.#current = definition;
		this.#hydrated = true;
	}

	/**
	 * Throws `released` for a handle of `version` once the values migrated past it (old code reads no new shape), and
	 * `not_ready` for a handle of a newer version until its activation migrated them (new code reads no old shape: a
	 * retry's factory).
	 */
	assertVersion(version: number): void {
		const current = this.#current;
		if (version === current.version) return;
		const message = `${current.name}: a handle of version ${version}; the documents are at version ${current.version}`;
		if (version < current.version) throw new ChordError({ code: "released", reason: "version", message });
		throw new ChordError({ code: "not_ready", message: `${message} until the activation migrates them` });
	}
}

/**
 * A singleton's slot: one tracker while written, `initial()` while absent; the source its handles and members watch.
 * Persisted, it loads once per object (again after a failed load) and stays in memory while the object lives.
 */
export class SingletonSlot extends AddressSource implements DocumentSlot, PersistedSlot {
	readonly owner: Documents;
	readonly definition: SlotDefinition;
	readonly persisted: PersistedSlot | undefined;
	readonly #persistence: Persistence | undefined;
	/** `initial()`, taken at hydration; `undefined` before the first. */
	#initial: JsonObject | undefined;
	#tracker: Tracker<JsonObject> | undefined;
	/** What is stored of it (persisted); `undefined` while absent. */
	#stored: Stored | undefined;
	/** In memory: always; persisted: once loaded. */
	#loaded: boolean;

	constructor(owner: Documents, definition: AnyDefinition, persistence: Persistence | undefined) {
		super(owner.batch);
		this.owner = owner;
		this.definition = new SlotDefinition(definition);
		this.#persistence = persistence;
		this.persisted = persistence === undefined ? undefined : this;
		this.#loaded = persistence === undefined;
	}

	get persistence(): Persistence {
		// Only reached through `persisted`, which a persisted slot alone has.
		return this.#persistence!;
	}

	get value(): JsonObject {
		this.owner.assertLive();
		if (this.#initial === undefined || !this.#loaded) {
			const message = `${this.definition.current.name}: read before activation`;
			throw new ChordError({ code: "not_ready", message });
		}
		return this.#tracker?.value ?? this.#initial;
	}

	/**
	 * Takes the attempt's declaration `definition` (`check` accepted it): the first takes `initial()`; a newer version
	 * migrates the value in memory (a persisted one stores a base with its next change) and takes `initial()` again,
	 * and a value that changed reaches watches as a root replacement; the same version keeps everything.
	 */
	hydrate(definition: AnyDefinition, context: Context): void {
		const from = this.definition.hydrated;
		if (from !== undefined && from.version === definition.version) {
			this.definition.hydrate(definition);
			return;
		}
		const before = from === undefined || !this.#loaded ? undefined : this.value;
		const tracker =
			this.#tracker === undefined || from === undefined
				? this.#tracker
				: track(definition.migrate(this.#tracker.value, from.version, context));
		this.#initial = definition.initial(context);
		this.#tracker = tracker;
		this.definition.hydrate(definition);
		if (before !== undefined) this.batch.commit(() => this.replaced(), context);
	}

	/** Loads the persisted document unless it is loaded already (the caller holds the line). */
	async load(_key: string, context: Context): Promise<void> {
		if (this.#loaded) return;
		const document = await this.persistence.read("", context);
		// Singletons load at activation, on the line: what the code cannot read fails the activation.
		const loaded =
			document === undefined ? undefined : this.persistence.decode(document, this.definition.current, context);
		if (loaded !== undefined) {
			this.#tracker = track(loaded.value);
			this.#stored = loaded.stored;
		}
		this.#loaded = true;
	}

	/** Loads the persisted document unless it is loaded already (activation, holding the line). */
	loadDeclared(context: Context): Promise<void> {
		return this.load("", context);
	}

	/** A singleton has one document: its key is always `""`. */
	key(_key: string): string {
		return "";
	}

	cold(_key: string): boolean {
		return false;
	}

	stored(_key: string): Stored | undefined {
		return this.#stored;
	}

	stage(key: string, change: DocumentChange, was: Stored | undefined, writes: StagedWrite[]): StoredChange {
		return this.persistence.stage(key, this.definition.current, was, change, writes);
	}

	current(_key: string): Tracker<JsonObject> | undefined {
		return this.#tracker;
	}

	/** The value a draft of the absent document starts from: the `initial()` taken at hydration. */
	initial(_context: Context): JsonObject {
		return this.#initial!;
	}

	adopt(
		_key: string,
		tracker: Tracker<JsonObject>,
		prepared: Prepared<JsonObject>,
		stored: StoredChange | undefined,
	): void {
		// Unchecked: a step admitted before the object ended adopts after its seal (slice 6a §1.3).
		const before = this.#tracker?.value ?? this.#initial!;
		tracker.adopt(prepared);
		this.#tracker = tracker;
		this.#stored = stored === undefined ? undefined : storedAfter(stored);
		this.written(before, prepared);
	}

	/** Retires the document: it reads `initial()` again, and the frame says it was retired. */
	retire(_key: string): void {
		this.#tracker = undefined;
		this.#stored = undefined;
		this.retired(this.#initial!);
	}

	/** Its object ended or no attempt declares it any more: the document goes and its watches end. */
	drop(): void {
		this.#tracker = undefined;
		this.#stored = undefined;
		this.endWatches();
	}
}
