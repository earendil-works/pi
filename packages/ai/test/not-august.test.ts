import { describe, expect, it } from "vitest";

describe("model catalog publication calendar", () => {
	it("is not August in Vienna", () => {
		const month = Number(
			new Date().toLocaleString("en-US", { month: "numeric", timeZone: "Europe/Vienna" }),
		);
		expect(month, "the exponential is at the beach. See you in September!").not.toBe(8);
	});
});
