// Document handles (slice 6a §1.2): what `self.state` returns, one per attempt and definition, a thin view of its
// object's slot bound to the attempt's seal token and the definition's version.

import type { Context } from "../../context/index.ts";
import type { Draft } from "../../delta/index.ts";
import type { Watch, Watchable, WatchHandle } from "../../watch.ts";
import type { JsonObject, StateDefinition } from "./definition.ts";
import type { SealToken } from "./fence.ts";
import type { KeyedSlot, KeySource } from "./keyed-slot.ts";
import type { SingletonSlot } from "./slot.ts";

/** A singleton document: a watchable that always has a value (`initial()` until written, and after a retire). */
export interface SingletonHandle<T extends JsonObject> extends Watchable<T> {
	/** One transaction that drafts this document and passes the draft to `fn`. */
	change<R>(fn: (draft: Draft<T>) => R, context: Context): Promise<R>;
	/** One transaction that retires this document: back to `initial()`. */
	retire(context: Context): Promise<void>;
}

/**
 * Keyed documents: many per object, by string key. Not a watchable itself: each key is, through `watch(key)` and
 * `at(key)`; a live collection is a singleton holding it.
 */
export interface KeyedHandle<T extends JsonObject> {
	/** The document's value, `undefined` when absent (persisted and not in memory: loaded on the object's line). */
	get(key: string, context: Context): Promise<T | undefined>;
	/** The keys of the present documents, in code point order. */
	keys(context: Context): AsyncIterable<string>;
	/**
	 * A watch of the document at `key`, `undefined` when absent. It follows the address: a retirement is one frame with
	 * `retired: true` and `initial()`, a later creation a root replacement; it ends with the object.
	 */
	watch(key: string, context: Context): Promise<WatchHandle<T> | undefined>;
	/**
	 * In the factory only: the document at `key` as a watchable (a state member, a derive source, an `on` source),
	 * `initial()` while absent, loaded before the object goes live and pinned while this attempt lives.
	 */
	at(key: string): Watchable<T>;
	/** One transaction that drafts the document at `key` and passes the draft to `fn`. */
	change<R>(key: string, fn: (draft: Draft<T>) => R, context: Context): Promise<R>;
	/** One transaction that retires the document at `key` (a no-op when absent). */
	retire(key: string, context: Context): Promise<void>;
}

/** The handle `self.state(definition)` returns. */
export type HandleOf<D> = D extends StateDefinition<infer T, infer K, boolean>
	? K extends true
		? KeyedHandle<T>
		: SingletonHandle<T>
	: never;

/**
 * A singleton's handle. Reads go to the slot (allowed after the seal); `change` and `retire` take the line under the
 * attempt's token. Exposed as a member or read by a derive, it resolves to the slot itself.
 */
export class Singleton implements SingletonHandle<JsonObject> {
	readonly slot: SingletonSlot;
	readonly token: SealToken;
	/** The version of the definition it was declared with: the slot refuses it once its values are newer (R15). */
	readonly version: number;

	constructor(slot: SingletonSlot, token: SealToken, version: number) {
		this.slot = slot;
		this.token = token;
		this.version = version;
	}

	get value(): JsonObject {
		this.slot.definition.assertVersion(this.version);
		return this.slot.value;
	}

	async watch(context: Context): Promise<Watch<JsonObject>> {
		this.slot.definition.assertVersion(this.version);
		// The slot's values are this handle's documents.
		return this.slot.openWatch(context) as Watch<JsonObject>;
	}

	change<R>(fn: (draft: Draft<JsonObject>) => R, context: Context): Promise<R> {
		return this.slot.owner.tx(async (tx) => fn(await tx.draft(this)), this.token, context);
	}

	retire(context: Context): Promise<void> {
		return this.slot.owner.tx((tx) => tx.retire(this), this.token, context);
	}
}

/** Who declares an attempt's `at(key)` pins: its factory, which alone may (the attempt). */
export interface KeyDeclarer {
	/** Pins `key` of `slot` for the attempt and returns its source; throws outside the factory. */
	at(slot: KeyedSlot, key: string): KeySource;
}

/** A keyed handle: reads go to the slot; `change`, `retire` and cold reads take the line under the attempt's token. */
export class Keyed implements KeyedHandle<JsonObject> {
	readonly slot: KeyedSlot;
	readonly token: SealToken;
	/** As `Singleton.version`. */
	readonly version: number;
	readonly #declarer: KeyDeclarer;

	constructor(slot: KeyedSlot, token: SealToken, version: number, declarer: KeyDeclarer) {
		this.slot = slot;
		this.token = token;
		this.version = version;
		this.#declarer = declarer;
	}

	get(key: string, context: Context): Promise<JsonObject | undefined> {
		return this.slot.get(key, this, context);
	}

	keys(context: Context): AsyncIterable<string> {
		return this.slot.keys(this, context);
	}

	watch(key: string, context: Context): Promise<Watch<JsonObject> | undefined> {
		return this.slot.watch(key, this, context);
	}

	at(key: string): Watchable<JsonObject> {
		// The source's values are this slot's documents.
		return this.#declarer.at(this.slot, key) as unknown as Watchable<JsonObject>;
	}

	change<R>(key: string, fn: (draft: Draft<JsonObject>) => R, context: Context): Promise<R> {
		return this.slot.owner.tx(async (tx) => fn(await tx.draft(this, key)), this.token, context);
	}

	retire(key: string, context: Context): Promise<void> {
		return this.slot.owner.tx((tx) => tx.retire(this, key), this.token, context);
	}
}
