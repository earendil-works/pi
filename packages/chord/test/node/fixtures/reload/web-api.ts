// The reload suite's web API (`@test/app/v1/web`): the `Views` registry the web plugins contribute their components to,
// Chord's React hooks, and the probe through which the tests see the page (every state a reference went through, every
// value of a tracked member) and call from it (each call's answer kept by number).

import type { ComponentType } from "react";
import { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
import { type Contract, isChordError, type RefState } from "../../../../src/index.ts";
import { defineRegistry } from "../../../../src/registries/index.ts";
import type { WatchCall } from "../../../../src/watch.ts";

export { useHold, useHost, usePageState, useRefState, useRegistry, useWatch } from "../../../../src/react/index.ts";

/** A web plugin's view: its name (the section's `data-view`) and its component. */
export type View = { readonly name: string; readonly component: ComponentType };

/** The views, in name order. */
export const Views = defineRegistry<View, readonly View[]>("reload.views", { version: 1 });

/** A call's answer as the tests read it. */
export type CallResult =
	| { readonly status: "pending" }
	| { readonly status: "ok"; readonly value: unknown }
	| { readonly status: "error"; readonly code: string; readonly reason: string | undefined; readonly message: string };

/** What the probe needs of a reference: its state, its members by name (state members and methods). */
type ProbedRef = {
	readonly state: {
		readonly value: RefState;
		watch(
			context: typeof BACKGROUND_CONTEXT,
		): Promise<{ start(listener: (call: { kind: string; value?: RefState }) => Promise<void>): void }>;
	};
	readonly release: () => void;
} & Record<string, unknown>;

/** A state member as the probe watches it. */
type ProbedMember = {
	watch(
		context: typeof BACKGROUND_CONTEXT,
	): Promise<{ start(listener: (call: WatchCall<unknown>) => Promise<void>): void }>;
};

/** A reference's state as one string: `live`, `loading`, `failed:<kind>:<reason or code>`, `ended:<code>`. */
function stateText(state: RefState): string {
	if (state.kind === "failed")
		return `failed:${state.cause.kind}:${state.cause.error.reason ?? state.cause.error.code}`;
	if (state.kind === "ended") return `ended:${state.error.code}`;
	return state.kind;
}

/** The page as the tests see it: tracked references, their states and member values, calls and their answers. */
class PageProbe {
	readonly refs: Record<string, ProbedRef> = {};
	/** Every state each tracked reference went through, in order; `remount` where a new reference took the name. */
	readonly states: Record<string, string[]> = {};
	/** Every value (or `failed:<reason>`) of each tracked reference's watched member. */
	readonly frames: Record<string, unknown[]> = {};
	readonly results: CallResult[] = [];
	/** The contracts web plugins registered, by name, for references the tests make themselves (`hold`). */
	readonly contracts: Record<string, Contract> = {};
	/** The page's own reference to the host, set by the base bundle. */
	host:
		| {
				hold(
					Type: Contract,
					params: unknown,
					context: typeof BACKGROUND_CONTEXT,
					options: { readyTimeout: number },
				): unknown;
		  }
		| undefined;

	/** Tracks `ref` under `name`: its states from now on and the values of its member `member`. */
	track(name: string, ref: unknown, member: string): void {
		// The references the web plugins hand in are Chord references; the probe reads them by member name.
		const probed = ref as ProbedRef;
		if (this.refs[name] === probed) return;
		const states = this.states[name] ?? [];
		const frames = this.frames[name] ?? [];
		this.states[name] = states;
		this.frames[name] = frames;
		if (this.refs[name] !== undefined) states.push("remount");
		this.refs[name] = probed;
		states.push(stateText(probed.state.value));
		void probed.state.watch(BACKGROUND_CONTEXT).then((watch) =>
			watch.start(async (call) => {
				if (this.refs[name] === probed && call.kind === "value") states.push(stateText(call.value!));
			}),
		);
		void (probed[member] as ProbedMember).watch(BACKGROUND_CONTEXT).then((watch) =>
			watch.start(async (call) => {
				if (this.refs[name] !== probed) return;
				frames.push(call.kind === "value" ? call.value : `failed:${failureText(call.error)}`);
			}),
		);
	}

	/** Holds the contract `contract` registered with `params` as the tracked reference `name`, parking calls `readyTimeout`. */
	hold(name: string, contract: string, params: unknown, readyTimeout: number, member: string): void {
		const ref = this.host!.hold(this.contracts[contract]!, params, BACKGROUND_CONTEXT, { readyTimeout });
		this.track(name, ref, member);
	}

	/** Calls `method` of the reference tracked as `name` with `args`; the number of its answer in `results`. */
	call(name: string, method: string, ...args: unknown[]): number {
		const index = this.results.length;
		this.results.push({ status: "pending" });
		const fn = this.refs[name]![method] as (...rest: unknown[]) => Promise<unknown>;
		fn(...args, BACKGROUND_CONTEXT).then(
			(value) => {
				this.results[index] = { status: "ok", value };
			},
			(error: unknown) => {
				this.results[index] = isChordError(error)
					? { status: "error", code: error.code, reason: error.reason, message: error.message }
					: { status: "error", code: "thrown", reason: undefined, message: String(error) };
			},
		);
		return index;
	}
}

/** A watch failure's error as text: a Chord error's reason or code, else its message. */
function failureText(error: unknown): string {
	return isChordError(error) ? (error.reason ?? error.code) : String(error);
}

/** The page's probe (one per page: this module is the page's instance of the web API). */
export const probe = new PageProbe();
