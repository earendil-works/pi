import type { StreamFunction, StreamOptions } from "../types.js";
export interface AnthropicOptions extends StreamOptions {
    thinkingEnabled?: boolean;
    thinkingBudgetTokens?: number;
    interleavedThinking?: boolean;
    toolChoice?: "auto" | "any" | "none" | {
        type: "tool";
        name: string;
    };
}
export declare const streamAnthropic: StreamFunction<"anthropic-messages">;
//# sourceMappingURL=anthropic.d.ts.map