// An object's documents (§9, P2, slice 6a §1.2, §10): its slots across attempts, its line (its transactions and line
// jobs run one at a time), the seal fence over the transaction holding the line, the factory's pins between attempts,
// the activation's loads and the residency of keyed documents.

import type { Context } from "../../context/index.ts";
import { ChordError } from "../data/index.ts";
import type { Batch } from "../state/internal.ts";
import type { ChordStore } from "../store/store.ts";
import type { CommitPersistence, JsonObject, StateDefinition } from "./definition.ts";
import { SealToken } from "./fence.ts";
import { type HandleOf, type KeyDeclarer, Keyed, Singleton } from "./handles.ts";
import { KeyedSlot } from "./keyed-slot.ts";
import { Line } from "./line.ts";
import { Persistence } from "./persistence.ts";
import { Residency } from "./residency.ts";
import { type AnyDefinition, SingletonSlot } from "./slot.ts";
import { Transaction } from "./transaction.ts";

/** Who owns an object's documents: the object's name, batch and context, its store address, its live failure. */
export type DocumentsOwner = {
	/** The owner's name in errors. */
	readonly label: string;
	readonly batch: Batch;
	/** The object's context: shared cold loads run under it (rule 11). */
	readonly context: Context;
	/** The host's store and the object's owner name in it (its type, R2), when it has one. */
	readonly store: { readonly store: ChordStore; readonly owner: string } | undefined;
	/** A document the code cannot read fails the live object `broken` (slice 6a §1.4); ignored when it is not live. */
	fail(error: ChordError): void;
};

/**
 * The documents of one object, from its first activation to its end: one slot per declared name, kept across
 * attempts, and the line. Each attempt declares its handles under its own seal token; the object's own transactions
 * (job outcomes) run under `own`, sealed only by the object's end.
 */
export class Documents {
	/** The owner's name in errors. */
	readonly label: string;
	readonly batch: Batch;
	/** The object's context. */
	readonly context: Context;
	readonly line = new Line();
	/**
	 * The idle persisted keyed documents and their eviction. A sweep's only rejection is `onLine`'s `released` once
	 * the object ended (a sweep itself drops trackers in memory and does not throw): nothing to report.
	 */
	readonly residency = new Residency((sweep) => void this.onLine(async () => sweep()).catch(() => {}));
	readonly #owner: DocumentsOwner;
	/** The token of the object's own transactions: sealed with the object (`seal`). */
	readonly own = new SealToken();
	readonly #slots = new Map<string, SingletonSlot | KeyedSlot>();
	/** The transaction holding the line, until it settles or its token is sealed. */
	#holder: Transaction | undefined;
	/** `sealed`: the object is ending; its documents stay readable, its transactions throw `released`. */
	#state: "open" | "sealed" | "ended" = "open";
	/** The pins the last factory that returned declared (`at(key)`): held until the next one returns (rule 6). */
	#pins: readonly (() => void)[] = [];

	constructor(owner: DocumentsOwner) {
		this.label = owner.label;
		this.batch = owner.batch;
		this.context = owner.context;
		this.#owner = owner;
	}

	/**
	 * A handle to `definition`'s slot for an attempt sealed by `token`, whose `at(key)` pins `declarer` takes: the slot
	 * made by the first declaration of its name, checked against the values for later ones (`SlotDefinition.check`).
	 * "Declared twice" is the attempt's check.
	 */
	declare<D extends StateDefinition<JsonObject, boolean, boolean>>(
		definition: D,
		token: SealToken,
		declarer: KeyDeclarer,
	): HandleOf<D> {
		const slot = this.#slots.get(definition.name);
		if (slot !== undefined) slot.definition.check(definition);
		const persistence = slot === undefined && definition.persist ? this.#persistence(definition.name) : undefined;
		// The definition's `keyed` decides the slot's class and the handle's; its documents are the definition's `T`.
		if (definition.keyed) {
			const keyed = slot ?? this.#add(new KeyedSlot(this, definition, persistence));
			return new Keyed(keyed as KeyedSlot, token, definition.version, declarer) as unknown as HandleOf<D>;
		}
		const singleton = slot ?? this.#add(new SingletonSlot(this, definition, persistence));
		return new Singleton(singleton as SingletonSlot, token, definition.version) as unknown as HandleOf<D>;
	}

	/**
	 * Takes an attempt's declarations once its factory returned: its `at(key)` pins replace the previous factory's, the
	 * slots it no longer declares are dropped (their watches end; persisted ones load again when declared again), every
	 * declared one hydrated (`initial()`, migrations; a throw fails the activation).
	 */
	hydrate(declared: ReadonlyMap<string, AnyDefinition>, pins: readonly (() => void)[], context: Context): void {
		const previous = this.#pins;
		this.#pins = pins;
		for (const release of previous) release();
		// A dropped persisted slot goes whole, its loaded documents too: observably the same as keeping them, since
		// every committed write is in the store and a later declaration reloads from there.
		for (const [name, slot] of this.#slots) {
			if (declared.has(name)) continue;
			this.#slots.delete(name);
			slot.drop();
		}
		for (const [name, definition] of declared) this.#slots.get(name)!.hydrate(definition, context);
	}

	/**
	 * Loads, in one line job, every persisted singleton not loaded yet and every pinned key not loaded since it was
	 * pinned (an attempt's activation, before it goes live, rule 6); `undefined` when nothing is persisted. A failure
	 * fails the activation.
	 */
	load(context: Context): Promise<void> | undefined {
		const persisted = [...this.#slots.values()].filter((slot) => slot.persisted !== undefined);
		// In memory only: nothing to wait for (an activation without persisted documents takes no extra turn).
		if (persisted.length === 0) return undefined;
		return this.onLine(async () => {
			for (const slot of persisted) await slot.loadDeclared(context);
		});
	}

	/**
	 * Runs `job` on the line (a cold load, a page of keys, an eviction sweep); refused `released` once the object is
	 * ending or `token` (the handle's that asks, when the job is one handle's) is sealed, a job queued before either
	 * included (anything taking the line after the seal is refused, rule 4).
	 */
	async onLine<T>(job: () => Promise<T>, token?: SealToken): Promise<T> {
		if (this.#state !== "open" || token?.sealed) throw this.released();
		const release = await this.line.acquire();
		try {
			if (this.#state !== "open" || token?.sealed) throw this.released();
			return await job();
		} finally {
			release();
		}
	}

	/**
	 * Runs `fn` as one transaction on the line under `token` and commits what it drafted (§9): a throw, an abort of
	 * `context`, the token's seal or the object's end discards everything. `persistence` defers storing a run state's
	 * change (D8).
	 */
	async tx<R>(
		fn: (tx: Transaction) => R | Promise<R>,
		token: SealToken,
		context: Context,
		persistence?: CommitPersistence,
	): Promise<R> {
		this.batch.assertOutside("tx");
		this.assertAdmitted(token);
		const release = await this.line.acquire();
		const tx = new Transaction(this, token, release, context, persistence);
		try {
			this.assertAdmitted(token);
			this.#holder = tx;
			const result = await fn(tx);
			// In-memory-only commits are synchronous (W12): no await unless the store's step is taken.
			const step = tx.commit();
			if (step !== undefined) await step;
			return result;
		} catch (error) {
			tx.discard();
			throw error;
		} finally {
			if (this.#holder === tx) this.#holder = undefined;
			release();
			tx.settle();
		}
	}

	/**
	 * Seals `token` (the seal fence): its transactions are refused from now on, and the one holding the line is
	 * discarded and the line released.
	 */
	fence(token: SealToken): void {
		token.seal();
		if (this.#holder?.token === token) this.#cut();
	}

	/** Throws `released` once the object ended. */
	assertLive(): void {
		if (this.#state === "ended") throw this.released();
	}

	/** Throws `released` once `token` is sealed or the object is ending: no new work takes the line. */
	assertAdmitted(token: SealToken): void {
		if (token.sealed || this.#state !== "open") throw this.released();
	}

	/** The live object fails `broken` with `error` (a document the code cannot read); ignored when it is not live. */
	fail(error: ChordError): void {
		this.#owner.fail(error);
	}

	/** The object is ending: every transaction is refused, the one holding the line discarded; documents stay readable. */
	seal(): void {
		if (this.#state !== "open") return;
		this.#state = "sealed";
		this.own.seal();
		this.#cut();
	}

	/**
	 * Resolves once the line is free. After `seal` only an admitted step can hold it (every other holder was cut):
	 * the object's teardown waits here, so the step adopts into documents that still exist (slice 6a §1.3).
	 */
	async settled(): Promise<void> {
		const release = await this.line.acquire();
		release();
	}

	/** Drops every document and pin; watches end `ended`, and every later use throws `released`. */
	end(): void {
		this.#state = "ended";
		this.residency.end();
		for (const slot of this.#slots.values()) slot.drop();
		this.#slots.clear();
		this.#pins = [];
	}

	/** The `released` error of this object's documents. */
	released(): ChordError {
		return new ChordError({ code: "released", reason: "ended", message: `${this.label}: ended` });
	}

	/** Discards the transaction holding the line and releases the line. */
	#cut(): void {
		const holder = this.#holder;
		this.#holder = undefined;
		holder?.cut();
	}

	#add<S extends SingletonSlot | KeyedSlot>(slot: S): S {
		this.#slots.set(slot.definition.current.name, slot);
		return slot;
	}

	/** The store side of persisted documents named `name`; the attempt checked the store first (P3). */
	#persistence(name: string): Persistence {
		const { store, owner } = this.#owner.store!;
		return new Persistence(store, owner, "chord", name);
	}
}
