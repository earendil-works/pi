// Accepted versions: the older versions a provider still serves, with the direct mappings their edits require.

import type { Context } from "../../context/index.ts";
import {
	type Contract,
	type ContractData,
	type ContractShape,
	contractData,
	type Kind,
	LOCAL,
	type ShapeOf,
} from "./contract.ts";
import { checkKeys, entriesOf } from "./declare.ts";
import type {
	Change,
	ChangesAfter,
	CurrentStep,
	MemberNames,
	MethodAt,
	OlderVersions,
	StepAt,
	VariantShape,
	Variants,
	VariantsWith,
} from "./history.ts";
import type { Method, Static } from "./schema.ts";

/** Per accepted older version, exactly the mappings its later edits require (direct: old to current). */
export type AcceptsTable<C extends Contract> = AcceptsOf<ShapeOf<C>>;

type AcceptsOf<S extends ContractShape> = {
	readonly [V in OlderVersions<S["history"]>]?: VersionMappings<
		S["kind"],
		StepAt<S["history"], V>["variants"],
		CurrentStep<S["history"]>["variants"],
		ChangesAfter<S["history"], V>
	>;
};

type VersionMappings<K extends Kind, Old extends Variants, Current extends Variants, C extends Change> = Section<
	"state",
	K extends "local" ? StateMappings<Old[Local], Current[Local], Local, C> : RemoteStateMappings<Old, Current, C>
> &
	Section<"methods", MethodMappings<Old, Current, C>>;

type Local = typeof LOCAL;

/** A section is required when it holds a required mapping; otherwise it may be absent or empty. */
type Section<Key extends string, T> = [keyof T] extends [never]
	? { readonly [K in Key]?: { readonly [member: string]: never } }
	: { readonly [K in Key]: T };

/** `T` without its `never` properties: the members that need no mapping. */
type OmitNever<T> = { readonly [K in keyof T as [T[K]] extends [never] ? never : K]: T[K] };

type RemoteStateMappings<Old extends Variants, Current extends Variants, C extends Change> = OmitNever<{
	[X in keyof Old & keyof Current]: [keyof StateMappings<Old[X], Current[X], X, C>] extends [never]
		? never
		: StateMappings<Old[X], Current[X], X, C>;
}>;

type StateMappings<Old extends VariantShape, Current extends VariantShape, X, C extends Change> = OmitNever<{
	[S in keyof Old["state"]]: StateMapping<Old, Current, X, S, C>;
}>;

/** A changed member maps the current member back; a removed one maps the variant's whole current state, or refuses. */
type StateMapping<
	Old extends VariantShape,
	Current extends VariantShape,
	X,
	S extends keyof Old["state"],
	C,
> = S extends keyof Current["state"]
	? [X, S, "state"] extends C
		? (current: Static<Current["state"][S]>) => Static<Old["state"][S]>
		: never
	: ((state: { [M in keyof Current["state"]]: Static<Current["state"][M]> }) => Static<Old["state"][S]>) | "refuse";

type MethodMappings<Old extends Variants, Current extends Variants, C extends Change> = OmitNever<{
	[M in MemberNames<Old, "methods">]: [RemovedFrom<Current, VariantsWith<Old, M>, M>] extends [never]
		? ChangedMethod<
				Changed<C, VariantsWith<Old, M>, M, "args">,
				Changed<C, VariantsWith<Old, M>, M, "result">,
				MethodAt<Old, M>,
				MethodAt<Current, M>
			>
		: Replacement<MethodAt<Old, M>>;
}>;

/** The variants among `Xs` that no longer have method `M`. */
type RemovedFrom<Current extends Variants, Xs extends keyof Current, M> = {
	[X in Xs]: M extends keyof Current[X]["methods"] ? never : X;
}[Xs];

/** `true` when an edit changed `Side` of `M` in one of `Xs`. */
type Changed<C, Xs, M, Side> = Xs extends unknown ? ([Xs, M, Side] extends C ? true : never) : never;

/** Mappings for the changed sides of a method (`A`, `R` are `true` when changed), or a replacement. */
type ChangedMethod<A, R, Old extends Method, Current extends Method> = [A | R] extends [never]
	? never
	:
			| ({ readonly call?: never } & ([A] extends [never]
					? { readonly args?: never }
					: { readonly args: (old: Static<Old["args"]>) => Static<Current["args"]> }) &
					([R] extends [never]
						? { readonly result?: never }
						: { readonly result: (current: Static<Current["result"]>) => Static<Old["result"]> }))
			| Replacement<Old>;

/** A removed (or changed) method served by the provider's own function, or refused. */
type Replacement<Old extends Method> =
	| {
			readonly call: (args: Static<Old["args"]>, context: Context) => Promise<Static<Old["result"]>>;
			readonly args?: never;
			readonly result?: never;
	  }
	| "refuse";

/** An accepted older version and its fingerprint. */
export type AcceptedVersion = { readonly version: number; readonly fingerprint: string };

/**
 * Validates an accepts table without calling any mapping: known older versions only, exactly the required mappings
 * with the right shapes. Fails with an Error naming the path (`notes accepts[1].methods.add`).
 */
export function checkAccepts<C extends Contract>(
	contract: C,
	accepts: AcceptsTable<C>,
): { readonly versions: readonly AcceptedVersion[] } {
	const data = contractData(contract);
	// Declaration policy: JavaScript callers reach every check below.
	const versions = entriesOf(accepts, `${data.name} accepts`).map(([key, mappings]) => {
		const path = `${data.name} accepts[${key}]`;
		const index = data.versions.findIndex(({ version }) => String(version) === key);
		if (index === -1 || index === data.versions.length - 1) throw new Error(`${path}: not an older version`);
		checkMappings(mappings, needs(data, index), data.kind, path);
		const { version, fingerprint } = data.versions[index]!;
		return { version, fingerprint };
	});
	return { versions };
}

/** What an accepted version needs, by edit and never by schema comparison. */
type Needs = {
	/** Per variant, per state member. */
	readonly state: ReadonlyMap<string, ReadonlyMap<string, StateNeed>>;
	readonly methods: ReadonlyMap<string, MethodNeed>;
};

type StateNeed = "changed" | "removed";

type MethodNeed =
	| { readonly kind: "removed" }
	| { readonly kind: "changed"; readonly args: boolean; readonly result: boolean };

function needs(data: ContractData, index: number): Needs {
	const old = data.versions[index]!;
	const current = data.versions.at(-1)!;
	const changes = new Set(data.versions.slice(index + 1).flatMap((version) => version.changes.map(changeKey)));
	const changed = (...change: Change) => changes.has(changeKey(change));
	const state = new Map<string, Map<string, StateNeed>>();
	const methods = new Map<string, { removed: boolean; args: boolean; result: boolean }>();
	for (const [variant, { state: oldState, methods: oldMethods }] of old.variants) {
		const now = current.variants.get(variant)!;
		const variantNeeds = new Map<string, StateNeed>();
		for (const member of oldState.keys()) {
			if (!now.state.has(member)) variantNeeds.set(member, "removed");
			else if (changed(variant, member, "state")) variantNeeds.set(member, "changed");
		}
		if (variantNeeds.size > 0) state.set(variant, variantNeeds);
		for (const member of oldMethods.keys()) {
			const need = methods.get(member) ?? { removed: false, args: false, result: false };
			need.removed ||= !now.methods.has(member);
			need.args ||= changed(variant, member, "args");
			need.result ||= changed(variant, member, "result");
			methods.set(member, need);
		}
	}
	const methodNeeds = new Map<string, MethodNeed>();
	for (const [member, { removed, args, result }] of methods) {
		if (removed) methodNeeds.set(member, { kind: "removed" });
		else if (args || result) methodNeeds.set(member, { kind: "changed", args, result });
	}
	return { state, methods: methodNeeds };
}

function changeKey(change: Change): string {
	return JSON.stringify(change);
}

function checkMappings(mappings: unknown, needs: Needs, kind: Kind, path: string): void {
	checkKeys(mappings, ["state", "methods"], path);
	const { state, methods } = mappings as { readonly state?: unknown; readonly methods?: unknown };
	const checkVariant = (variantMappings: unknown, variantNeeds: ReadonlyMap<string, StateNeed>, at: string) =>
		checkSection(variantMappings, variantNeeds, at, checkStateMapping);
	// A local table is flat: its state section is the one variant's.
	if (kind === "local") checkVariant(state, needs.state.get(LOCAL) ?? new Map(), `${path}.state`);
	else checkSection(state, needs.state, `${path}.state`, checkVariant);
	checkSection(methods, needs.methods, `${path}.methods`, checkMethodMapping);
}

/** Exactly the needed keys: no missing and no unnecessary mapping; absent only when nothing is needed. */
function checkSection<N>(
	section: unknown,
	needs: ReadonlyMap<string, N>,
	path: string,
	check: (mapping: unknown, need: N, path: string) => void,
): void {
	const mappings = new Map(section === undefined ? [] : entriesOf(section, path));
	for (const key of mappings.keys()) if (!needs.has(key)) throw new Error(`${path}.${key}: unnecessary mapping`);
	for (const [key, need] of needs) {
		if (!mappings.has(key)) throw new Error(`${path}.${key}: missing mapping`);
		check(mappings.get(key), need, `${path}.${key}`);
	}
}

function checkStateMapping(mapping: unknown, need: StateNeed, path: string): void {
	if (typeof mapping === "function" || (need === "removed" && mapping === "refuse")) return;
	throw new Error(`${path}: expected ${need === "removed" ? 'a function or "refuse"' : "a function"}`);
}

function checkMethodMapping(mapping: unknown, need: MethodNeed, path: string): void {
	if (mapping === "refuse") return;
	checkKeys(mapping, ["args", "result", "call"], path);
	const { args, result, call } = mapping as {
		readonly args?: unknown;
		readonly result?: unknown;
		readonly call?: unknown;
	};
	if (call !== undefined || need.kind === "removed") {
		if (typeof call !== "function" || args !== undefined || result !== undefined) {
			throw new Error(`${path}: expected { call } or "refuse"`);
		}
		return;
	}
	checkSide(args, need.args, `${path}.args`);
	checkSide(result, need.result, `${path}.result`);
}

function checkSide(mapping: unknown, needed: boolean, path: string): void {
	if (!needed && mapping !== undefined) throw new Error(`${path}: unnecessary mapping`);
	if (needed && mapping === undefined) throw new Error(`${path}: missing mapping`);
	if (needed && typeof mapping !== "function") throw new Error(`${path}: expected a function`);
}
