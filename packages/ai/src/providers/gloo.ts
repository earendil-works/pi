/**
 * Gloo AI provider — OAuth2 client_credentials wrapper around the
 * OpenAI-compatible chat-completions endpoint at `${GLOO_BASE_URL}/ai/v2`.
 *
 * Why a wrapper instead of just a "openai-completions" provider with the
 * Gloo baseUrl: Gloo bearer tokens are short-lived (1h default) and must
 * be minted via OAuth2 client_credentials at request time. Pi-ai's
 * provider registry resolves apiKeys synchronously from `getEnvApiKey()`
 * before the stream call, so a token-fetching step can't live there.
 *
 * This module registers a separate `"gloo-openai-completions"` `Api` tag
 * so Gloo models route through this wrapper, which:
 *
 *   1. Uses `options.apiKey` when auth-storage supplies a persisted OAuth bearer,
 *      otherwise resolves a fresh bearer via `getGlooAccessToken()` (cached + coalesced).
 *   2. Strips `context.tools` for models the platform rejects when tools
 *      are present (HTTP 400 "model does not support function calling"):
 *      deepseek-r1, llama-4-maverick, llama-3.1-8b-instruct.
 *   3. Casts the model to `Model<"openai-completions">` and delegates to
 *      `streamOpenAICompletions` / `streamSimpleOpenAICompletions`.
 *
 * `GLOO_BASE_URL` (default `https://platform.ai.gloo.com`) is resolved
 * from the model's `baseUrl` — set per-model in `models.gloo.ts` so the
 * same model catalog can target prod, staging, or a local `ai-api`.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { getGlooAccessToken } from "../utils/oauth/gloo.js";
import {
	type OpenAICompletionsOptions,
	streamOpenAICompletions,
	streamSimpleOpenAICompletions,
} from "./openai-completions.js";

export type GlooOptions = OpenAICompletionsOptions;

/**
 * Models the Gloo platform rejects with HTTP 400
 * "model does not support function calling" — strip tools before delegating.
 *
 * Verified 2026-04-27 against platform.ai.gloo.com via the opencode fork's
 * gloo-models.test.ts; mirrored here so pi-coding-agent / pi-mom don't
 * silently fail when an agent loop tries to send tools to one of these.
 */
export const GLOO_TOOLCALL_BLOCKLIST: ReadonlySet<string> = new Set([
	"gloo-deepseek-r1",
	"gloo-meta-llama-4-maverick",
	"gloo-meta-llama-3.1-8b-instruct",
]);

function modelRejectsTools(modelId: string): boolean {
	return GLOO_TOOLCALL_BLOCKLIST.has(modelId);
}

function castToOpenAIModel(model: Model<"gloo-openai-completions">): Model<"openai-completions"> {
	// Same shape, swap the api tag so streamOpenAICompletions doesn't error
	// on the model.api guard inside api-registry.ts.
	return { ...model, api: "openai-completions" } as unknown as Model<"openai-completions">;
}

function stripToolsIfBlocked(model: Model<"gloo-openai-completions">, context: Context): Context {
	if (!modelRejectsTools(model.id) || !context.tools || context.tools.length === 0) {
		return context;
	}
	return { ...context, tools: undefined };
}

function forwardStream(target: AssistantMessageEventStream, source: AsyncIterable<AssistantMessageEvent>): void {
	(async () => {
		for await (const event of source) {
			target.push(event);
		}
		target.end();
	})();
}

function buildErrorMessage<TApi extends Api>(model: Model<TApi>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

export const streamGloo: StreamFunction<"gloo-openai-completions", GlooOptions> = (
	model: Model<"gloo-openai-completions">,
	context: Context,
	options?: GlooOptions,
): AssistantMessageEventStream => {
	const outer = new AssistantMessageEventStream();

	(async () => {
		try {
			const baseUrl = stripChatCompletionsSuffix(model.baseUrl);
			const token =
				options?.apiKey ??
				(await getGlooAccessToken({
					baseUrl,
					signal: options?.signal,
				}));
			const inner = streamOpenAICompletions(castToOpenAIModel(model), stripToolsIfBlocked(model, context), {
				...options,
				apiKey: token,
			});
			forwardStream(outer, inner);
		} catch (error) {
			const message = buildErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		}
	})();

	return outer;
};

export const streamSimpleGloo: StreamFunction<"gloo-openai-completions", SimpleStreamOptions> = (
	model: Model<"gloo-openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const outer = new AssistantMessageEventStream();

	(async () => {
		try {
			const baseUrl = stripChatCompletionsSuffix(model.baseUrl);
			const token =
				options?.apiKey ??
				(await getGlooAccessToken({
					baseUrl,
					signal: options?.signal,
				}));
			const inner = streamSimpleOpenAICompletions(castToOpenAIModel(model), stripToolsIfBlocked(model, context), {
				...options,
				apiKey: token,
			});
			forwardStream(outer, inner);
		} catch (error) {
			const message = buildErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		}
	})();

	return outer;
};

/**
 * Model `baseUrl` is the OpenAI-compatible inference endpoint
 * (`${GLOO_BASE_URL}/ai/v2`). The OAuth2 token endpoint lives at
 * `${GLOO_BASE_URL}/oauth2/token` — the helper takes the bare base URL,
 * so we strip the `/ai/v2` suffix here before passing it through.
 *
 * Exported for testability.
 */
export function stripChatCompletionsSuffix(modelBaseUrl: string): string {
	return modelBaseUrl.replace(/\/ai\/v2\/?$/, "");
}
