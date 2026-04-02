import type { StreamFunction, StreamOptions } from "../types.js";
export interface OpenAICompletionsOptions extends StreamOptions {
    toolChoice?: "auto" | "none" | "required" | {
        type: "function";
        function: {
            name: string;
        };
    };
    reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}
export declare const streamOpenAICompletions: StreamFunction<"openai-completions">;
//# sourceMappingURL=openai-completions.d.ts.map