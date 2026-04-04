import type { Api, Context, Model, Tool } from "./types.js";

export interface PromptCachePolicyPlan {
	context: Context;
	provider: {
		cacheKey?: string;
	};
}

export interface PlanPromptCachePolicyArgs<TApi extends Api> {
	model: Model<TApi>;
	context: Context;
	sessionId?: string;
}

function sortToolsDeterministically(tools: Tool[] | undefined): Tool[] | undefined {
	if (!tools) return undefined;
	return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}

function getProviderCacheKey<TApi extends Api>(model: Model<TApi>, sessionId?: string): string | undefined {
	if (!sessionId) return undefined;
	if (model.api === "openai-codex-responses") return sessionId;
	return undefined;
}

export function planPromptCachePolicy<TApi extends Api>(args: PlanPromptCachePolicyArgs<TApi>): PromptCachePolicyPlan {
	return {
		context: {
			...args.context,
			tools: sortToolsDeterministically(args.context.tools),
		},
		provider: {
			cacheKey: getProviderCacheKey(args.model, args.sessionId),
		},
	};
}
