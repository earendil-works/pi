// Parked attempts (dependency model §3, §7): the dependency check, what an attempt's declared dependencies (`self.get`
// references and `self.registry` values) say at one moment: all live, or what the parked attempt shows while one is not
// (`loading`, `failed { waiting }` naming the nearest blocker and the root cause, or `broken` for a cycle, authority or
// an ended dependency), whether this host's first pass can count it (no blocker here still without its first outcome, decision
// (a)), and the remote blocker that is only loading; and the `parked_long` report a long wait on that blocker makes.

import { type ChordError, isChordError } from "../data/index.ts";
import { asChordError, waitingFor } from "../data/internal.ts";
import type { RegistryValueSource } from "../registries/internal.ts";
import type { ChordObject } from "./object.ts";
import { type Failed, LOADING, type RefState } from "./ref-state.ts";
import type { Binding } from "./reference.ts";

/** One declared dependency: a reference (`self.get`) or a registry's value (`self.registry`). */
export type Dependency =
	| { readonly kind: "reference"; readonly binding: Binding }
	| { readonly kind: "registry"; readonly value: RegistryValueSource };

/**
 * What the dependencies say. `live`: every one is live (hydrated: a reference's members have values). `parked`: what
 * the attempt shows (`loading`, or `failed { waiting }` naming its first failed blocker), whether its first pass is
 * over (`firstPass`: no blocker, loading or failed, is an object here still without its first outcome), and a remote
 * blocker whose hold is on a link and only loading (its label), for `parked_long`. `broken`: one failed for a cycle
 * (`invalid/cycle`), for authority (`forbidden`) or ended: it never comes back by itself.
 */
export type Check =
	| { readonly kind: "live" }
	| {
			readonly kind: "parked";
			readonly shown: RefState;
			readonly firstPass: boolean;
			readonly remoteLoading: string | undefined;
	  }
	| { readonly kind: "broken"; readonly error: ChordError };

const LIVE: Check = { kind: "live" };

/** Checks `dependencies` in declaration order (the first failed one is the one the attempt names). */
export function checkDependencies(dependencies: readonly Dependency[]): Check {
	let failed: Failed | undefined;
	let firstPass = true;
	let remoteLoading: string | undefined;
	let loading = false;
	for (const dependency of dependencies) {
		if (dependency.kind === "registry") {
			const { value } = dependency;
			const start = value.start();
			if (start.kind === "value" || start.last !== undefined) continue;
			failed ??= waitingOn(`registry ${value.name}`, asChordError(start.error, `registry ${value.name}`));
			continue;
		}
		const { binding } = dependency;
		const state = binding.refState;
		switch (state.kind) {
			case "live":
				continue;
			case "ended":
				return { kind: "broken", error: state.error };
			case "failed": {
				const { error } = state.cause;
				if (healsNever(error)) return { kind: "broken", error };
				failed ??= waitingOn(binding.label, error);
				// Parked `waiting` on something here still in its first attempt: no first outcome yet (fix round 1).
				if (binding.target?.blocksFirstPass === true) firstPass = false;
				continue;
			}
			case "loading": {
				loading = true;
				const target = binding.target;
				if (target?.blocksFirstPass === true) firstPass = false;
				if (target?.heldOnLink === true) remoteLoading ??= target.label;
			}
		}
	}
	if (failed === undefined && !loading) return LIVE;
	return { kind: "parked", shown: failed ?? LOADING, firstPass, remoteLoading };
}

/**
 * Whether a dependency failed with `error` never heals by itself, so its dependent breaks too: a cycle
 * (`invalid/cycle`: it would wait on a ring) or authority (`forbidden`: an `authorize` that refused, M§3.6; only
 * `retry()` or a reload helps).
 */
function healsNever(error: ChordError): boolean {
	return (isChordError(error, "invalid") && error.reason === "cycle") || isChordError(error, "forbidden");
}

/** A parked attempt's state for a blocker `label` that failed with `error`. */
export function waitingOn(label: string, error: ChordError): Failed {
	return { kind: "failed", cause: waitingFor(label, error), retryAt: undefined };
}

/**
 * The `parked_long` report of one parking episode (dependency model §7): once, when the attempt has waited
 * `readyTimeout` on a remote blocker that is only loading with its hold on a link (a ring across hosts started at the
 * same moment stays parked so; nothing fails or retries). The clock, and the report's `since`, start when such a
 * blocker is there and stop when none is (a link that drops, a path still without one): only the time a remote
 * attempt answered for the wait counts. Its one timer runs only meanwhile.
 */
export class ParkedLong {
	readonly #object: ChordObject;
	/** When the attempt began to wait on a remote blocker that is only loading on a link, while it does. */
	#since: number | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** The remote blocker it would name now. */
	#blocker: string | undefined;
	#reported = false;

	constructor(object: ChordObject) {
		this.#object = object;
	}

	/** What the check found: `blocker`, a remote attempt that is only loading on a link, or none. */
	waitingOn(blocker: string | undefined): void {
		this.#blocker = blocker;
		if (blocker === undefined) {
			this.stop();
			return;
		}
		if (this.#reported || this.#timer !== undefined) return;
		this.#since ??= Date.now();
		const due = this.#since + this.#object.host.timeouts.ready - Date.now();
		this.#timer = setTimeout(() => this.#report(), Math.max(0, due));
	}

	/** The episode ended, or no remote blocker is loading on a link now: the clock and its timer stop. */
	stop(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#since = undefined;
	}

	#report(): void {
		this.#timer = undefined;
		const waitingFor = this.#blocker;
		const since = this.#since;
		if (this.#reported || waitingFor === undefined || since === undefined) return;
		this.#reported = true;
		const object = this.#object;
		object.host.report({ kind: "parked_long", object: object.label, waitingFor, since });
	}
}
