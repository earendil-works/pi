import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { Context, Model, StreamFunction, StreamOptions } from "../types.js";
export type OpenAIResponsesToolChoice = "auto" | "none" | "required" | {
    type: "function";
    name: string;
};
export interface OpenAIResponsesOptions extends StreamOptions {
    reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    reasoningSummary?: "auto" | "detailed" | "concise" | null;
    toolChoice?: OpenAIResponsesToolChoice;
}
/**
 * Generate function for OpenAI Responses API
 */
export declare const streamOpenAIResponses: StreamFunction<"openai-responses">;
export declare function projectOpenAIResponsesRequest(model: Model<"openai-responses">, context: Context, options?: OpenAIResponsesOptions): ResponseCreateParamsStreaming;
//# sourceMappingURL=openai-responses.d.ts.map