// Keyed members across attempts (slice 6a §1.2, §1.4, §12): the keys of a local object's keyed members that references
// pin (`ref.member.at(key)`, `ref.member.watch(key)`), one member source per member and key, as state members have.
// While an attempt is live a key follows that attempt's keyed member (the object's own slot, or the provider's member
// it re-exposes, rule 22: one tracker at the end); while the object is failed it keeps its last value and gets no
// frames; when a new attempt goes live it follows that attempt's member of the same name, its key loaded before.

import { awaitWithContext, type Context } from "../../context/index.ts";
import type { ChordError } from "../data/index.ts";
import type { KeyedSlot } from "../documents/internal.ts";
import type { Batch, DeriveSource } from "../state/internal.ts";
import { MemberSource } from "./member-source.ts";
import type { KeyedBinding } from "./members.ts";

/** A key of a keyed member, pinned: its source, and the release (idempotent). */
export type PinnedKey = { readonly source: DeriveSource; readonly release: () => void };

/** A pinned key on one attempt's keyed member; `foreign` when the member is another object's (re-exposed). */
type Following = { readonly pin: PinnedKey; readonly foreign: boolean };

/**
 * Where one pinned key stands: its first pin in flight (`loading`: `abandon` rejects its users' waits), following an
 * attempt's member, frozen while its object is failed or activating again (both with what a new attempt prepared to
 * follow, `next`), dropped (its last user left, or its object failed or ended while it loaded), or ended with its
 * object (`error`, for a pin whose wait resolved just before).
 */
type EntryState =
	| { readonly kind: "loading"; readonly abandon: (error: unknown) => void }
	| {
			readonly kind: "bound";
			readonly source: MemberSource;
			readonly following: Following;
			readonly next: Following | undefined;
	  }
	| { readonly kind: "frozen"; readonly source: MemberSource; readonly next: Following | undefined }
	| { readonly kind: "dropped" }
	| { readonly kind: "ended"; readonly error: ChordError };

/** One pinned key of one keyed member: its users, the wait of its first pin, and where it stands. */
type Entry = {
	readonly member: string;
	readonly key: string;
	users: number;
	readonly ready: Promise<void>;
	state: EntryState;
};

/** The pinned keys of one object's keyed members, across its attempts; every pin below them released exactly once. */
export class KeyedMembers {
	readonly #batch: Batch;
	/** The object's context: a key's first load runs under it, shared by every user. */
	readonly #context: Context;
	readonly #entries = new Map<string, Map<string, Entry>>();

	constructor(batch: Batch, context: Context) {
		this.#batch = batch;
		this.#context = context;
	}

	/** Whether no key is pinned. */
	get empty(): boolean {
		return this.#entries.size === 0;
	}

	/**
	 * Pins `key` (a stored key) of `member`, which the live attempt has as `keyed`: its member source once the key is
	 * loaded; `context` ends only this caller's wait. Rejects when the object fails or ends while the first pin loads.
	 */
	async pin(member: string, key: string, keyed: KeyedBinding, context: Context): Promise<PinnedKey> {
		const entry = this.#entries.get(member)?.get(key) ?? this.#create(member, key, keyed);
		entry.users++;
		try {
			await awaitWithContext(entry.ready, context);
		} catch (error) {
			this.#release(entry);
			throw error;
		}
		const { state } = entry;
		// Loaded, but its object ended before this wait resumed: nothing to pin (the entry is gone).
		if (state.kind === "ended") throw state.error;
		// Loaded, and its object neither failed nor ended since (a failure while loading rejects `ready` first).
		const source = (state as Extract<EntryState, { readonly kind: "bound" | "frozen" }>).source;
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			this.#release(entry);
		};
		return { source, release };
	}

	/**
	 * Loads every pinned key on `members` (a new attempt's, while it activates, before it goes live); `undefined` when
	 * no key is pinned. Rejects when a load fails; `rebind` or `discard` then takes what it pinned.
	 */
	prepare(members: ReadonlyMap<string, KeyedBinding>, context: Context): Promise<void> | undefined {
		if (this.#entries.size === 0) return undefined;
		return (async () => {
			for (const byKey of this.#entries.values()) {
				for (const entry of byKey.values()) {
					const keyed = members.get(entry.member);
					if (keyed === undefined || (entry.state.kind !== "bound" && entry.state.kind !== "frozen")) continue;
					const next = { pin: await pinOn(keyed, entry.key, context), foreign: keyed.kind === "reexposed" };
					const state = entry.state;
					// Dropped while it loaded: the new pin goes at once.
					if (state.kind !== "bound" && state.kind !== "frozen") {
						next.pin.release();
						continue;
					}
					state.next?.pin.release();
					entry.state = { ...state, next };
				}
			}
		})();
	}

	/** The new attempt went live, inside a batch: every prepared key follows its new member (one frame). */
	rebind(): void {
		for (const byKey of this.#entries.values()) {
			for (const entry of byKey.values()) {
				const state = entry.state;
				if ((state.kind !== "bound" && state.kind !== "frozen") || state.next === undefined) continue;
				state.source.bind(state.next.pin.source);
				if (state.kind === "bound") state.following.pin.release();
				entry.state = { kind: "bound", source: state.source, following: state.next, next: undefined };
			}
		}
	}

	/** The new attempt did not go live: what `prepare` pinned is released. */
	discard(): void {
		for (const byKey of this.#entries.values()) {
			for (const entry of byKey.values()) {
				const state = entry.state;
				if ((state.kind !== "bound" && state.kind !== "frozen") || state.next === undefined) continue;
				state.next.pin.release();
				entry.state = { ...state, next: undefined };
			}
		}
	}

	/**
	 * The object failed live (`error`): the keys keep their values and release what they follow; `foreign` takes only
	 * the keys of re-exposed members (no admitted commit of this object changes them), `all` every key. A first pin
	 * still loading is given up at once (its users' waits reject with `error`; the pin, when it lands, is released).
	 */
	freeze(which: "foreign" | "all", error: unknown): void {
		for (const byKey of this.#entries.values()) {
			for (const entry of [...byKey.values()]) {
				const state = entry.state;
				if (state.kind === "loading") {
					this.#abandon(entry, state, error);
					continue;
				}
				if (state.kind !== "bound" || (which === "foreign" && !state.following.foreign)) continue;
				state.source.freeze();
				state.following.pin.release();
				entry.state = { kind: "frozen", source: state.source, next: state.next };
			}
		}
	}

	/** The object ended, inside a batch: every key ends with `error` and releases what it pins. */
	end(error: ChordError): void {
		for (const byKey of this.#entries.values()) {
			for (const entry of byKey.values()) {
				const state = entry.state;
				if (state.kind === "loading") state.abandon(error);
				else if (state.kind === "bound" || state.kind === "frozen") state.source.objectEnded(error);
				this.#releaseAll(entry);
				entry.state = { kind: "ended", error };
			}
		}
		this.#entries.clear();
	}

	/** A new entry, its first pin started under the object's context. */
	#create(member: string, key: string, keyed: KeyedBinding): Entry {
		const ready = Promise.withResolvers<void>();
		// Each user awaits `ready`; a rejection nobody waits for is not unhandled.
		ready.promise.catch(() => {});
		const entry: Entry = {
			member,
			key,
			users: 0,
			ready: ready.promise,
			state: { kind: "loading", abandon: ready.reject },
		};
		pinOn(keyed, key, this.#context).then(
			(pin) => {
				// Given up meanwhile (its object failed or ended, or every user left): the late pin goes, once.
				if (entry.state.kind !== "loading") {
					pin.release();
					return;
				}
				const source = new MemberSource(pin.source, this.#batch);
				entry.state = {
					kind: "bound",
					source,
					following: { pin, foreign: keyed.kind === "reexposed" },
					next: undefined,
				};
				ready.resolve();
			},
			(error) => {
				if (entry.state.kind === "loading") this.#abandon(entry, entry.state, error);
			},
		);
		let byKey = this.#entries.get(member);
		if (byKey === undefined) {
			byKey = new Map();
			this.#entries.set(member, byKey);
		}
		byKey.set(key, entry);
		return entry;
	}

	/** Gives up `entry`'s first pin with `error`: dropped and forgotten, its users' waits rejected. */
	#abandon(entry: Entry, state: Extract<EntryState, { readonly kind: "loading" }>, error: unknown): void {
		entry.state = { kind: "dropped" };
		this.#forget(entry);
		state.abandon(error);
	}

	/** One user of `entry` left; the last drops it. */
	#release(entry: Entry): void {
		if (--entry.users > 0) return;
		this.#forget(entry);
		this.#releaseAll(entry);
	}

	/** Drops `entry`: what it follows and will follow is released; its source keeps its value and follows nothing. */
	#releaseAll(entry: Entry): void {
		const state = entry.state;
		entry.state = { kind: "dropped" };
		if (state.kind !== "bound" && state.kind !== "frozen") return;
		state.source.freeze();
		if (state.kind === "bound") state.following.pin.release();
		state.next?.pin.release();
	}

	#forget(entry: Entry): void {
		const byKey = this.#entries.get(entry.member);
		if (byKey?.get(entry.key) !== entry) return;
		byKey.delete(entry.key);
		if (byKey.size === 0) this.#entries.delete(entry.member);
	}
}

/**
 * Pins `key` on `keyed`: on the object's own slot it is pinned and loaded; on a re-exposed member it is pinned on the
 * provider's member (whose own keys follow its attempts).
 */
function pinOn(keyed: KeyedBinding, key: string, context: Context): Promise<PinnedKey> {
	if (keyed.kind === "reexposed") return keyed.binding.pinKey(keyed.member, key, context);
	return pinned(keyed.slot, key, context);
}

/** Pins `key` on `slot` and loads it when it is not in memory; a failed load releases the pin. */
async function pinned(slot: KeyedSlot, key: string, context: Context): Promise<PinnedKey> {
	const release = slot.pin(key, context);
	try {
		await slot.ensure(key, context);
	} catch (error) {
		release();
		throw error;
	}
	return { source: slot.source(key), release };
}
