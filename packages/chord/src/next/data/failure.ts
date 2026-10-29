// Failure causes: transient (the object's own effect failed: retry later), broken (its own code, a cycle or authority:
// retry by hand) or waiting (not its fault: no provider, no fitting version, a dependency that failed; woken by an
// event). The failing stage decides, never the error code.

import { asChordError, ChordError } from "./errors.ts";

/** Why an object, or a request, is failed; the kind comes from the failing stage, never from the error code. */
export type FailureCause =
	| { readonly kind: "transient"; readonly error: ChordError }
	| { readonly kind: "broken"; readonly error: ChordError }
	| { readonly kind: "waiting"; readonly error: ChordError };

/** Marks an open's failure as broken (bad configuration): `throw broken(error)`. */
export function broken(cause: unknown): Error {
	return new BrokenOpen(cause);
}

/** The cause of a value thrown by an open: broken when it came from `broken()`, transient otherwise. */
export function openFailure(thrown: unknown, label: string): FailureCause {
	if (thrown instanceof BrokenOpen) return { kind: "broken", error: asChordError(thrown.cause, label) };
	return { kind: "transient", error: asChordError(thrown, label) };
}

/** The longest message a `waiting` cause of a dependent carries (telemetry's rule for error messages). */
const MESSAGE_LIMIT = 500;

/** How a dependent's message names its blocker: the nearest one first. */
const PREFIX = "waiting for ";

/** The separator after a blocker's label. */
const SEPARATOR = ": ";

/** The marker of a clipped label or root. */
const CLIPPED = "…";

/** The most of the 500 characters the root cause takes when both are long: the nearest blocker keeps the rest. */
const ROOT_LIMIT = 320;

/**
 * The `waiting` cause of a dependent parked on `blocker`, which failed with `error`: `unavailable`, its message always
 * "waiting for <blocker>: <root cause>" (the root found through any "waiting for …: " of `error`'s message), so a ring
 * of waiting attempts passing causes round reaches the same message after one round; within 500 characters, the
 * label clipped first, the root only past its share. `error` is its cause.
 */
export function waitingFor(blocker: string, error: ChordError): FailureCause {
	let root = rootMessage(error.message);
	let label = blocker;
	const room = MESSAGE_LIMIT - PREFIX.length - SEPARATOR.length;
	if (label.length + root.length > room) {
		const rootRoom = Math.max(ROOT_LIMIT, room - label.length);
		if (root.length > rootRoom) root = clipped(root, rootRoom);
		if (label.length + root.length > room) label = clipped(label, room - root.length);
	}
	const message = `${PREFIX}${label}${SEPARATOR}${root}`;
	return { kind: "waiting", error: new ChordError({ code: "unavailable", message }, { cause: error }) };
}

/** `text` within `length` characters, clipped with "…" when longer. */
function clipped(text: string, length: number): string {
	return text.length <= length ? text : `${text.slice(0, length - CLIPPED.length)}${CLIPPED}`;
}

/** The root cause in a "waiting for X: root" message: past every leading "waiting for …: ". */
function rootMessage(message: string): string {
	let rest = message;
	while (rest.startsWith(PREFIX)) {
		const end = rest.indexOf(SEPARATOR, PREFIX.length);
		if (end < 0) break;
		rest = rest.slice(end + SEPARATOR.length);
	}
	return rest;
}

/** Whether two failure causes say the same (a wake compares causes by value): kind, code, reason and message. */
export function sameCause(a: FailureCause, b: FailureCause): boolean {
	const { error: left } = a;
	const { error: right } = b;
	return (
		a.kind === b.kind && left.code === right.code && left.reason === right.reason && left.message === right.message
	);
}

class BrokenOpen extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "BrokenOpen";
	}
}
