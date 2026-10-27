import type { AnyContract, InputOf, Ref } from "./contract.ts";
import type { Op } from "./delta/index.ts";

/**
 * Options of `get`. `P` is the app's principal type: a JSON-serializable identity of a caller, mapped to an object key
 * by `createHost({ principalKey })`.
 */
export interface GetOptions<P = unknown> {
	/** Principal the object is created for. Defaults to the host's own principal (`createHost({ self })`). */
	readonly principal?: P;
	/**
	 * False: a method-only reference. It receives no state (unless another reference to the same object wants it), and
	 * is ready once its object is live.
	 */
	readonly state?: boolean;
}

/**
 * The explicit call context of one root (a short Chord call tree). Calls made with it carry its root id and code
 * version; `get` references are released when the call that received this ctx settles.
 */
export interface Ctx<P = unknown> {
	readonly signal: AbortSignal;
	readonly rootId: string;
	readonly codeVersion: number;
	/** Who the root acts as: the caller at ingress, the host's own principal inside objects. */
	readonly principal: P;
	/**
	 * A reference for this call, released when the call settles. Resolves once it is ready: live, with every state
	 * member of its variant (unless `state: false`). Rejects with the activation error, `aborted` when the ctx is
	 * aborted or the call settles first, or `unavailable/ready_timeout` after the host's `readyTimeout`; the reference
	 * is released then.
	 */
	get<C extends AnyContract>(type: C, input: InputOf<C>, options?: GetOptions<P>): Promise<Ref<C>>;
}

export type StateEvent<T> =
	| { readonly type: "snap"; readonly value: T }
	| { readonly type: "ops"; readonly ops: readonly Op[]; readonly value: T }
	| { readonly type: "reset"; readonly value: T };

/** A readable state source: a cell, a derivation, or a reference's state member. Values are immutable by contract. */
export interface Readable<T> {
	readonly value: T;
	/** Called with the current value immediately, then with every new value. */
	subscribe(listener: (value: T) => void): () => void;
	/** Delta stream: a snapshot immediately, then ops, or a reset after a migration or rebind. */
	events(listener: (event: StateEvent<T>) => void): () => void;
}

/**
 * What an implementation may expose as a state member: a cell, a derivation, or a held object's state member (an
 * object goes live only once the members it exposes have their values).
 */
export type StateSource<T> = Readable<T>;

declare const EXPOSED: unique symbol;

/** A local member backed by a resource (`self.expose(res.x)`): references read the resource's value once live. */
export interface Exposed<T> {
	readonly [EXPOSED]: T;
}

export type RefStatus = "loading" | "live" | "released" | "gone";

export interface Shape {
	readonly variant: string | undefined;
	readonly members: readonly string[];
	/** Fingerprint of the provider contract. */
	readonly contract: string;
}

export interface RefBase<C extends AnyContract> {
	/** The consumer contract token this reference was bound with. */
	readonly contract: C;
	readonly status: RefStatus;
	readonly ready: Promise<void>;
	readonly variant: string | undefined;
	readonly shape: Shape | undefined;
	/** Why the reference is gone, if it is. */
	readonly error: unknown;
	onShape(listener: (shape: Shape) => void): () => void;
	/**
	 * Called after every status change (`loading` → `live`, `live` → `loading` while a link reconnects, `released`,
	 * `gone` with `error`). A UI watches for `gone` to `get` again.
	 */
	onStatus(listener: (status: RefStatus, error: unknown) => void): () => void;
	release(): void;
}
