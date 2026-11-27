// A board's motion on the page as React hooks over `pointers.ts`: the caller's own pointer sent to the others while the
// view is mounted (taken off the board when it goes), and the others on the board, following the board's `motion`
// events and dropping pointers that stood still.

import { BACKGROUND_CONTEXT, type EventMember } from "@earendil-works/p3/v1";
import { useEvents } from "@earendil-works/p3/v1/web";
import { useEffect, useRef, useState } from "react";
import type { Caller } from "../things/contract.ts";
import type { Motion, Pointer } from "./kind.ts";
import { type MotionTarget, motionSender, type Other, othersAfter, STILL_MS, stillThere } from "./pointers.ts";

/** Sends the caller's pointer to `target` (the newest only) and takes it off the board on `leave` and when unmounted. */
export function useMotionSender(target: MotionTarget | undefined): {
	readonly point: (pointer: Pointer) => void;
	readonly leave: () => void;
} {
	const targetRef = useRef(target);
	targetRef.current = target;
	const [send] = useState(() => motionSender(() => targetRef.current));
	// Unmounted: the pointer leaves the board; lost, it goes from the others' boards once it stood still.
	useEffect(() => () => void targetRef.current?.leave(BACKGROUND_CONTEXT).catch(() => null), []);
	return { point: (pointer) => send({ kind: "point", pointer }), leave: () => send({ kind: "leave" }) };
}

/** The others on the board, following `motion` (the caller `me`'s own events left out; none while `me` is unknown). */
export function useOthers(motion: EventMember<Motion> | undefined, me: Caller | undefined): readonly Other[] {
	const [others, setOthers] = useState<readonly Other[]>([]);
	const keys = useRef(0);
	useEvents(motion, ({ value }) => {
		if (me === undefined) return;
		setOthers((current) => othersAfter(current, value, me, Date.now(), () => ++keys.current));
	});
	useEffect(() => {
		const timer = setInterval(() => setOthers((current) => stillThere(current, Date.now())), STILL_MS / 3);
		return () => clearInterval(timer);
	}, []);
	return others;
}
