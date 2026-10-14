// Image wire format adapted from pi-antigravity 0.9.0 (MIT, Rahul Arya).
// See antigravity/LICENSE. The shared transport retains the full license notice.
import { calculateCost } from "../models.ts";
import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ImagesOptions } from "../types.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { antigravityHeaders, endpointCandidates, jsonOrTextError, parseApiKey } from "./antigravity/client.ts";
import { safeError } from "./antigravity/security.ts";
import { fetchWithHeaderDeadline, streamHeaderTimeoutMs, streamStallTimeoutMs } from "./antigravity/stream.ts";
import type { GeminiInlineDataPart, GeminiTextPart, StreamUsageMetadata } from "./antigravity/types.ts";
import { antigravityRequestEnvelope, sanitizeText } from "./antigravity/util.ts";

export interface AntigravityImagesOptions extends ImagesOptions {
	/** Also accepted as metadata.aspectRatio through Models.generateImages(). Default: 1:1. */
	aspectRatio?: string;
}

const ASPECT_RATIOS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
const SYSTEM_INSTRUCTION =
	"You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.";

type ImageResponseData = {
	responseId?: string;
	candidates?: {
		content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] };
		finishReason?: string;
	}[];
	usageMetadata?: StreamUsageMetadata;
};
type ImageChunk = ImageResponseData & { response?: ImageResponseData; error?: { message?: string } };

/** One-shot image generation. Returns image bytes as base64; never writes files. */
export async function generateImages(
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options: AntigravityImagesOptions = {},
): Promise<AssistantImages> {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};
	try {
		options.signal?.throwIfAborted();
		if (
			model.type !== "image" ||
			model.id.length > 80 ||
			!/^(gemini-[a-z0-9.+-]*image[a-z0-9.+-]*|imagen-[a-z0-9.+-]+)$/i.test(model.id)
		)
			throw new Error(`Unsupported Antigravity image model: ${model.id}`);
		const ratio = options.aspectRatio ?? options.metadata?.aspectRatio ?? "1:1";
		if (typeof ratio !== "string" || !ASPECT_RATIOS.has(ratio.trim()))
			throw new Error("Unsupported Antigravity image aspect ratio");
		const prompt = context.input
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (!prompt.trim()) throw new Error("Image prompt is required");
		if (prompt.length > 8000) throw new Error("Image prompt is too long (max 8000 characters)");
		const parts = context.input.map((part): GeminiTextPart | GeminiInlineDataPart => {
			if (part.type === "text") return { text: sanitizeText(part.text) };
			if (!model.input.includes("image")) throw new Error(`Model ${model.id} does not support image input`);
			if (!part.data || !/^image\//i.test(part.mimeType)) throw new Error("Invalid image input");
			return { inlineData: { mimeType: part.mimeType, data: part.data } };
		});
		const credentials = parseApiKey(options.apiKey);
		const envelope = await antigravityRequestEnvelope(model.id, {
			isClaude: false,
			isNonGemini: false,
			step: 1,
			lastStepIndex: "0",
			requestIndex: 0,
			conversationId: crypto.randomUUID(),
			trajectoryId: crypto.randomUUID(),
		});
		let payload: unknown = {
			project: credentials.projectId,
			model: model.id,
			request: {
				contents: [{ role: "user", parts }],
				systemInstruction: { role: "user", parts: [{ text: SYSTEM_INSTRUCTION }] },
				generationConfig: { imageConfig: { aspectRatio: ratio.trim() }, candidateCount: 1 },
			},
			requestType: "agent",
			userAgent: "antigravity",
			requestId: envelope.requestId,
		};
		const replacement = await options.onPayload?.(payload, model);
		if (replacement !== undefined) payload = replacement;
		const body = JSON.stringify(payload);
		const headers = providerHeadersToRecord(
			antigravityHeaders(credentials.token, options.env),
			model.headers,
			options.headers,
		);
		const endpoints = endpointCandidates(options.env, model.baseUrl);
		const response = await retryProviderRequest(
			async () => {
				for (const [index, endpoint] of endpoints.entries()) {
					options.signal?.throwIfAborted();
					const response = await fetchWithHeaderDeadline(
						`${endpoint}/v1internal:streamGenerateContent?alt=sse`,
						{ method: "POST", headers, body },
						options.signal,
						options.timeoutMs ?? streamHeaderTimeoutMs(options.env),
						options.timeoutMs ?? streamStallTimeoutMs(options.env),
						options.fetch ?? fetch,
					);
					try {
						await options.onResponse?.(
							{ status: response.status, headers: headersToRecord(response.headers) },
							model,
						);
					} catch (error) {
						await response.body?.cancel().catch(() => undefined);
						throw error;
					}
					if (response.ok) return response;
					const error = Object.assign(
						new Error(
							`Antigravity image request failed (${response.status}): ${safeError(jsonOrTextError(await response.text())).slice(0, 400)}`,
						),
						{ status: response.status, headers: response.headers },
					);
					if (index === endpoints.length - 1 || ![403, 404, 429, 500, 502, 503, 504].includes(response.status))
						throw error;
				}
				throw new Error("No Antigravity endpoint available");
			},
			{ maxRetries: options.maxRetries, maxRetryDelayMs: options.maxRetryDelayMs, signal: options.signal },
		);
		await collectImages(response, output, model, options.signal);
		options.signal?.throwIfAborted();
		if (!output.output.some((part) => part.type === "image")) throw new Error("Antigravity returned no image data");
	} catch (error) {
		output.output = [];
		output.stopReason = options.signal?.aborted ? "aborted" : "error";
		output.errorMessage = safeError(error);
	}
	return output;
}

async function collectImages(
	response: Response,
	output: AssistantImages,
	model: ImageModel<ImageApi>,
	signal?: AbortSignal,
): Promise<void> {
	if (!response.body) throw new Error("Antigravity image response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let terminal = false;
	let doneMarker = false;
	try {
		while (!doneMarker) {
			signal?.throwIfAborted();
			const { value, done } = await reader.read();
			buffer += done ? `${decoder.decode()}\n` : decoder.decode(value, { stream: true });
			let start = 0;
			for (;;) {
				const end = buffer.indexOf("\n", start);
				if (end < 0) break;
				const line = buffer.slice(start, end);
				start = end + 1;
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (!data) continue;
				if (data === "[DONE]") {
					doneMarker = true;
					terminal = true;
					break;
				}
				let chunk: ImageChunk;
				try {
					chunk = JSON.parse(data) as ImageChunk;
				} catch {
					throw new Error("Malformed Antigravity image stream event");
				}
				if (chunk.error) throw new Error(chunk.error.message || "Antigravity image provider error");
				const frame = chunk.response ?? chunk;
				if (frame.responseId) output.responseId = frame.responseId;
				for (const candidate of frame.candidates ?? []) {
					if (candidate.finishReason) {
						if (candidate.finishReason !== "STOP")
							throw new Error(`Antigravity image generation stopped with: ${candidate.finishReason}`);
						terminal = true;
					}
					for (const part of candidate.content?.parts ?? []) {
						if (part.text) output.output.push({ type: "text", text: part.text });
						if (part.inlineData?.data) {
							const mimeType = part.inlineData.mimeType ?? "image/png";
							if (!/^image\//i.test(mimeType)) throw new Error("Antigravity returned non-image inline data");
							output.output.push({ type: "image", data: part.inlineData.data, mimeType });
						}
					}
				}
				if (frame.usageMetadata) {
					const usage = frame.usageMetadata;
					output.usage = {
						input: Math.max(0, (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0)),
						output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
						cacheRead: usage.cachedContentTokenCount ?? 0,
						cacheWrite: 0,
						totalTokens:
							usage.totalTokenCount ??
							(usage.promptTokenCount ?? 0) +
								(usage.candidatesTokenCount ?? 0) +
								(usage.thoughtsTokenCount ?? 0),
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					calculateCost(model, output.usage);
				}
			}
			buffer = buffer.slice(start);
			if (done) break;
		}
		if (!terminal) throw new Error("Antigravity image stream ended before completion");
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
