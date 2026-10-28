// Host kinds and addresses (§3): a kind of addressable host with params like a contract's, and the address of one
// host of a kind, which a remote contract's placement computes from its params.

import { checkName } from "./names.ts";
import { joinKey, type Params, type ParamsData, type RequiredFields, readParams } from "./params.ts";
import type { Static } from "./schema.ts";

/** What an address's type needs of its kind: the name and the params, type only. */
export type KindShape = { readonly kind: string; readonly "~params"?: Params };

/** One host of a kind: the kind's name, its params and its key (`session|S1`); two addresses are equal by key. */
export type Address<K extends KindShape = KindShape> = {
	readonly kind: K["kind"];
	readonly params: ParamsOfKind<K>;
	readonly key: string;
};

/** A kind of addressable host: called with its params, it makes an address. */
export interface HostKind<N extends string = string, P extends Params = Params> {
	(
		...params: keyof P extends never ? [params?: Record<never, never>] : [params: { [F in keyof P]: Static<P[F]> }]
	): Address<HostKind<N, P>>;
	readonly kind: N;
	/** Type only: absent at runtime. */
	readonly "~params"?: P;
}

/** The params object of a host kind. */
export type ParamsOfKind<K extends KindShape> = {
	[F in keyof NonNullable<K["~params"]>]: Static<NonNullable<K["~params"]>[F]>;
};

/**
 * Declares a host kind; `params` follow the params policy of contracts (a flat record of required `str()`, `int()`,
 * `bool()` and `oneOf(...)`). Making an address computes its key only: its params are checked where it is routed.
 */
export function hostKind<const N extends string, const P extends Params = Record<never, never>>(
	name: N,
	params?: P & NoInfer<RequiredFields<P>>,
): HostKind<N, P> {
	checkName(name, "A host kind's name");
	// `client` is the host kind of a host without an address in store names (owner strings, table names).
	if (name === "client") throw new Error('A host kind\'s name "client" is reserved for hosts without an address');
	const data = readParams(Object.entries(params ?? {}), `${name}.params`);
	const make = (values: { readonly [field: string]: unknown } = {}) => ({
		kind: name,
		params: values,
		key: addressKey(name, data, values),
	});
	Object.defineProperty(make, "kind", { value: name, enumerable: true });
	kinds.set(make, data);
	// The function and its `kind` are the declared shape; the params type is type-level only.
	return make as unknown as HostKind<N, P>;
}

const kinds = new WeakMap<object, ParamsData>();

/** The params of a declared host kind. */
export function kindParams(kind: { readonly kind: string }): ParamsData {
	const data = kinds.get(kind);
	if (data === undefined) throw new Error(`${kind.kind}: not a declared host kind`);
	return data;
}

/** An address's key: the kind's name and each field value in declared order, joined (`joinKey`). */
export function addressKey(kind: string, params: ParamsData, values: { readonly [field: string]: unknown }): string {
	return joinKey([kind, ...params.fields.map((field) => String(values[field]))]);
}
