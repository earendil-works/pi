// Revocation keys (§4, R10, R11): what `revokedBy` says revokes a principal, as canonical JSON, computed once per
// principal object.

import type { Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Principal } from "../data/index.ts";
import { canonicalJson } from "../data/internal.ts";

/** What revokes a principal: the app's typed values, the same function on every host. */
export type RevokedBy<P extends Principal, R extends JsonValue> = (principal: P) => readonly R[];

/** A host's revocation keys: each principal's, cached weakly by the principal object. */
export class RevocationKeys {
	readonly #revokedBy: RevokedBy<Principal, JsonValue> | undefined;
	readonly #keys = new WeakMap<Principal, ReadonlySet<string>>();

	constructor(revokedBy: RevokedBy<Principal, JsonValue> | undefined) {
		this.#revokedBy = revokedBy;
	}

	/**
	 * Whether `key` (a revocation's canonical JSON) is one of `principal`'s revocation keys: the canonical JSON of each
	 * value `revokedBy` returns for it, computed on its first use.
	 */
	revokes(principal: Principal, key: string, context: Context): boolean {
		const revokedBy = this.#revokedBy;
		if (revokedBy === undefined) return false;
		let keys = this.#keys.get(principal);
		if (keys === undefined) {
			keys = new Set(revokedBy(principal).map((revocation) => canonicalJson(revocation, context)));
			this.#keys.set(principal, keys);
		}
		return keys.has(key);
	}
}
