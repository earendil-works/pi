// Accepted versions: the older versions a provider still serves, with the direct mappings their edits require.

import type { Context } from "../context/index.ts";
import {
	type Contract,
	type ContractData,
	type ContractShape,
	contractData,
	type Kind,
	type ShapeOf,
} from "./contract.ts";
import { checkKeys, entriesOf } from "./declare.ts";
import type { Change, ChangesAfter, CurrentStep, MembersShape, OlderVersions, StepAt } from "./history.ts";
import type { Method, Static, Ungranted } from "./schema.ts";

/** Per accepted older version, exactly the mappings its later edits require (direct: old to current). */
export type AcceptsTable<C extends Contract> = AcceptsOf<ShapeOf<C>>;

type AcceptsOf<S extends ContractShape> = {
	readonly [V in OlderVersions<S["history"]>]?: VersionMappings<
		S["kind"],
		StepAt<S["history"], V>["members"],
		CurrentStep<S["history"]>["members"],
		ChangesAfter<S["history"], V>
	>;
};

type VersionMappings<
	K extends Kind,
	Old extends MembersShape,
	Current extends MembersShape,
	C extends Change,
> = Section<"state", StateMappings<Old, Current, C>> &
	Section<"methods", MethodMappings<Old, Current, C>> &
	Section<"keyed", K extends "local" ? KeyedMappings<Old, Current, C> : Record<never, never>> &
	Section<"events", EventMappings<Old, Current, C>>;

/**
 * Event members (decision "Events: fire-and-forget members"): a changed one maps each current value back, or refuses
 * the version's binding; a removed one needs nothing (an older consumer receives none of it), nor an added one.
 */
type EventMappings<Old extends MembersShape, Current extends MembersShape, C extends Change> = OmitNever<{
	[S in keyof NonNullable<Old["events"]>]: S extends keyof NonNullable<Current["events"]>
		? [S, "event"] extends C
			?
					| ((
							current: Static<Ungranted<NonNullable<Current["events"]>[S]>>,
					  ) => Static<Ungranted<NonNullable<Old["events"]>[S]>>)
					| "refuse"
			: never
		: never;
}>;

/**
 * A local contract's keyed members (slice 7b): a changed one maps each document of the current version back, or
 * refuses; a removed one refuses (no document maps from the whole state).
 */
type KeyedMappings<Old extends MembersShape, Current extends MembersShape, C extends Change> = OmitNever<{
	[S in keyof NonNullable<Old["keyed"]>]: S extends keyof NonNullable<Current["keyed"]>
		? [S, "keyed"] extends C
			? ((current: Static<NonNullable<Current["keyed"]>[S]>) => Static<NonNullable<Old["keyed"]>[S]>) | "refuse"
			: never
		: "refuse";
}>;

/** A section is required when it holds a required mapping; otherwise it may be absent or empty. */
type Section<Key extends string, T> = [keyof T] extends [never]
	? { readonly [K in Key]?: { readonly [member: string]: never } }
	: { readonly [K in Key]: T };

/** `T` without its `never` properties: the members that need no mapping. */
type OmitNever<T> = { readonly [K in keyof T as [T[K]] extends [never] ? never : K]: T[K] };

type StateMappings<Old extends MembersShape, Current extends MembersShape, C extends Change> = OmitNever<{
	[S in keyof Old["state"]]: StateMapping<Old, Current, S, C>;
}>;

/** A changed member maps the current member back; a removed one maps the whole current state, or refuses. */
type StateMapping<
	Old extends MembersShape,
	Current extends MembersShape,
	S extends keyof Old["state"],
	C,
> = S extends keyof Current["state"]
	? [S, "state"] extends C
		? (current: Static<Ungranted<Current["state"][S]>>) => Static<Ungranted<Old["state"][S]>>
		: never
	:
			| ((
					state: { [M in keyof Current["state"]]: Static<Ungranted<Current["state"][M]>> },
			  ) => Static<Ungranted<Old["state"][S]>>)
			| "refuse";

type MethodMappings<Old extends MembersShape, Current extends MembersShape, C extends Change> = OmitNever<{
	[M in keyof Old["methods"]]: M extends keyof Current["methods"]
		? ChangedMethod<
				[M, "args"] extends C ? true : never,
				[M, "result"] extends C ? true : never,
				Ungranted<Old["methods"][M]>,
				Ungranted<Current["methods"][M]>
			>
		: Replacement<Ungranted<Old["methods"][M]>>;
}>;

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
		checkMappings(mappings, needs(data, index), path);
		const { version, fingerprint } = data.versions[index]!;
		return { version, fingerprint };
	});
	return { versions };
}

/** What an accepted version needs, by edit and never by schema comparison. */
type Needs = {
	readonly state: ReadonlyMap<string, StateNeed>;
	readonly methods: ReadonlyMap<string, MethodNeed>;
	/** Per keyed member (local contracts). */
	readonly keyed: ReadonlyMap<string, KeyedNeed>;
	/** Per event member still declared and changed since: a mapping or `"refuse"`. */
	readonly events: ReadonlyMap<string, "changed">;
};

type StateNeed = "changed" | "removed";

/** A keyed member's need: a changed key kind (`rekeyed`: strings and addresses, or another kind) is only refused. */
type KeyedNeed = StateNeed | "rekeyed";

type MethodNeed =
	| { readonly kind: "removed" }
	| { readonly kind: "changed"; readonly args: boolean; readonly result: boolean };

function needs(data: ContractData, index: number): Needs {
	const old = data.versions[index]!.members;
	const now = data.versions.at(-1)!.members;
	const changes = new Set(data.versions.slice(index + 1).flatMap((version) => version.changes.map(changeKey)));
	const changed = (...change: Change) => changes.has(changeKey(change));
	const state = new Map<string, StateNeed>();
	const methods = new Map<string, MethodNeed>();
	const keyed = new Map<string, KeyedNeed>();
	const events = new Map<string, "changed">();
	// A removed event needs no mapping: an older consumer receives none of it.
	for (const member of old.events.keys()) {
		if (now.events.has(member) && changed(member, "event")) events.set(member, "changed");
	}
	for (const [member, { key }] of old.keyed) {
		const current = now.keyed.get(member);
		if (current === undefined) keyed.set(member, "removed");
		else if (current.key?.kind !== key?.kind) keyed.set(member, "rekeyed");
		else if (changed(member, "keyed")) keyed.set(member, "changed");
	}
	for (const member of old.state.keys()) {
		if (!now.state.has(member)) state.set(member, "removed");
		else if (changed(member, "state")) state.set(member, "changed");
	}
	for (const member of old.methods.keys()) {
		const args = changed(member, "args");
		const result = changed(member, "result");
		if (!now.methods.has(member)) methods.set(member, { kind: "removed" });
		else if (args || result) methods.set(member, { kind: "changed", args, result });
	}
	return { state, methods, keyed, events };
}

function changeKey(change: Change): string {
	return JSON.stringify(change);
}

function checkMappings(mappings: unknown, needs: Needs, path: string): void {
	checkKeys(mappings, ["state", "methods", "keyed", "events"], path);
	const { state, methods, keyed, events } = mappings as {
		readonly state?: unknown;
		readonly methods?: unknown;
		readonly keyed?: unknown;
		readonly events?: unknown;
	};
	checkSection(state, needs.state, `${path}.state`, checkStateMapping);
	checkSection(events, needs.events, `${path}.events`, checkEventMapping);
	checkSection(methods, needs.methods, `${path}.methods`, checkMethodMapping);
	checkSection(keyed, needs.keyed, `${path}.keyed`, checkKeyedMapping);
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

function checkEventMapping(mapping: unknown, _need: "changed", path: string): void {
	if (typeof mapping !== "function" && mapping !== "refuse")
		throw new Error(`${path}: expected a function or "refuse"`);
}

function checkKeyedMapping(mapping: unknown, need: KeyedNeed, path: string): void {
	if (mapping === "refuse" || (need === "changed" && typeof mapping === "function")) return;
	const because = need === "rekeyed" ? " (its key kind changed: a value mapping cannot map keys)" : "";
	throw new Error(`${path}: expected ${need === "changed" ? 'a function or "refuse"' : '"refuse"'}${because}`);
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
