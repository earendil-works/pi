// Keyed slots (slice 6a §1.2, §4, §10, §11): the documents of one keyed name on one object, by key. In memory, every
// present document stays; persisted, a document is loaded on demand (a cold read is a job on the object's line, one
// load in flight per key, shared) and leaves memory when unpinned and idle for the retention (`residency.ts`). A key
// read through `at(key)` or a watch has its own source, which exists while the key is pinned.

import { awaitWithContext, type Context } from "../../context/index.ts";
import { type Prepared, type Tracker, track } from "../../delta/index.ts";
import type { Watch } from "../../watch.ts";
import { ChordError } from "../data/index.ts";
import { asChordError } from "../data/internal.ts";
import type { StagedWrite } from "../store/step.ts";
import { compareText, storedText } from "../store/text.ts";
import { AddressSource } from "./address-source.ts";
import type { JsonObject } from "./definition.ts";
import type { Documents } from "./documents.ts";
import type { SealToken } from "./fence.ts";
import {
	type DocumentChange,
	type Loaded,
	type Persistence,
	type Stored,
	type StoredChange,
	storedAfter,
} from "./persistence.ts";
import { Resident } from "./residency.ts";
import { type AnyDefinition, type DocumentSlot, type PersistedSlot, SlotDefinition } from "./slot.ts";

/** Whom a read is for: a handle's seal token and the version it was declared with (R15). */
export type Access = { readonly token: SealToken; readonly version: number };

/**
 * A cold load in flight, shared by its waiters: their handles' tokens, and those already sealed when the load took
 * the line (`undefined` until then), whose waiters it refuses (rule 4).
 */
type SharedLoad = {
	readonly done: Promise<void>;
	readonly tokens: Set<SealToken>;
	refused: ReadonlySet<SealToken> | undefined;
};

/** The keys `keys(ctx)` reads per page from the store. */
const KEYS_PAGE = 100;

/** A keyed slot: one resident per document in memory, one source per pinned key. */
export class KeyedSlot implements DocumentSlot, PersistedSlot {
	readonly owner: Documents;
	readonly definition: SlotDefinition;
	readonly persisted: PersistedSlot | undefined;
	readonly #persistence: Persistence | undefined;
	readonly #residents = new Map<string, Resident>();
	/** The sources of pinned keys: a key is pinned while it has one. */
	readonly #sources = new Map<string, KeySource>();
	/** Cold loads in flight, by key: shared by every reader of the key. */
	readonly #loads = new Map<string, SharedLoad>();
	/** Names a refused key (the slot's name is the same at every version): made once, not per key check. */
	readonly #keyWhat: string;

	constructor(owner: Documents, definition: AnyDefinition, persistence: Persistence | undefined) {
		this.owner = owner;
		this.definition = new SlotDefinition(definition);
		this.#keyWhat = `${definition.name}: key`;
		this.#persistence = persistence;
		this.persisted = persistence === undefined ? undefined : this;
	}

	get persistence(): Persistence {
		// Only reached through `persisted`, which a persisted slot alone has.
		return this.#persistence!;
	}

	/**
	 * The value at `key`, `undefined` when absent. A document in memory is read at once (also through a sealed
	 * handle); a cold persisted one is loaded on the line (refused `released` once the access's token is sealed), and
	 * `context` ends only this caller's wait. An absent key is not cached (rule 20).
	 */
	get(raw: string, access: Access, context: Context): Promise<JsonObject | undefined> {
		// Not `async`: `#get` is the one async layer; a refused key still reaches the caller as a rejection.
		try {
			return this.#get(this.key(raw), access, context);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/** `get` of a key that went through `key` already. */
	async #get(key: string, access: Access, context: Context): Promise<JsonObject | undefined> {
		this.owner.assertLive();
		this.definition.assertVersion(access.version);
		const resident = this.#resident(key);
		if (resident !== undefined) {
			this.#touch(resident);
			return resident.tracker.value;
		}
		if (this.#persistence === undefined) return undefined;
		await this.#loadShared(key, access.token, context);
		return this.#residents.get(key)?.tracker.value;
	}

	/** The present keys in code point order: in memory, the residents; persisted, the store's, a page per line job. */
	async *keys(access: Access, context: Context): AsyncIterable<string> {
		this.owner.assertLive();
		this.definition.assertVersion(access.version);
		const persistence = this.#persistence;
		if (persistence === undefined) {
			yield* [...this.#residents.keys()].sort(compareText);
			return;
		}
		let after: string | undefined;
		for (;;) {
			const page = await this.owner.onLine(() => persistence.keys(after, KEYS_PAGE, context), access.token);
			yield* page;
			if (page.length < KEYS_PAGE) return;
			after = page.at(-1);
		}
	}

	/**
	 * A watch of the document at `key`, `undefined` when absent (after a cold load); it follows the address (a
	 * retirement is a frame with the `retired` flag) and pins the key until it ends.
	 */
	async watch(raw: string, access: Access, context: Context): Promise<Watch<JsonObject> | undefined> {
		const key = this.key(raw);
		if ((await this.#get(key, access, context)) === undefined) return undefined;
		const release = this.pin(key, context);
		// Retired between the load and now: absent.
		if (!this.#residents.has(key)) {
			release();
			return undefined;
		}
		let watch: Watch<JsonObject>;
		try {
			// The source's values are this slot's documents.
			watch = this.#sources.get(key)!.openWatch(context) as Watch<JsonObject>;
		} catch (error) {
			release();
			throw error;
		}
		void watch.closed.then(release);
		return watch;
	}

	/**
	 * Pins `key`: its source (made by the first pin) and its document stay in memory until the returned release
	 * (idempotent) runs; a persisted key not in memory is loaded by the next activation load (`loadDeclared`).
	 */
	pin(raw: string, context: Context): () => void {
		const key = this.key(raw);
		let source = this.#sources.get(key);
		if (source === undefined) {
			const ready = this.#persistence === undefined || this.#residents.has(key);
			source = new KeySource(this, key, this.definition.current.initial(context), ready);
			this.#sources.set(key, source);
		}
		source.pins++;
		const resident = this.#residents.get(key);
		if (resident !== undefined) this.owner.residency.forget(resident);
		const pinned = source;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--pinned.pins > 0 || this.#sources.get(key) !== pinned) return;
			this.#sources.delete(key);
			const idle = this.#residents.get(key);
			if (idle !== undefined) this.#touch(idle);
		};
	}

	/** Loads pinned `key` on the line unless it was loaded since it was pinned (a consumer's `at(key)`, slice 6a §12). */
	async ensure(raw: string, context: Context): Promise<void> {
		const key = this.key(raw);
		if (this.#sources.get(key)?.ready !== false) return;
		await this.owner.onLine(() => this.load(key, context));
	}

	/** The source of pinned `key`. */
	source(key: string): KeySource {
		return this.#sources.get(this.key(key))!;
	}

	/**
	 * `key` as the slot and the store keep it: the `str()` text rules (slice 6a §8), a lone surrogate replaced by
	 * U+FFFD, NUL refused `invalid/args`. Plugin keys are a trust boundary; every entry point takes them through here,
	 * so memory and the store agree on one key.
	 */
	key(key: string): string {
		return storedText(key, this.#keyWhat);
	}

	/** Loads every pinned key not loaded since it was pinned (activation, holding the line). */
	async loadDeclared(context: Context): Promise<void> {
		for (const [key, source] of this.#sources) if (!source.ready) await this.load(key, context);
	}

	/**
	 * Loads the document at `key` (the caller holds the line) and installs it while it is still absent from memory (a
	 * commit's `adopt` always wins). A stored version newer than the code's, another fingerprint or a failing `migrate`
	 * fails the owner (slice 6a §1.4) and rejects with the cause.
	 */
	async load(key: string, context: Context, token?: SealToken): Promise<void> {
		if (this.#residents.has(key)) return;
		// A store error rejects as the store's (`storage_failed`, `aborted`).
		const document = await this.persistence.read(key, context);
		// The transaction was cut meanwhile: what it read may be stale already.
		if (token?.sealed === true) return;
		let loaded: Loaded | undefined;
		try {
			loaded =
				document === undefined ? undefined : this.persistence.decode(document, this.definition.current, context);
		} catch (error) {
			// What the code cannot read (a failing `migrate`, whatever it throws) fails the owner.
			const failure = asChordError(error, this.owner.label);
			this.owner.fail(failure);
			throw failure;
		}
		if (loaded !== undefined && !this.#residents.has(key)) {
			const resident = new Resident(this, key, track(loaded.value), loaded.stored, this.definition.current.version);
			this.#residents.set(key, resident);
			this.#touch(resident);
		}
		const source = this.#sources.get(key);
		if (source !== undefined) source.ready = true;
	}

	cold(key: string): boolean {
		return this.#persistence !== undefined && !this.#residents.has(key);
	}

	stored(key: string): Stored | undefined {
		return this.#residents.get(key)?.stored;
	}

	stage(key: string, change: DocumentChange, was: Stored | undefined, writes: StagedWrite[]): StoredChange {
		return this.persistence.stage(key, this.definition.current, was, change, writes);
	}

	/**
	 * Takes the attempt's declaration: a newer version migrates each document in memory on its next access (persisted
	 * ones store a base with their next change); the pinned keys are watched, so they migrate now, all or none, and
	 * take `initial()` again.
	 */
	hydrate(definition: AnyDefinition, context: Context): void {
		const from = this.definition.hydrated;
		this.definition.hydrate(definition);
		if (from === undefined || from.version === definition.version) return;
		const pinned = [...this.#sources.keys()].flatMap((key) => this.#residents.get(key) ?? []);
		const migrated = pinned.map((resident) => [resident, this.#migrated(resident, context)] as const);
		for (const [resident, tracker] of migrated) {
			resident.tracker = tracker;
			resident.version = definition.version;
		}
		this.owner.batch.commit(() => {
			for (const source of this.#sources.values()) source.retake(definition.initial(context));
		}, context);
	}

	current(key: string): Tracker<JsonObject> | undefined {
		return this.#resident(key)?.tracker;
	}

	/** The value a draft of an absent document starts from: a fresh `initial()`. */
	initial(context: Context): JsonObject {
		return this.definition.current.initial(context);
	}

	adopt(
		key: string,
		tracker: Tracker<JsonObject>,
		prepared: Prepared<JsonObject>,
		change: StoredChange | undefined,
	): void {
		const stored = change === undefined ? undefined : storedAfter(change);
		const source = this.#sources.get(key);
		const before = source?.peek();
		tracker.adopt(prepared);
		let resident = this.#residents.get(key);
		const { version } = this.definition.current;
		if (resident === undefined) {
			resident = new Resident(this, key, tracker, stored, version);
			this.#residents.set(key, resident);
		} else {
			resident.tracker = tracker;
			resident.stored = stored;
			resident.version = version;
		}
		if (source === undefined) this.#touch(resident);
		else source.written(before!, prepared);
	}

	/** Retires the document at `key` (inside the batch): out of memory, its source reads `initial()` with the flag. */
	retire(key: string): void {
		const resident = this.#residents.get(key);
		if (resident !== undefined) {
			this.#residents.delete(key);
			this.owner.residency.forget(resident);
		}
		this.#sources.get(key)?.retire();
	}

	/** The sweep found `resident` idle past the retention: it leaves memory. */
	evict(resident: Resident): void {
		if (this.#residents.get(resident.key) === resident) this.#residents.delete(resident.key);
	}

	/** Its object ended or no attempt declares it any more: the documents go and the keys' watches end. */
	drop(): void {
		for (const resident of this.#residents.values()) this.owner.residency.forget(resident);
		this.#residents.clear();
		for (const source of this.#sources.values()) source.end();
		this.#sources.clear();
	}

	/**
	 * A cold persisted key's load, one in flight per key, on the line under the owner's context (rule 11). The load is
	 * every waiter's: when it takes the line, a waiter whose handle was sealed meanwhile (its attempt failed live, the
	 * object still open) is refused `released`, and with no other waiter the load does not run (rule 4).
	 */
	async #loadShared(key: string, token: SealToken, context: Context): Promise<void> {
		// Also when a load is in flight: a sealed handle's cold read is refused (rule 4).
		this.owner.assertAdmitted(token);
		let load = this.#loads.get(key);
		if (load === undefined) load = this.#startLoad(key);
		load.tokens.add(token);
		await awaitWithContext(load.done, context);
		if (load.refused?.has(token)) throw this.owner.released();
	}

	/** Starts the shared load of `key`; it leaves `#loads` when it settles. */
	#startLoad(key: string): SharedLoad {
		const tokens = new Set<SealToken>();
		const load: SharedLoad = {
			tokens,
			refused: undefined,
			// The job runs once the line is taken, after `load` is assigned.
			done: this.owner.onLine(async () => {
				const refused = new Set([...tokens].filter(({ sealed }) => sealed));
				load.refused = refused;
				if (refused.size === tokens.size) throw this.owner.released();
				await this.load(key, this.owner.context);
			}),
		};
		this.#loads.set(key, load);
		const settled = (): void => {
			this.#loads.delete(key);
		};
		load.done.then(settled, settled);
		return load;
	}

	/** The resident at `key`, migrated to the slot's version first when it is older (migration on access). */
	#resident(key: string): Resident | undefined {
		const resident = this.#residents.get(key);
		if (resident === undefined || resident.version === this.definition.current.version) return resident;
		const tracker = this.#migrated(resident, this.owner.context);
		resident.tracker = tracker;
		resident.version = this.definition.current.version;
		return resident;
	}

	/**
	 * `resident`'s value migrated from its version to the slot's (checked, R8). A throwing `migrate` fails the live
	 * owner `broken` (slice 6a §1.4) and throws the failure (an activation fails with it).
	 */
	#migrated(resident: Resident, context: Context): Tracker<JsonObject> {
		try {
			return track(this.definition.current.migrate(resident.tracker.value, resident.version, context));
		} catch (error) {
			const failure = asChordError(error, this.owner.label);
			this.owner.fail(failure);
			throw failure;
		}
	}

	/** A use of `resident` while unpinned: persisted, it is idle from now (Durable's granule rule). */
	#touch(resident: Resident): void {
		if (this.#persistence !== undefined && !this.#sources.has(resident.key)) this.owner.residency.touch(resident);
	}
}

/**
 * One pinned key of a keyed slot as a source (`handle.at(key)`, a keyed member's `at(key)`, `watch(key)`): the
 * document's value, `initial()` while it is absent; retirements arrive with the `retired` flag.
 */
export class KeySource extends AddressSource {
	readonly owner: Documents;
	readonly #slot: KeyedSlot;
	readonly key: string;
	/** Its pins: at 0 the slot forgets it. */
	pins = 0;
	/** Whether the key was loaded since it was pinned (always, in memory): its value is known. */
	ready: boolean;
	#initial: JsonObject;

	constructor(slot: KeyedSlot, key: string, initial: JsonObject, ready: boolean) {
		super(slot.owner.batch);
		this.owner = slot.owner;
		this.#slot = slot;
		this.key = key;
		this.#initial = initial;
		this.ready = ready;
	}

	get value(): JsonObject {
		this.#slot.owner.assertLive();
		if (!this.ready) {
			const message = `${this.#slot.definition.current.name}(${this.key}): read before it was loaded`;
			throw new ChordError({ code: "not_ready", message });
		}
		return this.peek();
	}

	/** The value without the checks (inside its slot's commits). */
	peek(): JsonObject {
		return this.#slot.current(this.key)?.value ?? this.#initial;
	}

	/** The document was retired: `initial()` from now, with the flag. */
	retire(): void {
		this.retired(this.#initial);
	}

	/** A new definition took over (inside a batch): `initial()` again, the value as a root replacement. */
	retake(initial: JsonObject): void {
		this.#initial = initial;
		if (this.ready) this.replaced();
	}

	/** Its slot was dropped: the watches end. */
	end(): void {
		this.endWatches();
	}
}
