import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";

describe("OpenRouter model metadata", () => {
	it("caps MiniMax M3 at the provider-enforced context and output limits", () => {
		const model = getModel("openrouter", "minimax/minimax-m3");

		expect(model).toBeDefined();
		expect(model.contextWindow).toBe(524288);
		expect(model.maxTokens).toBe(64000);
	});
});
