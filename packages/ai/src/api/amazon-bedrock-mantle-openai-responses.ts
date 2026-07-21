import OpenAI from "openai";
import { type BedrockProviderOptions, bedrock } from "openai/providers/bedrock/aws";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { resolveBedrockMantleEndpoint } from "./amazon-bedrock-mantle-region.ts";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

const API = "amazon-bedrock-mantle-openai-responses";
const TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", API]);

export interface AmazonBedrockMantleOpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	/** AWS region for the Bedrock Mantle endpoint and SigV4 signing scope. Unsupported model regions use a supported fallback. */
	region?: string;
	/** AWS named profile used to resolve credentials. Falls back to AWS_PROFILE. */
	profile?: string;
	/** Override the OpenAI-compatible base URL. The built-in URL materializes its AWS region at request time. */
	baseUrl?: string;
	/** Long-lived Bedrock API key (bearer token). When set, it is used directly instead of AWS SigV4 credential signing. */
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

function buildProviderOptions(
	model: Model<"amazon-bedrock-mantle-openai-responses">,
	options?: AmazonBedrockMantleOpenAIResponsesOptions,
): BedrockProviderOptions {
	const configuredBaseUrl = options?.baseUrl?.trim() || model.baseUrl.trim();
	const { baseUrl, region } = resolveBedrockMantleEndpoint(model.id, configuredBaseUrl, options);
	const endpoint: BedrockProviderOptions = {
		...(region ? { region } : {}),
		baseURL: baseUrl,
	};

	// Bearer and AWS credential modes are mutually exclusive in `bedrock()`; prefer
	// an explicit bearer token when present, mirroring the previous behavior.
	const apiKey = options?.apiKey === "<authenticated>" ? undefined : options?.apiKey;
	const bearerToken =
		options?.bearerToken || apiKey || getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options?.env) || undefined;
	if (bearerToken) {
		return { ...endpoint, apiKey: bearerToken };
	}

	// `bedrock()` accepts exactly one explicit AWS mode, so prefer explicit static
	// credentials over a named profile (matching AWS SDK precedence) before falling
	// back to the default credential chain.
	const accessKeyId = getProviderEnvValue("AWS_ACCESS_KEY_ID", options?.env);
	const secretAccessKey = getProviderEnvValue("AWS_SECRET_ACCESS_KEY", options?.env);
	if (accessKeyId && secretAccessKey) {
		const sessionToken = getProviderEnvValue("AWS_SESSION_TOKEN", options?.env);
		return { ...endpoint, accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
	}
	const profile = options?.profile || getProviderEnvValue("AWS_PROFILE", options?.env) || undefined;
	if (profile) {
		return { ...endpoint, profile };
	}
	return endpoint;
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
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const client = createClient(model, options);
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

			if (output.stopReason === "pending") {
				throw new Error("Amazon Bedrock Mantle stream ended without a stop reason");
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
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies AmazonBedrockMantleOpenAIResponsesOptions);
};

function createClient(
	model: Model<"amazon-bedrock-mantle-openai-responses">,
	options: AmazonBedrockMantleOpenAIResponsesOptions | undefined,
) {
	const headers = { ...model.headers };
	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	return new OpenAI({
		provider: bedrock(buildProviderOptions(model, options)),
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
