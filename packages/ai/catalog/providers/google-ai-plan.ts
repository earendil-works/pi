import type { Model, ThinkingLevelMap } from "../../src/types.ts";
import { defineProvider, withInputLimits } from "../define.ts";

// Google AI Ultra plan models, served by the Interactions API on the user's plan quota. The plan has no
// model list endpoint, so the partner docs require this fixed list. Usage is covered by the plan: no cost.
// Thinking levels per the partner docs: Neon and Hydrogen low..xhigh, Carbon low..high, Flash-Lite minimal..high.
const GEMINI_4_XHIGH: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: null,
};
const GEMINI_4: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};
const FLASH_LITE: ThinkingLevelMap = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

const MODELS: { id: string; name: string; thinkingLevelMap: ThinkingLevelMap }[] = [
	{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", thinkingLevelMap: GEMINI_4_XHIGH },
	{ id: "gemini-4-neon", name: "Gemini 4 Neon", thinkingLevelMap: GEMINI_4_XHIGH },
	{ id: "gemini-4-carbon", name: "Gemini 4 Carbon", thinkingLevelMap: GEMINI_4 },
	{ id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", thinkingLevelMap: FLASH_LITE },
];

export default defineProvider({
	id: "google-ai-plan",
	models: () =>
		MODELS.map(
			({ id, name, thinkingLevelMap }): Model<"google-interactions"> => ({
				id,
				name,
				api: "google-interactions",
				provider: "google-ai-plan",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				reasoning: true,
				thinkingLevelMap,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1048576,
				maxTokens: 65536,
			}),
		),
	// Interactions API docs: inline data under 100 MB per request (generateContent allows 20 MB), and Gemini models
	// accept at most 3,600 images per request.
	// https://ai.google.dev/gemini-api/docs/interactions/file-input-methods
	// https://ai.google.dev/gemini-api/docs/image-understanding
	finalize: (model) => withInputLimits(model, { maxRequestBytes: 100 * 1024 * 1024, images: { maxPerRequest: 3600 } }),
});
