// The `ctx` a method handler gets (§8): its call's context, who called, the calling host's incarnation, and
// call-scoped references; and the abort signal of a call's context, linked to long-lived sources until it settles.

import { type Context, type ContextKey, withAbortSignal, withoutAbortSignal } from "../../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import { ChordError, type Principal } from "../data/index.ts";
import type { AnyHost, GetOptions } from "./host.ts";
import type { Binding, Reference } from "./reference.ts";

/** A handler's context. */
export interface Ctx<P extends Principal = Principal> extends Context {
	/** The caller as its link stamped it; on a local object's handler the host's principal (none on a client). */
	readonly principal: P | undefined;
	/** The calling host's incarnation over a link, this host's otherwise (R20). */
	readonly incarnation: string;
	/**
	 * A reference as the caller (`principal`) sees it, released when the handler settles; afterwards `get` throws
	 * `released`.
	 */
	get<C extends Contract>(Type: C, params: ParamsOf<C>, options?: GetOptions): Promise<Reference<C>>;
}

/** Who makes a call: the principal it acts as and its host's incarnation. */
export type Caller = { readonly principal: Principal | undefined; readonly incarnation: string };

/** The ctx of one handler run (or root scope): its references are released by `settle` when it settled. */
export class CallContext implements Ctx {
	readonly principal: Principal | undefined;
	readonly incarnation: string;
	readonly #context: Context;
	readonly #host: AnyHost;
	/** The references taken with `get`; `undefined` once the handler settled. */
	#references: Binding[] | undefined = [];
	/** Aborted when the handler settles: a `get` still waiting gives up and releases its reference. By the first. */
	#settling: AbortController | undefined;

	constructor(context: Context, caller: Caller, host: AnyHost) {
		this.#context = context;
		this.principal = caller.principal;
		this.incarnation = caller.incarnation;
		this.#host = host;
	}

	get abortSignal(): AbortSignal | undefined {
		return this.#context.abortSignal;
	}

	get telemetry(): Context["telemetry"] {
		return this.#context.telemetry;
	}

	value<T>(key: ContextKey<T>): T | undefined {
		return this.#context.value(key);
	}

	toString(): string {
		return `${this.#context}.Ctx`;
	}

	async get<C extends Contract>(Type: C, params: ParamsOf<C>, options: GetOptions = {}): Promise<Reference<C>> {
		// A settled scope refuses `released` whatever aborted it; an aborted call creates nothing.
		if (this.#references === undefined) throw settled(Type);
		this.#context.abortSignal?.throwIfAborted();
		// Made for the caller: its principal and its origin's incarnation travel with the reference's holds.
		const caller = { principal: this.principal, incarnation: this.incarnation };
		this.#settling ??= new AbortController();
		const scoped = withLinkedAbortSignal(this.#settling.signal, this.#context);
		let binding: Binding;
		try {
			binding = await this.#host.acquire(Type, params, caller, scoped.context, options);
		} catch (error) {
			throw this.#references === undefined ? settled(Type) : error;
		} finally {
			scoped.release();
		}
		// A get that finished in the turn its handler settled: nobody releases its reference later.
		if (this.#references === undefined) {
			binding.release();
			throw settled(Type);
		}
		this.#references.push(binding);
		// The binding was built from `Type`'s members.
		return binding.reference as Reference<C>;
	}

	/** The handler settled: its references are released, waiting gets give up, and `get` throws from now on. */
	settle(): void {
		const references = this.#references ?? [];
		this.#references = undefined;
		this.#settling?.abort();
		for (const binding of references) binding.release();
	}
}

function settled(Type: Contract): ChordError {
	return new ChordError({
		code: "released",
		reason: "settled",
		message: `${Type.name}: ctx.get after its call settled`,
	});
}

/**
 * A child of `context` aborted by `signal` and by the caller's signal (the caller's reason first) until `release()`,
 * which the call runs when it settles. Not `AbortSignal.any`: before Node 24.16.0 it keeps cleanup entries per call for
 * as long as its sources live (nodejs/node#62367), and a call's sources (its attempt, its reference) live long.
 * Without a caller's signal the child is aborted by `signal` itself and `release` does nothing.
 */
export function withLinkedAbortSignal(
	signal: AbortSignal,
	context: Context,
): { readonly context: Context; release(): void } {
	const caller = context.abortSignal;
	if (caller === undefined) return { context: withAbortSignal(signal, context), release: NOTHING };
	const linked = new AbortController();
	const listeners = [caller, signal].map((source) => {
		const forward = (): void => {
			release();
			linked.abort(source.reason);
		};
		return [source, forward] as const;
	});
	const release = (): void => {
		for (const [source, forward] of listeners) source.removeEventListener("abort", forward);
	};
	const aborted = listeners.find(([source]) => source.aborted);
	if (aborted !== undefined) linked.abort(aborted[0].reason);
	else for (const [source, forward] of listeners) source.addEventListener("abort", forward, { once: true });
	return { context: withAbortSignal(linked.signal, withoutAbortSignal(context)), release };
}

const NOTHING = (): void => {};
