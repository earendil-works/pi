// Host kinds and addresses (§3): a kind of addressable host with params like a contract's, and the address of one
// host of a kind, which a remote contract's `hostAddress` computes from its params.

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
	kinds.set(make, { data, fields: fieldsOf(data) });
	// The function and its `kind` are the declared shape; the params type is type-level only.
	return make as unknown as HostKind<N, P>;
}

/** One params field as an address key holds it: its name, its type and, for `oneOf(...)`, its literals. */
type KeyField = {
	readonly name: string;
	readonly type: "string" | "integer" | "boolean";
	readonly literals: ReadonlySet<string> | undefined;
};

/** A declared kind's params and its fields as keys hold them (read once, at declaration). */
type KindData = { readonly data: ParamsData; readonly fields: readonly KeyField[] };

const kinds = new WeakMap<object, KindData>();

/** The params of a declared host kind. */
export function kindParams(kind: { readonly kind: string }): ParamsData {
	return kindData(kind).data;
}

/**
 * The key of `value` when it is an address of `kind` (a trust boundary for values a plugin hands in: a host-keyed
 * document's key, a `host(...)` cell): an object of that kind whose `params` hold exactly the kind's fields, each of
 * its type (a `oneOf(...)` one among its literals; other constraints are checked where the address is routed). The key
 * is computed from the params, never taken from `value.key`. `undefined` when it does not fit.
 */
export function keyOfAddress(kind: { readonly kind: string }, value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { kind: name, params } = value as { readonly kind?: unknown; readonly params?: unknown };
	if (name !== kind.kind || typeof params !== "object" || params === null) return undefined;
	const { data, fields } = kindData(kind);
	const values = params as { readonly [field: string]: unknown };
	if (Object.keys(values).length !== fields.length) return undefined;
	for (const { name: field, type, literals } of fields) {
		const each = values[field];
		const fits =
			type === "integer"
				? Number.isSafeInteger(each)
				: type === "boolean"
					? typeof each === "boolean"
					: typeof each === "string" && (literals === undefined || literals.has(each));
		if (!fits) return undefined;
	}
	return addressKey(kind.kind, data, values);
}

/**
 * The address of `kind` whose key is `key` (a key `keyOfAddress` made: stored data): the escaped parts split, `int()`
 * fields as numbers, `bool()` fields as booleans. A key of another kind or number of parts throws.
 */
export function addressOfKey<K extends KindShape>(kind: K & { readonly kind: string }, key: string): Address<K> {
	const { fields } = kindData(kind);
	const [name, ...parts] = splitKey(key);
	if (name !== kind.kind || parts.length !== fields.length) {
		throw new Error(`${JSON.stringify(key)}: not an address key of ${kind.kind}`);
	}
	const params: { [field: string]: string | number | boolean } = {};
	for (const [index, { name: field, type }] of fields.entries()) {
		const part = parts[index]!;
		params[field] = type === "integer" ? Number(part) : type === "boolean" ? part === "true" : part;
	}
	// The params were read by the kind's fields: its params object.
	return { kind: kind.kind, params: params as ParamsOfKind<K>, key };
}

/** The kind's name of an address key: its first part (kind names never hold `|` or a backslash). */
export function kindOfKey(key: string): string {
	const end = key.indexOf("|");
	return end === -1 ? key : key.slice(0, end);
}

function kindData(kind: { readonly kind: string }): KindData {
	const data = kinds.get(kind);
	if (data === undefined) throw new Error(`${kind.kind}: not a declared host kind`);
	return data;
}

/** The fields of declared params as keys hold them (`readParams` admitted only these normal forms). */
function fieldsOf(data: ParamsData): KeyField[] {
	// `normal` is `[field, normal form]` pairs in identity order.
	const normal = data.normal as unknown as readonly (readonly [
		string,
		{ readonly type?: string; readonly anyOf?: unknown },
	])[];
	return normal.map(([name, node]) => {
		if (node.anyOf === undefined) {
			return { name, type: node.type as KeyField["type"], literals: undefined };
		}
		// `oneOf(...)` of string literals: `{ type: "string", const }` branches.
		const branches = node.anyOf as readonly { readonly const: string }[];
		return { name, type: "string", literals: new Set(branches.map((branch) => branch.const)) };
	});
}

/** The parts of a key `joinKey` made, unescaped. */
function splitKey(key: string): string[] {
	const parts: string[] = [];
	let part = "";
	for (let index = 0; index < key.length; index++) {
		const char = key[index]!;
		if (char === "\\") part += key[++index] ?? "";
		else if (char === "|") {
			parts.push(part);
			part = "";
		} else part += char;
	}
	parts.push(part);
	return parts;
}

/** An address's key: the kind's name and each field value in declared order, joined (`joinKey`). */
export function addressKey(kind: string, params: ParamsData, values: { readonly [field: string]: unknown }): string {
	return joinKey([kind, ...params.fields.map((field) => String(values[field]))]);
}
