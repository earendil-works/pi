import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";

describe("OpenAI model metadata", () => {
	it("uses current GPT-5.4 and GPT-5.5 API context windows", () => {
		expect(getModel("openai", "gpt-5.4").contextWindow).toBe(1050000);
		expect(getModel("openai", "gpt-5.5").contextWindow).toBe(1050000);
	});

	it("uses current OpenAI Codex context windows", () => {
		expect(getModel("openai-codex", "gpt-5.4").contextWindow).toBe(1000000);
		expect(getModel("openai-codex", "gpt-5.4-mini").contextWindow).toBe(400000);
		expect(getModel("openai-codex", "gpt-5.5").contextWindow).toBe(400000);
	});
});
