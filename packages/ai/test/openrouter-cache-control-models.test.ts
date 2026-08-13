import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";

const OPENROUTER_ANTHROPIC_LATEST_MODEL_IDS = [
	"~anthropic/claude-fable-latest",
	"~anthropic/claude-haiku-latest",
	"~anthropic/claude-opus-latest",
	"~anthropic/claude-sonnet-latest",
] as const;

describe("OpenRouter Anthropic cache control metadata", () => {
	it.each(OPENROUTER_ANTHROPIC_LATEST_MODEL_IDS)("enables cache control for %s", (modelId) => {
		expect(getModel("openrouter", modelId).compat?.cacheControlFormat).toBe("anthropic");
	});
});
