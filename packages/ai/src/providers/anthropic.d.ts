import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import type { Context, Model, StreamFunction, StreamOptions } from "../types.js";
export type AnthropicEffort = "low" | "medium" | "high" | "max";
export interface AnthropicOptions extends StreamOptions {
	thinkingEnabled?: boolean;
	thinkingBudgetTokens?: number;
	effort?: AnthropicEffort;
	interleavedThinking?: boolean;
	toolChoice?:
		| "auto"
		| "any"
		| "none"
		| {
				type: "tool";
				name: string;
		  };
}
export declare const streamAnthropic: StreamFunction<"anthropic-messages">;
export declare function projectAnthropicRequest(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
	isOAuthToken?: boolean,
): MessageCreateParamsStreaming;
//# sourceMappingURL=anthropic.d.ts.map
