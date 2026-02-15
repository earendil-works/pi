import { describe, expect, it } from "vitest";
import { fixThinkingSpill } from "./thinking-spill.js";

describe("fixThinkingSpill", () => {
	it("strips a duplicated thinking prefix from the response text", () => {
		const result = fixThinkingSpill("THINKING", "THINKING\n\nANSWER");
		expect(result.thinking).toBe("THINKING");
		expect(result.text).toBe("ANSWER");
	});

	it("strips a duplicated thinking suffix from the response text", () => {
		const result = fixThinkingSpill("THINKING", "ANSWER\n\nTHINKING");
		expect(result.thinking).toBe("THINKING");
		expect(result.text).toBe("ANSWER");
	});

	it("drops thinking on exact duplicates when configured", () => {
		const result = fixThinkingSpill("DUP", "DUP", { exactDuplicateStrategy: "dropThinking" });
		expect(result.thinking).toBe("");
		expect(result.text).toBe("DUP");
	});

	it("drops text on exact duplicates when configured", () => {
		const result = fixThinkingSpill("DUP", "DUP", { exactDuplicateStrategy: "dropText" });
		expect(result.thinking).toBe("DUP");
		expect(result.text).toBe("");
	});
});
