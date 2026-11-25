// Evolution: `evolve(previous, (e) => e...)` appends the next version of a history with structured edits.

import {
	type AdmissionData,
	type Contract,
	type ContractData,
	type ContractShape,
	type CurrentMembers,
	contractData,
	createContract,
	type HostKeyed,
	type KeyedSnapshot,
	type Kind,
	type MemberKind,
	type MethodData,
	type QueriesData,
	type ShapeOf,
} from "./contract.ts";
import { admissionData, checkMembers, eventSnapshot, keyedSnapshot, memberPath, readMethod } from "./declare.ts";
import { materialize } from "./fingerprint.ts";
import type { Change, CurrentStep, Increment, MembersShape } from "./history.ts";
import type { HostKind, KindShape } from "./host-kind.ts";
import type { Params } from "./params.ts";
import { Grantable, Method, type Schema, type Ungranted } from "./schema.ts";
import { type Snapshot, snapshotArguments, snapshotSchema } from "./snapshot.ts";

/** A member's declaration in an `add…` edit: a remote contract's may be `grantable(...)`, a local one's never. */
type Added<K extends Kind, T extends Schema | Method> = K extends "remote" ? T | Grantable<T> : T;

/** The edits of both kinds: state, methods and event members (a remote contract's new ones may be grantable). */
interface MemberEditor<K extends Kind, V extends MembersShape, C extends Change> {
	/** Type only: the members after the edits so far. */
	readonly "~members"?: V;
	/** Type only: the changes made by the edits so far. */
	readonly "~changes"?: C;
	state<M extends keyof V["state"] & string, S extends Schema>(
		member: M,
		schema: S,
	): Editor<K, Put<V, "state", M, Regranted<V["state"][M], S>>, C | [M, "state"]>;
	addState<const M extends string, S extends Added<K, Schema>>(
		member: M,
		schema: S,
	): Editor<K, Put<V, "state", M, S>, C | [M, "state"]>;
	removeState<M extends keyof V["state"] & string>(member: M): Editor<K, Drop<V, "state", M>, C>;
	args<M extends keyof V["methods"] & string, A extends Schema>(
		member: M,
		args: A,
	): Editor<
		K,
		Put<V, "methods", M, Regranted<V["methods"][M], Method<A, Ungranted<V["methods"][M]>["result"]>>>,
		C | [M, "args"]
	>;
	result<M extends keyof V["methods"] & string, R extends Schema>(
		member: M,
		result: R,
	): Editor<
		K,
		Put<V, "methods", M, Regranted<V["methods"][M], Method<Ungranted<V["methods"][M]>["args"], R>>>,
		C | [M, "result"]
	>;
	method<M extends keyof V["methods"] & string, A extends Schema, R extends Schema>(
		member: M,
		args: A,
		result: R,
	): Editor<K, Put<V, "methods", M, Regranted<V["methods"][M], Method<A, R>>>, C | [M, "args" | "result"]>;
	addMethod<const M extends string, A extends Schema, R extends Schema>(
		member: M,
		args: A,
		result: R,
	): Editor<K, Put<V, "methods", M, Method<A, R>>, C | [M, "args" | "result"]>;
	/** Adds a grantable method (a remote contract's): `addMethod(member, grantable(method(args, result)))`. */
	addMethod<const M extends string, D extends Grantable<Method>>(
		member: M & (K extends "remote" ? string : never),
		declared: D,
	): Editor<K, Put<V, "methods", M, D>, C | [M, "args" | "result"]>;
	removeMethod<M extends keyof V["methods"] & string>(member: M): Editor<K, Drop<V, "methods", M>, C>;
	/** Changes event member `member`'s schema (an older consumer gets each value mapped, or is refused). */
	event<M extends EventNames<V> & string, S extends Schema>(
		member: M,
		schema: S,
	): Editor<K, PutEvent<V, M, Regranted<NonNullable<V["events"]>[M], S>>, C | [M, "event"]>;
	addEvent<const M extends string, S extends Added<K, Schema>>(
		member: M,
		schema: S,
	): Editor<K, PutEvent<V, M, S>, C | [M, "event"]>;
	removeEvent<M extends EventNames<V> & string>(member: M): Editor<K, DropEvent<V, M>, C>;
}

/** Edits of a remote contract. */
interface RemoteEditor<V extends MembersShape, C extends Change> extends MemberEditor<"remote", V, C> {
	/**
	 * Replaces the schema of the admission's data (slice 14 §2.5), or gives the contract one: the last edit of a
	 * version. The wire fingerprint is untouched; a reload rehearses the new factory only with a value of an equal
	 * admission schema.
	 */
	admission<S extends Schema>(schema: S): Edited<V, C> & { readonly "~admission"?: S };
}

/** What an editor says of its edits in the types: the members after them and the changes they made. */
type Edited<V extends MembersShape, C extends Change> = { readonly "~members"?: V; readonly "~changes"?: C };

/** Edits of a local contract: the member edits, and keyed members. */
interface LocalEditor<V extends MembersShape, C extends Change> extends MemberEditor<"local", V, C> {
	/**
	 * Changes keyed member `member`'s schema, keyed by string or by addresses of `key` (slice 7b: an older consumer reads
	 * each key mapped, or is refused; a changed key kind only refused).
	 */
	keyed<M extends KeyedNames<V> & string, S extends Schema>(
		member: M,
		schema: S,
	): LocalEditor<PutKeyed<V, M, S>, C | [M, "keyed"]>;
	keyed<M extends KeyedNames<V> & string, S extends Schema, N extends string, P extends Params>(
		member: M,
		schema: S,
		key: HostKind<N, P>,
	): LocalEditor<PutKeyed<V, M, HostKeyed<S, HostKind<N, P>>>, C | [M, "keyed"]>;
	addKeyed<const M extends string, S extends Schema>(
		member: M,
		schema: S,
	): LocalEditor<PutKeyed<V, M, S>, C | [M, "keyed"]>;
	addKeyed<const M extends string, S extends Schema, N extends string, P extends Params>(
		member: M,
		schema: S,
		key: HostKind<N, P>,
	): LocalEditor<PutKeyed<V, M, HostKeyed<S, HostKind<N, P>>>, C | [M, "keyed"]>;
	removeKeyed<M extends KeyedNames<V> & string>(member: M): LocalEditor<DropKeyed<V, M>, C>;
}

/** `T`, grantable when `Old` was: a changed member keeps its mark (whether a member is grantable never changes). */
type Regranted<Old, T extends Schema | Method> = Old extends Grantable ? Grantable<T> : T;

/** The event member names. */
type EventNames<V extends MembersShape> = keyof NonNullable<V["events"]>;

/** The members with event member `M` set to `T`. */
type PutEvent<V extends MembersShape, M extends string, T> = {
	[S in keyof V | "events"]: S extends "events"
		? { [K in keyof NonNullable<V["events"]> | M]: K extends M ? T : NonNullable<V["events"]>[K] }
		: V[S & keyof V];
};

/** The members without event member `M`. */
type DropEvent<V extends MembersShape, M extends string> = {
	[S in keyof V]: S extends "events" ? Omit<NonNullable<V["events"]>, M> : V[S];
};

/** The keyed member names. */
type KeyedNames<V extends MembersShape> = keyof NonNullable<V["keyed"]>;

/** The members with keyed member `M` set to `T`. */
type PutKeyed<V extends MembersShape, M extends string, T> = {
	[S in keyof V | "keyed"]: S extends "keyed"
		? { [K in keyof NonNullable<V["keyed"]> | M]: K extends M ? T : NonNullable<V["keyed"]>[K] }
		: V[S & keyof V];
};

/** The members without keyed member `M`. */
type DropKeyed<V extends MembersShape, M extends string> = {
	[S in keyof V]: S extends "keyed" ? Omit<NonNullable<V["keyed"]>, M> : V[S];
};

type Editor<K extends Kind, V extends MembersShape, C extends Change> = K extends "remote"
	? RemoteEditor<V, C>
	: LocalEditor<V, C>;

type EditorOf<C extends Contract> = Editor<ShapeOf<C>["kind"], CurrentMembers<C>, never>;

/** The members with member `M` of `Side` set to `T`. */
type Put<V extends MembersShape, Side extends EditedSide, M extends string, T> = {
	[S in keyof V]: S extends Side ? { [K in keyof V[S] | M]: K extends M ? T : V[S][K] } : V[S];
};

/** The members without member `M` of `Side`. */
type Drop<V extends MembersShape, Side extends EditedSide, M extends string> = {
	[S in keyof V]: S extends Side ? Omit<V[S], M> : V[S];
};

/** The sides `Put` and `Drop` edit (keyed and event members have their own). */
type EditedSide = "state" | "methods";

type Evolved<S extends ContractShape, E extends Edited<MembersShape, Change>> = {
	kind: S["kind"];
	name: S["name"];
	params: S["params"];
	history: [
		...S["history"],
		{
			version: Increment<CurrentStep<S["history"]>["version"]>;
			members: NonNullable<E["~members"]>;
			changes: NonNullable<E["~changes"]>;
		},
	];
} & ("~admission" extends keyof E
	? { admission: NonNullable<E["~admission"]> }
	: S extends { readonly admission: infer A extends Schema }
		? { admission: A }
		: unknown) &
	(S extends { readonly flags: infer F } ? { flags: F } : unknown);

/**
 * Appends the next version (`previous.version + 1`) with the edits `edit` makes; `edit` must return the editor it was
 * given. Params, whether a member is grantable, and the flags never change: a change to any is a new history base
 * (slice 15 §1.1).
 */
export function evolve<C extends Contract, E extends Edited<MembersShape, Change>>(
	previous: C,
	edit: (editor: EditorOf<C>) => E,
): Contract<Evolved<ShapeOf<C>, E>> {
	const draft = new Draft(contractData(previous));
	// The editor interfaces track the edits in the types; at runtime every edit returns the same editor.
	editWith(draft as unknown as EditorOf<C>, edit, `${draft.path}: evolve`);
	return createContract(draft.next());
}

/**
 * Runs `edit` on `editor` (contracts' and tables' rule): an edit returning anything but the editor it was given throws
 * (`what` names the call).
 */
export function editWith<E>(editor: E, edit: (editor: E) => unknown, what: string): void {
	if (edit(editor) !== editor) throw new Error(`${what} must return the editor it was given`);
}

/** The next version under construction, and the editor of both kinds. Every edit is checked as it is made. */
class Draft {
	readonly kind: Kind;
	readonly path: string;
	readonly #data: ContractData;
	readonly #version: number;
	/** Its members; `queries` members are carried over as they are: no edit changes one yet (slice 14, carry-over). */
	readonly #members: {
		readonly state: Map<string, Snapshot>;
		readonly methods: Map<string, MethodData>;
		readonly keyed: Map<string, KeyedSnapshot>;
		readonly events: Map<string, Snapshot>;
		readonly queries: ReadonlyMap<string, QueriesData>;
	};
	readonly #grantable: Set<string>;
	readonly #kinds: Map<string, MemberKind>;
	readonly #changes: Change[] = [];
	/** The admission of the next version: the previous one's unless `admission(schema)` replaced it. */
	#admission: AdmissionData | undefined;

	constructor(data: ContractData) {
		const current = data.versions.at(-1)!;
		const { state, methods, keyed, events, queries } = current.members;
		this.kind = data.kind;
		this.#data = data;
		this.#version = current.version + 1;
		this.path = `${data.name} v${this.#version}`;
		this.#members = {
			state: new Map(state),
			methods: new Map(methods),
			keyed: new Map(keyed),
			events: new Map(events),
			queries,
		};
		this.#grantable = new Set(current.grantable);
		this.#kinds = new Map(data.kinds);
		this.#admission = data.admission;
	}

	admission(schema: Schema): object {
		if (this.kind === "local") throw new Error(`${this.path}.admission: only a remote contract has an admission`);
		this.#admission = admissionData(schema, `${this.path}.admission`);
		return this;
	}

	state(member: string, schema: Schema): object {
		if (!this.#members.state.has(member)) throw new Error(`${this.#path(member, "state")}: no such state member`);
		return this.#putState(member, schema);
	}

	addState(member: string, schema: Schema | Grantable<Schema>): object {
		this.#refuseDeclared(member, "state");
		return this.#putState(member, this.#unmarked(member, schema, "state"));
	}

	removeState(member: string): object {
		if (!this.#members.state.delete(member)) throw new Error(`${this.#path(member, "state")}: no such state member`);
		this.#grantable.delete(member);
		return this;
	}

	args(member: string, args: Schema): object {
		return this.#changeMethod(member, args, undefined);
	}

	result(member: string, result: Schema): object {
		return this.#changeMethod(member, undefined, result);
	}

	method(member: string, args: Schema, result: Schema): object {
		return this.#changeMethod(member, args, result);
	}

	addMethod(member: string, args: Schema | Grantable<Method>, result?: Schema): object {
		this.#refuseDeclared(member, "method");
		const declared = args instanceof Grantable ? args : new Method(args, result!);
		const method = this.#unmarked<unknown>(member, declared, "method");
		// Declaration policy: JavaScript callers reach it.
		if (!(method instanceof Method))
			throw new Error(`${this.#path(member, "method")}: expected grantable(method(...))`);
		this.#members.methods.set(member, readMethod(method, this.#path(member, "method")));
		this.#changes.push([member, "args"], [member, "result"]);
		return this.#checked();
	}

	removeMethod(member: string): object {
		if (!this.#members.methods.delete(member)) throw new Error(`${this.path}: no method "${member}"`);
		this.#grantable.delete(member);
		return this;
	}

	keyed(member: string, schema: Schema, key?: KindShape): object {
		if (!this.#members.keyed.has(member)) throw new Error(`${this.#path(member, "keyed")}: no such keyed member`);
		return this.#putKeyed(member, schema, key);
	}

	addKeyed(member: string, schema: Schema, key?: KindShape): object {
		this.#refuseDeclared(member, "keyed");
		return this.#putKeyed(member, schema, key);
	}

	removeKeyed(member: string): object {
		if (!this.#members.keyed.delete(member)) throw new Error(`${this.#path(member, "keyed")}: no such keyed member`);
		return this;
	}

	event(member: string, schema: Schema): object {
		if (!this.#members.events.has(member)) throw new Error(`${this.#path(member, "event")}: no such event member`);
		return this.#putEvent(member, schema);
	}

	addEvent(member: string, schema: Schema | Grantable<Schema>): object {
		this.#refuseDeclared(member, "event");
		return this.#putEvent(member, this.#unmarked(member, schema, "event"));
	}

	removeEvent(member: string): object {
		if (!this.#members.events.delete(member)) throw new Error(`${this.#path(member, "event")}: no such event member`);
		this.#grantable.delete(member);
		return this;
	}

	/** The contract data with this version appended. */
	next(): ContractData {
		const { kind, params, versions, flags } = this.#data;
		const grants = [...flags.keys()];
		const version = materialize(kind, params, this.#version, this.#members, this.#grantable, grants, this.#changes);
		return { ...this.#data, versions: [...versions, version], kinds: this.#kinds, admission: this.#admission };
	}

	/** A new member's declaration without its mark, which a remote contract records (a local one refuses it). */
	#unmarked<T>(member: string, declared: T | Grantable, kind: MemberKind): T {
		const marked = declared instanceof Grantable;
		const known = this.#data.kinds.get(member) === kind;
		// Also not through a removal (slice 15 §1.1): an older consumer's types say which members are always there.
		if (known && marked !== this.#data.versions.some(({ grantable }) => grantable.has(member)))
			throw new Error(`${this.#path(member, kind)}: whether it is grantable never changes across a history`);
		if (!marked) return declared as T;
		if (this.kind === "local") {
			throw new Error(`${this.#path(member, kind)}: only a remote contract has grantable members`);
		}
		this.#grantable.add(member);
		// A grantable mark wraps the member's declaration: what the edit takes unmarked.
		return declared.member as T;
	}

	#putState(member: string, schema: Schema): object {
		this.#members.state.set(member, snapshotSchema(schema, this.#path(member, "state")));
		this.#changes.push([member, "state"]);
		return this.#checked();
	}

	#putEvent(member: string, schema: Schema): object {
		this.#members.events.set(member, eventSnapshot(schema, this.#path(member, "event")));
		this.#changes.push([member, "event"]);
		return this.#checked();
	}

	#putKeyed(member: string, schema: Schema, key: KindShape | undefined): object {
		if (this.kind === "remote")
			throw new Error(`${this.#path(member, "keyed")}: keyed members are only in local contracts`);
		this.#members.keyed.set(member, keyedSnapshot(schema, key, this.#path(member, "keyed")));
		this.#changes.push([member, "keyed"]);
		return this.#checked();
	}

	/** Changes the given sides of a method. */
	#changeMethod(member: string, args: Schema | undefined, result: Schema | undefined): object {
		const old = this.#members.methods.get(member);
		if (old === undefined) throw new Error(`${this.path}: no method "${member}"`);
		const path = this.#path(member, "method");
		const newArgs = args === undefined ? undefined : snapshotArguments(args, `${path}.args`);
		const newResult = result === undefined ? undefined : snapshotSchema(result, `${path}.result`);
		this.#members.methods.set(member, { args: newArgs ?? old.args, result: newResult ?? old.result });
		if (newArgs !== undefined) this.#changes.push([member, "args"]);
		if (newResult !== undefined) this.#changes.push([member, "result"]);
		return this.#checked();
	}

	#refuseDeclared(member: string, kind: MemberKind): void {
		const declared = Object.values(this.#members);
		if (declared.some((members) => members.has(member)) || this.#data.flags.has(member)) {
			throw new Error(`${this.#path(member, kind)}: already declared`);
		}
	}

	#path(member: string, kind: MemberKind): string {
		return memberPath(this.path, this.kind, member, kind);
	}

	/** A member's kind never changes, also not after a removal. */
	#checked(): object {
		checkMembers(this.#members, this.#kinds, (member, kind) => this.#path(member, kind));
		return this;
	}
}
