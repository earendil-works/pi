import { defineProvider } from "../define.ts";
import { isKimiK3FamilyId, KIMI_K3_MAX_TOKENS } from "../families/kimi.ts";

export default defineProvider({
	id: "vercel-ai-gateway",
	models: (ctx) =>
		structuredClone(ctx.sources.aiGateway.chat).map((model) =>
			// Keep Kimi K3's canonical output limit when gateway metadata is missing or incorrect.
			model.id.startsWith("moonshotai/") && isKimiK3FamilyId(model.id.slice("moonshotai/".length))
				? { ...model, maxTokens: KIMI_K3_MAX_TOKENS }
				: model,
		),
	classifiers: (ctx) => structuredClone(ctx.sources.aiGateway.classifiers),
});
