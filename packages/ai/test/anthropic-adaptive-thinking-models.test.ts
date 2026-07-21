import { describe, expect, it } from "vitest";
import { getModels, getProviders } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";

const EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS = [
	"anthropic/claude-fable-5",
	"anthropic/claude-opus-4-8",
	"anthropic/claude-sonnet-5",
	"cloudflare-ai-gateway/claude-fable-5",
	"kimi-coding/k2p7",
	"kimi-coding/k3",
	"kimi-coding/kimi-for-coding-highspeed",
	"opencode/claude-opus-4-8",
	"vercel-ai-gateway/anthropic/claude-opus-4.8",
	"vercel-ai-gateway/anthropic/claude-sonnet-5",
];

function getAllModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => getModels(provider) as Model<Api>[]);
}

describe("Anthropic adaptive thinking model metadata", () => {
	it("marks built-in Anthropic Messages models that use adaptive thinking", () => {
		const flaggedModels = getAllModels()
			.filter((model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages")
			.filter((model) => model.compat?.forceAdaptiveThinking === true)
			.map((model) => `${model.provider}/${model.id}`)
			.sort();

		expect(flaggedModels).toEqual(expect.arrayContaining([...EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS].sort()));
		expect(flaggedModels).toEqual(
			flaggedModels.filter((modelId) =>
				/(opus[-.]4[-.][678]|sonnet[-.]4[-.]6|sonnet[-.]5|fable[-.]5|kimi-coding\/)/.test(modelId),
			),
		);
	});
});
