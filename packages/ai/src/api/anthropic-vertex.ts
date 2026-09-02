import type Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { Context, Model, ProviderEnv, ProviderHeaders, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { type AnthropicEffort, type AnthropicOptions, stream as streamAnthropic } from "./anthropic-messages.ts";
import { lazyStream } from "./lazy.ts";
import { adjustMaxTokensForThinking, buildBaseOptions, clampMaxTokensToContext } from "./simple-options.ts";

const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

/**
 * Options for Claude models served through Google Cloud Vertex AI.
 * Authentication uses ambient Google Application Default Credentials.
 */
export interface AnthropicVertexOptions extends Omit<AnthropicOptions, "apiKey" | "client"> {
	project?: string;
	location?: string;
}

export const stream: StreamFunction<"anthropic-vertex", AnthropicVertexOptions> = (
	model: Model<"anthropic-vertex">,
	context: Context,
	options?: AnthropicVertexOptions,
) =>
	lazyStream(model, async () => {
		assertAmbientCredentialPath(options?.env);

		const projectId = resolveProject(options);
		const baseURL = resolveBaseUrl(model, options?.env);
		const defaultHeaders = buildDefaultHeaders(model, options);
		const vertexClient = new AnthropicVertex({
			...(projectId ? { projectId } : {}),
			region: resolveLocation(options),
			// A generated `{location}` URL is catalog metadata, not a usable
			// override. Passing null prevents the SDK from rereading the same
			// ambient placeholder and lets it derive the documented endpoint.
			// https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai
			baseURL: baseURL ?? null,
			fetch: options?.fetch,
			defaultHeaders,
		});

		// AnthropicVertex implements the same Messages streaming surface used by
		// the direct client, but intentionally omits unsupported resources.
		const authorization = Object.entries(defaultHeaders).find(([name]) => name.toLowerCase() === "authorization");
		const client = (authorization
			? {
					messages: {
						create: (params: MessageCreateParamsStreaming, requestOptions?: Anthropic.RequestOptions) =>
							vertexClient.messages.create(params, {
								...requestOptions,
								headers: { Authorization: authorization[1] },
							}),
					},
				}
			: vertexClient) as unknown as Anthropic;
		return streamAnthropic(model as unknown as Model<"anthropic-messages">, context, {
			...options,
			apiKey: undefined,
			client,
		});
	});

export const streamSimple: StreamFunction<"anthropic-vertex", SimpleStreamOptions> = (
	model: Model<"anthropic-vertex">,
	context: Context,
	options?: SimpleStreamOptions,
) => {
	const base = { ...buildBaseOptions(model, context, options), apiKey: undefined };
	if (!options?.reasoning) {
		return stream(model, context, {
			...base,
			thinkingEnabled: false,
		} satisfies AnthropicVertexOptions);
	}

	if (model.compat?.forceAdaptiveThinking === true) {
		return stream(model, context, {
			...base,
			thinkingEnabled: true,
			effort: mapThinkingLevelToEffort(model, options.reasoning),
		} satisfies AnthropicVertexOptions);
	}

	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);
	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
	return stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
	} satisfies AnthropicVertexOptions);
};

function buildDefaultHeaders(
	model: Model<"anthropic-vertex">,
	options?: AnthropicVertexOptions,
): Record<string, string> {
	// Same gate as the shared Anthropic client: adaptive-thinking models interleave
	// on their own. Google Cloud accepts this beta header on any model and ignores
	// it where interleaved thinking is unsupported, so no model list is needed.
	// https://platform.claude.com/docs/en/build-with-claude/extended-thinking#interleaved-thinking-in-manual-mode
	const automaticHeaders: ProviderHeaders =
		(options?.interleavedThinking ?? true) && model.compat?.forceAdaptiveThinking !== true
			? { "anthropic-beta": INTERLEAVED_THINKING_BETA }
			: {};
	const merged: ProviderHeaders = {};
	for (const headers of [automaticHeaders, model.headers, options?.headers]) {
		for (const [name, value] of Object.entries(headers ?? {})) {
			for (const existingName of Object.keys(merged)) {
				if (existingName.toLowerCase() === name.toLowerCase()) delete merged[existingName];
			}
			merged[name] = value;
		}
	}
	return providerHeadersToRecord(merged) ?? {};
}

function resolveProject(options?: AnthropicVertexOptions): string | undefined {
	return firstNonEmpty(
		options?.project,
		options?.env?.ANTHROPIC_VERTEX_PROJECT_ID,
		options?.env?.GOOGLE_CLOUD_PROJECT,
		options?.env?.GCLOUD_PROJECT,
		getProviderEnvValue("ANTHROPIC_VERTEX_PROJECT_ID"),
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT"),
		getProviderEnvValue("GCLOUD_PROJECT"),
	);
}

function resolveLocation(options?: AnthropicVertexOptions): string {
	return (
		firstNonEmpty(
			options?.location,
			options?.env?.CLOUD_ML_REGION,
			options?.env?.GOOGLE_CLOUD_LOCATION,
			getProviderEnvValue("CLOUD_ML_REGION"),
			getProviderEnvValue("GOOGLE_CLOUD_LOCATION"),
		) ?? "global"
	);
}

function resolveBaseUrl(model: Model<"anthropic-vertex">, env?: ProviderEnv): string | undefined {
	return firstConcreteBaseUrl(
		model.baseUrl,
		env?.ANTHROPIC_VERTEX_BASE_URL,
		getProviderEnvValue("ANTHROPIC_VERTEX_BASE_URL"),
	);
}

function firstConcreteBaseUrl(...values: (string | undefined)[]): string | undefined {
	return values
		.map((value) => value?.trim())
		.find((value): value is string => !!value && !value.includes("{location}"));
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
	return values.map((value) => value?.trim()).find((value): value is string => !!value);
}

function assertAmbientCredentialPath(env?: ProviderEnv): void {
	const scopedPath = env?.GOOGLE_APPLICATION_CREDENTIALS?.trim();
	if (!scopedPath) return;
	const ambientPath = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS")?.trim();
	if (scopedPath !== ambientPath) {
		throw new Error(
			"Anthropic Vertex AI uses process-scoped Google Application Default Credentials; request-scoped GOOGLE_APPLICATION_CREDENTIALS cannot select a different credential file",
		);
	}
}

function mapThinkingLevelToEffort(
	model: Model<"anthropic-vertex">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}
