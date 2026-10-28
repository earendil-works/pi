// Evolution: `evolve(previous, (e) => e...)` appends the next version of a history with structured edits.

import {
	type Contract,
	type ContractData,
	type ContractShape,
	type CurrentVariants,
	contractData,
	createContract,
	type Kind,
	LOCAL,
	type MemberKind,
	type MethodData,
	type ShapeOf,
} from "./contract.ts";
import { checkMembers, memberPath, readMethod } from "./declare.ts";
import { materialize } from "./fingerprint.ts";
import type { Change, CurrentStep, Increment, MemberNames, MethodAt, Variants, VariantsWith } from "./history.ts";
import { Method, type TSchema } from "./schema.ts";
import { type Snapshot, snapshotArguments, snapshotSchema } from "./snapshot.ts";

/** Method edits, the same for both kinds: each changes the method in every variant that has it. */
interface MethodEditor<K extends Kind, V extends Variants, C extends Change> {
	/** Type only: the variants after the edits so far. */
	readonly "~variants"?: V;
	/** Type only: the changes made by the edits so far. */
	readonly "~changes"?: C;
	args<M extends MemberNames<V, "methods">, A extends TSchema>(
		member: M,
		args: A,
	): Editor<
		K,
		Put<V, VariantsWith<V, M>, "methods", M, Method<A, MethodAt<V, M>["result"]>>,
		C | [VariantsWith<V, M>, M, "args"]
	>;
	result<M extends MemberNames<V, "methods">, R extends TSchema>(
		member: M,
		result: R,
	): Editor<
		K,
		Put<V, VariantsWith<V, M>, "methods", M, Method<MethodAt<V, M>["args"], R>>,
		C | [VariantsWith<V, M>, M, "result"]
	>;
	method<M extends MemberNames<V, "methods">, A extends TSchema, R extends TSchema>(
		member: M,
		args: A,
		result: R,
	): Editor<K, Put<V, VariantsWith<V, M>, "methods", M, Method<A, R>>, C | [VariantsWith<V, M>, M, "args" | "result"]>;
	removeMethod<M extends MemberNames<V, "methods">>(member: M): Editor<K, Drop<V, keyof V, "methods", M>, C>;
}

/** Edits of a remote contract. */
interface RemoteEditor<V extends Variants, C extends Change> extends MethodEditor<"remote", V, C> {
	state<X extends keyof V & string, M extends keyof V[X]["state"] & string, S extends TSchema>(
		variant: X,
		member: M,
		schema: S,
	): RemoteEditor<Put<V, X, "state", M, S>, C | [X, M, "state"]>;
	addState<X extends keyof V & string, const M extends string, S extends TSchema>(
		variant: X,
		member: M,
		schema: S,
	): RemoteEditor<Put<V, X, "state", M, S>, C | [X, M, "state"]>;
	removeState<X extends keyof V & string, M extends keyof V[X]["state"] & string>(
		variant: X,
		member: M,
	): RemoteEditor<Drop<V, X, "state", M>, C>;
	addMethod<X extends keyof V & string, const M extends string, A extends TSchema, R extends TSchema>(
		variant: X,
		member: M,
		args: A,
		result: R,
	): RemoteEditor<Put<V, X, "methods", M, Method<A, R>>, C | [X, M, "args" | "result"]>;
}

/** Edits of a local contract: like remote ones, without a variant. */
interface LocalEditor<V extends Variants, C extends Change> extends MethodEditor<"local", V, C> {
	state<M extends keyof V[Local]["state"] & string, S extends TSchema>(
		member: M,
		schema: S,
	): LocalEditor<Put<V, Local, "state", M, S>, C | [Local, M, "state"]>;
	addState<const M extends string, S extends TSchema>(
		member: M,
		schema: S,
	): LocalEditor<Put<V, Local, "state", M, S>, C | [Local, M, "state"]>;
	removeState<M extends keyof V[Local]["state"] & string>(member: M): LocalEditor<Drop<V, Local, "state", M>, C>;
	addMethod<const M extends string, A extends TSchema, R extends TSchema>(
		member: M,
		args: A,
		result: R,
	): LocalEditor<Put<V, Local, "methods", M, Method<A, R>>, C | [Local, M, "args" | "result"]>;
}

type Local = typeof LOCAL;

type Editor<K extends Kind, V extends Variants, C extends Change> = K extends "remote"
	? RemoteEditor<V, C>
	: LocalEditor<V, C>;

type EditorOf<C extends Contract> = Editor<ShapeOf<C>["kind"], CurrentVariants<C>, never>;

/** Variants `X` with member `M` of `Side` set to `T`. */
type Put<V extends Variants, X, Side extends EditedSide, M extends string, T> = {
	[Y in keyof V]: Y extends X
		? {
				[S in keyof V[Y]]: S extends Side ? { [K in keyof V[Y][S] | M]: K extends M ? T : V[Y][S][K] } : V[Y][S];
			}
		: V[Y];
};

/** Variants `X` without member `M` of `Side`. */
type Drop<V extends Variants, X, Side extends EditedSide, M extends string> = {
	[Y in keyof V]: Y extends X ? { [S in keyof V[Y]]: S extends Side ? Omit<V[Y][S], M> : V[Y][S] } : V[Y];
};

/** The sides of a variant that edits change; keyed members are carried over unchanged (their versions: slice 7). */
type EditedSide = "state" | "methods";

type Evolved<S extends ContractShape, E extends MethodEditor<S["kind"], Variants, Change>> = {
	kind: S["kind"];
	name: S["name"];
	params: S["params"];
	history: [
		...S["history"],
		{
			version: Increment<CurrentStep<S["history"]>["version"]>;
			variants: NonNullable<E["~variants"]>;
			changes: NonNullable<E["~changes"]>;
		},
	];
};

/**
 * Appends the next version (`previous.version + 1`) with the edits `edit` makes; `edit` must return the editor it was
 * given. Params and the variant set never change: a change to either is a new history base.
 */
export function evolve<C extends Contract, E extends MethodEditor<ShapeOf<C>["kind"], Variants, Change>>(
	previous: C,
	edit: (editor: EditorOf<C>) => E,
): Contract<Evolved<ShapeOf<C>, E>> {
	const draft = new Draft(contractData(previous));
	const editor = draft.kind === "local" ? localEditor(draft) : draft;
	// The editor interfaces track the edits in the types; at runtime every edit returns the same editor.
	editWith(editor as unknown as EditorOf<C>, edit, `${draft.path}: evolve`);
	return createContract(draft.next());
}

/**
 * Runs `edit` on `editor` (contracts' and tables' rule): an edit returning anything but the editor it was given throws
 * (`what` names the call).
 */
export function editWith<E>(editor: E, edit: (editor: E) => unknown, what: string): void {
	if (edit(editor) !== editor) throw new Error(`${what} must return the editor it was given`);
}

/** A variant under construction; keyed members are carried over unchanged (their versions are slice 7's). */
type DraftVariant = {
	readonly state: Map<string, Snapshot>;
	readonly methods: Map<string, MethodData>;
	readonly keyed: ReadonlyMap<string, Snapshot>;
};

/** The next version under construction, and the remote editor. Every edit is checked as it is made. */
class Draft {
	readonly kind: Kind;
	readonly path: string;
	/** What edits return: the draft itself, or the local editor wrapping it. */
	editor: object = this;
	readonly #data: ContractData;
	readonly #version: number;
	readonly #variants: Map<string, DraftVariant>;
	readonly #kinds: Map<string, MemberKind>;
	readonly #changes: Change[] = [];

	constructor(data: ContractData) {
		const current = data.versions.at(-1)!;
		this.kind = data.kind;
		this.#data = data;
		this.#version = current.version + 1;
		this.path = `${data.name} v${this.#version}`;
		this.#variants = new Map(
			[...current.variants].map(([name, { state, methods, keyed }]) => [
				name,
				{ state: new Map(state), methods: new Map(methods), keyed },
			]),
		);
		this.#kinds = new Map(data.kinds);
	}

	state(variant: string, member: string, schema: TSchema): object {
		if (!this.#variant(variant).state.has(member)) {
			throw new Error(`${this.#path(variant, member, "state")}: no such state member`);
		}
		return this.#putState(variant, member, schema);
	}

	addState(variant: string, member: string, schema: TSchema): object {
		this.#refuseDeclared(variant, member, "state");
		return this.#putState(variant, member, schema);
	}

	removeState(variant: string, member: string): object {
		if (!this.#variant(variant).state.delete(member)) {
			throw new Error(`${this.#path(variant, member, "state")}: no such state member`);
		}
		return this.editor;
	}

	args(member: string, args: TSchema): object {
		return this.#changeMethod(member, args, undefined);
	}

	result(member: string, result: TSchema): object {
		return this.#changeMethod(member, undefined, result);
	}

	method(member: string, args: TSchema, result: TSchema): object {
		return this.#changeMethod(member, args, result);
	}

	addMethod(variant: string, member: string, args: TSchema, result: TSchema): object {
		this.#refuseDeclared(variant, member, "method");
		this.#variant(variant).methods.set(
			member,
			readMethod(new Method(args, result), this.#path(variant, member, "method")),
		);
		this.#changes.push([variant, member, "args"], [variant, member, "result"]);
		return this.#checked();
	}

	removeMethod(member: string): object {
		for (const variant of this.#variantsWith(member)) this.#variant(variant).methods.delete(member);
		return this.editor;
	}

	/** The contract data with this version appended. */
	next(): ContractData {
		const { kind, params, versions } = this.#data;
		const version = materialize(kind, params, this.#version, this.#variants, this.#changes);
		return { ...this.#data, versions: [...versions, version], kinds: this.#kinds };
	}

	#putState(variant: string, member: string, schema: TSchema): object {
		this.#variant(variant).state.set(member, snapshotSchema(schema, this.#path(variant, member, "state")));
		this.#changes.push([variant, member, "state"]);
		return this.#checked();
	}

	/** Changes the given sides of a method in every variant that has it. */
	#changeMethod(member: string, args: TSchema | undefined, result: TSchema | undefined): object {
		const variants = this.#variantsWith(member);
		const path = this.#path(variants[0]!, member, "method");
		const newArgs = args === undefined ? undefined : snapshotArguments(args, `${path}.args`);
		const newResult = result === undefined ? undefined : snapshotSchema(result, `${path}.result`);
		for (const variant of variants) {
			const { methods } = this.#variant(variant);
			const old = methods.get(member)!;
			methods.set(member, { args: newArgs ?? old.args, result: newResult ?? old.result });
			if (newArgs !== undefined) this.#changes.push([variant, member, "args"]);
			if (newResult !== undefined) this.#changes.push([variant, member, "result"]);
		}
		return this.#checked();
	}

	#variant(variant: string): DraftVariant {
		const found = this.#variants.get(variant);
		if (found === undefined) {
			throw new Error(`${this.path}.${variant}: unknown variant (the variant set never changes)`);
		}
		return found;
	}

	#variantsWith(member: string): string[] {
		const variants = [...this.#variants].filter(([, { methods }]) => methods.has(member)).map(([variant]) => variant);
		if (variants.length === 0) throw new Error(`${this.path}: no method "${member}"`);
		return variants;
	}

	#refuseDeclared(variant: string, member: string, kind: MemberKind): void {
		const { state, methods } = this.#variant(variant);
		if (state.has(member) || methods.has(member)) {
			throw new Error(`${this.#path(variant, member, kind)}: already declared`);
		}
	}

	#path(variant: string, member: string, kind: MemberKind): string {
		return memberPath(this.path, this.kind, variant, member, kind);
	}

	/** A member's kind never changes, also not after a removal; a method keeps one signature across variants. */
	#checked(): object {
		checkMembers(this.#variants, this.#kinds, (variant, member, kind) => this.#path(variant, member, kind));
		return this.editor;
	}
}

/** The local editor: the draft's edits with the variant filled in. */
function localEditor(draft: Draft): object {
	draft.editor = {
		state: (member: string, schema: TSchema) => draft.state(LOCAL, member, schema),
		addState: (member: string, schema: TSchema) => draft.addState(LOCAL, member, schema),
		removeState: (member: string) => draft.removeState(LOCAL, member),
		addMethod: (member: string, args: TSchema, result: TSchema) => draft.addMethod(LOCAL, member, args, result),
		args: (member: string, args: TSchema) => draft.args(member, args),
		result: (member: string, result: TSchema) => draft.result(member, result),
		method: (member: string, args: TSchema, result: TSchema) => draft.method(member, args, result),
		removeMethod: (member: string) => draft.removeMethod(member),
	};
	return draft.editor;
}
