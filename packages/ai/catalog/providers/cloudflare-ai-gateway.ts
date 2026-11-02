import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
} from "../../src/api/cloudflare.ts";
import type { Model } from "../../src/types.ts";
import { type ChatModel, defineProvider, mergeCompat, modelsDevModels } from "../define.ts";
import { enableOpenAiGrammarTools, OPENAI_STANDARD_COSTS, withOpenAiLongContextPricing } from "../families/openai.ts";

/** models.dev lists gateway models as `<upstream>/<id>`; route each upstream to its passthrough. */
function routeGatewayModel(model: ChatModel): ChatModel | undefined {
	const slash = model.id.indexOf("/");
	if (slash === -1) return undefined;
	const upstream = model.id.slice(0, slash);
	const nativeId = model.id.slice(slash + 1);
	if (upstream === "openai") {
		// Cloudflare AI Gateway passes OpenAI usage through at OpenAI list prices.
		const standardCost = OPENAI_STANDARD_COSTS[nativeId];
		return {
			...model,
			id: nativeId,
			api: "openai-responses",
			baseUrl: CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
			...(standardCost ? { cost: withOpenAiLongContextPricing(standardCost) } : {}),
		};
	}
	if (upstream === "anthropic") {
		// The /anthropic passthrough forwards the model ID to Anthropic unchanged.
		// models.dev lists dotted versions (claude-opus-5.5), but Anthropic only
		// accepts dashed IDs (claude-opus-5-5).
		return {
			...model,
			id: nativeId.replaceAll(".", "-"),
			api: "anthropic-messages",
			baseUrl: CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
			// Gateway passthroughs forward session affinity headers to upstreams that
			// use them for cache/routing affinity.
			compat: { sendSessionAffinityHeaders: true },
		};
	}
	if (upstream === "workers-ai") {
		return { ...model, compat: { sendSessionAffinityHeaders: true } };
	}
	return undefined;
}

export default defineProvider({
	id: "cloudflare-ai-gateway",
	models: (ctx) => {
		const models = modelsDevModels(ctx, "cloudflare-ai-gateway", {
			api: "openai-completions",
			baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
			map: routeGatewayModel,
		});
		// The gateway proxies Workers AI through its OpenAI-compatible /compat endpoint,
		// but models.dev may omit or intermittently drop those `workers-ai/*` entries
		// from the AI Gateway catalog. Mirror the Workers AI catalog under the documented
		// prefix so the gateway keeps its OpenAI-compatible models stable.
		const ids = new Set(models.map((model) => model.id));
		const mirrored = modelsDevModels(ctx, "cloudflare-workers-ai", {
			api: "openai-completions",
			baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
			compat: { sendSessionAffinityHeaders: true },
			include: (source) => !ids.has(`workers-ai/${source.id}`),
			map: (model) => ({ ...model, id: `workers-ai/${model.id}` }),
		});
		return [...models, ...mirrored];
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
	finalize: (model) => {
		if (model.api === "openai-responses") {
			mergeCompat(model as Model<"openai-responses">, { supportsStrictMode: true });
		}
		enableOpenAiGrammarTools(model);
	},
});
