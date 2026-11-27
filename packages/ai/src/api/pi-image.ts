import type {
	AssistantImages,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
	ImagesOutputContent,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { isRecord, parsePiUsage, postJsonRequest } from "./json-request.ts";

/**
 * pi-image API implementation.
 *
 * Sends pi's own image-generation protocol directly to a backend: the request
 * is a single POST of `{ model, context, options }` to `<baseUrl>/image`, and
 * a `200 OK` response is a completed `{ output, usage?, responseId? }` JSON
 * object. Errors use non-2xx HTTP statuses with the
 * `{ error: { message, code?, details? } }` envelope, matching `pi-messages`
 * and `pi-decision`.
 */

const LABEL = "Pi Image";

export interface PiImageOptions extends ImagesOptions {
	/** Optional session identifier for gateway correlation/analytics. */
	sessionId?: string;
}

/** Wire request body sent by `pi-image` to `POST <baseUrl>/image`. */
export type PiImageRequest = {
	model: string;
	context: ImagesContext;
	options?: {
		aspectRatio?: string;
		size?: string;
		sessionId?: string;
		metadata?: Record<string, unknown>;
	};
};

/** Wire response body returned by a `pi-image` backend on `200 OK`. */
export type PiImageResponse = {
	output: ImagesOutputContent[];
	usage?: Usage;
	responseId?: string;
};

function parseOutput(value: unknown): ImagesOutputContent[] {
	if (!Array.isArray(value)) throw new Error(`${LABEL} returned an unexpected response`);
	return value.map((item, index): ImagesOutputContent => {
		if (!isRecord(item)) throw new Error(`${LABEL} returned an invalid output block at index ${index}`);
		if (item.type === "text") {
			if (typeof item.text !== "string") {
				throw new Error(`${LABEL} returned an invalid text block at index ${index}`);
			}
			return { type: "text", text: item.text };
		}
		if (item.type === "image") {
			if (typeof item.data !== "string" || !item.data || typeof item.mimeType !== "string" || !item.mimeType) {
				throw new Error(`${LABEL} returned an invalid image block at index ${index}`);
			}
			return { type: "image", data: item.data, mimeType: item.mimeType };
		}
		throw new Error(`${LABEL} returned an unknown output block type at index ${index}`);
	});
}

/** Image generation through pi's canonical `POST <baseUrl>/image` protocol. */
export const generateImages: ImagesFunction<PiImageOptions> = async (model, context, options) => {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== "pi-image") throw new Error(`Unsupported image API: ${model.api}`);
		const hasInputImages = context.input.some((item) => item.type === "image");
		if (hasInputImages && !model.input.includes("image")) {
			throw new Error(`${LABEL} model ${model.id} does not support image input`);
		}
		const url = new URL("image", `${model.baseUrl.replace(/\/+$/u, "")}/`);
		const wireOptions: PiImageRequest["options"] = {
			...(options?.aspectRatio !== undefined ? { aspectRatio: options.aspectRatio } : {}),
			...(options?.size !== undefined ? { size: options.size } : {}),
			...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
			...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
		};
		const requestBody: PiImageRequest = {
			model: model.id,
			context: { input: context.input },
			...(Object.keys(wireOptions).length > 0 ? { options: wireOptions } : {}),
		};
		const body = await postJsonRequest(LABEL, url, model, requestBody, options);
		if (!isRecord(body)) throw new Error(`${LABEL} returned an unexpected response`);
		if (typeof body.responseId === "string" && body.responseId) output.responseId = body.responseId;
		const usage = parsePiUsage(body.usage, model);
		if (usage) output.usage = usage;
		output.output = parseOutput(body.output);
		return output;
	} catch (error) {
		output.output = [];
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error), `${LABEL} error`);
		return output;
	}
};
