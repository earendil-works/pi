import OpenAI from "openai";
import type { ImageGenerateParamsNonStreaming } from "openai/resources/images.js";
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
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

export const generateImages: ImagesFunction<"deepinfra-images", ImagesOptions> = async (
	model: ImagesModel<"deepinfra-images">,
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
		const client = createClient(model, apiKey, options?.headers);
		let params = buildParams(model, context);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) {
			params = nextParams as typeof params;
		}
		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			maxRetries: options?.maxRetries ?? 0,
		};
		const { data: response, response: rawResponse } = await client.images
			.generate(params, requestOptions)
			.withResponse();
		await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);

		for (const image of response.data ?? []) {
			if (!image.b64_json) continue;
			// DeepInfra returns raw base64 (occasionally a data: URI); strip any prefix and
			// detect the real format instead of assuming PNG.
			const dataUri = image.b64_json.match(/^data:([^;]+);base64,(.+)$/);
			const data = dataUri ? dataUri[2] : image.b64_json;
			const mimeType = dataUri ? dataUri[1] : detectImageMimeType(data);
			output.output.push({ type: "image", mimeType, data } satisfies ImageContent);
		}

		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
};

/** Sniff the image format from the leading bytes of a base64 payload. */
function detectImageMimeType(base64: string): string {
	if (base64.startsWith("iVBORw0KGgo")) return "image/png";
	if (base64.startsWith("/9j/")) return "image/jpeg";
	if (base64.startsWith("R0lGOD")) return "image/gif";
	if (base64.startsWith("UklGR")) return "image/webp";
	return "image/png";
}

function createClient(
	model: ImagesModel<"deepinfra-images">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): OpenAI {
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: providerHeadersToRecord({ ...model.headers, ...optionsHeaders }),
	});
}

function buildParams(model: ImagesModel<"deepinfra-images">, context: ImagesContext): ImageGenerateParamsNonStreaming {
	const prompt = context.input
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => sanitizeSurrogates(item.text))
		.join("\n");
	return {
		model: model.id,
		prompt,
		n: 1,
		response_format: "b64_json",
		stream: false,
	};
}
