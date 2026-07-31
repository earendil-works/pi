import type {
	AssistantMusic,
	MusicContext,
	MusicFunction,
	MusicModel,
	MusicOptions,
	ProviderResponse,
} from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { formatProviderError, normalizeProviderError, truncateErrorText } from "../utils/error-body.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

interface MiniMaxMusicResponse {
	trace_id?: unknown;
	data?: {
		status?: unknown;
		audio?: unknown;
	};
	base_resp?: {
		status_code?: unknown;
		status_msg?: unknown;
	};
}

type MiniMaxMusicPayload = Record<string, unknown>;

class MiniMaxMusicHttpError extends Error {
	readonly status: number;
	readonly headers: Headers;
	readonly body: string;

	constructor(response: Response, body: string) {
		const detail = body.trim();
		super(
			`MiniMax music request failed with HTTP ${response.status}${detail ? `: ${truncateErrorText(detail, 4000)}` : ""}`,
		);
		this.name = "MiniMaxMusicHttpError";
		this.status = response.status;
		this.headers = response.headers;
		this.body = detail;
	}
}

export const generateMusic: MusicFunction<"minimax-music", MusicOptions> = async (
	model: MusicModel<"minimax-music">,
	context: MusicContext,
	options?: MusicOptions,
) => {
	const output: AssistantMusic = {
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

		let payload = buildPayload(model, context);
		const nextPayload = await options?.onPayload?.(payload, model);
		if (nextPayload !== undefined) payload = nextPayload as MiniMaxMusicPayload;

		const combinedSignal = combineAbortSignals([
			options?.signal,
			options?.timeoutMs !== undefined && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined,
		]);
		try {
			const response = await retryProviderRequest(
				() => requestMusic(model, payload, apiKey, options, combinedSignal.signal),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: combinedSignal.signal,
				},
			);
			await options?.onResponse?.(response.response, model);
			return applyResponse(output, response.body, context, model);
		} finally {
			combinedSignal.cleanup();
		}
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
};

async function requestMusic(
	model: MusicModel<"minimax-music">,
	payload: MiniMaxMusicPayload,
	apiKey: string,
	options: MusicOptions | undefined,
	signal: AbortSignal | undefined,
): Promise<{ response: ProviderResponse; body: MiniMaxMusicResponse }> {
	const fetcher = options?.fetch ?? globalThis.fetch;
	const response = await fetcher(model.baseUrl, {
		method: "POST",
		headers: {
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
			...providerHeadersToRecord({ ...model.headers, ...options?.headers }),
		},
		body: JSON.stringify(payload),
		signal,
	});
	const bodyText = await response.text();
	if (!response.ok) throw new MiniMaxMusicHttpError(response, bodyText);

	return {
		response: { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
		body: parseResponse(bodyText),
	};
}

function buildPayload(model: MusicModel<"minimax-music">, context: MusicContext): MiniMaxMusicPayload {
	const payload: MiniMaxMusicPayload = { model: model.id };
	if (context.prompt !== undefined) payload.prompt = sanitizeSurrogates(context.prompt);
	if (context.lyrics !== undefined) payload.lyrics = sanitizeSurrogates(context.lyrics);
	if (context.stream !== undefined) payload.stream = context.stream;

	const outputFormat = context.outputFormat ?? (context.stream ? "hex" : undefined);
	if (context.stream && outputFormat === "url") {
		throw new Error("MiniMax music streaming supports hex output only");
	}
	if (outputFormat !== undefined) {
		assertIncludes(model.outputFormats, outputFormat, "output format");
		payload.output_format = outputFormat;
	}

	if (context.audioSetting !== undefined) {
		const audioSetting: Record<string, unknown> = {};
		if (context.audioSetting.sampleRate !== undefined) audioSetting.sample_rate = context.audioSetting.sampleRate;
		if (context.audioSetting.bitrate !== undefined) audioSetting.bitrate = context.audioSetting.bitrate;
		if (context.audioSetting.format !== undefined) {
			assertIncludes(model.audioFormats, context.audioSetting.format, "audio format");
			audioSetting.format = context.audioSetting.format;
		}
		payload.audio_setting = audioSetting;
	}

	if (context.lyricsOptimizer !== undefined) payload.lyrics_optimizer = context.lyricsOptimizer;
	if (context.isInstrumental !== undefined) payload.is_instrumental = context.isInstrumental;
	if (context.audioUrl !== undefined) payload.audio_url = context.audioUrl;
	if (context.audioBase64 !== undefined) payload.audio_base64 = context.audioBase64;
	if (context.coverFeatureId !== undefined) payload.cover_feature_id = context.coverFeatureId;
	if (model.regionalFields.includes("aigc_watermark") && context.aigcWatermark !== undefined) {
		payload.aigc_watermark = context.aigcWatermark;
	}

	return payload;
}

function assertIncludes<T>(values: readonly T[], value: T, label: string): void {
	if (!values.includes(value)) throw new Error(`Unsupported MiniMax music ${label}: ${String(value)}`);
}

function parseResponse(bodyText: string): MiniMaxMusicResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch (error) {
		throw new Error(
			`MiniMax music response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(parsed)) throw new Error("MiniMax music response was not an object");
	return parsed;
}

function applyResponse(
	output: AssistantMusic,
	response: MiniMaxMusicResponse,
	context: MusicContext,
	model: MusicModel<"minimax-music">,
): AssistantMusic {
	const statusCode = response.base_resp?.status_code;
	if (statusCode !== 0) {
		const message =
			typeof response.base_resp?.status_msg === "string" ? response.base_resp.status_msg : "unknown error";
		throw new Error(`MiniMax music API error (${String(statusCode)}): ${message}`);
	}

	const status = response.data?.status;
	if (status !== 1 && status !== 2) throw new Error("MiniMax music response has invalid data.status");
	output.status = status === 1 ? "in_progress" : "completed";
	output.stopReason = status === 1 ? "in_progress" : "stop";
	if (typeof response.trace_id === "string") output.responseId = response.trace_id;

	const audio = response.data?.audio;
	if (typeof audio !== "string" || audio.length === 0) {
		if (status === 2) throw new Error("MiniMax music response is missing data.audio");
		return output;
	}

	const outputFormat = context.outputFormat ?? (isUrl(audio) ? "url" : "hex");
	assertIncludes(model.outputFormats, outputFormat, "output format");
	if (outputFormat === "url" && !isUrl(audio)) throw new Error("MiniMax music response did not contain an audio URL");
	if (outputFormat === "hex" && isUrl(audio))
		throw new Error("MiniMax music response did not contain hexadecimal audio");

	const audioFormat = context.audioSetting?.format;
	output.output.push({
		type: "audio",
		data: audio,
		outputFormat,
		...(audioFormat ? { audioFormat } : {}),
	});
	return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUrl(value: string): boolean {
	return /^https?:\/\//.test(value);
}
