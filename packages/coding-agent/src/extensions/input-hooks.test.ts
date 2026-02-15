import { describe, expect, it } from "vitest";
import { ExtensionRunner } from "./runner.js";

describe("ExtensionRunner input hooks", () => {
	it("transforms are chained and handled short-circuits", async () => {
		const runner = new ExtensionRunner();

		runner.registerInput(
			(text) => {
				return { type: "transform", text: text.toUpperCase() };
			},
			{ sourceId: "a" },
		);

		runner.registerInput(
			(text) => {
				if (text === "STOP") {
					return { type: "handled" };
				}
			},
			{ sourceId: "b" },
		);

		const r1 = await runner.applyInput("hello");
		expect(r1).toEqual({ handled: false, text: "HELLO" });

		const r2 = await runner.applyInput("stop");
		expect(r2.handled).toBe(true);
		expect(r2.text).toBe("STOP");
	});
});
