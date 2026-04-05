import type { StreamFunction, StreamOptions } from "../types.js";
export type AnthropicEffort = "low" | "medium" | "high" | "max";
export interface AnthropicOptions extends StreamOptions {
    thinkingEnabled?: boolean;
    thinkingBudgetTokens?: number;
    effort?: AnthropicEffort;
    interleavedThinking?: boolean;
    toolChoice?: "auto" | "any" | "none" | {
        type: "tool";
        name: string;
    };
}
export declare const streamAnthropic: StreamFunction<"anthropic-messages">;
//# sourceMappingURL=anthropic.d.ts.map