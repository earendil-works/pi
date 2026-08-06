import type { AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface RpModelConfig {
	/** Model id sent to the API. */
	id: string;
	/** Provider API transport. Default: "openai-completions". */
	api?: string;
	/** Provider id. Default: "custom". */
	provider?: string;
	/** OpenAI-compatible base URL. */
	baseUrl: string;
	/** API key. Optional for keyless endpoints. */
	apiKey?: string;
	contextWindow?: number;
	maxTokens?: number;
}

export interface RpConfig {
	model: RpModelConfig;
	/** Persona anchor system prompt. */
	systemPrompt?: string;
	thinkingLevel?: ThinkingLevel;
}

export type ServerRequest =
	| { type: "init"; config: RpConfig }
	| { type: "card"; format: "json" | "png"; data: string }
	| { type: "prompt"; text: string }
	| { type: "abort" }
	| { type: "ping" };

export type ServerResponse =
	| { type: "ready" }
	| { type: "event"; event: AgentEvent }
	| { type: "result"; error?: string }
	| { type: "card_loaded"; name: string; greeting: string }
	| { type: "pong" }
	| { type: "error"; error: string };

export function encodeResponse(response: ServerResponse): string {
	return `${JSON.stringify(response)}\n`;
}

export function decodeRequest(line: string): ServerRequest {
	const parsed: unknown = JSON.parse(line);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("Request must be a JSON object");
	}
	const request = parsed as Record<string, unknown>;
	if (typeof request.type !== "string") {
		throw new Error('Request missing string field "type"');
	}
	switch (request.type) {
		case "init": {
			const config = request.config as RpConfig;
			if (typeof config?.model?.id !== "string" || typeof config.model.baseUrl !== "string") {
				throw new Error('Init request missing config.model with string fields "id" and "baseUrl"');
			}
			return { type: "init", config };
		}
		case "prompt":
			if (typeof request.text !== "string") {
				throw new Error('Prompt request missing string field "text"');
			}
			return { type: "prompt", text: request.text };
		case "card":
			if (request.format !== "json" && request.format !== "png") {
				throw new Error('Card request missing valid "format" ("json" or "png")');
			}
			if (typeof request.data !== "string") {
				throw new Error('Card request missing string field "data"');
			}
			return { type: "card", format: request.format, data: request.data };
		case "abort":
			return { type: "abort" };
		case "ping":
			return { type: "ping" };
		default:
			throw new Error(`Unknown request type: ${request.type}`);
	}
}
