/**
 * Request transformation for Codex API.
 */
import type { CodexSystemPrompt } from "./prompts/system-prompt.js";
export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	summary: "auto" | "concise" | "detailed" | "off" | "on";
}
export interface CodexRequestOptions {
	reasoningEffort?: ReasoningConfig["effort"];
	reasoningSummary?: ReasoningConfig["summary"] | null;
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
}
export interface InputItem {
	id?: string | null;
	type?: string | null;
	role?: string;
	content?: unknown;
	call_id?: string | null;
	name?: string;
	output?: unknown;
	arguments?: string;
}
export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: InputItem[];
	tools?: unknown;
	temperature?: number;
	reasoning?: Partial<ReasoningConfig>;
	text?: {
		verbosity?: "low" | "medium" | "high";
	};
	include?: string[];
	prompt_cache_key?: string;
	prompt_cache_retention?: "in_memory" | "24h";
	max_output_tokens?: number;
	max_completion_tokens?: number;
	[key: string]: unknown;
}
export declare function transformRequestBody(
	body: RequestBody,
	options?: CodexRequestOptions,
	prompt?: CodexSystemPrompt,
): Promise<RequestBody>;
//# sourceMappingURL=request-transformer.d.ts.map
