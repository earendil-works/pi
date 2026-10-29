// Arguments: a provider's binding (its dispatch table per accepted version) and the per-call argument check.

import type { Validator } from "typebox/compile";
import type { Context } from "../../context/index.ts";
import { type AcceptedVersion, type AcceptsTable, checkAccepts } from "../contracts/accepts.ts";
import {
	type Contract,
	type CurrentVariants,
	contractData,
	type MethodData,
	type VersionData,
} from "../contracts/contract.ts";
import type { MemberNames, MethodAt } from "../contracts/history.ts";
import type { Static } from "../contracts/schema.ts";
import type { Snapshot } from "../contracts/snapshot.ts";
import { ChordError, invalid } from "./errors.ts";
import { check, validatorFor } from "./validator.ts";

/** JSON plus byte leaves. Same-host values are plain data and immutable once handed over, by convention. */
export type Value = null | boolean | number | string | Uint8Array | Value[] | { [key: string]: Value };

/** A provider's binding of a contract with the older versions it accepts. */
export type Provider<C extends Contract> = { readonly contract: C; readonly accepted: readonly AcceptedVersion[] };

/**
 * Checked arguments: a method's arguments in the current shape with the result mapping back to the caller's version,
 * or the old arguments for the provider's own `call` replacement (L4 dispatches it).
 */
export type CheckedArgs<C extends Contract, M extends string> =
	| { readonly kind: "method"; readonly args: ArgsOf<C, M>; readonly result?: (current: Value) => Value }
	| { readonly kind: "call"; readonly args: Value; readonly call: (args: Value, context: Context) => Promise<Value> };

type ArgsOf<C extends Contract, M extends string> = M extends MemberNames<CurrentVariants<C>, "methods">
	? Static<MethodAt<CurrentVariants<C>, M>["args"]>
	: Value;

/**
 * Binds a contract and the app's accepts table (validated once, kept as it is) into a provider. Builds the dispatch
 * table: accepted version -> method -> schema and mapping; nothing is compiled yet.
 */
export function bindProvider<C extends Contract>(contract: C, accepts: AcceptsTable<C>): Provider<C> {
	const { versions: accepted } = checkAccepts(contract, accepts);
	const { versions } = contractData(contract);
	const current = versions.at(-1)!;
	// checkAccepts established this shape.
	const mappings = accepts as CheckedAccepts;
	const table: Dispatch = new Map([[current.version, dispatchEntries(current, undefined)]]);
	for (const { version } of accepted) {
		const data = versions.find((candidate) => candidate.version === version)!;
		table.set(version, dispatchEntries(data, mappings[version]?.methods));
	}
	const provider = { contract, accepted };
	dispatchTables.set(provider, table);
	return provider;
}

/** An accepts table after `checkAccepts`, as the binding reads it. */
type CheckedAccepts = {
	readonly [version: string]: { readonly methods?: { readonly [member: string]: CheckedMethodMapping } };
};

type CheckedMethodMapping =
	| "refuse"
	| { readonly call: (args: Value, context: Context) => Promise<Value> }
	| { readonly args?: (old: Value) => Value; readonly result?: (current: Value) => Value };

/** Accepted version -> method -> entry. */
type Dispatch = Map<number, Map<string, DispatchEntry>>;

type DispatchEntry =
	| { readonly kind: "refuse" }
	| {
			readonly kind: "call";
			readonly args: Snapshot;
			readonly call: (args: Value, context: Context) => Promise<Value>;
			validator: Validator | undefined;
	  }
	| {
			readonly kind: "method";
			readonly args: Snapshot;
			readonly mapArgs: ((old: Value) => Value) | undefined;
			readonly mapResult: ((current: Value) => Value) | undefined;
			validator: Validator | undefined;
	  };

const dispatchTables = new WeakMap<Provider<Contract>, Dispatch>();

function dispatchEntries(
	version: VersionData,
	mappings: { readonly [member: string]: CheckedMethodMapping } | undefined,
): Map<string, DispatchEntry> {
	const entries = new Map<string, DispatchEntry>();
	// A method has one signature in every variant that has it.
	const methods = new Map<string, MethodData>([...version.variants.values()].flatMap(({ methods }) => [...methods]));
	for (const [member, { args }] of methods) {
		const mapping = mappings !== undefined && Object.hasOwn(mappings, member) ? mappings[member] : undefined;
		entries.set(member, dispatchEntry(args, mapping));
	}
	return entries;
}

function dispatchEntry(args: Snapshot, mapping: CheckedMethodMapping | undefined): DispatchEntry {
	if (mapping === "refuse") return { kind: "refuse" };
	if (mapping !== undefined && "call" in mapping) {
		return { kind: "call", args, call: mapping.call, validator: undefined };
	}
	return { kind: "method", args, mapArgs: mapping?.args, mapResult: mapping?.result, validator: undefined };
}

/**
 * Checks a call's arguments against the provider's schema for the caller's bound version: three map lookups, one
 * compiled check, at most one direct mapping old -> current (never for current-version calls). A method without
 * arguments gets `null` (its internal and wire form). Unknown method: `invalid/member`; version not accepted or refused: `contract_mismatch`.
 */
export function checkArgs<C extends Contract, M extends string>(
	provider: Provider<C>,
	method: M,
	raw: unknown,
	boundVersion: number,
	context: Context,
): CheckedArgs<C, M> {
	const name = provider.contract.name;
	const methods = dispatchTables.get(provider)!.get(boundVersion);
	if (methods === undefined) {
		throw new ChordError({ code: "contract_mismatch", message: `${name} v${boundVersion} is not accepted` });
	}
	const entry = methods.get(method);
	if (entry === undefined) throw invalid("member", `${name} v${boundVersion} has no method "${method}"`);
	if (entry.kind === "refuse") {
		throw new ChordError({ code: "contract_mismatch", message: `${name} v${boundVersion} refuses "${method}"` });
	}
	entry.validator ??= validatorFor(entry.args, context);
	check(entry.validator, raw, "args", context);
	// The check above establishes the argument type; mapping output is trusted.
	const args = raw as Value;
	if (entry.kind === "call") return { kind: "call", args, call: entry.call };
	return {
		kind: "method",
		args: (entry.mapArgs === undefined ? args : entry.mapArgs(args)) as ArgsOf<C, M>,
		result: entry.mapResult,
	};
}
