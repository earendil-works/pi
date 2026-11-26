// Declarations: `remote(...)` and `local(...)`, the checks every declared version passes, and the reading of
// untyped declaration input. A member is state, a method, a keyed member (local only) or an event; a remote contract's
// may be grantable, and it may declare flags (slice 15 §1).

import { isJsonValue } from "../json.ts";
import type { AdmissionData, HostKeyed, KeyedSnapshot, MembersData, QueriesData } from "./contract.ts";
import {
	type Contract,
	createContract,
	type HostAddress,
	type Kind,
	type MemberKind,
	type MethodData,
	NO_GRANTS,
} from "./contract.ts";
import { fingerprintOf, materialize } from "./fingerprint.ts";
import { type Address, type KindShape, kindParams } from "./host-kind.ts";
import type { MessageData } from "./message.ts";
import { checkName } from "./names.ts";
import { type Params, type RequiredFields, readParams } from "./params.ts";
import { EventDeclaration, Grantable, KeyedMember, Method, QueriesMember, type Schema, type Static } from "./schema.ts";
import { type Snapshot, snapshotArguments, snapshotSchema } from "./snapshot.ts";

type StateDeclarations = { readonly [member: string]: Schema | Grantable<Schema> };

type MethodDeclarations = { readonly [member: string]: Method | Grantable<Method> };

type FlagDeclarations = { readonly [flag: string]: MessageData };

type LocalMembers<M extends { readonly [member: string]: LocalMember }> = {
	state: { [K in keyof M as M[K] extends Marker ? never : K]: Exclude<M[K], Marker> };
	methods: { [K in keyof M as M[K] extends Method ? K : never]: Extract<M[K], Method> };
	keyed: { [K in keyof M as M[K] extends KeyedMember ? K : never]: SchemaOf<M[K]> };
	events: { [K in keyof M as M[K] extends EventDeclaration ? K : never]: EventSchemaOf<M[K]> };
	queries: { [K in keyof M as M[K] extends QueriesMember ? K : never]: Extract<M[K], QueriesMember> };
};

/** A local contract's member: a state schema, `method(...)`, `keyed(schema)` or `event(schema)`. */
type LocalMember = Schema | Marker;

/** The local members that are no state schema. */
type Marker = Method | KeyedMember | EventDeclaration | QueriesMember;

type EventSchemaOf<M> = M extends EventDeclaration<infer S> ? S : never;

type SchemaOf<M> = M extends KeyedMember<infer S, infer K> ? (K extends KindShape ? HostKeyed<S, K> : S) : never;

/**
 * D11, slice 15 §1.1: a name is one member or one flag of a remote contract, never two; state and event members are
 * schemas (keyed, `queries` and `event(...)` members are only in local contracts).
 */
type Distinct<D, Others> = { [M in keyof D]: M extends keyof Others ? never : D[M] };

/**
 * Declares a remote contract: one shape for every caller (slice 15 §1). Its state, methods and events; a member marked
 * `grantable(...)` exists for a caller only if its admission granted it, and `flags` are rights that are no member.
 * Optionally its `admission`: the schema of the data its provider reads about a caller before the factory runs.
 */
export function remote<
	const N extends string,
	const P extends Params,
	const V extends number,
	const S extends StateDeclarations = Record<never, never>,
	const M extends MethodDeclarations = Record<never, never>,
	const E extends StateDeclarations = Record<never, never>,
	const F extends FlagDeclarations = Record<never, never>,
	A extends Schema = never,
>(
	name: N,
	declaration: {
		readonly version: V;
		readonly params: P & NoInfer<RequiredFields<P>>;
		/** The address of the host serving an object for these params; never part of the fingerprint. */
		readonly hostAddress: (params: { [F in keyof P]: Static<P[F]> }) => Address;
		/**
		 * The schema of the data the type's admission hands its factory besides `granted` (an `obj(...)`): small, about
		 * the caller (a mode, a role). Never part of the fingerprint, never validated at runtime.
		 */
		readonly admission?: A;
		readonly state?: S & NoInfer<Distinct<S, M & E & F>>;
		readonly methods?: M & NoInfer<Distinct<M, S & E & F>>;
		readonly events?: E & NoInfer<Distinct<E, S & M & F>>;
		/**
		 * Rights that are no member, each with its label: a message (`messages.message("flagExport")` of the plugin's
		 * `defineMessages`), which the access UI renders in the viewer's language; never part of the fingerprint.
		 */
		readonly flags?: F & NoInfer<Distinct<F, S & M & E>>;
	},
): Contract<
	{
		kind: "remote";
		name: N;
		params: P;
		history: [{ version: `${V}`; members: { state: S; methods: M; events: E }; changes: never }];
	} & ([A] extends [never] ? unknown : { admission: A }) &
		([keyof F] extends [never] ? unknown : { flags: F })
> {
	// Declaration policy: JavaScript callers reach every check below.
	checkName(name, "A contract name");
	checkKeys(declaration, REMOTE_KEYS, name);
	const { hostAddress } = declaration;
	if (typeof hostAddress !== "function") throw new Error(`${name}.hostAddress: expected a function of the params`);
	const { members, grantable } = readRemoteMembers(declaration, name);
	const flags = new Map(
		entriesOf(declaration.flags ?? {}, `${name}.flags`).map(
			([flag, label]) => [flag, flagLabel(label, `${name}.flags.${flag}`)] as const,
		),
	);
	const { admission } = declaration;
	const admitted = admission === undefined ? undefined : admissionData(admission, `${name}.admission`);
	// The host address gets the checked params of this contract.
	const base = { kind: "remote", name, hostAddress: hostAddress as HostAddress, admission: admitted, flags } as const;
	return declare(base, declaration, members, grantable);
}

const REMOTE_KEYS = ["version", "params", "hostAddress", "admission", "state", "methods", "events", "flags"];

/**
 * A flag's label as `MessageSchema` describes a message: JSON data (finite numbers, dense arrays, as it crosses links)
 * of its namespace, key and plain parameters, nothing else.
 */
function flagLabel(label: unknown, path: string): MessageData {
	const { namespace, key, params } = (
		isJsonValue(label) && typeof label === "object" && label !== null ? label : {}
	) as {
		namespace?: unknown;
		key?: unknown;
		params?: unknown;
	};
	// JSON already: a parameter is plain unless it is an object or an array.
	const plain = (param: unknown) => param === null || typeof param !== "object";
	if (typeof namespace !== "string" || typeof key !== "string" || !Array.isArray(params) || !params.every(plain)) {
		throw new Error(`${path}: expected its label as a message ({ namespace, key, params })`);
	}
	checkKeys(label, MESSAGE_KEYS, path);
	return label as MessageData;
}

const MESSAGE_KEYS = ["namespace", "key", "params"];

/** A remote declaration's members as Chord-owned snapshots, and which of them are grantable. */
function readRemoteMembers(
	declaration: { readonly state?: unknown; readonly methods?: unknown; readonly events?: unknown },
	name: string,
): { readonly members: MembersData; readonly grantable: ReadonlySet<string> } {
	const grantable = new Set<string>();
	const unmarked = (member: string, value: unknown): unknown => {
		if (!(value instanceof Grantable)) return value;
		grantable.add(member);
		return value.member;
	};
	const state = entriesOf(declaration.state ?? {}, `${name}.state`).map(([member, value]) => {
		const schema = unmarked(member, value);
		const path = `${name}.state.${member}`;
		if (schema instanceof Method) throw new Error(`${path}: a method belongs in methods`);
		if (schema instanceof KeyedMember) throw new Error(`${path}: keyed members are only in local contracts`);
		if (schema instanceof EventDeclaration) throw new Error(`${path}: an event belongs in events`);
		if (schema instanceof QueriesMember) throw new Error(`${path}: queries members are only in local contracts`);
		return [member, snapshotSchema(schema, path)] as const;
	});
	const methods = entriesOf(declaration.methods ?? {}, `${name}.methods`).map(([member, value]) => {
		const method = unmarked(member, value);
		if (!(method instanceof Method)) throw new Error(`${name}.methods.${member}: expected method(...)`);
		return [member, readMethod(method, `${name}.methods.${member}`)] as const;
	});
	const events = entriesOf(declaration.events ?? {}, `${name}.events`).map(([member, value]) => {
		const schema = unmarked(member, value);
		if (schema instanceof Method || schema instanceof KeyedMember || schema instanceof EventDeclaration) {
			throw new Error(`${name}.events.${member}: expected the schema of the event's values`);
		}
		return [member, eventSnapshot(schema, `${name}.events.${member}`)] as const;
	});
	const members = {
		state: new Map(state),
		methods: new Map(methods),
		keyed: new Map(),
		events: new Map(events),
		queries: new Map(),
	};
	return { members, grantable };
}

/**
 * An admission schema as Chord-owned data, with its fingerprint. Declaration policy: JSON only (no `bytes()` leaf), an
 * object whose fields are the admitted data (`granted` is Chord's, slice 15 §1.2).
 */
export function admissionData(schema: unknown, path: string): AdmissionData {
	const snapshot = snapshotSchema(schema, path);
	if (snapshot.bytes) throw new Error(`${path}: an admission's value is JSON only (no bytes())`);
	// A schema's normal form is an object of keywords.
	const normal = snapshot.normal as {
		readonly type?: unknown;
		readonly properties?: { readonly [field: string]: unknown };
	};
	if (normal.type !== "object") throw new Error(`${path}: an admission's data is an obj(...)`);
	if (normal.properties !== undefined && Object.hasOwn(normal.properties, "granted")) {
		throw new Error(`${path}: "granted" is Chord's: the admitted data has no field of that name`);
	}
	return { schema: snapshot, fingerprint: fingerprintOf(snapshot.normal) };
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
	history: [{ version: `${V}`; members: LocalMembers<M>; changes: never }];
}> {
	// Declaration policy: JavaScript callers reach every check below.
	checkName(name, "A contract name");
	checkKeys(declaration, ["version", "params", "members"], name);
	const state = new Map<string, Snapshot>();
	const methods = new Map<string, MethodData>();
	const keyed = new Map<string, KeyedSnapshot>();
	const events = new Map<string, Snapshot>();
	const queries = new Map<string, QueriesData>();
	for (const [member, value] of entriesOf(declaration.members, `${name}.members`)) {
		const path = `${name}.members.${member}`;
		if (value instanceof Grantable) throw new Error(`${path}: only a remote contract has grantable members`);
		if (value instanceof Method) methods.set(member, readMethod(value, path));
		else if (value instanceof QueriesMember) queries.set(member, readQueries(value, path));
		else if (value instanceof KeyedMember) keyed.set(member, keyedSnapshot(value.schema, value.key, path));
		else if (value instanceof EventDeclaration) events.set(member, eventSnapshot(value.schema, path));
		else state.set(member, snapshotSchema(value, path));
	}
	const base = { kind: "local", name, hostAddress: undefined, admission: undefined, flags: NO_FLAGS } as const;
	return declare(base, declaration, { state, methods, keyed, events, queries }, NO_GRANTS);
}

const NO_FLAGS: ReadonlyMap<string, MessageData> = new Map();

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

/** A `queries` member as Chord-owned snapshots: its items' schema, and each named query's arguments, closed. */
function readQueries(member: QueriesMember, path: string): QueriesData {
	const args = entriesOf(member.args, `${path}.args`).map(
		([query, schema]) => [query, snapshotArguments(schema, `${path}.args.${query}`)] as const,
	);
	return { item: snapshotSchema(member.item, `${path}.item`), args: new Map(args) };
}

/** One method declaration as Chord-owned snapshots; its arguments must be closed. */
export function readMethod(method: Method, path: string): MethodData {
	return {
		args: snapshotArguments(method.args, `${path}.args`),
		result: snapshotSchema(method.result, `${path}.result`),
	};
}

/** The parts of a contract's data its declaration reads before its members. */
type Base = {
	readonly kind: Kind;
	readonly name: string;
	readonly hostAddress: HostAddress | undefined;
	readonly admission: AdmissionData | undefined;
	readonly flags: ReadonlyMap<string, MessageData>;
};

function declare<C extends Contract>(
	base: Base,
	declaration: { readonly version: number; readonly params: unknown },
	members: MembersData,
	grantable: ReadonlySet<string>,
): C {
	const { kind, name, flags } = base;
	const { version } = declaration;
	if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${name}.version: expected a positive integer`);
	const kinds = new Map<string, MemberKind>();
	checkMembers(members, kinds, (member, memberKind) => memberPath(name, kind, member, memberKind));
	for (const flag of flags.keys()) {
		if (RESERVED_MEMBERS.has(flag))
			throw new Error(`${name}.flags.${flag}: "${flag}" is reserved: a reference has it`);
		if (kinds.has(flag))
			throw new Error(`${name}.flags.${flag}: "${flag}" is a member: a name is a member or a flag`);
	}
	const params = readParams(entriesOf(declaration.params, `${name}.params`), `${name}.params`);
	const versions = [materialize(kind, params, version, members, grantable, [...flags.keys()], [])];
	return createContract({ ...base, params, versions, kinds });
}

/** Checks a version's members: a name keeps one kind across the kinds of members and the whole history (`kinds`). */
export function checkMembers(
	{ state, methods, keyed, events, queries }: MembersData,
	kinds: Map<string, MemberKind>,
	path: (member: string, kind: MemberKind) => string,
): void {
	const seen = new Set<string>();
	const record = (member: string, kind: MemberKind): void => {
		if (seen.has(member)) throw new Error(`${path(member, kind)}: "${member}" is declared twice`);
		seen.add(member);
		recordKind(kinds, member, kind, path(member, kind));
	};
	for (const member of queries.keys()) record(member, "queries");
	for (const member of state.keys()) record(member, "state");
	for (const member of keyed.keys()) record(member, "keyed");
	for (const member of events.keys()) record(member, "event");
	for (const member of methods.keys()) record(member, "method");
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
 * Names a reference has itself (`release`, `granted`, and `state` and `retry` with failures), and `then`, which would
 * make an awaited reference thenable.
 */
const RESERVED_MEMBERS: ReadonlySet<string> = new Set(["then", "release", "granted", "state", "retry"]);

/** The path of a member in errors: `notes.methods.add`, `game.events.paddle`, `info.members.clear`. */
export function memberPath(base: string, kind: Kind, member: string, memberKind: MemberKind): string {
	if (kind === "local") return `${base}.members.${member}`;
	return `${base}.${SECTIONS[memberKind]}.${member}`;
}

/** The section of a remote contract a member of each kind is declared in (keyed members: only local contracts). */
const SECTIONS: { readonly [K in MemberKind]: string } = {
	state: "state",
	method: "methods",
	keyed: "state",
	event: "events",
	queries: "state",
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
