import OpenAI from "openai";
import type { Context, Model, StreamFunction, StreamOptions } from "../types.js";
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
export declare function projectOpenAICompletionsRequest(model: Model<"openai-completions">, context: Context, options?: OpenAICompletionsOptions): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
//# sourceMappingURL=openai-completions.d.ts.map