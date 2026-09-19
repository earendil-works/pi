import { expect, expectTypeOf, it } from "vitest";
import { GITHUB_COPILOT_MODELS } from "../src/providers/github-copilot.models.ts";
import { XAI_MODELS } from "../src/providers/xai.models.ts";

it("derives model API, ID, and provider literals from grouped model data", () => {
	expectTypeOf(XAI_MODELS["grok-4.5"].api).toEqualTypeOf<"openai-responses">();
	expectTypeOf(XAI_MODELS["grok-4.5"].id).toEqualTypeOf<"grok-4.5">();
	expectTypeOf(XAI_MODELS["grok-4.5"].provider).toEqualTypeOf<"xai">();
	expectTypeOf(XAI_MODELS["grok-4.6"].api).toEqualTypeOf<"openai-responses">();
	expectTypeOf(XAI_MODELS["grok-4.6"].id).toEqualTypeOf<"grok-4.6">();
	expectTypeOf(XAI_MODELS["grok-4.3"].api).toEqualTypeOf<"openai-responses">();
});

it("routes GitHub Copilot Grok 4.5 through the Responses API", () => {
	expectTypeOf(GITHUB_COPILOT_MODELS["grok-4.5"].api).toEqualTypeOf<"openai-responses">();
	expect(GITHUB_COPILOT_MODELS["grok-4.5"].api).toBe("openai-responses");
});

// Regression test for https://github.com/earendil-works/pi/issues/9209
it("routes all GitHub Copilot GPT models through the Responses API", () => {
	const gptModels = Object.values(GITHUB_COPILOT_MODELS).filter((model) => model.id.startsWith("gpt-"));
	expect(gptModels.length).toBeGreaterThan(0);
	expect(gptModels.every((model) => model.api === "openai-responses")).toBe(true);
	expectTypeOf(GITHUB_COPILOT_MODELS["gpt-6-astra"].api).toEqualTypeOf<"openai-responses">();
});
