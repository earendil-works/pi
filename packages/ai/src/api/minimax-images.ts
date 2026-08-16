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
import {
	formatProviderError,
	MAX_PROVIDER_ERROR_BODY_CHARS,
	normalizeProviderError,
	truncateErrorText,
} from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

/** Models served by the image generation endpoint. */
export const MINIMAX_IMAGE_MODEL_IDS = ["image-01", "image-01-live"] as const;

/** Regional image generation endpoints, keyed by image provider id. */
export const MINIMAX_IMAGE_BASE_URLS = {
	minimax: "https://api.minimax.io/v1/image_generation",
	"minimax-cn": "https://api.minimaxi.com/v1/image_generation",
} as const;

/** The only reference subject type the endpoint accepts. */
const SUBJECT_REFERENCE_TYPE = "character";

/** Wire format of the generated images. */
export type MiniMaxImageResponseFormat = "url" | "base64";

/**
 * A reference image for image-to-image generation. `imageFile` is either a
 * publicly reachable URL or a `data:<mimeType>;base64,<data>` payload.
 */
export interface MiniMaxImageSubjectReference {
	type: typeof SUBJECT_REFERENCE_TYPE;
	imageFile: string;
}

export interface MiniMaxImagesOptions extends ImagesOptions {
	[key: string]: unknown;
	/**
	 * Reference images for image-to-image generation. Defaults to the image
	 * inputs of `ImagesContext.input`, sent as base64 data payloads.
	 */
	subjectReference?: MiniMaxImageSubjectReference[];
	/** Documented output ratio. Takes priority over `width`/`height`. */
	aspectRatio?: string;
	/** Pixel width, paired with `height`. Only honored by the non-live model. */
	width?: number;
	/** Pixel height, paired with `width`. Only honored by the non-live model. */
	height?: number;
	/** Requested wire format. Defaults to `base64` so no image URL has to be fetched. */
	responseFormat?: MiniMaxImageResponseFormat;
	/** Reused with identical parameters to reproduce a previous result. */
	seed?: number;
	/** Number of images to generate. */
	n?: number;
	/** Let the service rewrite the prompt before generating. */
	promptOptimizer?: boolean;
}

interface MiniMaxImageSubjectReferenceRequest {
	type: typeof SUBJECT_REFERENCE_TYPE;
	image_file: string;
}

interface MiniMaxImageGenerationRequest {
	model: string;
	prompt: string;
	subject_reference?: MiniMaxImageSubjectReferenceRequest[];
	aspect_ratio?: string;
	width?: number;
	height?: number;
	response_format: MiniMaxImageResponseFormat;
	seed?: number;
	n?: number;
	prompt_optimizer?: boolean;
}

interface MiniMaxImageGenerationResponse {
	id?: string;
	data?: {
		/** Returned for `response_format: "url"`; each URL expires after a day. */
		image_urls?: string[];
		/** Returned for `response_format: "base64"`. */
		image_base64?: string[];
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

/** Shape `retryProviderRequest` inspects to decide whether a failure is retryable. */
type ProviderRequestError = Error & {
	status: number | undefined;
	headers: Headers | undefined;
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

		let params: unknown = buildParams(model, context, options);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) {
			params = nextParams;
		}

		const response = await retryProviderRequest(
			() =>
				requestOk(
					model.baseUrl,
					{
						method: "POST",
						headers: buildHeaders(apiKey, model.headers, options?.headers),
						body: JSON.stringify(params),
					},
					options,
				),
			retryOptions(options),
		);
		await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

		const payload = (await response.json()) as MiniMaxImageGenerationResponse;
		const statusCode = payload.base_resp?.status_code;
		if (statusCode !== undefined && statusCode !== 0) {
			const statusMessage = payload.base_resp?.status_msg?.trim();
			throw new Error(
				`Image generation failed with status ${statusCode}${statusMessage ? `: ${statusMessage}` : ""}`,
			);
		}

		output.responseId = payload.id;
		for (const image of [...(payload.data?.image_base64 ?? []), ...(payload.data?.image_urls ?? [])]) {
			output.output.push(await resolveImage(image, options));
		}
		if (output.output.length === 0) {
			const failedCount = payload.metadata?.failed_count ?? 0;
			throw new Error(
				failedCount > 0
					? `Image generation returned no images (${failedCount} rejected by content safety)`
					: "Image generation returned no images",
			);
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
	const subjectReference = options?.subjectReference ?? contextSubjectReferences(context);

	return {
		model: model.id,
		prompt,
		...(subjectReference.length > 0
			? {
					subject_reference: subjectReference.map((reference) => ({
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

/** Image inputs are the reference subjects of an image-to-image request. */
function contextSubjectReferences(context: ImagesContext): MiniMaxImageSubjectReference[] {
	return context.input
		.filter((item): item is ImageContent => item.type === "image")
		.map((item) => ({
			type: SUBJECT_REFERENCE_TYPE,
			imageFile: `data:${item.mimeType};base64,${item.data}`,
		}));
}

function buildHeaders(
	apiKey: string,
	modelHeaders?: Record<string, string>,
	optionsHeaders?: ProviderHeaders,
): Record<string, string> | undefined {
	return providerHeadersToRecord({
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		...modelHeaders,
		...optionsHeaders,
	});
}

function retryOptions(options?: MiniMaxImagesOptions) {
	return {
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		signal: options?.signal,
	};
}

async function requestOk(url: string, init: RequestInit, options?: MiniMaxImagesOptions): Promise<Response> {
	const timeoutSignal =
		options?.timeoutMs !== undefined && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
	const combined = combineAbortSignals([options?.signal, timeoutSignal]);

	try {
		const response = await (options?.fetch ?? globalThis.fetch)(url, { ...init, signal: combined.signal });
		if (!response.ok) {
			const body = truncateErrorText(await response.text(), MAX_PROVIDER_ERROR_BODY_CHARS);
			throw providerRequestError(
				new Error(`${response.status} ${response.statusText}: ${body}`),
				response.status,
				response.headers,
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

function providerRequestError(error: Error, status?: number, headers?: Headers): ProviderRequestError {
	return Object.assign(error, { status, headers });
}

function isProviderRequestError(error: unknown): error is ProviderRequestError {
	return error instanceof Error && "status" in error && "headers" in error;
}

/**
 * Turns one response entry into image content. Both response formats are
 * accepted for either array: a data URI and a bare base64 payload are used
 * as-is, an `http(s)` URL is downloaded before it expires.
 */
async function resolveImage(image: string, options?: MiniMaxImagesOptions): Promise<ImageContent> {
	const dataUri = /^data:([^;,]+);base64,(.*)$/s.exec(image);
	if (dataUri?.[1] && dataUri[2] !== undefined) {
		return { type: "image", mimeType: dataUri[1], data: dataUri[2] };
	}
	if (!/^https?:\/\//i.test(image)) {
		return { type: "image", mimeType: detectImageMimeType(image), data: image };
	}

	const response = await retryProviderRequest(
		() => requestOk(image, { method: "GET" }, options),
		retryOptions(options),
	);
	const data = arrayBufferToBase64(await response.arrayBuffer());
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
	return {
		type: "image",
		mimeType: contentType?.startsWith("image/") ? contentType : detectImageMimeType(data),
		data,
	};
}

/** Base64-encoded magic bytes of the formats the endpoint can return. */
function detectImageMimeType(base64: string): string {
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
