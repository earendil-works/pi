import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { hasVertexAdcCredentials } from "../env-api-keys.ts";
import type {
	AssistantMessageEventStream,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	TranscriptContext,
} from "../types.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import {
	type AnthropicOptions,
	stream as anthropicStream,
	streamSimple as anthropicStreamSimple,
} from "./anthropic-messages.ts";

class VertexAuthClient extends GoogleGenAI {
	fetchAuthHeaders(): Promise<Headers> {
		return this.apiClient.getAuthHeaders();
	}
	getResolvedProject(): string | undefined {
		return this.apiClient.getProject();
	}
}

export function resolveVertexApiKey(apiKey: string | undefined): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed || trimmed === "gcp-vertex-credentials" || /^<[^>]+>$/.test(trimmed)) {
		return undefined;
	}
	return trimmed;
}

export interface VertexAnthropicFetchConfig {
	project?: string;
	location?: string;
	apiKey?: string;
	env?: ProviderEnv;
	fetch?: typeof globalThis.fetch;
	model: Model<"anthropic-messages">;
}

export function createVertexAnthropicFetch(config: VertexAnthropicFetchConfig): typeof globalThis.fetch {
	const underlyingFetch = config.fetch ?? globalThis.fetch;
	let cachedAuthHeaders: Headers | undefined;
	let cachedAuthExpiresAt = 0;

	return async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
		const urlString =
			typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;

		let bodyObj: Record<string, unknown> | undefined;
		if (init?.body && typeof init.body === "string") {
			try {
				bodyObj = JSON.parse(init.body);
			} catch {
				// not JSON
			}
		}

		if (
			bodyObj &&
			(urlString.includes("/messages") || urlString.includes("streamRawPredict") || urlString.includes("rawPredict"))
		) {
			const location =
				config.location ||
				getProviderEnvValue("GOOGLE_CLOUD_LOCATION", config.env) ||
				getProviderEnvValue("CLOUD_ML_REGION", config.env);

			if (!location) {
				throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
			}

			const modelId = (bodyObj.model as string) || config.model.id;
			delete bodyObj.model;
			if (!bodyObj.anthropic_version) {
				bodyObj.anthropic_version = "vertex-2023-10-16";
			}

			const isStream = bodyObj.stream === true;
			const specifier = isStream ? "streamRawPredict" : "rawPredict";

			let targetUrl: string;
			const trimmedBase = config.model.baseUrl?.trim();
			const hasCustomBaseUrl =
				trimmedBase &&
				!trimmedBase.includes("{location}") &&
				!trimmedBase.includes("vertex.googleapis.com") &&
				!trimmedBase.includes("api.anthropic.com");

			if (hasCustomBaseUrl) {
				targetUrl = `${trimmedBase.replace(/\/+$/, "")}/${specifier}`;
			} else {
				let project =
					config.project ||
					getProviderEnvValue("GOOGLE_CLOUD_PROJECT", config.env) ||
					getProviderEnvValue("GCLOUD_PROJECT", config.env) ||
					getProviderEnvValue("ANTHROPIC_VERTEX_PROJECT_ID", config.env);

				if (!project && !config.apiKey) {
					try {
						const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", config.env);
						const authClient = new VertexAuthClient({
							vertexai: true,
							location,
							...(keyFilename ? { googleAuthOptions: { keyFilename } } : {}),
						});
						project = authClient.getResolvedProject();
					} catch {
						// Ignored, will throw below with clearer error
					}
				}

				if (!project) {
					throw new Error(
						"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
					);
				}

				targetUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models/${modelId}:${specifier}`;
			}

			const headers = new Headers(init?.headers);
			headers.delete("x-api-key");
			headers.set("content-type", "application/json");

			if (config.apiKey) {
				headers.set("x-goog-api-key", config.apiKey);
			} else {
				const now = Date.now();
				if (!cachedAuthHeaders || now >= cachedAuthExpiresAt) {
					const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", config.env);
					const project =
						config.project ||
						getProviderEnvValue("GOOGLE_CLOUD_PROJECT", config.env) ||
						getProviderEnvValue("GCLOUD_PROJECT", config.env) ||
						getProviderEnvValue("ANTHROPIC_VERTEX_PROJECT_ID", config.env) ||
						"default";
					const authClient = new VertexAuthClient({
						vertexai: true,
						project,
						location,
						...(keyFilename ? { googleAuthOptions: { keyFilename } } : {}),
					});
					cachedAuthHeaders = await authClient.fetchAuthHeaders();
					cachedAuthExpiresAt = now + 50 * 60 * 1000;
				}
				for (const [key, value] of cachedAuthHeaders.entries()) {
					headers.set(key, value);
				}
			}

			return underlyingFetch(targetUrl, {
				...init,
				headers,
				body: JSON.stringify(bodyObj),
			});
		}

		return underlyingFetch(input, init);
	};
}

function mergeClientHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const merged: ProviderHeaders = { "User-Agent": getPiUserAgent() };
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

export interface VertexAnthropicOptions extends AnthropicOptions {
	project?: string;
	location?: string;
}

function createClientForVertex(model: Model<"anthropic-messages">, options?: VertexAnthropicOptions): Anthropic {
	const resolvedApiKey = resolveVertexApiKey(options?.apiKey);
	const project =
		options?.project ||
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", options?.env) ||
		getProviderEnvValue("GCLOUD_PROJECT", options?.env) ||
		getProviderEnvValue("ANTHROPIC_VERTEX_PROJECT_ID", options?.env);
	const location =
		options?.location ||
		getProviderEnvValue("GOOGLE_CLOUD_LOCATION", options?.env) ||
		getProviderEnvValue("CLOUD_ML_REGION", options?.env);

	const customFetch = createVertexAnthropicFetch({
		project,
		location,
		apiKey: resolvedApiKey,
		env: options?.env,
		fetch: options?.fetch,
		model,
	});

	const defaultHeaders = mergeClientHeaders(
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		model.headers,
		options?.headers,
	);

	return new Anthropic({
		apiKey: resolvedApiKey ?? "vertex-credentials",
		authToken: null,
		baseURL: "https://vertex.googleapis.com",
		dangerouslyAllowBrowser: true,
		fetch: customFetch,
		defaultHeaders,
	});
}

function assertVertexAuth(options?: VertexAnthropicOptions): void {
	const apiKey = resolveVertexApiKey(options?.apiKey);
	if (apiKey) return;
	const project =
		options?.project ||
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", options?.env) ||
		getProviderEnvValue("GCLOUD_PROJECT", options?.env) ||
		getProviderEnvValue("ANTHROPIC_VERTEX_PROJECT_ID", options?.env);
	const location =
		options?.location ||
		getProviderEnvValue("GOOGLE_CLOUD_LOCATION", options?.env) ||
		getProviderEnvValue("CLOUD_ML_REGION", options?.env);
	if (hasVertexAdcCredentials(options?.env) && project && location) {
		return;
	}
	throw new Error(
		"Vertex AI requires credentials. Run `gcloud auth application-default login` and set GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION, or set GOOGLE_CLOUD_API_KEY.",
	);
}

export const stream: StreamFunction<"anthropic-messages", VertexAnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options?: VertexAnthropicOptions,
): AssistantMessageEventStream => {
	assertVertexAuth(options);
	const client = options?.client ?? createClientForVertex(model, options);
	return anthropicStream(model, context, { ...options, client });
};

export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const anthropicOpts = options as AnthropicOptions | undefined;
	assertVertexAuth(anthropicOpts);
	const client = anthropicOpts?.client ?? createClientForVertex(model, anthropicOpts);
	return anthropicStreamSimple(model, context, { ...options, client } as SimpleStreamOptions);
};
