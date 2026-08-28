import { describe, expect, it } from "vitest";
import type { Model } from "../src/models.ts";
import { __test__ } from "../src/api/openai-completions.ts";

const { MAX_TOKENS_CAPS, applyMaxTokensCap } = __test__;

function fakeModel(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		provider,
		api: "openai-completions",
		name: id,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 1_000_000,
	} as unknown as Model<"openai-completions">;
}

describe("openai-completions applyMaxTokensCap", () => {
	it("returns the request unchanged when no cap is registered for the model", () => {
		const model = fakeModel("openai", "gpt-4o-mini");
		expect(applyMaxTokensCap(8192, model)).toBe(8192);
	});

	it("clamps to the registered cap when the request exceeds it (M3 / GMICloud)", () => {
		const model = fakeModel("openrouter", "minimax-m3:free");
		// The exact failure mode observed 2026-08-28: caller asked for
		// > 524288 output tokens, GMICloud returned 400 code 2013.
		expect(applyMaxTokensCap(1_000_000, model)).toBe(524288);
		expect(applyMaxTokensCap(600_000, model)).toBe(524288);
	});

	it("honours the user when their request is below the cap", () => {
		const model = fakeModel("openrouter", "minimax-m3:free");
		expect(applyMaxTokensCap(4096, model)).toBe(4096);
	});

	it("handles the alt-slug form for the same model on OpenRouter", () => {
		const model = fakeModel("openrouter", "minimax/minimax-m3:free");
		expect(applyMaxTokensCap(800_000, model)).toBe(524288);
	});

	it("does not cross-pollute between providers", () => {
		const orModel = fakeModel("openrouter", "minimax-m3:free");
		const nvidiaModel = fakeModel("nvidia", "minimaxai/minimax-m3");
		// OpenRouter is capped at 524288, nvidia at 16384.
		expect(applyMaxTokensCap(1_000_000, orModel)).toBe(524288);
		expect(applyMaxTokensCap(1_000_000, nvidiaModel)).toBe(16384);
	});

	it("the cap table is a frozen record (no runtime mutation)", () => {
		expect(Object.isFrozen(MAX_TOKENS_CAPS)).toBe(true);
	});
});
