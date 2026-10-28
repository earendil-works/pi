// Presence (§19): `host.references(Type)`, a JSON watchable of the references to objects of one type on this host, one
// entry per reference with the object's params, the reference's principal (remote types) and its incarnation.

import type { Context } from "../../context/index.ts";
import type { Op } from "../../delta/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import { Source } from "../state/internal.ts";
import type { ChordObject, Holder } from "./object.ts";

/**
 * One reference to an object of `C`: the object's params, the principal it acts as (for a remote type), and its
 * incarnation: the host that made it as its caller sees it (a hold's caller over a link; two tabs are two
 * incarnations), the word `ctx.incarnation` uses.
 */
export type Presence<C extends Contract = Contract, P extends Principal = Principal> = {
	readonly params: ParamsOf<C>;
	readonly principal?: P;
	readonly incarnation: string;
};

/**
 * The references of one type, made by the host for its first `host.references(Type)` and kept from then on: one entry
 * per reference, added when it binds and removed when it ends, in the batch where that happens (derives over it
 * recompute there). While watched, a batch's changes are folded into the published list once, with one splice op per
 * removal and one for the additions; otherwise the list is built on its next read.
 */
export class References extends Source {
	readonly #entries = new Map<Holder, Presence>();
	/** The list as last published or read; `undefined` once it changed while nobody watched it. */
	#list: readonly Presence[] | undefined;
	/** Entries added since `#list`, in order (only while it is defined). */
	#added: Presence[] = [];
	/** Entries of `#list` removed since. */
	readonly #removed = new Set<Presence>();
	/** The ops folding `#list` forward, for the current batch's frame. */
	#ops: Op[] = [];

	get value(): JsonValue {
		this.#fold();
		// Entries are JSON: params, a principal and a string.
		return this.#list as unknown as JsonValue;
	}

	/** `holder` references `object`, added in the batch running now or the next one. */
	add(object: ChordObject, holder: Holder, context: Context): void {
		this.batch.within(() => {
			const entry = this.record(object, holder);
			if (this.#follows()) this.#added.push(entry);
			this.changed();
		}, context);
	}

	/** `holders` of `object` ended, removed in one batch. */
	remove(holders: Iterable<Holder>, context: Context): void {
		this.batch.within(() => {
			const follows = this.#follows();
			for (const holder of holders) {
				const entry = this.#entries.get(holder);
				if (entry === undefined) continue;
				this.#entries.delete(holder);
				if (!follows) continue;
				const added = this.#added.indexOf(entry);
				if (added === -1) this.#removed.add(entry);
				else this.#added.splice(added, 1);
			}
			this.changed();
		}, context);
	}

	/** Records `holder` without a batch (the list being made) and returns its entry. */
	record(object: ChordObject, holder: Holder): Presence {
		const { principal, incarnation } = holder.caller;
		const entry: Presence = {
			params: object.params,
			...(object.served.kind === "remote" && principal !== undefined ? { principal } : {}),
			incarnation,
		};
		this.#entries.set(holder, entry);
		return entry;
	}

	deliver(context: Context): void {
		const value = this.value;
		const ops = this.#ops;
		this.#ops = [];
		// Listed once per change: the batch's first delivery carries all of them.
		if (ops.length > 0) this.publish(value, ops, false, context);
	}

	/**
	 * Whether a change is folded into the published list: while watched (a watch read the list first). Otherwise the
	 * list is dropped and built on its next read.
	 */
	#follows(): boolean {
		if (this.watched && this.#list !== undefined) return true;
		this.#list = undefined;
		return false;
	}

	/**
	 * Folds the changes since `#list` into a new list, once: a removal is one splice op at its index, the additions one
	 * splice op at the end. Builds the list from the entries when there is none.
	 */
	#fold(): void {
		if (this.#list === undefined) {
			this.#list = [...this.#entries.values()];
			this.#added = [];
			this.#removed.clear();
			this.#ops = [];
			return;
		}
		if (this.#added.length === 0 && this.#removed.size === 0) return;
		let list = this.#list;
		if (this.#removed.size > 0) {
			const kept: Presence[] = [];
			for (const entry of list) {
				if (this.#removed.has(entry)) this.#ops.push(["p", [], kept.length, 1, []]);
				else kept.push(entry);
			}
			this.#removed.clear();
			list = kept;
		}
		if (this.#added.length > 0) {
			this.#ops.push(["p", [], list.length, 0, this.#added as unknown as JsonValue[]]);
			list = [...list, ...this.#added];
			this.#added = [];
		}
		this.#list = list;
	}
}
