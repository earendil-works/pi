import { describe, expect, it, vi } from "vitest";

import { submitExplicitHandoff } from "../src/explicit-handoff.js";

describe("explicit handoff submission", () => {
	it("prefers input callback when available", async () => {
		const submitViaInput = vi.fn();
		const prompt = vi.fn(async () => {});

		const result = await submitExplicitHandoff({
			message: "handoff",
			submitViaInput,
			prompt,
		});

		expect(result).toBe("input");
		expect(submitViaInput).toHaveBeenCalledWith("handoff");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("falls back to prompt when no input callback", async () => {
		const prompt = vi.fn(async () => {});

		const result = await submitExplicitHandoff({
			message: "handoff",
			prompt,
		});

		expect(result).toBe("prompt");
		expect(prompt).toHaveBeenCalledWith("handoff");
	});
});
