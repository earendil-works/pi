import { defineProvider, modelsDevModels } from "../define.ts";
import { NVIDIA_BASE_URL, normalizeNvidiaModelId } from "../sources/index.ts";

// Listed by NIM but unusable through pi (no tool calls, broken streaming, or retired).
const UNSUPPORTED_MODEL_IDS = new Set([
	"abacusai/dracarys-llama-3.1-70b-instruct",
	"bytedance/seed-oss-36b-instruct",
	"deepseek-ai/deepseek-v4-flash",
	"deepseek-ai/deepseek-v4-pro",
	"google/gemma-2-2b-it",
	"google/gemma-3n-e2b-it",
	"google/gemma-3n-e4b-it",
	"google/gemma-4-31b-it",
	"meta/llama-3.2-1b-instruct",
	"meta/llama-4-maverick-17b-128e-instruct",
	"microsoft/phi-4-mini-instruct",
	"minimaxai/minimax-m2.7",
	"mistralai/mistral-nemotron",
	"nvidia/nemotron-mini-4b-instruct",
	"qwen/qwen3-next-80b-a3b-instruct",
	"qwen/qwen3.5-397b-a17b",
	"sarvamai/sarvam-m",
	"upstage/solar-10.7b-instruct",
]);

export default defineProvider({
	id: "nvidia",
	models: (ctx) => {
		const liveIds = ctx.sources.nvidiaModelIds;
		const liveId = (id: string) => liveIds.get(id) ?? liveIds.get(normalizeNvidiaModelId(id));
		return modelsDevModels(ctx, "nvidia", {
			api: "openai-completions",
			baseUrl: NVIDIA_BASE_URL,
			headers: { "NVCF-POLL-SECONDS": "3600" },
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
				supportsLongCacheRetention: false,
			},
			// Only models the live NIM API serves, under the id it uses.
			include: (source) => {
				if (!source.textInput || !source.textOutput) return false;
				const id = liveId(source.id);
				return id !== undefined && !UNSUPPORTED_MODEL_IDS.has(id);
			},
			map: (model) => {
				const id = liveId(model.id) ?? model.id;
				return { ...model, id, name: model.name === model.id ? id : model.name };
			},
		});
	},
	compat: {
		"openai-completions": {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
		},
	},
});
