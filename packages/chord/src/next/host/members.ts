// The member check (Q14): an implementation is one variant with exactly that variant's members, methods being
// functions and state members JSON watchables; and the resolution of what Chord follows behind every derive's declared
// sources (JSON and native) and every contribution to a registry (slice 8).
//
// The rule for watches across attempts (slice 6a §1.2, §1.4): references and other objects' derives follow a local
// object's state member through its member source (`member-source.ts`), and a key of a keyed member they hold (`at`,
// `watch(key)`) through a member source per key (`keyed-members.ts`); both live as long as the object. While the
// object is failed or activating again they keep their last values and get no frames; when a new attempt goes live
// they re-bind by name to that attempt's member (a pinned key loaded on it first), whether a document or a derive: one
// frame from the last value, and every derive downstream recovers, one that failed on the old member's error included
// (decision "self healing"). A re-exposed member is the re-exposing object's: it freezes with that object, its
// provider's source goes on. At a live failure, members following another object's sources freeze at once; the
// object's own documents and derives freeze once its admitted commits adopted, so until then an own derive over
// another object's member may still change. Holds over a link follow the live attempt's members and take a snapshot at
// each binding.

import type { Context } from "../../context/index.ts";
import type { Contract } from "../contracts/index.ts";
import { currentVariants, LOCAL, takesNoArgs, type VariantData } from "../contracts/internal.ts";
import type { KeyedSlot } from "../documents/internal.ts";
import {
	type ContributionContent,
	type Contributor,
	RegistryContribution,
	type RegistryEdge,
	type RegistryRecord,
	RegistryValueSource,
} from "../registries/internal.ts";
import { type Derive, type DeriveInput, type DeriveSource, NativeSource } from "../state/internal.ts";
import { type Binding, resolveKeyed, resolveWatchable } from "./reference.ts";

/** A checked implementation, as Chord calls and follows it. */
export type Members = {
	/** The methods, each called with its arguments (`null` for none) and a context. */
	readonly methods: ReadonlyMap<string, Method>;
	/** The state members, resolved to what Chord follows. */
	readonly state: ReadonlyMap<string, DeriveSource>;
	/** The keyed members (slice 6a §12): the object's own slot, or the provider's member it re-exposes. */
	readonly keyed: ReadonlyMap<string, KeyedBinding>;
};

/**
 * What a keyed member is: a keyed document handle's slot (`own`), or another object's keyed member re-exposed through
 * a reference (`reexposed`), which reads end at the ultimate provider's slot (rule 22) and pinned keys follow.
 */
export type KeyedBinding =
	| { readonly kind: "own"; readonly slot: KeyedSlot }
	| { readonly kind: "reexposed"; readonly binding: Binding; readonly member: string };

/** A method as Chord calls it. */
type Method = (args: unknown, context: Context) => Promise<unknown>;

/**
 * Checks what a factory returned (plugin code): a local contract's members, or a remote contract's `{ variant,
 * members }` naming one of its current variants. Errors name the variant or member (the failure cause adds the
 * object).
 */
export function checkImplementation(
	contract: Contract,
	implementation: unknown,
): { readonly variant: string | undefined; readonly members: Members } {
	const variants = currentVariants(contract);
	if (contract.kind === "local") {
		// The member check establishes the shape.
		return { variant: undefined, members: checkMembers(variants.get(LOCAL)!, implementation as Implementation) };
	}
	// Plugin code: a remote factory returns `{ variant, members }`, which the checks below establish.
	const { variant, members } = implementation as { readonly variant: string; readonly members: Implementation };
	const data = variants.get(variant);
	if (data === undefined) throw new Error(`variant ${JSON.stringify(variant)}: not a variant of ${contract.name}`);
	return { variant, members: checkMembers(data, members) };
}

type Implementation = { readonly [member: string]: unknown };

/**
 * Checks members against a variant's (exactly its members, methods being functions, state members JSON watchables and
 * keyed members keyed document handles); a method without arguments is called with the context alone.
 */
function checkMembers({ state, methods, keyed }: VariantData, implementation: Implementation): Members {
	for (const member of Object.keys(implementation)) {
		if (!state.has(member) && !methods.has(member) && !keyed.has(member)) throw new Error(`${member}: not a member`);
	}
	// Own properties only: an inherited `toString` is no implementation of a member named so.
	const own = (member: string): unknown =>
		Object.hasOwn(implementation, member) ? implementation[member] : undefined;
	const checked = {
		methods: new Map<string, Method>(),
		state: new Map<string, DeriveSource>(),
		keyed: new Map<string, KeyedBinding>(),
	};
	for (const [member, data] of methods) {
		const method = own(member);
		if (typeof method !== "function") throw new Error(`${member}: a method is a function`);
		const call: Method = takesNoArgs(data)
			? (_args, context) => method(context)
			: (args, context) => method(args, context);
		checked.methods.set(member, call);
	}
	for (const member of state.keys()) {
		const source = resolveWatchable(own(member));
		if (source === undefined) throw new Error(`${member}: a state member is a JSON watchable`);
		checked.state.set(member, source);
	}
	for (const member of keyed.keys()) {
		const resolved = resolveKeyed(own(member));
		if (resolved === undefined) throw new Error(`${member}: a keyed member is a keyed document handle`);
		checked.keyed.set(member, resolved);
	}
	return checked;
}

/**
 * Resolves every derive's sources; errors name a derive by the member exposing it, else by its position. `report`
 * makes each derive's failure report, with the member exposing it when there is one (`derive_failed`).
 */
export function attachDerives(
	derives: readonly Derive[],
	state: ReadonlyMap<string, DeriveSource>,
	report: (member: string | undefined) => (error: unknown) => void,
): void {
	const exposed = new Map<DeriveSource, string>([...state].map(([member, source]) => [source, member]));
	derives.forEach((derive, position) => {
		const member = exposed.get(derive);
		const name = member ?? `derive #${position + 1}`;
		const resolve = (source: unknown, index: number): DeriveInput => {
			const resolved = resolveWatchable(source) ?? (source instanceof NativeSource ? source : undefined);
			if (resolved === undefined) throw new Error(`${name}: source ${index} is not a Chord watchable`);
			return resolved;
		};
		derive.attach(resolve, report(member));
	});
}

/**
 * A contribution of `contributor` at `version` to `record`, as Chord follows it: a Chord watchable (a source, a
 * constant, a document handle, a reference member, a native source) is followed, anything else is a plain value,
 * whatever methods it has (registries carry natives). Refused (`invalid/cycle`) when it is a registry's value that
 * closes a cycle of registries, through the tables and the contributor's `pending` edges.
 */
export function contributionOf(
	record: RegistryRecord,
	contributor: Contributor,
	version: number,
	value: unknown,
	pending: readonly RegistryEdge[],
): RegistryContribution {
	if (value instanceof RegistryValueSource) record.assertNoCycle(value, pending);
	return new RegistryContribution(record, contributor, version, contentOf(value));
}

/** What Chord follows behind a contribution: its JSON or native source when it is a Chord watchable. */
function contentOf(value: unknown): ContributionContent {
	if (value instanceof NativeSource) return { kind: "native", source: value };
	const source = resolveWatchable(value);
	return source === undefined ? { kind: "plain", value } : { kind: "json", source };
}
