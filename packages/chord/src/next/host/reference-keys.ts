// The keys a reference holds (slice 6a §12; decision "References are the only indirection" (4)): its key watches and
// its factory's pins (`at(key)`) of its object's keyed members, one source per member and key shared by them, pinned on
// the object's live instance (loaded, mapped to the reference's version). While the object still follows the instance a
// key is pinned on (a swap's old instance, a restart's drain, a live failure's admitted commits) the key follows it on,
// as members do. When the reference moves to a new instance or a new object it pins the key there again, keeping the
// last value until that pin loads, then one frame; while it points at nothing the key keeps its last value (one
// `failed` call when its target failed, none while it loads).

import { awaitWithContext, BACKGROUND_CONTEXT, type Context } from "../../context/index.ts";
import { ChordError } from "../data/index.ts";
import { asChordError } from "../data/internal.ts";
import type { Batch } from "../state/internal.ts";
import type { PinnedKey } from "./attempt.ts";
import type { Target } from "./reference.ts";
import { ReferenceSource } from "./reference-source.ts";

/** What a reference's keys need of it. */
export interface KeyHolder {
	readonly batch: Batch;
	/** Its contract version: keys are mapped to it. */
	readonly version: number;
	/** The object it is bound to; `undefined` while unbound. */
	target(): Target | undefined;
	/** What a read throws while a key never had a value. */
	none(): ChordError;
}

/** One key of one keyed member held by the reference: its source, its users, and the instance pin it follows. */
type KeyEntry = {
	readonly member: string;
	readonly key: string;
	readonly source: ReferenceSource;
	holders: number;
	/** The live instance its pin is (or is being) taken on; `undefined` while it points at nothing. */
	instance: unknown;
	/** The pin it follows. */
	pin: PinnedKey | undefined;
	/** The pin in flight, settled once the source follows it. */
	loading: Promise<void> | undefined;
};

/** A reference's held keys; every instance pin below them released exactly once. */
export class ReferenceKeys {
	readonly #holder: KeyHolder;
	readonly #entries = new Map<string, Map<string, KeyEntry>>();

	constructor(holder: KeyHolder) {
		this.#holder = holder;
	}

	/**
	 * Holds `key` of keyed member `member`: its source once pinned and loaded on the live instance; `context` ends only
	 * this caller's wait. `release` (once) lets it go with its last holder.
	 */
	async hold(member: string, key: string, context: Context): Promise<PinnedKey> {
		const entry = this.#entry(member, key);
		entry.holders++;
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			this.#release(entry);
		};
		try {
			if (entry.pin === undefined) await awaitWithContext(this.#pin(entry), context);
		} catch (error) {
			release();
			throw error;
		}
		return { source: entry.source, release };
	}

	/**
	 * Its reference's target changed, inside a batch: a key pins again on a new live instance (last value meanwhile);
	 * while the target is not live it follows the instance it is pinned on as long as the object does (a commit admitted
	 * there still shows), then keeps its last value (one `failed` call for a failure) and its pin goes.
	 */
	follow(context: Context): void {
		const target = this.#holder.target();
		const instance = target?.instance;
		const attachable = target?.attachable;
		for (const byKey of this.#entries.values()) {
			for (const entry of byKey.values()) {
				if (instance !== undefined) {
					// A failed load shows on the key (`failed`); nobody waits on this pin.
					if (entry.instance !== instance) this.#pin(entry).catch(() => {});
					continue;
				}
				if (attachable !== undefined && entry.instance === attachable) continue;
				const state = target?.state;
				if (state?.kind === "failed") entry.source.fail(state.cause.error, context);
				else entry.source.hold();
				this.#unpin(entry);
			}
		}
	}

	/** Its reference left its object (`error`: why it waits), inside a batch: keys keep their last values, pins go. */
	fail(error: ChordError, context: Context): void {
		for (const byKey of this.#entries.values()) {
			for (const entry of byKey.values()) {
				entry.source.fail(error, context);
				this.#unpin(entry);
			}
		}
	}

	/** Its reference ended, inside a batch: every key ends with `error` and releases its pin. */
	end(error: ChordError): void {
		for (const byKey of this.#entries.values()) {
			for (const entry of byKey.values()) {
				entry.source.end(error);
				this.#unpin(entry);
			}
		}
		this.#entries.clear();
	}

	/** The entry of `member` and `key`, made by the first holder. */
	#entry(member: string, key: string): KeyEntry {
		let byKey = this.#entries.get(member);
		if (byKey === undefined) {
			byKey = new Map();
			this.#entries.set(member, byKey);
		}
		let entry = byKey.get(key);
		if (entry === undefined) {
			const source = new ReferenceSource(this.#holder.batch, this.#holder);
			entry = { member, key, source, holders: 0, instance: undefined, pin: undefined, loading: undefined };
			byKey.set(key, entry);
		}
		return entry;
	}

	/**
	 * Pins `entry`'s key on the target's live instance (once per instance): the source keeps its last value meanwhile,
	 * follows the pin when it lands (one frame) and releases the previous one; a failed load shows as its failure.
	 */
	#pin(entry: KeyEntry): Promise<void> {
		const { batch, version } = this.#holder;
		const target = this.#holder.target();
		const instance = target?.instance;
		if (target === undefined || instance === undefined) return Promise.reject(this.#holder.none());
		if (entry.instance === instance && entry.loading !== undefined) return entry.loading;
		entry.instance = instance;
		// No frames from the old instance while the new one loads the key.
		entry.source.hold();
		const loading = target.pinKey(entry.member, entry.key, version, BACKGROUND_CONTEXT).then(
			(pin) => {
				if (entry.instance !== instance || entry.holders === 0) {
					pin.release();
					return;
				}
				const previous = entry.pin;
				entry.pin = pin;
				batch.within(() => entry.source.bind(pin.source), BACKGROUND_CONTEXT);
				previous?.release();
			},
			(error: unknown) => {
				if (entry.instance === instance) {
					entry.instance = undefined;
					entry.loading = undefined;
					const failure = asChordError(error, target.label);
					batch.within(() => entry.source.fail(failure, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
				}
				throw error;
			},
		);
		entry.loading = loading;
		return loading;
	}

	/** One holder of `entry` left; the last drops it and its pin. */
	#release(entry: KeyEntry): void {
		if (--entry.holders > 0) return;
		const byKey = this.#entries.get(entry.member);
		if (byKey?.get(entry.key) !== entry) return;
		byKey.delete(entry.key);
		if (byKey.size === 0) this.#entries.delete(entry.member);
		// Its source ends: it leaves the document, whose other holders would keep it and its reference (Astra, GC).
		const released = new ChordError({ code: "released", message: `${entry.member}.at(${entry.key}): released` });
		const end = (): void => entry.source.end(released);
		if (entry.source.inUse) this.#holder.batch.within(end, BACKGROUND_CONTEXT);
		else end();
		this.#unpin(entry);
	}

	/** Releases the pin `entry` follows or awaits: it points at nothing until pinned again. */
	#unpin(entry: KeyEntry): void {
		entry.pin?.release();
		entry.pin = undefined;
		entry.instance = undefined;
		entry.loading = undefined;
	}
}
