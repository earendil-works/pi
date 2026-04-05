import type { StreamFunction, StreamOptions } from "../types.js";
export interface GoogleOptions extends StreamOptions {
    toolChoice?: "auto" | "none" | "any";
    thinking?: {
        enabled: boolean;
        budgetTokens?: number;
    };
}
export declare const streamGoogle: StreamFunction<"google-generative-ai">;
//# sourceMappingURL=google.d.ts.map