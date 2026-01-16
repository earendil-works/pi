import { describe, expect, it } from "vitest";

import { scheduleExplicitHandoff } from "../src/explicit-handoff.js";

describe("explicit handoff scheduler", () => {
	it("pauses queue drain before deferring execution", () => {
		const calls: string[] = [];

		scheduleExplicitHandoff({
			pauseQueueDrain: () => {
				calls.push("pause");
			},
			execute: () => {
				calls.push("execute");
			},
			defer: (fn) => {
				calls.push("defer");
				fn();
			},
		});

		expect(calls).toEqual(["pause", "defer", "execute"]);
	});

	it("does not execute synchronously when deferral does not run", () => {
		let executed = false;

		scheduleExplicitHandoff({
			pauseQueueDrain: () => {},
			execute: () => {
				executed = true;
			},
			defer: () => {},
		});

		expect(executed).toBe(false);
	});
});
