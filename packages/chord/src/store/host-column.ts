// `host(kind)` table columns (decision "Documents and table rows can belong to a host"): a column holding the address of
// a host of one kind, stored as the address key in a `TEXT` cell (a `str` column to the store), so the store finds the
// rows belonging to one host (`host-data.ts`: export, import, delete). At most one per table, never `opt(...)`, indexed.

import type { Address, HostKind, KindShape, Schema } from "../contracts/index.ts";
import { addressOfKey, keyOfAddress, kindParams, type Params } from "../contracts/internal.ts";
import { invalid } from "../data/internal.ts";
import { storedText } from "./text.ts";

/** A `host(...)` column as `columns` takes it: a schema of the kind's addresses carrying the column. */
export interface HostColumnSchema<K extends KindShape> extends Schema<Address<K>> {
	readonly host: HostColumn;
}

/** A column holding an address of host kind `kind` per row: the row belongs to that host. */
export function host<N extends string, P extends Params>(kind: HostKind<N, P>): HostColumnSchema<HostKind<N, P>> {
	// Typed as the addresses' schema, so `Static` reads it; the table reads its `host` field.
	return { host: new HostColumn(kind) } as HostColumnSchema<HostKind<N, P>>;
}

/** A `host(...)` column's definition: its kind, the stored key of an address and the address of a stored key. */
export class HostColumn {
	readonly kind: KindShape;

	constructor(kind: KindShape) {
		// Declaration policy: only a declared kind decodes keys (throws otherwise).
		kindParams(kind);
		this.kind = kind;
	}

	/**
	 * The canonical stored key of `value`, an address of the column's kind (a trust boundary): its key under the `str()`
	 * text rules (a lone surrogate replaced, NUL refused), as document keys and host data selections have it;
	 * `invalid/args` otherwise.
	 */
	key(value: unknown, what: string): string {
		const key = keyOfAddress(this.kind, value);
		if (key === undefined) throw invalid("args", `${what}: expected an address of ${this.kind.kind}`);
		return storedText(key, what);
	}

	/** The address a stored key holds. */
	address(key: string): Address {
		return addressOfKey(this.kind, key);
	}
}
