import { defineProvider, modelsDevModels, withInputLimits } from "../define.ts";
import { getEffortThinkingLevelMap } from "../reasoning.ts";

// Opus 5 is only callable through cross-region inference profiles.
const INFERENCE_PROFILE_ONLY_MODEL_IDS = new Set(["anthropic.claude-opus-5"]);

// Families whose AWS model cards document a flat `reasoning_effort` in Converse's
// additionalModelRequestFields. Converse forwards that field without validating it, and
// other families take effort elsewhere or not at all, so only these get models.dev effort levels.
// Do not add Nova 2 (reasoningConfig.maxReasoningEffort) or Grok (no Converse effort field),
// although models.dev lists effort values for both.
const FLAT_REASONING_EFFORT_FAMILIES = ["moonshotai.kimi-k3", "zai.glm-5.3"];

// Kimi K3 and K3.1 fail on Converse with InternalServerException when reasoning from earlier
// turns is sent back; their AWS model cards say to drop it.
const NO_REASONING_REPLAY_FAMILIES = ["moonshotai.kimi-k3"];

function bedrockBaseUrl(modelId: string): string {
	return modelId.startsWith("eu.")
		? "https://bedrock-runtime.eu-central-1.amazonaws.com"
		: "https://bedrock-runtime.us-east-1.amazonaws.com";
}

export default defineProvider({
	id: "amazon-bedrock",
	models: (ctx) =>
		modelsDevModels(ctx, "amazon-bedrock", {
			api: "bedrock-converse-stream",
			baseUrl: "",
			include: (source) =>
				!INFERENCE_PROFILE_ONLY_MODEL_IDS.has(source.id) &&
				// Jamba does not support tool use in streaming mode.
				!source.id.startsWith("ai21.jamba") &&
				// Mistral 7B Instruct does not support system messages.
				!source.id.startsWith("mistral.mistral-7b-instruct-v0"),
			// Includes models.dev pricing tiers, e.g. the long-context tier for OpenAI models (#10326).
			map: (model, source) => {
				const thinkingLevelMap = FLAT_REASONING_EFFORT_FAMILIES.some((family) => source.id.includes(family))
					? getEffortThinkingLevelMap(source.reasoningOptions ?? [])
					: undefined;
				const compat = {
					...(source.structuredOutput ? { supportsStrictMode: true } : {}),
					...(NO_REASONING_REPLAY_FAMILIES.some((family) => source.id.includes(family))
						? { supportsReasoningReplay: false }
						: {}),
				};
				return {
					...model,
					baseUrl: bedrockBaseUrl(model.id),
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					compat,
				};
			},
		}),
	finalize: (model) => withInputLimits(model, { images: { maxPerMessage: 20 } }),
});
