// A restart's readiness (decision "Reload restarts every affected object; old work finishes on old code", rule 3):
// the requests its new factory made in staging, bound once every fate of the reload started (every served type is the
// new one then), and held until the successor's own requests bound. The old attempt is sealed only once they are
// ready, so old work that reaches the object meanwhile still finds its old attempt open.

import { type Context, withAbortSignal } from "../context/index.ts";
import type { FailureCause } from "../data/index.ts";
import { asChordError, checkParams, waitingFor } from "../data/internal.ts";
import type { Caller } from "./ctx.ts";
import type { AnyHost } from "./host.ts";
import type { Binding } from "./reference.ts";
import type { Request } from "./staging.ts";

/**
 * One restart's readiness: ready once each recorded type request is live (an open old instance that binds its version
 * counts) or failed for a reason other than another host's version skew (which heals by itself), or at its bound.
 * Registry requests are served by facets in the commit and kept by the old attempt's contributions until its seal: it
 * does not wait for them. Its failure follows the requests: `shows` gets each change of it.
 */
export class Readiness {
	readonly #host: AnyHost;
	readonly #caller: Caller;
	readonly #requests: readonly Request[];
	readonly #shows: (cause: FailureCause | undefined) => void;
	readonly #context: Context;
	readonly #bindings: Binding[] = [];
	readonly #started = Promise.withResolvers<void>();
	/** Ends the waits on its bindings at its release. */
	readonly #abort = new AbortController();
	/** A request refused for good at the start (an authority, a host address): it heals with no change of a binding. */
	#refused: FailureCause | undefined;
	/** The failed request's cause `shows` got last (`from`), as the successor waits for it (`waiting`). */
	#failed: { readonly from: FailureCause; readonly waiting: FailureCause } | undefined;

	constructor(
		host: AnyHost,
		caller: Caller,
		requests: readonly Request[],
		shows: (cause: FailureCause | undefined) => void,
		context: Context,
	) {
		this.#host = host;
		this.#caller = caller;
		this.#requests = requests;
		this.#shows = shows;
		this.#context = context;
	}

	/** What the successor waits for now: a request refused for good, or `waiting` for the first failed one. */
	get cause(): FailureCause | undefined {
		return this.#refused ?? this.#failed?.waiting;
	}

	/**
	 * Binds the recorded type requests as the object's own would be (once every fate of the reload started), kept out
	 * of presence lists (they are no consumers of their own), and follows them: `shows` gets each change of `cause`.
	 */
	start(): void {
		const following = withAbortSignal(this.#abort.signal, this.#context);
		for (const request of this.#requests) {
			if (request.kind !== "type") continue;
			const { contract, params } = request;
			const binding = this.#host.reference(contract, undefined, this.#caller, {});
			binding.unlist();
			this.#bindings.push(binding);
			try {
				this.#host.bind(binding, contract, checkParams(contract, params, this.#context), this.#context);
			} catch (error) {
				// Refused for good (an authority, a host address): the successor's factory meets the same refusal.
				this.#refused ??= { kind: "broken", error: asChordError(error, contract.name) };
				continue;
			}
			// Checked at every change of the binding until the release (never done): the failure shown follows it.
			binding
				.until(() => {
					this.#changed();
					return false;
				}, following)
				.catch(() => {});
		}
		this.#changed();
		this.#started.resolve();
	}

	/** Resolves once every request is ready, or at `due` (`Date.now()` time), whichever is first. */
	async ready(due: number): Promise<void> {
		const timer = Promise.withResolvers<void>();
		const timeout = setTimeout(timer.resolve, Math.max(0, due - Date.now()));
		try {
			await Promise.race([timer.promise, this.#allReady()]);
		} finally {
			clearTimeout(timeout);
		}
	}

	/** The successor's own requests bound: its bindings are let go (a dependency held only by them never ends). */
	release(): void {
		this.#abort.abort();
		for (const binding of this.#bindings.splice(0)) binding.release();
	}

	/** A binding changed: `shows` gets the failure if it is another one now. */
	#changed(): void {
		const before = this.cause;
		const failed = this.#firstFailed();
		if (failed?.cause !== this.#failed?.from) {
			this.#failed = failed && { from: failed.cause, waiting: waitingFor(failed.label, failed.cause.error) };
		}
		const cause = this.cause;
		if (cause !== before) this.#shows(cause);
	}

	/** The first request failed for a reason other than another host's version skew, with its cause. */
	#firstFailed(): { readonly label: string; readonly cause: FailureCause } | undefined {
		for (const binding of this.#bindings) {
			const state = binding.refState;
			if (state.kind === "failed" && !versionSkew(binding)) return { label: binding.label, cause: state.cause };
		}
		return undefined;
	}

	async #allReady(): Promise<void> {
		await this.#started.promise;
		const context = withAbortSignal(this.#abort.signal, this.#context);
		// A wait ends with the binding (released) or the abort: either way nothing waits any more.
		const waits = this.#bindings.map((binding) => binding.until(() => isReady(binding), context).catch(() => {}));
		await Promise.all(waits);
	}
}

/** Whether a request is ready: live, ended, or failed for a reason other than a version skew. */
function isReady(binding: Binding): boolean {
	const state = binding.refState;
	if (state.kind === "failed") return !versionSkew(binding);
	return state.kind !== "loading";
}

/**
 * Whether `binding` failed for another host's version refusal (its own, or a dependency's along the chain: `waiting`
 * causes keep the reason): that heals when the other host's reload lands, so the old attempt stays open meanwhile,
 * bounded as always. A refusal on this host heals by no other reload: it is no skew.
 */
function versionSkew(binding: Binding): boolean {
	const state = binding.refState;
	if (state.kind !== "failed" || binding.target?.kind !== "remote") return false;
	const { error } = state.cause;
	return error.code === "contract_mismatch" || (error.code === "unavailable" && error.reason === "version");
}
