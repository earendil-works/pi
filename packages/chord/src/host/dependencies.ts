// Parked attempts (dependency model §3, §7): the dependency check, what an attempt's declared dependencies (`self.get`
// references and `self.registry` values) say at one moment: all live, or what the parked attempt shows while one is not
// (`loading`, `failed { waiting }` naming the nearest blocker and the root cause, `failed { denied }` for a dependency
// an admission refused, or `broken` for a cycle, authority or an ended dependency), whether this host's first pass can
// count it (no blocker here still without its first outcome, decision (a)), and its first blocker; what a parked
// attempt does after one check (`Parking`); the loading of the keys a factory pinned; and the `parked_long` report of
// a long parking episode.

import type { Context } from "../context/index.ts";
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
 * What a check names its blocker to: a parking episode's `parked_long` clock (`ParkedLong`), or nothing (a route's
 * decision is no attempt: it reports no long wait).
 */
export type Blocked = { blockedBy(blocker: Blocker | undefined): void };

/**
 * What the dependencies say. `live`: every one is live (hydrated: a reference's members have values). `parked`: what
 * the attempt shows (`loading`, or `failed { waiting }` naming its first failed blocker), whether its first pass is
 * over (`firstPass`: no blocker, loading or failed, is an object here still without its first outcome), and its first
 * blocker in declaration order (`parked_long` names it; none when only denials block: a denial is no report). `broken`:
 * one failed for a cycle (`invalid/cycle`), for authority (`forbidden`) or ended: it never comes back by itself. A
 * dependency an admission denied is no such failure: the attempt shows `denied` with that error and goes on when the
 * dependency is admitted (slice 14 §2.2).
 */
export type Check =
	| { readonly kind: "live" }
	| {
			readonly kind: "parked";
			readonly shown: RefState;
			readonly firstPass: boolean;
			readonly blocker: Blocker | undefined;
			/** The first blocker in declaration order that is only loading (a reload's report names it). */
			readonly loadingOn: string | undefined;
	  }
	| { readonly kind: "broken"; readonly error: ChordError };

/**
 * What a parked attempt does after one check (of its dependencies, or of its admission): it goes on; it stays parked
 * showing `shown` (`firstPass` as in `Check`; `cause`: why it parked, for a reload's report, none when only a pinned
 * key failed to load); or it breaks.
 */
export type Parking =
	| { readonly kind: "ready" }
	| {
			readonly kind: "parked";
			readonly shown: RefState;
			readonly firstPass: boolean;
			readonly cause: FailureCause | undefined;
	  }
	| { readonly kind: "broken"; readonly error: ChordError };

const LIVE: Check = { kind: "live" };

/** Checks `dependencies` in declaration order (the first failed one is the one the attempt names). */
export function checkDependencies(dependencies: readonly Dependency[]): Check {
	let failed: Failed | undefined;
	let firstPass = true;
	let blocker: Blocker | undefined;
	let loadingOn: string | undefined;
	let parked = false;
	for (const dependency of dependencies) {
		if (dependency.kind === "registry") {
			const { value } = dependency;
			const start = value.start();
			if (start.kind === "value" || start.last !== undefined) continue;
			const label = `registry ${value.name}`;
			failed ??= waitingOn(label, asChordError(start.error, label));
			blocker ??= { label, state: "failed" };
			parked = true;
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
				parked = true;
				// Before `healsNever`: a denial's error is `forbidden`, and it heals when the dependency is admitted.
				if (state.cause.kind === "denied") {
					failed ??= { kind: "failed", cause: state.cause, retryAt: undefined };
					continue;
				}
				if (healsNever(error)) return { kind: "broken", error };
				failed ??= waitingOn(binding.label, error);
				blocker ??= { label: binding.label, state: "failed" };
				// Parked `waiting` on something here still in its first attempt: no first outcome yet (fix round 1).
				if (binding.target?.blocksFirstPass === true) firstPass = false;
				continue;
			}
			case "loading":
				parked = true;
				loadingOn ??= binding.label;
				blocker ??= { label: binding.label, state: "loading" };
				if (binding.target?.blocksFirstPass === true) firstPass = false;
		}
	}
	if (!parked) return LIVE;
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
 * Loads the keys a factory (or an admission) pinned on `references`' keyed members (`at(key)`), each reference named
 * to `long` as the blocker while they load (`failed` when they failed); `undefined` once all are, else what the parked
 * attempt shows for the first that failed to load (`waiting` on its reference). Awaited by its callers: without a key
 * to load it answers at once, and the await takes the one turn it took when this was an async function (whose frame
 * cost about 0.45 KiB per check); with one, the rest runs as it did, in one async function from that reference on.
 */
export function pinKeys(
	references: readonly { readonly binding: Binding }[],
	long: Blocked,
	context: Context,
): Failed | undefined | Promise<Failed | undefined> {
	for (let index = 0; index < references.length; index++) {
		const { binding } = references[index]!;
		const { label } = binding;
		try {
			const pinning = binding.pinKeys(context);
			if (pinning === undefined) continue;
			long.blockedBy({ label, state: "loading" });
			return pinsLoading(references, index, pinning, long, context);
		} catch (error) {
			long.blockedBy({ label, state: "failed" });
			return waitingOn(label, asChordError(error, label));
		}
	}
	return undefined;
}

/** `pinKeys` from the reference at `from` on, whose keys load (`pinning`, named to `long` already). */
async function pinsLoading(
	references: readonly { readonly binding: Binding }[],
	from: number,
	pinning: Promise<void>,
	long: Blocked,
	context: Context,
): Promise<Failed | undefined> {
	for (let index = from; index < references.length; index++) {
		const { binding } = references[index]!;
		const { label } = binding;
		try {
			const loading = index === from ? pinning : binding.pinKeys(context);
			if (loading === undefined) continue;
			if (index !== from) long.blockedBy({ label, state: "loading" });
			await loading;
		} catch (error) {
			long.blockedBy({ label, state: "failed" });
			return waitingOn(label, asChordError(error, label));
		}
	}
	return undefined;
}

/**
 * The `parked_long` report of one parking episode (dependency model §7, audit A11): once, when the attempt has been
 * parked longer than `readyTimeout`, whatever its blocker (a ring across hosts started at the same moment stays parked
 * so, and so does a long wait; nothing fails or retries). The clock and the report's `since` start when the episode
 * does (its pinned keys' loading included); the report names the blocker of the latest check. Its one timer runs until
 * the report or the episode's end (`stop`).
 */
export class ParkedLong implements Blocked {
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

	/** What the latest check found blocking; none when it is parked on a denial alone (no report for one). */
	blockedBy(blocker: Blocker | undefined): void {
		this.#blocker = blocker;
	}

	/** The episode ended: no report from now on. */
	stop(): void {
		clearTimeout(this.#timer);
	}
}
