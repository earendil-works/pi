// Root scopes (slice 8 §4, D3, design §8): `host.root(fn, context, options?)`, a call context for code outside objects
// (a Durable tool, a CLI), sealed when `fn` settles, when `context` aborts and when the host closes: its signal aborted,
// its `ctx.get` refused `released`, every reference it took released.

import { awaitWithContext, type Context } from "../../context/index.ts";
import { ChordError, type Principal } from "../data/index.ts";
import { CallContext, type Ctx, withLinkedAbortSignal } from "./ctx.ts";
import type { AnyHost } from "./host.ts";

/** What `host.root` takes besides `fn` and the context. */
export type RootOptions<P extends Principal = Principal> = {
	/** Whom the scope acts as: the host's principal by default; a trusted same-host caller's choice (base code). */
	readonly principal?: P;
};

/** An open root scope: its seal, and the rejection its caller gets when the host closes. */
type OpenScope = { readonly seal: (reason: unknown) => void; readonly closed: PromiseWithResolvers<never> };

/** The open root scopes of a host, each sealed once; `close` seals the rest and rejects their callers. */
export class RootScopes {
	readonly #host: AnyHost;
	/** Each open scope: how it is sealed with a reason, and its caller's rejection when the host closes. */
	readonly #open = new Set<OpenScope>();

	constructor(host: AnyHost) {
		this.#host = host;
	}

	/**
	 * Runs `fn` with a call context like a handler's (`principal`, this host's incarnation, `context`'s telemetry, a
	 * signal linked to `context`'s), sealed when `fn` settles, `context` aborts or the host closes. Resolves as `fn`
	 * does; rejects at once when `context` aborts or the host closes (an uncooperative `fn` runs on and fails at its
	 * next use of Chord), or when `context` was aborted already (`fn` does not run).
	 */
	run<T>(fn: (ctx: Ctx) => Promise<T>, principal: Principal | undefined, context: Context): Promise<T> {
		context.abortSignal?.throwIfAborted();
		const host = this.#host;
		const controller = new AbortController();
		const linked = withLinkedAbortSignal(controller.signal, context);
		const scope = linked.context;
		const ctx = new CallContext(scope, { principal, incarnation: host.incarnation }, host);
		const open: OpenScope = {
			seal: (reason) => {
				if (!this.#open.delete(open)) return;
				scope.abortSignal?.removeEventListener("abort", aborted);
				// References first: a `get` still waiting gives up with `released`, not with the abort's reason.
				ctx.settle();
				// While still linked, so the scope's own signal (a caller's context has one) aborts too.
				controller.abort(reason);
				linked.release();
			},
			closed: Promise.withResolvers<never>(),
		};
		const aborted = (): void => open.seal(scope.abortSignal?.reason);
		this.#open.add(open);
		scope.abortSignal?.addEventListener("abort", aborted, { once: true });
		// Plugin code: a synchronous throw becomes the rejection.
		const running = (async () => fn(ctx))();
		const settled = (): void => open.seal(SETTLED);
		running.then(settled, settled);
		// A method's caller gets `released` when its object ends, whatever the handler still does: so does this one. One
		// wait on the caller's signal around both, so the close removes its listener too.
		return awaitWithContext(Promise.race([running, open.closed.promise]), context);
	}

	/** The host closes: every open scope is sealed with `reason`, its caller rejected with it. */
	close(reason: unknown): void {
		for (const open of [...this.#open]) {
			open.seal(reason);
			open.closed.reject(reason);
		}
	}
}

/** The abort reason of a scope whose `fn` settled. */
const SETTLED = new ChordError({ code: "released", reason: "settled", message: "host.root: its fn settled" });
