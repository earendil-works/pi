import type { Api, Context, Model } from "./types.js";
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
export declare function planPromptCachePolicy<TApi extends Api>(args: PlanPromptCachePolicyArgs<TApi>): PromptCachePolicyPlan;
//# sourceMappingURL=prompt-cache-policy.d.ts.map