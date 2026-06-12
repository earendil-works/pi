import type { AuthClient } from "google-auth-library";
import { GoogleAuth } from "google-auth-library";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { resolveAnthropicVertexLocation, resolveAnthropicVertexProject } from "../vertex-shared.ts";
import {
	type AnthropicMessagesClient,
	type AnthropicOptions,
	mapThinkingLevelToAnthropicEffort,
	streamAnthropic,
} from "./anthropic.ts";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.ts";

export interface AnthropicVertexOptions extends AnthropicOptions {
	project?: string;
	location?: string;
}

interface VertexMessagesClientOptions {
	projectId?: string;
	region: string;
	headers?: Record<string, string>;
	authClient?: VertexAuthClient;
	fetch?: typeof fetch;
}

type VertexAuthClient = Pick<AuthClient, "getRequestHeaders"> & { projectId?: string | null };
type VertexCreateParams = Parameters<AnthropicMessagesClient["messages"]["create"]>[0];
type VertexCreateOptions = Parameters<AnthropicMessagesClient["messages"]["create"]>[1];

export const streamAnthropicVertex: StreamFunction<"anthropic-messages", AnthropicVertexOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicVertexOptions,
): AssistantMessageEventStream => {
	try {
		const { project: _project, location: _location, ...anthropicOptions } = options ?? {};
		const client = createAnthropicVertexMessagesClient({
			projectId: resolveProject(options),
			region: resolveLocation(options),
			headers: options?.headers,
		});
		return streamAnthropic(model, context, {
			...anthropicOptions,
			client,
		});
	} catch (error) {
		return createErrorStream(model, error);
	}
};

export const streamSimpleAnthropicVertex: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, options, undefined);
	if (!options?.reasoning) {
		return streamAnthropicVertex(model, context, {
			...base,
			thinkingEnabled: false,
		});
	}

	if (model.compat?.forceAdaptiveThinking === true) {
		return streamAnthropicVertex(model, context, {
			...base,
			thinkingEnabled: true,
			effort: mapThinkingLevelToAnthropicEffort(model, options.reasoning),
		});
	}

	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return streamAnthropicVertex(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	});
};

export function createAnthropicVertexMessagesClient(options: VertexMessagesClientOptions): AnthropicMessagesClient {
	const authClientPromise = options.authClient
		? Promise.resolve(options.authClient)
		: new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" }).getClient();

	const createImpl = (params: VertexCreateParams, requestOptions?: VertexCreateOptions) => ({
		asResponse: async () => {
			const authClient = await authClientPromise;
			const googleHeaders = normalizeHeaders(await authClient.getRequestHeaders());
			const projectId = options.projectId || authClient.projectId || googleHeaders["x-goog-user-project"];
			if (!projectId) {
				throw new Error(
					"Anthropic Vertex requires a project ID. Set ANTHROPIC_VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT, or pass project in options.",
				);
			}

			const url = new URL(resolveBaseUrl(options.region));
			const model = params.model;
			url.pathname = [
				"/v1/projects",
				projectId,
				"locations",
				options.region,
				"publishers",
				"anthropic",
				"models",
				`${model}:${params.stream ? "streamRawPredict" : "rawPredict"}`,
			].join("/");

			const body: Record<string, unknown> = {
				...params,
				anthropic_version: (params as unknown as Record<string, unknown>).anthropic_version ?? "vertex-2023-10-16",
			};
			delete body.model;

			const requestInit: RequestInit = {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					...googleHeaders,
					...(options.headers ?? {}),
				},
				body: JSON.stringify(body),
				signal: withTimeout(
					requestOptions?.signal ?? undefined,
					typeof requestOptions?.timeout === "number" ? requestOptions.timeout : undefined,
				),
			};
			const maxRetries = typeof requestOptions?.maxRetries === "number" ? requestOptions.maxRetries : 0;

			for (let attempt = 0; ; attempt++) {
				try {
					const response = await (options.fetch ?? fetch)(url.toString(), requestInit);
					if (response.ok) {
						return response;
					}

					const errorText = await response.text();
					if (attempt < maxRetries && shouldRetryVertexStatus(response.status, errorText)) {
						continue;
					}
					throw new Error(`${response.status} ${errorText}`);
				} catch (error) {
					if (attempt < maxRetries && shouldRetryVertexError(error)) {
						continue;
					}
					throw error;
				}
			}
		},
	});
	const create = createImpl as unknown as AnthropicMessagesClient["messages"]["create"];

	return {
		messages: {
			create,
		},
	};
}

function resolveBaseUrl(location: string): string {
	switch (location) {
		case "global":
			return "https://aiplatform.googleapis.com";
		case "us":
			return "https://aiplatform.us.rep.googleapis.com";
		case "eu":
			return "https://aiplatform.eu.rep.googleapis.com";
		default:
			return `https://${location}-aiplatform.googleapis.com`;
	}
}

function normalizeHeaders(headers: Headers | Record<string, string>): Record<string, string> {
	if (headers instanceof Headers) {
		const normalized: Record<string, string> = {};
		headers.forEach((value: string, key: string) => {
			normalized[key] = value;
		});
		return normalized;
	}
	return { ...headers };
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
	if (timeoutMs === undefined) {
		return signal;
	}

	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function shouldRetryVertexStatus(status: number, errorText: string): boolean {
	if (status === 408 || status === 409 || status >= 500) {
		return true;
	}
	if (status === 429) {
		return !isUsageLimitError(errorText);
	}
	return false;
}

function shouldRetryVertexError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const normalized = `${error.name} ${error.message}`.toLowerCase();
	return !normalized.includes("abort");
}

function isUsageLimitError(errorText: string): boolean {
	return /usage limit|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(errorText);
}

function resolveProject(options?: AnthropicVertexOptions): string {
	const project = resolveAnthropicVertexProject(options);
	if (!project) {
		throw new Error(
			"Anthropic Vertex requires a project ID. Set ANTHROPIC_VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT, or pass project in options.",
		);
	}
	return project;
}

function resolveLocation(options?: AnthropicVertexOptions): string {
	const location = resolveAnthropicVertexLocation(options);
	if (!location) {
		throw new Error(
			"Anthropic Vertex requires a location. Set CLOUD_ML_REGION or GOOGLE_CLOUD_LOCATION, or pass location in options.",
		);
	}
	return location;
}

function createErrorStream(model: Model<Api>, error: unknown): AssistantMessageEventStream {
	const message: AssistantMessage = {
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

	const stream = new AssistantMessageEventStream();
	stream.push({ type: "error", reason: "error", error: message });
	stream.end(message);
	return stream;
}
