// A board's motion on the page, as plain data and functions (the React hooks over them are `motion-hooks.tsx`): the
// caller's own pointer sent to the others (the newest only, at most one call in flight and one every `SEND_GAP_MS`,
// so a slow link never queues stale positions), and the others' pointers and drafts as their events arrive, each gone
// once it leaves or stays still for `STILL_MS` (a closed tab sends no leave). Callers are told apart by their fields
// (`sameCaller`), never by a text made of them.

import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/p3/v1";
import type { Caller } from "../things/contract.ts";
import { type Motion, type Mover, type Pointer, type Shape, sameCaller } from "./kind.ts";

/** What sends the caller's motion: a board's `point` and `leave`. */
export type MotionTarget = {
	point(pointer: Pointer, context: Context): Promise<null>;
	leave(context: Context): Promise<null>;
};

/** The caller's own motion, as it is sent: a pointer, or leaving. */
export type Outgoing = { readonly kind: "point"; readonly pointer: Pointer } | { readonly kind: "leave" };

/**
 * Another caller on the board: who they are, where their pointer is and what they are drawing; `key` is theirs on
 * this page while they stay (React's key), `at` when they moved last.
 */
export type Other = {
	readonly key: number;
	readonly who: Mover;
	readonly x: number;
	readonly y: number;
	readonly draft: Shape | null;
	readonly at: number;
};

/** The least time between two sends of the caller's pointer, in ms (about 25 a second). */
export const SEND_GAP_MS = 40;

/**
 * A sender of the caller's motion to `target()` (none: nothing is sent): each call replaces what waits, one send runs
 * at a time, and the next starts `SEND_GAP_MS` after the last ended. A failed send is no failure: the next replaces it.
 */
export function motionSender(target: () => MotionTarget | undefined): (next: Outgoing) => void {
	let latest: Outgoing | undefined;
	let busy = false;
	const flush = async () => {
		if (busy) return;
		busy = true;
		try {
			for (let next = latest; next !== undefined; next = latest) {
				latest = undefined;
				const to = target();
				if (to === undefined) break;
				await (next.kind === "point"
					? to.point(next.pointer, BACKGROUND_CONTEXT)
					: to.leave(BACKGROUND_CONTEXT)
				).catch(() => null);
				await new Promise((resolve) => setTimeout(resolve, SEND_GAP_MS));
			}
		} finally {
			busy = false;
		}
	};
	return (next) => {
		latest = next;
		void flush();
	};
}

/**
 * `others` after `motion` arrived at `now`: the mover's pointer moved (in their place, so their draft keeps its place
 * in the drawing order; a newcomer last, with the key `newKey()`) or gone; the caller `me`'s own motion changes nothing.
 */
export function othersAfter(
	others: readonly Other[],
	motion: Motion,
	me: Caller,
	now: number,
	newKey: () => number,
): readonly Other[] {
	if (sameCaller(motion.who, me)) return others;
	if (motion.kind === "leave") return others.filter((other) => !sameCaller(other.who, motion.who));
	const { who, x, y, draft } = motion;
	const known = others.find((other) => sameCaller(other.who, who));
	const moved = { key: known?.key ?? newKey(), who, x, y, draft, at: now };
	return known === undefined ? [...others, moved] : others.map((other) => (other === known ? moved : other));
}

/** How long a pointer that does not move stays on the board, in ms. */
export const STILL_MS = 15_000;

/** `others` without those that stood still for `STILL_MS` at `now` (the same list when none did). */
export function stillThere(others: readonly Other[], now: number): readonly Other[] {
	const kept = others.filter((other) => now - other.at < STILL_MS);
	return kept.length === others.length ? others : kept;
}
