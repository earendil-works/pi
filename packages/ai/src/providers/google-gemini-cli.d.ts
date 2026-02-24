/**
 * Google Gemini CLI / Antigravity provider.
 * Shared implementation for both google-gemini-cli and google-antigravity providers.
 * Uses the Cloud Code Assist API endpoint to access Gemini and Claude models.
 */
import type { StreamFunction, StreamOptions } from "../types.js";
import type {
	GenerationConfigRoutingConfig,
	MediaResolution,
	ModelSelectionConfig,
	SafetySetting,
	SpeechConfigUnion,
	ThinkingConfig,
} from "@google/genai";
interface VertexGenerationConfig {
	temperature?: number;
	topP?: number;
	topK?: number;
	candidateCount?: number;
	maxOutputTokens?: number;
	stopSequences?: string[];
	responseLogprobs?: boolean;
	logprobs?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	seed?: number;
	responseMimeType?: string;
	responseJsonSchema?: unknown;
	responseSchema?: unknown;
	routingConfig?: GenerationConfigRoutingConfig;
	modelSelectionConfig?: ModelSelectionConfig;
	responseModalities?: string[];
	mediaResolution?: MediaResolution;
	speechConfig?: SpeechConfigUnion;
	audioTimestamp?: boolean;
	thinkingConfig?: ThinkingConfig;
}
export interface GoogleGeminiCliOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	userPromptId?: string;
	sessionId?: string;
	cachedContent?: string;
	labels?: Record<string, string>;
	safetySettings?: SafetySetting[];
	generationConfig?: VertexGenerationConfig;
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
