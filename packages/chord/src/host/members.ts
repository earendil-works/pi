// The member check (Q14): an implementation is one variant with exactly that variant's members, methods being
// functions, state members JSON watchables and event members the attempt's own sources or references' event members
// (decision "Events: fire-and-forget members"); and the resolution of what Chord follows behind every derive's declared
// sources (JSON and native) and every contribution to a registry (slice 8).
//
// The rule for watches across attempts (decision "References are the only indirection"): consumers' watches and
// derives over another object's member follow it through their reference's member (`reference-source.ts`) and keys
// (`reference-keys.ts`), passed straight through to the instance's own document or derive. While the object points at
// nothing they keep their last values (one `failed` call for a failure); when a new instance goes live they move by
// name to its member (a key pinned there again), whether a document or a derive: one frame from the last value, and
// every derive downstream recovers (decision "self healing"). A re-exposed member is the re-exposing object's
// reference member: it holds with that object, its provider's source goes on. Holds over a link follow the live
// instance's members and take a snapshot at each binding.

import type { Context } from "../context/index.ts";
import type { Contract } from "../contracts/index.ts";
import { currentVariants, LOCAL, takesNoArgs, type VariantData } from "../contracts/internal.ts";
import type { KeyedSlot } from "../documents/internal.ts";
import {
	type ContributionContent,
	type Contributor,
	RegistryContribution,
	type RegistryRecord,
} from "../registries/internal.ts";
import { type Derive, type DeriveInput, type DeriveSource, NativeSource } from "../state/internal.ts";
import { type EventNode, OwnEventSource, type SourceOwner } from "./events.ts";
import { type Binding, resolveKeyed, resolveWatchable } from "./reference.ts";
import { ReexposedEvents, ReferenceEvents } from "./reference-events.ts";

/** A checked implementation, as Chord calls and follows it. */
export type Members = {
	/** The methods, each called with its arguments (`null` for none) and a context. */
	readonly methods: ReadonlyMap<string, Method>;
	/** The state members, resolved to what Chord follows. */
	readonly state: ReadonlyMap<string, DeriveSource>;
	/** The keyed members (slice 6a §12): the object's own slot, or the provider's member it re-exposes. */
	readonly keyed: ReadonlyMap<string, KeyedBinding>;
	/** The event members: the attempt's own sources, or nodes fed by the references they re-expose (`ReexposedEvents`). */
	readonly events: ReadonlyMap<string, EventNode>;
};

/**
 * What a keyed member is: a keyed document handle's slot (`own`), or another object's keyed member re-exposed through
 * a reference (`reexposed`), which reads end at the ultimate provider's slot (rule 22) and pinned keys follow.
 */
export type KeyedBinding =
	| { readonly kind: "own"; readonly slot: KeyedSlot }
	| {
			readonly kind: "reexposed";
			readonly binding: Binding;
			readonly member: string;
			/** The host kind the re-exposed member is keyed by; `undefined` for string keys. */
			readonly key: string | undefined;
	  };

/** A method as Chord calls it. */
export type Method = (args: unknown, context: Context) => Promise<unknown>;

/**
 * Checks what a factory returned (plugin code): a local contract's members, or a remote contract's `{ variant,
 * members }` naming one of its current variants. `sources` owns the attempt's own event sources (none declared:
 * `undefined`). Errors name the variant or member (the failure cause adds the object).
 */
export function checkImplementation(
	contract: Contract,
	implementation: unknown,
	sources: SourceOwner | undefined,
): { readonly variant: string | undefined; readonly members: Members } {
	const variants = currentVariants(contract);
	if (contract.kind === "local") {
		// The member check establishes the shape.
		const members = checkMembers(variants.get(LOCAL)!, implementation as Implementation, sources);
		return { variant: undefined, members };
	}
	// Plugin code: a remote factory returns `{ variant, members }`, which the checks below establish.
	const { variant, members } = implementation as { readonly variant: string; readonly members: Implementation };
	const data = variants.get(variant);
	if (data === undefined) throw new Error(`variant ${JSON.stringify(variant)}: not a variant of ${contract.name}`);
	return { variant, members: checkMembers(data, members, sources) };
}

type Implementation = { readonly [member: string]: unknown };

/** The event members of a variant without any: shared, never written. */
const NO_EVENTS: ReadonlyMap<string, EventNode> = new Map();

/**
 * Checks members against a variant's (exactly its members, methods being functions, state members JSON watchables,
 * keyed members keyed document handles and event members the attempt's own sources or references' event members); a
 * method without arguments is called with the context alone.
 */
function checkMembers(
	{ state, methods, keyed, events }: VariantData,
	implementation: Implementation,
	sources: SourceOwner | undefined,
): Members {
	for (const member of Object.keys(implementation)) {
		if (!state.has(member) && !methods.has(member) && !keyed.has(member) && !events.has(member)) {
			throw new Error(`${member}: not a member`);
		}
	}
	// Own properties only: an inherited `toString` is no implementation of a member named so.
	const own = (member: string): unknown =>
		Object.hasOwn(implementation, member) ? implementation[member] : undefined;
	const checked = {
		methods: new Map<string, Method>(),
		state: new Map<string, DeriveSource>(),
		keyed: new Map<string, KeyedBinding>(),
		events: NO_EVENTS,
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
	for (const [member, { key }] of keyed) {
		const resolved = resolveKeyed(own(member));
		if (resolved === undefined) throw new Error(`${member}: a keyed member is a keyed document handle`);
		// Declaration policy: the handle's keys are the member's (strings, or addresses of its host kind).
		const keys = resolved.kind === "own" ? resolved.slot.definition.current.host?.kind : resolved.key;
		if (keys !== key?.kind) {
			const what = (kind: string | undefined) => (kind === undefined ? "string keys" : `addresses of ${kind}`);
			throw new Error(`${member}: declared with ${what(key?.kind)}, implemented with ${what(keys)}`);
		}
		checked.keyed.set(member, resolved);
	}
	if (events.size > 0) checked.events = checkEvents(events, own, sources);
	return checked;
}

/**
 * Checks event members: each is the attempt's own source (owned by `sources`) or a reference's event member, re-exposed
 * (the declaration boundary, Q14: only Chord-made event members).
 */
function checkEvents(
	events: ReadonlyMap<string, unknown>,
	own: (member: string) => unknown,
	sources: SourceOwner | undefined,
): ReadonlyMap<string, EventNode> {
	const nodes = new Map<string, EventNode>();
	for (const member of events.keys()) {
		const value = own(member);
		if (value instanceof OwnEventSource && sources !== undefined && value.ownedBy(sources)) {
			nodes.set(member, value);
		} else if (value instanceof ReferenceEvents) {
			nodes.set(member, new ReexposedEvents(value));
		} else {
			throw new Error(`${member}: an event member is this object's own self.events() or a reference's event member`);
		}
	}
	return nodes;
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
 * constant, a document handle, a reference member, a native source: another registry's value too) is followed,
 * anything else is a plain value, whatever methods it has (registries carry natives).
 */
export function contributionOf(
	record: RegistryRecord,
	contributor: Contributor,
	version: number,
	value: unknown,
): RegistryContribution {
	return new RegistryContribution(record, contributor, version, contentOf(value));
}

/** What Chord follows behind a contribution: its JSON or native source when it is a Chord watchable. */
function contentOf(value: unknown): ContributionContent {
	if (value instanceof NativeSource) return { kind: "native", source: value };
	const source = resolveWatchable(value);
	return source === undefined ? { kind: "plain", value } : { kind: "json", source };
}
