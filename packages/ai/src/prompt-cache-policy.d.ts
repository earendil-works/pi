import type { Api, Context, Model } from "./types.js";
export type PromptCacheLayerId = "system" | "tools" | "context" | "history";
export interface PromptCacheLayer {
	id: PromptCacheLayerId;
	stability: "stable" | "volatile";
	content: string;
	fingerprint: string;
}
export interface PromptCachePolicyPlan {
	context: Context;
	provider: {
		cacheKey?: string;
	};
	layers: PromptCacheLayer[];
	stablePrefixFingerprint: string;
}
export interface PlanPromptCachePolicyArgs<TApi extends Api> {
	model: Model<TApi>;
	context: Context;
	sessionId?: string;
}
export declare function planPromptCachePolicy<TApi extends Api>(
	args: PlanPromptCachePolicyArgs<TApi>,
): PromptCachePolicyPlan;
//# sourceMappingURL=prompt-cache-policy.d.ts.map
