// Contract handles: the branded, immutable value an app declares, its type-level shape, and the Chord-owned data
// behind it.

import type { TNull } from "typebox";
import type { Context } from "../../context/index.ts";
import type { Watchable, WatchHandle } from "../../watch.ts";
import type { Change, CurrentStep, History, VariantShape } from "./history.ts";
import type { Address } from "./host-kind.ts";
import type { Params, ParamsData } from "./params.ts";
import type { Method, Static } from "./schema.ts";
import type { Snapshot } from "./snapshot.ts";

export type Kind = "remote" | "local";

/** The variant name of a local contract's members. */
export const LOCAL = "members";

/** Everything the types know about a contract: kind, name, params and the whole history. */
export type ContractShape = {
	readonly kind: Kind;
	readonly name: string;
	readonly params: Params;
	readonly history: History;
};

/** A declared contract: a branded handle, immutable by convention. Spread or hand-built copies are refused. */
export interface Contract<S extends ContractShape = ContractShape> {
	readonly kind: S["kind"];
	readonly name: S["name"];
	readonly version: number;
	readonly fingerprint: string;
	/** Type only: absent at runtime. */
	readonly "~shape"?: S;
}

export type ShapeOf<C extends Contract> = NonNullable<C["~shape"]>;

/** The variants of a contract's current version. */
export type CurrentVariants<C extends Contract> = CurrentStep<ShapeOf<C>["history"]>["variants"];

/** The params object of a contract. */
export type ParamsOf<C extends Contract> = { [F in keyof ShapeOf<C>["params"]]: Static<ShapeOf<C>["params"][F]> };

/**
 * What a factory returns: for `local`, a `Watchable` per state member and a function per method, `(args, context)`,
 * or `(context)` when the method takes no arguments; for `remote`, one variant `{ variant, members }` with exactly
 * that variant's members. `X` is the context the methods get.
 */
export type Implementation<C extends Contract, X extends Context = Context> = ImplementationOf<
	ShapeOf<C>["kind"],
	CurrentVariants<C>,
	X
>;

type ImplementationOf<
	K extends Kind,
	V extends { readonly [variant: string]: VariantShape },
	X extends Context,
> = K extends "local"
	? VariantImplementation<V[typeof LOCAL], X>
	: { [N in keyof V]: { readonly variant: N; readonly members: VariantImplementation<V[N], X> } }[keyof V];

/**
 * One variant's members: a `Watchable` per state member, a function per method and, in a local contract, a
 * `KeyedWatchable` per keyed member.
 */
export type VariantImplementation<V extends VariantShape, X extends Context = Context> = {
	[M in keyof V["state"] | keyof V["methods"] | keyof NonNullable<V["keyed"]>]: M extends keyof V["methods"]
		? MethodFunction<V["methods"][M], X>
		: M extends keyof V["state"]
			? Watchable<Static<V["state"][M]>>
			: M extends keyof NonNullable<V["keyed"]>
				? KeyedWatchable<Static<NonNullable<V["keyed"]>[M]>>
				: never;
};

/**
 * A keyed state member (slice 6a §12): documents by key, each watchable on its own; a keyed document handle
 * provides it. `at(key)` is valid only in a factory (it pins the key while that attempt lives).
 */
export interface KeyedWatchable<T> {
	/** The document at `key`, `undefined` when absent. */
	get(key: string, context: Context): Promise<T | undefined>;
	/** A watch of the document at `key` that follows its address, `undefined` when absent. */
	watch(key: string, context: Context): Promise<WatchHandle<T> | undefined>;
	/** In a factory only: the document at `key` as a watchable, `initial()` while absent. */
	at(key: string): Watchable<T>;
}

/** A method as a function: without the argument when its argument schema is `null` (`null` stays the wire form). */
type MethodFunction<M extends Method, X extends Context = Context> = M["args"] extends TNull
	? (context: X) => Promise<Static<M["result"]>>
	: (args: Static<M["args"]>, context: X) => Promise<Static<M["result"]>>;

/** The Chord-owned data behind a contract handle. */
export type ContractData = {
	readonly kind: Kind;
	readonly name: string;
	readonly params: ParamsData;
	/** A remote contract's placement: the address of the host serving an object for its params. */
	readonly placement: Placement | undefined;
	/** Every version of the history, oldest first; the last is current. */
	readonly versions: readonly VersionData[];
	/** The kind of every member name ever declared in the history. */
	readonly kinds: ReadonlyMap<string, MemberKind>;
};

export type MemberKind = "state" | "method" | "keyed";

/** A placement as Chord calls it: with checked params. Plugin code: what it returns is checked where it is routed. */
export type Placement = (params: ParamsOf<Contract>) => Address;

export type VersionData = {
	readonly version: number;
	readonly fingerprint: string;
	readonly variants: ReadonlyMap<string, VariantData>;
	/** The changes that produced this version; empty for a base. */
	readonly changes: readonly Change[];
};

export type VariantData = {
	readonly state: ReadonlyMap<string, Snapshot>;
	readonly methods: ReadonlyMap<string, MethodData>;
	/** Keyed state members (slice 6a §12): only a local contract has any. */
	readonly keyed: ReadonlyMap<string, Snapshot>;
};

export type MethodData = { readonly args: Snapshot; readonly result: Snapshot };

/** The data behind a contract handle; refuses spread and hand-built copies. */
export function contractData(contract: Contract): ContractData {
	const data = contracts.get(contract);
	if (data === undefined) {
		throw new Error(`${contract.name}: not a declared contract (spread and hand-built copies are refused)`);
	}
	return data;
}

const contracts = new WeakMap<Contract, ContractData>();

/** Whether a method takes no arguments: its argument schema is `null`, so its functions omit the argument. */
export function takesNoArgs(method: MethodData): boolean {
	// A schema's normal form is an object of keywords.
	const normal = method.args.normal as { readonly [keyword: string]: unknown };
	return normal.type === "null" && Object.keys(normal).length === 1;
}

/** The variants of a contract's current version; a local contract has the one variant `LOCAL`. */
export function currentVariants(contract: Contract): ReadonlyMap<string, VariantData> {
	return contractData(contract).versions.at(-1)!.variants;
}

/** A variant's names as links index them (2b): its state members and its methods, each sorted. */
export type VariantNames = { readonly state: readonly string[]; readonly methods: readonly string[] };

/** The current version's variant names in the order links index them: sorted. */
export function variantOrder(contract: Contract): readonly string[] {
	return [...currentVariants(contract).keys()].sort();
}

/** A variant's state members and methods in the order links index them: each sorted. */
export function variantNames(variant: VariantData): VariantNames {
	return { state: [...variant.state.keys()].sort(), methods: [...variant.methods.keys()].sort() };
}

/** A new contract handle for `data`; the caller states the type-level shape. */
export function createContract<C extends Contract>(data: ContractData): C {
	const current = data.versions.at(-1)!;
	const contract: Contract = {
		kind: data.kind,
		name: data.name,
		version: current.version,
		fingerprint: current.fingerprint,
	};
	contracts.set(contract, data);
	// The shape is type-level only; every caller states the shape it built.
	return contract as C;
}
