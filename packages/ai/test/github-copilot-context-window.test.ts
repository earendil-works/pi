import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";

describe("github-copilot extended context window", () => {
	it("gives Claude Sonnet 5 a smaller default and a 1M extended context window", () => {
		const model = getModel("github-copilot", "claude-sonnet-5");

		expect(model.contextWindow).toBe(200000);
		expect(model.extendedContextWindow).toBe(1000000);
	});

	it("derives GPT-5.4's default context window from its pricing tier threshold", () => {
		const model = getModel("github-copilot", "gpt-5.4");

		expect(model.cost.tiers?.[0]?.inputTokensAbove).toBe(model.contextWindow);
		expect(model.extendedContextWindow).toBeGreaterThan(model.contextWindow);
	});

	it("derives GPT-5.6 Sol's default context window from its pricing tier threshold", () => {
		const model = getModel("github-copilot", "gpt-5.6-sol");

		expect(model.contextWindow).toBe(272000);
		expect(model.extendedContextWindow).toBe(1050000);
	});

	it("leaves models without extended capability unset", () => {
		const model = getModel("github-copilot", "claude-haiku-4.5");

		expect(model.extendedContextWindow).toBeUndefined();
	});
});
