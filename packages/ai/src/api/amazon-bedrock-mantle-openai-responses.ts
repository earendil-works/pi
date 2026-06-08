import { getToken } from "@aws/bedrock-token-generator";
import { BedrockRuntimeClient, type BedrockRuntimeClientConfig } from "@aws-sdk/client-bedrock-runtime";
import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderEnv,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

const API = "amazon-bedrock-mantle-openai-responses";
const TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", API]);

export interface AmazonBedrockMantleOpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	/** AWS region for the Bedrock Mantle endpoint and bearer-token scope. Falls back to AWS_REGION / profile config. */
	region?: string;
	/** AWS named profile used to resolve credentials. Falls back to AWS_PROFILE. */
	profile?: string;
	/** Override the OpenAI-compatible base URL. Defaults to https://bedrock-mantle.<region>.api.aws/openai/v1. */
	baseUrl?: string;
	/** Long-lived Bedrock API key (bearer token). When set, it is used directly instead of minting a short-lived token. */
	bearerToken?: string;
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		const status = (error as Error & { status?: unknown }).status;
		const statusCode = typeof status === "number" ? status : undefined;
		if (statusCode !== undefined) {
			return `Amazon Bedrock Mantle OpenAI Responses API error (${statusCode}): ${error.message}`;
		}
		return error.message;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function getStandardBedrockMantleRegionFromHost(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	try {
		const { hostname } = new URL(baseUrl);
		const match = hostname.toLowerCase().match(/^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

function buildDefaultBaseUrl(region: string): string {
	return `https://bedrock-mantle.${region}.api.aws/openai/v1`;
}

function getConfiguredBedrockCredentials(env?: ProviderEnv): BedrockRuntimeClientConfig["credentials"] | undefined {
	const accessKeyId = getProviderEnvValue("AWS_ACCESS_KEY_ID", env);
	const secretAccessKey = getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env);
	if (!accessKeyId || !secretAccessKey) {
		return undefined;
	}
	const sessionToken = getProviderEnvValue("AWS_SESSION_TOKEN", env);
	return {
		accessKeyId,
		secretAccessKey,
		...(sessionToken ? { sessionToken } : {}),
	};
}

async function resolveAuth(
	model: Model<"amazon-bedrock-mantle-openai-responses">,
	options?: AmazonBedrockMantleOpenAIResponsesOptions,
): Promise<{ baseUrl: string; apiKey: string }> {
	const baseUrlOption = options?.baseUrl?.trim() || model.baseUrl?.trim() || undefined;
	const explicitRegion =
		options?.region ||
		getProviderEnvValue("AWS_REGION", options?.env) ||
		getProviderEnvValue("AWS_DEFAULT_REGION", options?.env) ||
		undefined;

	const apiKey = options?.apiKey === "<authenticated>" ? undefined : options?.apiKey;
	const bearerToken =
		options?.bearerToken || apiKey || getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options?.env) || undefined;
	if (bearerToken) {
		const region = getStandardBedrockMantleRegionFromHost(baseUrlOption) || explicitRegion || "us-east-1";
		return { baseUrl: normalizeBaseUrl(baseUrlOption || buildDefaultBaseUrl(region)), apiKey: bearerToken };
	}

	const profile = options?.profile || getProviderEnvValue("AWS_PROFILE", options?.env);
	const credentials = getConfiguredBedrockCredentials(options?.env);
	const client = new BedrockRuntimeClient({
		...(explicitRegion ? { region: explicitRegion } : {}),
		...(profile ? { profile } : {}),
		...(credentials ? { credentials } : {}),
	});
	const region =
		getStandardBedrockMantleRegionFromHost(baseUrlOption) || explicitRegion || (await client.config.region());
	const token = await getToken({ credentials: client.config.credentials, region });
	return { baseUrl: normalizeBaseUrl(baseUrlOption || buildDefaultBaseUrl(region)), apiKey: token };
}

export const stream: StreamFunction<
	"amazon-bedrock-mantle-openai-responses",
	AmazonBedrockMantleOpenAIResponsesOptions
> = (
	model: Model<"amazon-bedrock-mantle-openai-responses">,
	context: Context,
	options?: AmazonBedrockMantleOpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: API as Api,
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
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const { baseUrl, apiKey } = await resolveAuth(model, options);
			const client = createClient(model, baseUrl, apiKey, options);
			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: options?.maxRetries ?? 0,
			};
			const { data: openaiStream, response } = await client.responses.create(params, requestOptions).withResponse();
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			await processResponsesStream(openaiStream, output, stream, model);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"amazon-bedrock-mantle-openai-responses", SimpleStreamOptions> = (
	model: Model<"amazon-bedrock-mantle-openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, options, options?.apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies AmazonBedrockMantleOpenAIResponsesOptions);
};

function createClient(
	model: Model<"amazon-bedrock-mantle-openai-responses">,
	baseUrl: string,
	apiKey: string,
	options: AmazonBedrockMantleOpenAIResponsesOptions | undefined,
) {
	const headers = { ...model.headers };
	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	return new OpenAI({
		apiKey,
		baseURL: baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: headers,
	});
}

function buildParams(
	model: Model<"amazon-bedrock-mantle-openai-responses">,
	context: Context,
	options?: AmazonBedrockMantleOpenAIResponsesOptions,
) {
	const messages = convertResponsesMessages(model, context, TOOL_CALL_PROVIDERS);

	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options.maxTokens;
	} else if (model.maxTokens) {
		// Bedrock Mantle can return an empty completed response when reasoning and
		// encrypted reasoning replay are requested without an output cap. Always send
		// a cap; the endpoint clamps it to available context.
		params.max_output_tokens = model.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertResponsesTools(context.tools);
	}

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
	}

	return params;
}
