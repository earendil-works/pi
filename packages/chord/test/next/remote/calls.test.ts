import { describe, expect, it } from "vitest";
import { CallWindow, type QueuedCall } from "../../../src/next/remote/calls.ts";
import { expectCollected } from "../support.ts";

/** A call of `hold` that records its name in `sent` when it goes out. */
function callOf(name: string, sent: string[], hold = 0): QueuedCall {
	return { hold, send: () => void sent.push(name) };
}

describe("the call window", () => {
	it("sends nothing before the peer's hello, then up to its N; the rest waits", () => {
		const sent: string[] = [];
		const window = new CallWindow();
		for (const name of ["a", "b", "c"]) window.submit(callOf(name, sent));
		expect(sent).toEqual([]);
		window.opened(2);
		expect(sent).toEqual(["a", "b"]);
		window.freed();
		expect(sent).toEqual(["a", "b", "c"]);
	});

	it("sends waiting calls in order as slots free", () => {
		const sent: string[] = [];
		const window = new CallWindow();
		window.opened(1);
		for (const name of ["a", "b", "c", "d"]) window.submit(callOf(name, sent));
		for (let slot = 0; slot < 3; slot++) window.freed();
		expect(sent).toEqual(["a", "b", "c", "d"]);
	});

	it("never preempts: a call that waits does not overtake while every slot is taken", () => {
		const sent: string[] = [];
		const window = new CallWindow();
		window.opened(1);
		window.submit(callOf("long", sent));
		window.submit(callOf("short", sent));
		expect(sent).toEqual(["long"]);
	});

	it("takes out a cancelled waiting call, and every waiting call of a hold that rebinds", () => {
		const sent: string[] = [];
		const window = new CallWindow();
		window.opened(1);
		window.submit(callOf("first", sent));
		const cancelled = callOf("cancelled", sent);
		window.submit(cancelled);
		const rebinding = [callOf("hold 1 a", sent, 1), callOf("hold 1 b", sent, 1)];
		for (const call of rebinding) window.submit(call);
		window.submit(callOf("last", sent));
		window.remove(cancelled);
		// A second remove of the same call changes nothing.
		window.remove(cancelled);
		expect(window.removeHold(1)).toEqual(rebinding);
		window.freed();
		expect(sent).toEqual(["first", "last"]);
		expect(window.clear()).toEqual([]);
	});

	it("keeps no call that went out or was taken", async () => {
		const window = new CallWindow();
		window.opened(1);
		const refs = (() => {
			const sent = callOf("a", []);
			const next = callOf("b", []);
			const waiting = callOf("c", []);
			for (const call of [sent, next, waiting]) window.submit(call);
			window.freed();
			window.remove(waiting);
			return [new WeakRef(sent), new WeakRef(waiting)];
		})();
		await expectCollected(...refs);
		expect(window).toBeDefined();
	});
});
