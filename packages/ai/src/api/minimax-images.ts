import type {
	AssistantImages,
	ImageContent,
	ImagesContext,
	ImagesFunction,
	ImagesModel,
	ImagesOptions,
	ProviderHeaders,
	TextContent,
} from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

export const MINIMAX_IMAGE_MODEL_IDS = ["image-01", "image-01-live"] as const;

export const MINIMAX_IMAGE_BASE_URLS = {
	minimax: "https://api.minimax.io/v1/image_generation",
	"minimax-cn": "https://api.minimaxi.com/v1/image_generation",
} as const;

export interface MiniMaxImageSubjectReference {
	type: "character";
	imageFile: string;
}

export interface MiniMaxImagesOptions extends ImagesOptions {
	[key: string]: unknown;
	subjectReference?: MiniMaxImageSubjectReference[];
	aspectRatio?: string;
	width?: number;
	height?: number;
	responseFormat?: "url" | "base64";
	seed?: number;
	n?: number;
	promptOptimizer?: boolean;
}

interface MiniMaxImageGenerationRequest {
	model: string;
	prompt: string;
	subject_reference?: Array<{ type: "character"; image_file: string }>;
	aspect_ratio?: string;
	width?: number;
	height?: number;
	response_format: "url" | "base64";
	seed?: number;
	n?: number;
	prompt_optimizer?: boolean;
}

interface MiniMaxImageGenerationResponse {
	id?: string;
	data?: {
		image_urls?: string[];
	};
	metadata?: {
		success_count?: number;
		failed_count?: number;
	};
	base_resp?: {
		status_code?: number;
		status_msg?: string;
	};
}

type ProviderRequestError = Error & {
	status: number | undefined;
	headers: Headers | undefined;
	body?: string;
};

export const generateImages: ImagesFunction<"minimax-images", MiniMaxImagesOptions> = async (
	model: ImagesModel<"minimax-images">,
	context: ImagesContext,
	options?: MiniMaxImagesOptions,
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

		let params = buildParams(model, context, options);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) {
			params = nextParams as MiniMaxImageGenerationRequest;
		}

		const response = await retryProviderRequest(
			() =>
				fetchOk(
					model.baseUrl,
					{
						method: "POST",
						headers: buildHeaders(apiKey, model.headers, options?.headers),
						body: JSON.stringify(params),
					},
					options,
				),
			{
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
			},
		);
		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

		const payload = (await response.json()) as MiniMaxImageGenerationResponse;
		const statusCode = payload.base_resp?.status_code;
		if (statusCode !== undefined && statusCode !== 0) {
			const statusMessage = payload.base_resp?.status_msg?.trim();
			throw new Error(`MiniMax image API error ${statusCode}${statusMessage ? `: ${statusMessage}` : ""}`);
		}

		output.responseId = payload.id;
		for (const url of payload.data?.image_urls ?? []) {
			output.output.push(await resolveImageUrl(url, options));
		}

		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
};

function buildParams(
	model: ImagesModel<"minimax-images">,
	context: ImagesContext,
	options?: MiniMaxImagesOptions,
): MiniMaxImageGenerationRequest {
	const prompt = context.input
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => sanitizeSurrogates(item.text))
		.join("\n");

	return {
		model: model.id,
		prompt,
		...(options?.subjectReference
			? {
					subject_reference: options.subjectReference.map((reference) => ({
						type: reference.type,
						image_file: reference.imageFile,
					})),
				}
			: {}),
		...(options?.aspectRatio !== undefined ? { aspect_ratio: options.aspectRatio } : {}),
		...(options?.width !== undefined ? { width: options.width } : {}),
		...(options?.height !== undefined ? { height: options.height } : {}),
		response_format: options?.responseFormat ?? "base64",
		...(options?.seed !== undefined ? { seed: options.seed } : {}),
		...(options?.n !== undefined ? { n: options.n } : {}),
		...(options?.promptOptimizer !== undefined ? { prompt_optimizer: options.promptOptimizer } : {}),
	};
}

function buildHeaders(apiKey: string, modelHeaders?: Record<string, string>, optionsHeaders?: ProviderHeaders) {
	return providerHeadersToRecord({
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		...modelHeaders,
		...optionsHeaders,
	});
}

async function fetchOk(url: string, init: RequestInit, options?: ImagesOptions): Promise<Response> {
	const timeoutSignal =
		options?.timeoutMs !== undefined && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
	const combined = combineAbortSignals([options?.signal, timeoutSignal]);

	try {
		const response = await (options?.fetch ?? globalThis.fetch)(url, { ...init, signal: combined.signal });
		if (!response.ok) {
			const body = await response.text();
			throw providerRequestError(
				new Error(`MiniMax image API request failed`),
				response.status,
				response.headers,
				body,
			);
		}
		return response;
	} catch (error) {
		if (isProviderRequestError(error)) throw error;
		throw providerRequestError(error instanceof Error ? error : new Error(String(error)));
	} finally {
		combined.cleanup();
	}
}

function providerRequestError(error: Error, status?: number, headers?: Headers, body?: string): ProviderRequestError {
	return Object.assign(error, { status, headers, ...(body !== undefined ? { body } : {}) });
}

function isProviderRequestError(error: unknown): error is ProviderRequestError {
	return error instanceof Error && "status" in error && "headers" in error;
}

async function resolveImageUrl(url: string, options?: MiniMaxImagesOptions): Promise<ImageContent> {
	const dataUri = parseBase64Image(url);
	if (dataUri) return dataUri;

	const response = await retryProviderRequest(() => fetchOk(url, { method: "GET" }, options), {
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		signal: options?.signal,
	});
	const data = arrayBufferToBase64(await response.arrayBuffer());
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
	return {
		type: "image",
		mimeType: contentType?.startsWith("image/") ? contentType : detectImageMimeType(data),
		data,
	};
}

function parseBase64Image(value: string): ImageContent | undefined {
	if (!value) return undefined;
	const dataUri = /^data:([^;]+);base64,(.+)$/s.exec(value);
	const data = dataUri?.[2] ?? value;
	if (!dataUri && /^(?:https?:)?\/\//i.test(value)) return undefined;
	return {
		type: "image",
		mimeType: dataUri?.[1] ?? detectImageMimeType(data),
		data,
	};
}

function detectImageMimeType(base64: string): string {
	if (base64.startsWith("iVBORw0KGgo")) return "image/png";
	if (base64.startsWith("/9j/")) return "image/jpeg";
	if (base64.startsWith("R0lGOD")) return "image/gif";
	if (base64.startsWith("UklGR")) return "image/webp";
	return "image/png";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 8192) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	}
	return btoa(binary);
}
