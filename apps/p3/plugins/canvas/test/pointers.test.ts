// A board's motion on the page as data (`pointers.ts`): the sender sends the newest motion only, one call at a time and
// one per `SEND_GAP_MS` (mocked timers), sends nothing without a target and goes on after a failed send; the others
// on the board follow the events, told apart by their fields (an agent and a person of the same id are two), the
// caller's own left out, a mover keeping their place and key, a leave removing them; pointers that stood still for
// `STILL_MS` go, and a list where none did is the same list.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/p3/v1";
import type { Motion, Pointer, Shape } from "../kind.ts";
import {
	type MotionTarget,
	motionSender,
	type Other,
	othersAfter,
	SEND_GAP_MS,
	STILL_MS,
	stillThere,
} from "../pointers.ts";

/** A short stroke. */
const STROKE: Shape = { kind: "line", color: "#000000", width: 8, points: [0, 0, 1, 1] };

/** A target recording what it is sent; each call waits for `release` to answer (failing with `fails`). */
function recording(fails = false) {
	const sent: string[] = [];
	const answers: (() => void)[] = [];
	const answer = (what: string) =>
		new Promise<null>((resolve, reject) => {
			sent.push(what);
			answers.push(() => (fails ? reject(new Error("lost")) : resolve(null)));
		});
	const target: MotionTarget = {
		point: (pointer: Pointer, _context: Context) => answer(`point ${pointer.x}`),
		leave: (_context: Context) => answer("leave"),
	};
	return { target, sent, release: () => answers.shift()?.() };
}

/** Lets the sender's promises run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A pointer at `x`. */
const at = (x: number) => ({ kind: "point", pointer: { x, y: 0, draft: null } }) as const;

describe("the sender of the caller's motion", () => {
	it("sends the newest only, one call at a time, one per SEND_GAP_MS", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { target, sent, release } = recording();
		const send = motionSender(() => target);
		send(at(1));
		send(at(2));
		send(at(3));
		await settle();
		assert.deepEqual(sent, ["point 1"]);
		release();
		await settle();
		// The gap after the answer: nothing yet.
		assert.deepEqual(sent, ["point 1"]);
		t.mock.timers.tick(SEND_GAP_MS);
		await settle();
		assert.deepEqual(sent, ["point 1", "point 3"]);
		send({ kind: "leave" });
		release();
		await settle();
		t.mock.timers.tick(SEND_GAP_MS);
		await settle();
		assert.deepEqual(sent, ["point 1", "point 3", "leave"]);
	});

	it("sends nothing without a target, and goes on after a failed send", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		motionSender(() => undefined)(at(1));
		const { target, sent, release } = recording(true);
		const send = motionSender(() => target);
		send(at(1));
		await settle();
		release();
		await settle();
		t.mock.timers.tick(SEND_GAP_MS);
		send(at(2));
		await settle();
		assert.deepEqual(sent, ["point 1", "point 2"]);
	});
});

describe("the others on the board", () => {
	const me = { kind: "person", person: "me" } as const;
	const ann = { kind: "person", person: "a", name: "Ann" } as const;
	const agent = { kind: "agent", session: "a" } as const;
	const point = (who: Extract<Motion, { kind: "point" }>["who"], x: number): Motion => ({
		kind: "point",
		who,
		x,
		y: 0,
		draft: STROKE,
	});

	it("follow the events by their fields: the caller left out, a mover in place with their key, a leave gone", () => {
		let key = 0;
		const newKey = () => ++key;
		let others: readonly Other[] = [];
		others = othersAfter(others, point({ ...me, name: "Me" }, 1), me, 10, newKey);
		assert.deepEqual(others, []);
		others = othersAfter(others, point(ann, 1), me, 10, newKey);
		others = othersAfter(others, point(agent, 2), me, 11, newKey);
		others = othersAfter(others, point(ann, 5), me, 12, newKey);
		assert.deepEqual(
			others.map(({ key, who, x, at }) => [key, who.kind, x, at]),
			[
				[1, "person", 5, 12],
				[2, "agent", 2, 11],
			],
		);
		others = othersAfter(others, { kind: "leave", who: { kind: "person", person: "a" } }, me, 13, newKey);
		assert.deepEqual(
			others.map(({ who }) => who),
			[agent],
		);
	});

	it("drop pointers that stood still for STILL_MS; none dropped is the same list", () => {
		const others = othersAfter([], point(ann, 1), { kind: "server" }, 0, () => 1);
		assert.equal(stillThere(others, STILL_MS - 1), others);
		assert.deepEqual(stillThere(others, STILL_MS), []);
	});
});
