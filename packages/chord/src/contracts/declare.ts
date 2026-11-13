// Declarations: `remote(...)` and `local(...)`, the checks every declared version passes, and the reading of
// untyped declaration input. A member is state, a method, a keyed member (local only) or an event.

import type { HostKeyed, KeyedSnapshot } from "./contract.ts";
import {
	type Contract,
	createContract,
	type HostAddress,
	type Kind,
	LOCAL,
	type MemberKind,
	type MethodData,
	type VariantData,
} from "./contract.ts";
import { materialize } from "./fingerprint.ts";
import type { MemberNames, MethodAt, VariantShape } from "./history.ts";
import { type Address, type KindShape, kindParams } from "./host-kind.ts";
import { checkName } from "./names.ts";
import { type Params, type RequiredFields, readParams } from "./params.ts";
import { EventDeclaration, KeyedMember, Method, type Schema, type Static } from "./schema.ts";
import { type Snapshot, snapshotArguments, snapshotSchema } from "./snapshot.ts";

type VariantDeclaration = {
	readonly state?: { readonly [member: string]: Schema };
	readonly methods?: { readonly [member: string]: Method };
	readonly events?: { readonly [member: string]: Schema };
};

type VariantDeclarations = { readonly [variant: string]: VariantDeclaration };

type RemoteVariants<D extends VariantDeclarations> = {
	[V in keyof D]: {
		state: D[V]["state"] extends object ? D[V]["state"] : Record<never, never>;
		methods: D[V]["methods"] extends object ? D[V]["methods"] : Record<never, never>;
		events: D[V]["events"] extends object ? D[V]["events"] : Record<never, never>;
	};
};

type LocalVariants<M extends { readonly [member: string]: LocalMember }> = {
	[LOCAL]: {
		state: { [K in keyof M as M[K] extends Marker ? never : K]: Exclude<M[K], Marker> };
		methods: { [K in keyof M as M[K] extends Method ? K : never]: Extract<M[K], Method> };
		keyed: { [K in keyof M as M[K] extends KeyedMember ? K : never]: SchemaOf<M[K]> };
		events: { [K in keyof M as M[K] extends EventDeclaration ? K : never]: EventSchemaOf<M[K]> };
	};
};

/** A local contract's member: a state schema, `method(...)`, `keyed(schema)` or `event(schema)`. */
type LocalMember = Schema | Marker;

/** The local members that are no state schema. */
type Marker = Method | KeyedMember | EventDeclaration;

type EventSchemaOf<M> = M extends EventDeclaration<infer S> ? S : never;

type SchemaOf<M> = M extends KeyedMember<infer S, infer K> ? (K extends KindShape ? HostKeyed<S, K> : S) : never;

/** D11: a member name has one kind in every variant, a method one signature; no keyed members. */
type SameMembers<D extends VariantDeclarations, V extends { [variant: string]: VariantShape } = RemoteVariants<D>> = {
	[X in keyof D]: {
		state?: {
			// Keyed members are only in local contracts (slice 6a §12).
			[M in keyof D[X]["state"]]: M extends MemberNames<V, "methods"> | MemberNames<V, "events">
				? never
				: D[X]["state"][M] extends KeyedMember | EventDeclaration
					? never
					: D[X]["state"][M];
		};
		methods?: {
			[M in keyof D[X]["methods"]]: M extends MemberNames<V, "state"> | MemberNames<V, "events">
				? never
				: [MethodAt<V, M>] extends [D[X]["methods"][M]]
					? D[X]["methods"][M]
					: never;
		};
		events?: {
			[M in keyof D[X]["events"]]: M extends MemberNames<V, "state"> | MemberNames<V, "methods">
				? never
				: D[X]["events"][M] extends Marker
					? never
					: D[X]["events"][M];
		};
	};
};

/** Declares a remote contract: per-principal variants of state, methods and events. */
export function remote<
	const N extends string,
	const P extends Params,
	const V extends number,
	const D extends VariantDeclarations,
>(
	name: N,
	declaration: {
		readonly version: V;
		readonly params: P & NoInfer<RequiredFields<P>>;
		/** The address of the host serving an object for these params; never part of the fingerprint. */
		readonly hostAddress: (params: { [F in keyof P]: Static<P[F]> }) => Address;
		readonly variants: D & NoInfer<SameMembers<D>>;
	},
): Contract<{
	kind: "remote";
	name: N;
	params: P;
	history: [{ version: `${V}`; variants: RemoteVariants<D>; changes: never }];
}> {
	// Declaration policy: JavaScript callers reach every check below.
	checkName(name, "A contract name");
	checkKeys(declaration, ["version", "params", "hostAddress", "variants"], name);
	const variants = entriesOf(declaration.variants, `${name}.variants`);
	if (variants.length === 0) throw new Error(`${name}.variants: at least one variant is required`);
	const { hostAddress } = declaration;
	if (typeof hostAddress !== "function") throw new Error(`${name}.hostAddress: expected a function of the params`);
	const read = variants.map(([variant, members]) => [variant, readVariant(members, `${name}.${variant}`)] as const);
	// The host address gets the checked params of this contract.
	return declare("remote", name, declaration, new Map(read), hostAddress as HostAddress);
}

/**
 * Declares a local contract: one flat map of members, where a schema is state, `method(...)` a method,
 * `keyed(schema)` a keyed state member and `event(schema)` an event member.
 */
export function local<
	const N extends string,
	const P extends Params,
	const V extends number,
	const M extends { readonly [member: string]: LocalMember },
>(
	name: N,
	declaration: { readonly version: V; readonly params: P & NoInfer<RequiredFields<P>>; readonly members: M },
): Contract<{
	kind: "local";
	name: N;
	params: P;
	history: [{ version: `${V}`; variants: LocalVariants<M>; changes: never }];
}> {
	// Declaration policy: JavaScript callers reach every check below.
	checkName(name, "A contract name");
	checkKeys(declaration, ["version", "params", "members"], name);
	const state = new Map<string, Snapshot>();
	const methods = new Map<string, MethodData>();
	const keyed = new Map<string, KeyedSnapshot>();
	const events = new Map<string, Snapshot>();
	for (const [member, value] of entriesOf(declaration.members, `${name}.${LOCAL}`)) {
		const path = `${name}.${LOCAL}.${member}`;
		if (value instanceof Method) methods.set(member, readMethod(value, path));
		else if (value instanceof KeyedMember) keyed.set(member, keyedSnapshot(value.schema, value.key, path));
		else if (value instanceof EventDeclaration) events.set(member, eventSnapshot(value.schema, path));
		else state.set(member, snapshotSchema(value, path));
	}
	return declare("local", name, declaration, new Map([[LOCAL, { state, methods, keyed, events }]]));
}

function readVariant(source: unknown, path: string): VariantData {
	checkKeys(source, ["state", "methods", "events"], path);
	const { state = {}, methods = {}, events = {} } = source as VariantDeclaration;
	const stateEntries = entriesOf(state, `${path}.state`).map(([member, schema]) => {
		if (schema instanceof Method) throw new Error(`${path}.state.${member}: a method belongs in methods`);
		if (schema instanceof KeyedMember) {
			throw new Error(`${path}.state.${member}: keyed members are only in local contracts`);
		}
		if (schema instanceof EventDeclaration) throw new Error(`${path}.state.${member}: an event belongs in events`);
		return [member, snapshotSchema(schema, `${path}.state.${member}`)] as const;
	});
	const methodEntries = entriesOf(methods, `${path}.methods`).map(([member, method]) => {
		if (!(method instanceof Method)) throw new Error(`${path}.methods.${member}: expected method(...)`);
		return [member, readMethod(method, `${path}.methods.${member}`)] as const;
	});
	const eventEntries = entriesOf(events, `${path}.events`).map(([member, schema]) => {
		if (schema instanceof Method || schema instanceof KeyedMember || schema instanceof EventDeclaration) {
			throw new Error(`${path}.events.${member}: expected the schema of the event's values`);
		}
		return [member, eventSnapshot(schema, `${path}.events.${member}`)] as const;
	});
	return {
		state: new Map(stateEntries),
		methods: new Map(methodEntries),
		keyed: new Map(),
		events: new Map(eventEntries),
	};
}

/** An event member's snapshot: JSON only (declaration policy: no `bytes()` leaf, events travel as JSON parts). */
export function eventSnapshot(schema: unknown, path: string): Snapshot {
	const snapshot = snapshotSchema(schema, path);
	if (snapshot.bytes) throw new Error(`${path}: an event's values are JSON only (no bytes())`);
	return snapshot;
}

/**
 * A keyed member's snapshot: its schema's and, keyed by a host kind, the kind (declaration policy: a declared one, its
 * name in the member's normal form).
 */
export function keyedSnapshot(schema: unknown, key: KindShape | undefined, path: string): KeyedSnapshot {
	const snapshot = snapshotSchema(schema, path);
	if (key === undefined) return snapshot;
	kindParams(key);
	return { ...snapshot, key };
}

/** One method declaration as Chord-owned snapshots; its arguments must be closed. */
export function readMethod(method: Method, path: string): MethodData {
	return {
		args: snapshotArguments(method.args, `${path}.args`),
		result: snapshotSchema(method.result, `${path}.result`),
	};
}

function declare<C extends Contract>(
	kind: Kind,
	name: string,
	declaration: { readonly version: number; readonly params: unknown },
	variants: ReadonlyMap<string, VariantData>,
	hostAddress?: HostAddress,
): C {
	const { version } = declaration;
	if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${name}.version: expected a positive integer`);
	const kinds = new Map<string, MemberKind>();
	checkMembers(variants, kinds, (variant, member, memberKind) => memberPath(name, kind, variant, member, memberKind));
	const params = readParams(entriesOf(declaration.params, `${name}.params`), `${name}.params`);
	const versions = [materialize(kind, params, version, variants, [])];
	return createContract({ kind, name, params, hostAddress, versions, kinds });
}

/**
 * Checks the members of every variant: a name keeps one kind across variants and the whole history (`kinds`, updated
 * here), a method one signature across variants.
 */
export function checkMembers(
	variants: ReadonlyMap<string, VariantData>,
	kinds: Map<string, MemberKind>,
	path: (variant: string, member: string, kind: MemberKind) => string,
): void {
	const signatures = new Map<string, string>();
	for (const [variant, { state, methods, keyed, events }] of variants) {
		for (const member of state.keys()) recordKind(kinds, member, "state", path(variant, member, "state"));
		for (const member of keyed.keys()) recordKind(kinds, member, "keyed", path(variant, member, "keyed"));
		for (const member of events.keys()) recordKind(kinds, member, "event", path(variant, member, "event"));
		for (const [member, { args, result }] of methods) {
			recordKind(kinds, member, "method", path(variant, member, "method"));
			const signature = JSON.stringify([args.normal, result.normal]);
			if ((signatures.get(member) ?? signature) !== signature) {
				throw new Error(`${path(variant, member, "method")}: a method has the same signature in every variant`);
			}
			signatures.set(member, signature);
		}
	}
}

function recordKind(kinds: Map<string, MemberKind>, member: string, kind: MemberKind, path: string): void {
	if (RESERVED_MEMBERS.has(member)) throw new Error(`${path}: "${member}" is reserved: a reference has it`);
	const known = kinds.get(member);
	if (known !== undefined && known !== kind) {
		throw new Error(
			`${path}: "${member}" is ${known === "event" ? "an" : "a"} ${known} member; its kind never changes`,
		);
	}
	kinds.set(member, kind);
}

/**
 * Names a reference has itself (`release`, `variant`, and `state` and `retry` with failures), and `then`, which would
 * make an awaited reference thenable.
 */
const RESERVED_MEMBERS: ReadonlySet<string> = new Set(["then", "release", "variant", "state", "retry"]);

/** The path of a member in errors: `notes.editor.methods.add`, `game.player.events.paddle`, `info.members.clear`. */
export function memberPath(base: string, kind: Kind, variant: string, member: string, memberKind: MemberKind): string {
	if (kind === "local") return `${base}.${LOCAL}.${member}`;
	return `${base}.${variant}.${SECTIONS[memberKind]}.${member}`;
}

/** The section of a remote variant a member of each kind is declared in (keyed members: only local contracts). */
const SECTIONS: { readonly [K in MemberKind]: string } = {
	state: "state",
	method: "methods",
	keyed: "state",
	event: "events",
};

/** Refuses a non-object and unknown keys. */
export function checkKeys(source: unknown, allowed: readonly string[], path: string): void {
	for (const [key] of entriesOf(source, path)) {
		if (!allowed.includes(key)) throw new Error(`${path}: unknown key "${key}"`);
	}
}

/** The entries of an object; anything else is refused. */
export function entriesOf(source: unknown, path: string): [string, unknown][] {
	if (typeof source !== "object" || source === null || Array.isArray(source)) {
		throw new Error(`${path}: expected an object`);
	}
	return Object.entries(source);
}
