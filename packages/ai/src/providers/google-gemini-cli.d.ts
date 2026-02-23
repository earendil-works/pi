/**
 * Google Gemini CLI / Antigravity provider.
 * Shared implementation for both google-gemini-cli and google-antigravity providers.
 * Uses the Cloud Code Assist API endpoint to access Gemini and Claude models.
 */
import type { StreamFunction, StreamOptions } from "../types.js";
export interface GoogleGeminiCliOptions extends StreamOptions {
    toolChoice?: "auto" | "none" | "any";
    /**
     * Thinking/reasoning configuration.
     * Uses `budgetTokens` to set the thinking budget.
     * For Gemini 3 models, this controls thinking intensity.
     */
    thinking?: {
        enabled: boolean;
        /** Thinking budget in tokens. */
        budgetTokens?: number;
    };
    projectId?: string;
}
export declare const streamGoogleGeminiCli: StreamFunction<"google-gemini-cli">;
//# sourceMappingURL=google-gemini-cli.d.ts.map