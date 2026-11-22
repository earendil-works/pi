// A board's motion on the page: the caller's own pointer sent to the others (the newest only, at most one call in
// flight and about 25 a second, so a slow link never queues stale positions), and the others' pointers and drafts
// as their events arrive, each gone once it leaves or stays still for a while.

import { BACKGROUND_CONTEXT, type Context, type EventMember } from "@earendil-works/p3/v1";
import { useEvents } from "@earendil-works/p3/v1/web";
import { useEffect, useRef, useState } from "react";
import type { Motion, Pointer, Shape } from "./contract.ts";

/** What sends the caller's motion: a board's `point` and `leave`. */
export type MotionTarget = {
	point(pointer: Pointer, context: Context): Promise<null>;
	leave(context: Context): Promise<null>;
};

/** Another caller on the board: their name, where their pointer is and what they are drawing. */
export type Other = {
	readonly who: string;
	readonly name: string;
	readonly x: number;
	readonly y: number;
	readonly draft: Shape | null;
	readonly at: number;
};

/** The least time between two sends of the caller's pointer. */
const SEND_GAP_MS = 40;

/** Sends the caller's pointer to `target` (the newest only) and takes it off the board on `leave`. */
export function useMotionSender(target: MotionTarget | undefined): {
	readonly point: (pointer: Pointer) => void;
	readonly leave: () => void;
} {
	const latest = useRef<{ readonly kind: "point"; readonly pointer: Pointer } | { readonly kind: "leave" }>(undefined);
	const busy = useRef(false);
	const targetRef = useRef(target);
	targetRef.current = target;
	const flush = async () => {
		if (busy.current) return;
		busy.current = true;
		try {
			for (let next = latest.current; next !== undefined; next = latest.current) {
				latest.current = undefined;
				const to = targetRef.current;
				if (to === undefined) break;
				// A lost pointer is no failure: the next one replaces it.
				await (next.kind === "point"
					? to.point(next.pointer, BACKGROUND_CONTEXT)
					: to.leave(BACKGROUND_CONTEXT)
				).catch(() => null);
				await new Promise((resolve) => setTimeout(resolve, SEND_GAP_MS));
			}
		} finally {
			busy.current = false;
		}
	};
	useEffect(() => () => void targetRef.current?.leave(BACKGROUND_CONTEXT).catch(() => null), []);
	return {
		point: (pointer) => {
			latest.current = { kind: "point", pointer };
			void flush();
		},
		leave: () => {
			latest.current = { kind: "leave" };
			void flush();
		},
	};
}

/** How long a pointer that does not move stays on the board. */
const STILL_MS = 15_000;

/** The others on the board, following `motion` (the caller `me`'s own events left out; none while `me` is unknown). */
export function useOthers(motion: EventMember<Motion> | undefined, me: string | undefined): readonly Other[] {
	const [others, setOthers] = useState<ReadonlyMap<string, Other>>(new Map());
	useEvents(motion, ({ value }) => {
		if (me === undefined || value.who === me) return;
		setOthers((current) => {
			const next = new Map(current);
			if (value.kind === "leave") next.delete(value.who);
			else next.set(value.who, { ...value, at: Date.now() });
			return next;
		});
	});
	useEffect(() => {
		// A closed tab sends no leave: its pointer goes once it stood still long enough.
		const timer = setInterval(() => {
			setOthers((current) => {
				const now = Date.now();
				const kept = [...current].filter(([, other]) => now - other.at < STILL_MS);
				return kept.length === current.size ? current : new Map(kept);
			});
		}, STILL_MS / 3);
		return () => clearInterval(timer);
	}, []);
	return [...others.values()];
}
