// Root scopes (slice 8 §4, D3, design §8): `host.root(fn, context, options?)`, a call context for code outside objects
// (a Durable tool, a CLI), sealed when `fn` settles, when `context` aborts and when the host closes: its signal aborted,
// its `ctx.get` refused `released`, every reference it took released.

import { awaitWithContext, type Context, withAbortSignal, withoutAbortSignal } from "../../context/index.ts";
import { ChordError, type Principal } from "../data/index.ts";
import { CallContext, type Ctx } from "./ctx.ts";
import type { AnyHost } from "./host.ts";

/** What `host.root` takes besides `fn` and the context. */
export type RootOptions<P extends Principal = Principal> = {
	/**
	 * Whom the scope acts as: the host's principal when omitted; a trusted same-host caller's choice (base code), an
	 * explicit `undefined` anonymous (`ctx.principal` undefined).
	 */
	readonly principal?: P | undefined;
};

/** An open root scope: its seal, and how its caller is rejected when the host closes. */
type OpenScope = { readonly seal: (reason: unknown) => void; readonly reject: (reason: unknown) => void };

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
		const caller = context.abortSignal;
		caller?.throwIfAborted();
		const host = this.#host;
		// The scope's own signal, aborted by its seal; the caller's abort seals it (one listener, no linked signal: a
		// request's scope is made per HTTP request).
		const controller = new AbortController();
		const scope = withAbortSignal(controller.signal, caller === undefined ? context : withoutAbortSignal(context));
		const ctx = new CallContext(scope, { principal, incarnation: host.incarnation }, host);
		const result = Promise.withResolvers<T>();
		const open: OpenScope = {
			seal: (reason) => {
				if (!this.#open.delete(open)) return;
				caller?.removeEventListener("abort", aborted);
				// References first: a `get` still waiting gives up with `released`, not with the abort's reason.
				ctx.settle();
				controller.abort(reason);
			},
			reject: result.reject,
		};
		const aborted = (): void => open.seal(caller?.reason);
		this.#open.add(open);
		caller?.addEventListener("abort", aborted, { once: true });
		// Plugin code: a synchronous throw becomes the rejection.
		const running = (async () => fn(ctx))();
		running.then(
			(value) => {
				open.seal(SETTLED);
				result.resolve(value);
			},
			(error: unknown) => {
				open.seal(SETTLED);
				result.reject(error);
			},
		);
		// A method's caller gets `released` when its object ends, whatever the handler still does: so does this one
		// (`close` rejects `result`), and at once when its context aborts.
		return caller === undefined ? result.promise : awaitWithContext(result.promise, context);
	}

	/** The host closes: every open scope is sealed with `reason`, its caller rejected with it. */
	close(reason: unknown): void {
		for (const open of [...this.#open]) {
			open.seal(reason);
			open.reject(reason);
		}
	}
}

/** The abort reason of a scope whose `fn` settled. */
const SETTLED = new ChordError({ code: "released", reason: "settled", message: "host.root: its fn settled" });
