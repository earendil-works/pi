import OpenAI from "openai";
import type {
	ChatCompletion,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions.js";
import type {
	AssistantImages,
	ImageApi,
	ImageContent,
	ImageModel,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
	ProviderHeaders,
	TextContent,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { applyOpenRouterReportedCost, type OpenRouterUsageAccounting } from "../utils/openrouter-cost.ts";
import { readOpenRouterNativeFinishReason } from "../utils/openrouter-finish-reason.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

interface OpenRouterGeneratedImage {
	image_url?: string | { url?: string };
}

interface OpenRouterChoiceError {
	message?: string | null;
	code?: string | number | null;
}

type OpenRouterImageGenerationMessage = ChatCompletion["choices"][number]["message"] & {
	images?: OpenRouterGeneratedImage[];
};

type OpenRouterImageGenerationChoice = ChatCompletion["choices"][number] & {
	message: OpenRouterImageGenerationMessage;
	error?: OpenRouterChoiceError;
};

type OpenRouterImageGenerationResponse = Omit<ChatCompletion, "choices"> & {
	choices?: OpenRouterImageGenerationChoice[];
	error?: OpenRouterChoiceError;
};

function formatOpenRouterError(error: OpenRouterChoiceError | undefined): string | undefined {
	if (!error) return undefined;
	if (typeof error.message === "string" && error.message.trim().length > 0) {
		return error.message.trim();
	}
	if (error.code !== undefined && error.code !== null && String(error.code).trim().length > 0) {
		return `Provider error (${String(error.code).trim()})`;
	}
	return undefined;
}

/** Image generation over OpenRouter's chat completions endpoint. */
export const generateImages: ImagesFunction<ImagesOptions> = async (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		const apiKey = options?.apiKey;
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		const client = createClient(model, apiKey, options?.headers, options?.fetch, options?.identity);
		let params = buildParams(model, context, options);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) {
			params = nextParams as typeof params;
		}
		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			maxRetries: 0,
		};
		const { data: response, response: rawResponse } = await retryProviderRequest(
			() =>
				client.chat.completions
					.create(params as unknown as ChatCompletionCreateParamsNonStreaming, requestOptions)
					.withResponse(),
			{
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
				onErrorResponse: (errorResponse) => options?.onResponse?.(errorResponse, model),
			},
		);
		await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);

		const imageResponse = response as OpenRouterImageGenerationResponse;
		output.responseId = imageResponse.id;
		if (imageResponse.usage) {
			output.usage = parseUsage(imageResponse.usage, model);
		}

		const choice = imageResponse.choices?.[0];
		if (!choice) {
			output.stopReason = "error";
			output.errorMessage = formatOpenRouterError(imageResponse.error) ?? "Provider returned no choices";
			return output;
		}

		const choiceError = formatOpenRouterError(choice.error) ?? formatOpenRouterError(imageResponse.error);
		if (choiceError) {
			output.stopReason = "error";
			output.errorMessage = choiceError;
			return output;
		}

		const finishReason = choice.finish_reason as string | null | undefined;
		if (finishReason && finishReason !== "stop" && finishReason !== "end") {
			output.stopReason = "error";
			const nativeReason = readOpenRouterNativeFinishReason(choice);
			output.errorMessage =
				nativeReason && nativeReason !== finishReason
					? `Provider finish_reason: ${finishReason} (native_finish_reason: ${nativeReason})`
					: `Provider finish_reason: ${finishReason}`;
			return output;
		}

		const content = choice.message.content;
		if (typeof content === "string" && content.length > 0) {
			output.output.push({ type: "text", text: content } satisfies TextContent);
		}

		for (const image of choice.message.images ?? []) {
			const imageUrl = typeof image.image_url === "string" ? image.image_url : image.image_url?.url;
			if (!imageUrl?.startsWith("data:")) continue;
			const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
			if (!matches) continue;
			output.output.push({
				type: "image",
				mimeType: matches[1],
				data: matches[2],
			} satisfies ImageContent);
		}

		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
};

function createClient(
	model: ImageModel<ImageApi>,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	identity?: ClientIdentity,
): OpenAI {
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: providerHeadersToRecord(getIdentityHeaders(model, identity), model.headers, optionsHeaders),
	});
}

type OpenRouterImagesCreateParams = Omit<ChatCompletionCreateParamsNonStreaming, "modalities"> & {
	modalities: Array<"image" | "text">;
	image_config?: {
		aspect_ratio?: string;
		image_size?: string;
	};
};

function buildParams(
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
): OpenRouterImagesCreateParams {
	const content: ChatCompletionContentPart[] = context.input.map((item): ChatCompletionContentPart => {
		if (item.type === "text") {
			return {
				type: "text",
				text: sanitizeSurrogates(item.text),
			} satisfies ChatCompletionContentPartText;
		}
		return {
			type: "image_url",
			image_url: {
				url: `data:${item.mimeType};base64,${item.data}`,
			},
		} satisfies ChatCompletionContentPartImage;
	});

	const imageConfig = {
		...(options?.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
		...(options?.size ? { image_size: options.size } : {}),
	};

	return {
		model: model.id,
		messages: [
			{
				role: "user" as const,
				content,
			},
		],
		stream: false,
		modalities: model.output.includes("text") ? ["image", "text"] : ["image"],
		...(Object.keys(imageConfig).length > 0 ? { image_config: imageConfig } : {}),
	};
}

function parseUsage(
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number; image_tokens?: number };
	},
	model: ImageModel<ImageApi>,
) {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const reportedCachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
	const cacheReadTokens =
		cacheWriteTokens > 0 ? Math.max(0, reportedCachedTokens - cacheWriteTokens) : reportedCachedTokens;
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const output = rawUsage.completion_tokens || 0;
	const usage = {
		input,
		output,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		// completion_tokens already includes reasoning_tokens.
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
		// Undefined, not 0, when OpenRouter omits the split: 0 would claim no image tokens.
		...(typeof rawUsage.completion_tokens_details?.image_tokens === "number"
			? { imageOutput: rawUsage.completion_tokens_details.image_tokens }
			: {}),
		totalTokens: input + output + cacheReadTokens + cacheWriteTokens,
		cost: {
			input: (model.cost.input / 1000000) * input,
			output: (model.cost.output / 1000000) * output,
			cacheRead: (model.cost.cacheRead / 1000000) * cacheReadTokens,
			cacheWrite: (model.cost.cacheWrite / 1000000) * cacheWriteTokens,
			total: 0,
			totalFromProvider: false,
		},
	};
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	applyOpenRouterReportedCost(usage, rawUsage as typeof rawUsage & OpenRouterUsageAccounting);
	return usage;
}
