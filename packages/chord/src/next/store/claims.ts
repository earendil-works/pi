// Claims (slice 6b "owner names and claims", "claims per table and per document namespace"): what can collide in a
// store is claimed once, in memory: a table by its SQL name, documents by `(owner, namespace)`. A claim is held by its
// claimant (an object, a `StoreStorage`) until its end releases every claim it holds. While a batch applies, nothing
// is claimed: batch apply and owners exclude each other both ways.

import { invalid } from "../data/internal.ts";

/** Who holds claims: named in the refusal of a second claim. */
export type Claimant = { readonly label: string };

/** A store's claims, by key; one claimant per key. */
export class Claims {
	readonly #holders = new Map<string, Claimant>();
	readonly #keys = new Map<Claimant, string[]>();
	/** Whether a batch applies now: no claim is taken meanwhile. */
	#locked = false;

	/** Whether any claimant holds a claim (batch apply is refused then: its memory would go stale). */
	get held(): boolean {
		return this.#keys.size > 0;
	}

	/** Claims table `table` (its SQL name) for `claimant`; held by another: `invalid/args`. */
	table(table: string, claimant: Claimant): void {
		this.#claim(`table ${JSON.stringify(table)}`, claimant);
	}

	/** Claims the documents of `owner` in `namespace` for `claimant`; held by another: `invalid/args`. */
	documents(owner: string, namespace: string, claimant: Claimant): void {
		this.#claim(`documents ${JSON.stringify([owner, namespace])}`, claimant);
	}

	/** Refuses every claim (`invalid/args`) until the returned unlock: a batch applies meanwhile. */
	lock(): () => void {
		this.#locked = true;
		return () => {
			this.#locked = false;
		};
	}

	/** Releases every claim `claimant` holds. */
	release(claimant: Claimant): void {
		for (const key of this.#keys.get(claimant) ?? []) this.#holders.delete(key);
		this.#keys.delete(claimant);
	}

	#claim(key: string, claimant: Claimant): void {
		if (this.#locked) throw invalid("args", `store: ${key} cannot be claimed while a batch applies`);
		const holder = this.#holders.get(key);
		if (holder === claimant) return;
		if (holder !== undefined) throw invalid("args", `store: ${key} is claimed by ${holder.label}`);
		this.#holders.set(key, claimant);
		const keys = this.#keys.get(claimant);
		if (keys === undefined) this.#keys.set(claimant, [key]);
		else keys.push(key);
	}
}
