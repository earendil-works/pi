// Parked attempts (dependency model §3, §7): the dependency check, what an attempt's declared dependencies (`self.get`
// references and `self.registry` values) say at one moment: all live, or what the parked attempt shows while one is not
// (`loading`, `failed { waiting }` naming the nearest blocker and the root cause, or `broken` for a cycle, authority or
// an ended dependency), whether this host's first pass can count it (no blocker here still without its first outcome,
// decision (a)), and its first blocker; and the `parked_long` report of a long parking episode.

import { ChordError, type FailureCause, isChordError } from "../data/index.ts";
import { asChordError, waitingFor } from "../data/internal.ts";
import type { RegistryValueSource } from "../registries/internal.ts";
import type { ChordObject } from "./object.ts";
import { type Failed, LOADING, type RefState } from "./ref-state.ts";
import type { Binding } from "./reference.ts";

/** One declared dependency: a reference (`self.get`) or a registry's value (`self.registry`). */
export type Dependency =
	| { readonly kind: "reference"; readonly binding: Binding }
	| { readonly kind: "registry"; readonly value: RegistryValueSource };

/** A blocker as `parked_long` names it: a reference's label or `registry <name>`, and whether it loads or failed. */
export type Blocker = { readonly label: string; readonly state: "loading" | "failed" };

/**
 * What the dependencies say. `live`: every one is live (hydrated: a reference's members have values). `parked`: what
 * the attempt shows (`loading`, or `failed { waiting }` naming its first failed blocker), whether its first pass is
 * over (`firstPass`: no blocker, loading or failed, is an object here still without its first outcome), and its first
 * blocker in declaration order (`parked_long` names it). `broken`: one failed for a cycle (`invalid/cycle`), for
 * authority (`forbidden`) or ended: it never comes back by itself.
 */
export type Check =
	| { readonly kind: "live" }
	| {
			readonly kind: "parked";
			readonly shown: RefState;
			readonly firstPass: boolean;
			readonly blocker: Blocker;
			/** The first blocker in declaration order that is only loading (a reload's report names it). */
			readonly loadingOn: string | undefined;
	  }
	| { readonly kind: "broken"; readonly error: ChordError };

const LIVE: Check = { kind: "live" };

/** Checks `dependencies` in declaration order (the first failed one is the one the attempt names). */
export function checkDependencies(dependencies: readonly Dependency[]): Check {
	let failed: Failed | undefined;
	let firstPass = true;
	let blocker: Blocker | undefined;
	let loadingOn: string | undefined;
	for (const dependency of dependencies) {
		if (dependency.kind === "registry") {
			const { value } = dependency;
			const start = value.start();
			if (start.kind === "value" || start.last !== undefined) continue;
			const label = `registry ${value.name}`;
			failed ??= waitingOn(label, asChordError(start.error, label));
			blocker ??= { label, state: "failed" };
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
				blocker ??= { label: binding.label, state: "failed" };
				// Parked `waiting` on something here still in its first attempt: no first outcome yet (fix round 1).
				if (binding.target?.blocksFirstPass === true) firstPass = false;
				continue;
			}
			case "loading":
				loadingOn ??= binding.label;
				blocker ??= { label: binding.label, state: "loading" };
				if (binding.target?.blocksFirstPass === true) firstPass = false;
		}
	}
	if (blocker === undefined) return LIVE;
	return { kind: "parked", shown: failed ?? LOADING, firstPass, blocker, loadingOn };
}

/**
 * Whether a dependency failed with `error` never heals by itself, so its dependent breaks too: a cycle
 * (`invalid/cycle`: it would wait on a ring) or authority (`forbidden`: an `authorize` that refused, M§3.6; only
 * `retry()` or a reload helps).
 */
function healsNever(error: ChordError): boolean {
	return (isChordError(error, "invalid") && error.reason === "cycle") || isChordError(error, "forbidden");
}

/**
 * What a reload reports for a parked attempt (slice 7b §4): its failure's cause, or for a blocker that is only
 * loading a `waiting` cause naming it.
 */
export function parkedCause(check: Extract<Check, { readonly kind: "parked" }>): FailureCause {
	const { shown } = check;
	if (shown.kind === "failed") return shown.cause;
	const label = check.loadingOn ?? "a dependency";
	return waitingFor(label, new ChordError({ code: "unavailable", message: `${label} is loading` }));
}

/** A parked attempt's state for a blocker `label` that failed with `error`. */
export function waitingOn(label: string, error: ChordError): Failed {
	return { kind: "failed", cause: waitingFor(label, error), retryAt: undefined };
}

/**
 * The `parked_long` report of one parking episode (dependency model §7, audit A11): once, when the attempt has been
 * parked longer than `readyTimeout`, whatever its blocker (a ring across hosts started at the same moment stays parked
 * so, and so does a long wait; nothing fails or retries). The clock and the report's `since` start when the episode
 * does (its pinned keys' loading included); the report names the blocker of the latest check. Its one timer runs until
 * the report or the episode's end (`stop`).
 */
export class ParkedLong {
	readonly #since = Date.now();
	readonly #timer: ReturnType<typeof setTimeout>;
	/** The blocker the latest check found. */
	#blocker: Blocker | undefined;

	constructor(object: ChordObject) {
		this.#timer = setTimeout(() => {
			const blocker = this.#blocker;
			if (blocker === undefined) return;
			const { label, state } = blocker;
			object.host.report({
				kind: "parked_long",
				object: object.label,
				waitingFor: label,
				state,
				since: this.#since,
			});
		}, object.host.timeouts.ready);
	}

	/** What the latest check found blocking. */
	blockedBy(blocker: Blocker): void {
		this.#blocker = blocker;
	}

	/** The episode ended: no report from now on. */
	stop(): void {
		clearTimeout(this.#timer);
	}
}
