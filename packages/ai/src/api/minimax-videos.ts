import type {
	AssistantVideos,
	ProviderHeaders,
	ProviderResponse,
	VideoGenerationAsset,
	VideosContext,
	VideosFunction,
	VideosModel,
	VideosOptions,
} from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { formatProviderError, normalizeProviderError, truncateErrorText } from "../utils/error-body.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

export const MINIMAX_VIDEO_MODELS = {
	v2: ["MiniMax-H3"],
	v1: [
		"MiniMax-Hailuo-2.3",
		"MiniMax-Hailuo-2.3-Fast",
		"MiniMax-Hailuo-02",
		"T2V-01-Director",
		"T2V-01",
		"I2V-01-Director",
		"I2V-01-live",
		"I2V-01",
	],
} as const;

export const MINIMAX_VIDEO_BASE_URLS = {
	minimax: {
		v2: "https://api.minimax.io/v2/video_generation",
		v1: "https://api.minimax.io/v1/video_generation",
	},
	"minimax-cn": {
		v2: "https://api.minimaxi.com/v2/video_generation",
		v1: "https://api.minimaxi.com/v1/video_generation",
	},
} as const;

export interface MiniMaxVideosOptions extends VideosOptions {
	[key: string]: unknown;
}

type MiniMaxVideoPayload = Record<string, unknown>;

interface MiniMaxVideoResponse {
	task_id?: unknown;
	status?: unknown;
	file_id?: unknown;
	file?: { download_url?: unknown; url?: unknown };
	task?: {
		id?: unknown;
		model?: unknown;
		status?: unknown;
		error?: unknown;
		content?: { url?: unknown };
	};
	base_resp?: {
		status_code?: unknown;
		status_msg?: unknown;
	};
}

class MiniMaxVideoHttpError extends Error {
	readonly status: number;
	readonly headers: Headers;
	readonly body: string;

	constructor(response: Response, body: string) {
		const detail = body.trim();
		super(
			`MiniMax video request failed with HTTP ${response.status}${detail ? `: ${truncateErrorText(detail, 4000)}` : ""}`,
		);
		this.name = "MiniMaxVideoHttpError";
		this.status = response.status;
		this.headers = response.headers;
		this.body = detail;
	}
}

export const generateVideos: VideosFunction<"minimax-videos", MiniMaxVideosOptions> = async (
	model: VideosModel<"minimax-videos">,
	context: VideosContext,
	options?: MiniMaxVideosOptions,
) =>
	withVideoErrors(model, options, async (output) => {
		const apiKey = requireApiKey(model, options);
		let payload =
			model.apiVersion === "v2" ? buildV2CreatePayload(model, context) : buildV1CreatePayload(model, context);
		const nextPayload = await options?.onPayload?.(payload, model);
		if (nextPayload !== undefined) payload = nextPayload as MiniMaxVideoPayload;
		const response = await requestJson(model, model.baseUrl, "POST", apiKey, payload, options);
		applyResponse(output, response.body);
		return output;
	});

export async function queryVideoGeneration(
	model: VideosModel<"minimax-videos">,
	taskId: string,
	options?: MiniMaxVideosOptions,
): Promise<AssistantVideos> {
	return withVideoErrors(model, options, async (output) => {
		const apiKey = requireApiKey(model, options);
		const url =
			model.apiVersion === "v2"
				? `${model.baseUrl.replace(/\/video_generation$/, "/query/video_generation")}/${encodeURIComponent(taskId)}`
				: `${model.baseUrl.replace(/\/video_generation$/, "/query/video_generation")}?task_id=${encodeURIComponent(taskId)}`;
		const response = await requestJson(model, url, "GET", apiKey, undefined, options);
		applyResponse(output, response.body);
		if (!output.taskId) output.taskId = taskId;
		return output;
	});
}

export async function downloadVideo(
	model: VideosModel<"minimax-videos">,
	fileId: string,
	options?: MiniMaxVideosOptions,
): Promise<AssistantVideos> {
	return withVideoErrors(model, options, async (output) => {
		if (model.apiVersion !== "v1") throw new Error("MiniMax video download is available for v1 file IDs");
		const apiKey = requireApiKey(model, options);
		const url = `${model.baseUrl.replace(/\/video_generation$/, "/files/retrieve")}?file_id=${encodeURIComponent(fileId)}`;
		const response = await requestJson(model, url, "GET", apiKey, undefined, options);
		applyResponse(output, response.body);
		output.fileId = output.fileId ?? fileId;
		return output;
	});
}

function buildV2CreatePayload(model: VideosModel<"minimax-videos">, context: VideosContext): MiniMaxVideoPayload {
	const content = buildV2Content(context);
	if (!content.some((item) => item.type === "text")) throw new Error("MiniMax video generation requires text content");
	const duration = context.duration ?? model.durationSeconds.min;
	assertDuration(model, duration);
	const resolution = context.resolution ?? model.resolutions[0];
	assertIncludes(model.resolutions, resolution, "resolution");
	const payload: MiniMaxVideoPayload = {
		model: model.id,
		content,
		resolution,
		duration,
	};
	if (context.ratio !== undefined) payload.ratio = context.ratio;
	if (context.callbackUrl !== undefined) payload.callback_url = context.callbackUrl;
	if (model.provider === "minimax-cn" && context.aigcWatermark !== undefined)
		payload.aigc_watermark = context.aigcWatermark;
	return payload;
}

function buildV2Content(context: VideosContext): Array<Record<string, unknown>> {
	const items: Array<Record<string, unknown>> = [];
	if (context.prompt !== undefined) items.push({ type: "text", text: sanitizeSurrogates(context.prompt) });
	for (const item of context.input ?? []) {
		if (item.type === "text") {
			items.push({ type: "text", text: sanitizeSurrogates(item.text) });
		} else if (item.type === "image") {
			items.push({ type: "image_url", image_url: `data:${item.mimeType};base64,${item.data}` });
		} else {
			items.push(contentAsset(item));
		}
	}
	return items;
}

function contentAsset(item: VideoGenerationAsset): Record<string, unknown> {
	const field = item.type;
	return {
		type: item.type,
		[field]: item.url,
		...(item.role ? { role: item.role } : {}),
	};
}

function buildV1CreatePayload(model: VideosModel<"minimax-videos">, context: VideosContext): MiniMaxVideoPayload {
	const payload: MiniMaxVideoPayload = { model: model.id };
	if (context.prompt !== undefined) payload.prompt = sanitizeSurrogates(context.prompt);
	const firstImage = context.firstFrameImage ?? firstImageFromInput(context);
	if (firstImage !== undefined) payload.first_frame_image = firstImage;
	if (!payload.prompt && !payload.first_frame_image)
		throw new Error("MiniMax video generation requires prompt or first frame");
	if (context.promptOptimizer !== undefined) payload.prompt_optimizer = context.promptOptimizer;
	if (context.fastPretreatment !== undefined) payload.fast_pretreatment = context.fastPretreatment;
	if (context.duration !== undefined) payload.duration = context.duration;
	if (context.resolution !== undefined) payload.resolution = context.resolution;
	if (context.callbackUrl !== undefined) payload.callback_url = context.callbackUrl;
	return payload;
}

function firstImageFromInput(context: VideosContext): string | undefined {
	for (const item of context.input ?? []) {
		if (item.type === "image") return `data:${item.mimeType};base64,${item.data}`;
		if (item.type === "image_url") return item.url;
	}
	return undefined;
}

async function requestJson(
	model: VideosModel<"minimax-videos">,
	url: string,
	method: "GET" | "POST" | "DELETE",
	apiKey: string,
	payload: MiniMaxVideoPayload | undefined,
	options?: MiniMaxVideosOptions,
): Promise<{ response: ProviderResponse; body: MiniMaxVideoResponse }> {
	const combinedSignal = combineAbortSignals([
		options?.signal,
		options?.timeoutMs !== undefined && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined,
	]);
	try {
		const response = await retryProviderRequest(
			() => fetchJson(url, method, apiKey, model.headers, options, payload, combinedSignal.signal),
			{ maxRetries: options?.maxRetries, maxRetryDelayMs: options?.maxRetryDelayMs, signal: combinedSignal.signal },
		);
		await options?.onResponse?.(response.response, model);
		return response;
	} finally {
		combinedSignal.cleanup();
	}
}

async function fetchJson(
	url: string,
	method: "GET" | "POST" | "DELETE",
	apiKey: string,
	modelHeaders: ProviderHeaders | undefined,
	options: MiniMaxVideosOptions | undefined,
	payload: MiniMaxVideoPayload | undefined,
	signal: AbortSignal | undefined,
): Promise<{ response: ProviderResponse; body: MiniMaxVideoResponse }> {
	const fetcher = options?.fetch ?? globalThis.fetch;
	const response = await fetcher(url, {
		method,
		headers: {
			authorization: `Bearer ${apiKey}`,
			...(payload !== undefined ? { "content-type": "application/json" } : {}),
			...providerHeadersToRecord({ ...modelHeaders, ...options?.headers }),
		},
		...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
		signal,
	});
	const bodyText = await response.text();
	if (!response.ok) throw new MiniMaxVideoHttpError(response, bodyText);
	return {
		response: { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
		body: parseResponse(bodyText),
	};
}

function applyResponse(output: AssistantVideos, response: MiniMaxVideoResponse): void {
	const statusCode = response.base_resp?.status_code;
	if (statusCode !== undefined && statusCode !== 0) {
		const message =
			typeof response.base_resp?.status_msg === "string" ? response.base_resp.status_msg : "unknown error";
		throw new Error(`MiniMax video API error (${String(statusCode)}): ${message}`);
	}
	const taskId = stringValue(response.task_id) ?? stringValue(response.task?.id);
	if (taskId) {
		output.taskId = taskId;
		output.responseId = taskId;
	}
	const fileId = stringValue(response.file_id);
	if (fileId) output.fileId = fileId;
	const status = normalizeStatus(response.task?.status ?? response.status);
	if (status) {
		output.status = status;
		output.stopReason = status === "completed" ? "stop" : status === "in_progress" ? "in_progress" : "error";
	}
	const error = response.task?.error;
	if (typeof error === "string" && error.length > 0) output.errorMessage = error;
	const url =
		stringValue(response.task?.content?.url) ??
		stringValue(response.file?.download_url) ??
		stringValue(response.file?.url);
	if (url) output.output.push({ type: "video", url });
}

async function withVideoErrors(
	model: VideosModel<"minimax-videos">,
	options: MiniMaxVideosOptions | undefined,
	fn: (output: AssistantVideos) => Promise<AssistantVideos>,
): Promise<AssistantVideos> {
	const output: AssistantVideos = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};
	try {
		return await fn(output);
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
}

function requireApiKey(model: VideosModel<"minimax-videos">, options?: MiniMaxVideosOptions): string {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	return apiKey;
}

function parseResponse(bodyText: string): MiniMaxVideoResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch (error) {
		throw new Error(
			`MiniMax video response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("MiniMax video response was not an object");
	}
	return parsed as MiniMaxVideoResponse;
}

function normalizeStatus(status: unknown): AssistantVideos["status"] | undefined {
	if (typeof status !== "string") return undefined;
	const value = status.toLowerCase();
	if (["success", "completed", "complete"].includes(value)) return "completed";
	if (["processing", "queueing", "preparing", "running", "in_progress", "pending"].includes(value))
		return "in_progress";
	if (["failed", "fail", "error"].includes(value)) return "failed";
	if (value === "deleted") return "deleted";
	return undefined;
}

function assertIncludes(values: readonly string[], value: string, label: string): void {
	if (!values.includes(value)) throw new Error(`Unsupported MiniMax video ${label}: ${value}`);
}

function assertDuration(model: VideosModel<"minimax-videos">, duration: number): void {
	const { min, max, integer } = model.durationSeconds;
	if (duration < min || duration > max || (integer && !Number.isInteger(duration))) {
		throw new Error(`Unsupported MiniMax video duration: ${duration}`);
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
