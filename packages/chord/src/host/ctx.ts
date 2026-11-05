// The `ctx` a method handler gets (§8): its call's context, who called, the calling host's incarnation, call-scoped
// references and child spans (`ctx.trace`, slice 9), its node of the call chain (old work during a reload); and the
// abort signal of a call's context, linked to long-lived sources until it settles.

import type { SpanAttributes, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { type Context, type ContextKey, withAbortSignal, withoutAbortSignal, withTelemetry } from "../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import { ChordError, type Principal } from "../data/index.ts";
import { ended, untraced } from "../telemetry.ts";
import type { AnyHost, GetOptions } from "./host.ts";
import { CALL_CHAIN, type CallNode, type OldWorkSource } from "./old-work.ts";
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
	/**
	 * Runs `fn` in a child span `name` of this ctx's span (`telemetry`) with its host's `chord.host` and `attributes`:
	 * `fn` gets a child ctx (the same principal, incarnation, signal and `get`, its references this ctx's), so calls
	 * inside are parented under it. A throw marks the span failed (`trace_failed`; a cancel keeps it ok) and is rethrown.
	 * Without an adapter that records, `fn` gets this ctx.
	 */
	trace<T>(name: string, attributes: SpanAttributes, fn: (ctx: Ctx<P>) => Promise<T>): Promise<T>;
}

/** Who makes a call: the principal it acts as and its host's incarnation. */
export type Caller = { readonly principal: Principal | undefined; readonly incarnation: string };

/**
 * The ctx of one handler run (or root scope): its references are released by `settle` when it settled. A method
 * call's ctx is its own node of the call chain (`on`: the attempt it runs on), so the chain costs no allocation.
 */
export class CallContext implements Ctx, CallNode {
	readonly principal: Principal | undefined;
	readonly incarnation: string;
	readonly #context: Context;
	readonly #host: AnyHost;
	/** The attempt a method call runs on; `undefined` for a root scope, a routine or a job run (no chain node). */
	readonly #on: OldWorkSource | undefined;
	/** The references taken with `get`; `undefined` once the handler settled. */
	#references: Binding[] | undefined = [];
	/** Aborted when the handler settles: a `get` still waiting gives up and releases its reference. By the first. */
	#settling: AbortController | undefined;

	constructor(context: Context, caller: Caller, host: AnyHost, on?: OldWorkSource) {
		this.#context = context;
		this.principal = caller.principal;
		this.incarnation = caller.incarnation;
		this.#host = host;
		this.#on = on;
	}

	get abortSignal(): AbortSignal | undefined {
		return this.#context.abortSignal;
	}

	get telemetry(): Context["telemetry"] {
		return this.#context.telemetry;
	}

	value<T>(key: ContextKey<T>): T | undefined {
		// A method call's ctx is its chain node; the key's type is `CallNode`, which this is.
		if (key.token === CALL_CHAIN.token && this.#on !== undefined) return this as unknown as T;
		return this.#context.value(key);
	}

	/** The attempt its handler runs on (only read through `CALL_CHAIN`, which a method call's ctx answers). */
	get on(): OldWorkSource {
		return this.#on!;
	}

	/** The chain of the call that made this one. */
	up(): CallNode | undefined {
		return this.#context.value(CALL_CHAIN);
	}

	toString(): string {
		return `${this.#context}.Ctx`;
	}

	/** Its host's `chord.host`, for its child spans. */
	get spanHost(): string {
		return this.#host.spanHost;
	}

	async get<C extends Contract>(Type: C, params: ParamsOf<C>, options: GetOptions = {}): Promise<Reference<C>> {
		// A settled scope refuses `released` whatever aborted it; an aborted call creates nothing.
		if (this.#references === undefined) throw settled(Type);
		this.#context.abortSignal?.throwIfAborted();
		// Made for the caller: its principal and its origin's incarnation travel with the reference's holds.
		const caller = { principal: this.principal, incarnation: this.incarnation };
		this.#settling ??= new AbortController();
		// Under this ctx itself: the getter belongs to the call's chain (old work during a reload).
		const scoped = withLinkedAbortSignal(this.#settling.signal, this);
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

	trace<T>(name: string, attributes: SpanAttributes, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
		return traceUnder(this, name, attributes, fn);
	}

	/** Its child under `span` (`ctx.trace`), every member kept. */
	traced(span: TelemetrySpan): Ctx {
		return new SpanCtx(this, span);
	}

	/** The handler settled: its references are released, waiting gets give up, and `get` throws from now on. */
	settle(): void {
		const references = this.#references ?? [];
		this.#references = undefined;
		this.#settling?.abort();
		for (const binding of references) binding.release();
	}
}

/**
 * A ctx that makes its child under a span (`ctx.trace`): the same kind of ctx (a job's has `jobId` and `state`), and
 * its host's `chord.host`.
 */
type Traceable = Ctx & { readonly spanHost: string; traced(span: TelemetrySpan): Ctx };

/**
 * `ctx.trace` of `ctx`: `fn` in a child span with its child ctx; with nothing recorded, `fn` with `ctx` itself. Either
 * way a synchronous throw of `fn` rejects (review L5: recording changes nothing `fn` sees but its span).
 */
function traceUnder<T>(
	ctx: Traceable,
	name: string,
	attributes: SpanAttributes,
	fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
	const parent = ctx.telemetry;
	// Plugin code: a synchronous throw becomes the rejection.
	if (untraced(parent)) return (async () => fn(ctx))();
	return parent.startSpan({ name, attributes: { "chord.host": ctx.spanHost, ...attributes } }, async (span) => {
		try {
			return await fn(ctx.traced(span));
		} catch (error) {
			ended(span, "trace_failed", error, ctx.abortSignal);
			throw error;
		}
	});
}

/** A ctx under a child span (`ctx.trace`): its parent's caller, signal and references, `telemetry` the span. */
export class SpanCtx implements Ctx {
	readonly #parent: Traceable;
	readonly #context: Context;

	constructor(parent: Traceable, span: TelemetrySpan) {
		this.#parent = parent;
		this.#context = withTelemetry(span, parent);
	}

	/** Its host's `chord.host`, for its child spans. */
	get spanHost(): string {
		return this.#parent.spanHost;
	}

	get principal(): Principal | undefined {
		return this.#parent.principal;
	}

	get incarnation(): string {
		return this.#parent.incarnation;
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
		return `${this.#parent}.Trace`;
	}

	get<C extends Contract>(Type: C, params: ParamsOf<C>, options?: GetOptions): Promise<Reference<C>> {
		return this.#parent.get(Type, params, options);
	}

	trace<T>(name: string, attributes: SpanAttributes, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
		return traceUnder(this, name, attributes, fn);
	}

	/** Its child under `span`, of its own kind. */
	traced(span: TelemetrySpan): Ctx {
		return new SpanCtx(this, span);
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
