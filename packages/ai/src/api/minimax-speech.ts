import type {
	AssistantSpeech,
	SpeechAudioFormat,
	SpeechContext,
	SpeechFunction,
	SpeechModel,
	SpeechOptions,
} from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { formatProviderError, normalizeProviderError, truncateErrorText } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";

interface MinimaxSpeechRequest {
	model: string;
	text: string;
	stream: false;
	language_boost?: string;
	output_format: "hex" | "url";
	voice_setting?: {
		voice_id: string;
		speed?: number;
		vol?: number;
		pitch?: number;
		emotion?: string;
	};
	pronunciation_dict?: { tone?: string[] };
	audio_setting?: {
		sample_rate?: number;
		bitrate?: number;
		format?: SpeechAudioFormat;
		channel?: number;
	};
	voice_modify?: {
		pitch?: number;
		intensity?: number;
		timbre?: number;
		sound_effects?: string;
	};
	subtitle_enable?: boolean;
}

interface MinimaxSpeechResponse {
	data?: { audio?: string; status?: number } | null;
	trace_id?: string;
	base_resp?: { status_code?: number; status_msg?: string };
}

class SpeechHttpError extends Error {
	status: number;
	headers: Headers;
	body: string;

	constructor(response: Response, body: string) {
		super(`Speech request failed with status ${response.status}`);
		this.name = "SpeechHttpError";
		this.status = response.status;
		this.headers = response.headers;
		this.body = truncateErrorText(body, 4000);
	}
}

export const generateSpeech: SpeechFunction<"minimax-speech", SpeechOptions> = async (
	model: SpeechModel<"minimax-speech">,
	context: SpeechContext,
	options?: SpeechOptions,
) => {
	const output: AssistantSpeech = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	let timeout: ReturnType<typeof setTimeout> | undefined;
	let cleanupSignal = () => {};
	try {
		if (!options?.apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		if (context.text.length === 0) {
			throw new Error("Speech text must not be empty");
		}

		let payload = buildPayload(model, context, options);
		const nextPayload = await options.onPayload?.(payload, model);
		if (nextPayload !== undefined) {
			payload = nextPayload as MinimaxSpeechRequest;
		}
		const format = payload.audio_setting?.format ?? "mp3";
		if (!model.audioFormats.includes(format)) {
			throw new Error(`Unsupported audio format: ${format}`);
		}

		const timeoutController = options.timeoutMs === undefined ? undefined : new AbortController();
		if (timeoutController) {
			timeout = setTimeout(() => timeoutController.abort(new Error("Speech request timed out")), options.timeoutMs);
		}
		const combinedSignal = combineAbortSignals([options.signal, timeoutController?.signal]);
		cleanupSignal = combinedSignal.cleanup;

		const headers = providerHeadersToRecord({
			...model.headers,
			Authorization: `Bearer ${options.apiKey}`,
			"Content-Type": "application/json",
			...options.headers,
		});
		const requestFetch = options.fetch ?? globalThis.fetch;
		const { response, responseBody } = await retryProviderRequest(
			async () => {
				const response = await requestFetch(model.baseUrl, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					signal: combinedSignal.signal,
				});
				const responseBody = await response.text();
				if (!response.ok) {
					throw new SpeechHttpError(response, responseBody);
				}
				return { response, responseBody };
			},
			{
				maxRetries: options.maxRetries,
				maxRetryDelayMs: options.maxRetryDelayMs,
				signal: combinedSignal.signal,
			},
		);
		await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

		const parsed = JSON.parse(responseBody) as MinimaxSpeechResponse;
		const statusCode = parsed.base_resp?.status_code;
		if (statusCode !== 0) {
			throw new Error(
				`Speech request failed (${statusCode ?? "unknown"}): ${parsed.base_resp?.status_msg ?? "unknown error"}`,
			);
		}
		if (parsed.data?.status !== 2) {
			throw new Error(`Speech response is incomplete (status ${parsed.data?.status ?? "missing"})`);
		}
		if (!parsed.data.audio) {
			throw new Error("Speech response did not include audio");
		}

		const mimeType = audioMimeType(format);
		output.responseId = parsed.trace_id;
		output.output.push(
			payload.output_format === "url"
				? { type: "audio", url: validateAudioUrl(parsed.data.audio), mimeType }
				: { type: "audio", data: hexToBase64(parsed.data.audio), mimeType },
		);
		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		cleanupSignal();
	}
};

function buildPayload(
	model: SpeechModel<"minimax-speech">,
	context: SpeechContext,
	options: SpeechOptions,
): MinimaxSpeechRequest {
	return {
		model: model.id,
		text: context.text,
		stream: false,
		output_format: options.outputFormat ?? "hex",
		...(options.languageBoost === undefined ? {} : { language_boost: options.languageBoost }),
		...(options.voiceSetting === undefined
			? {}
			: {
					voice_setting: {
						voice_id: options.voiceSetting.voiceId,
						...(options.voiceSetting.speed === undefined ? {} : { speed: options.voiceSetting.speed }),
						...(options.voiceSetting.volume === undefined ? {} : { vol: options.voiceSetting.volume }),
						...(options.voiceSetting.pitch === undefined ? {} : { pitch: options.voiceSetting.pitch }),
						...(options.voiceSetting.emotion === undefined ? {} : { emotion: options.voiceSetting.emotion }),
					},
				}),
		...(options.pronunciationDictionary === undefined ? {} : { pronunciation_dict: options.pronunciationDictionary }),
		...(options.audioSetting === undefined
			? {}
			: {
					audio_setting: {
						...(options.audioSetting.sampleRate === undefined
							? {}
							: { sample_rate: options.audioSetting.sampleRate }),
						...(options.audioSetting.bitrate === undefined ? {} : { bitrate: options.audioSetting.bitrate }),
						...(options.audioSetting.format === undefined ? {} : { format: options.audioSetting.format }),
						...(options.audioSetting.channel === undefined ? {} : { channel: options.audioSetting.channel }),
					},
				}),
		...(options.voiceModification === undefined
			? {}
			: {
					voice_modify: {
						...(options.voiceModification.pitch === undefined ? {} : { pitch: options.voiceModification.pitch }),
						...(options.voiceModification.intensity === undefined
							? {}
							: { intensity: options.voiceModification.intensity }),
						...(options.voiceModification.timbre === undefined
							? {}
							: { timbre: options.voiceModification.timbre }),
						...(options.voiceModification.soundEffects === undefined
							? {}
							: { sound_effects: options.voiceModification.soundEffects }),
					},
				}),
		...(options.subtitleEnabled === undefined ? {} : { subtitle_enable: options.subtitleEnabled }),
	};
}

function audioMimeType(format: SpeechAudioFormat): string {
	switch (format) {
		case "mp3":
			return "audio/mpeg";
		case "wav":
			return "audio/wav";
		case "flac":
			return "audio/flac";
		case "pcm":
			return "audio/L16";
	}
}

function validateAudioUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Unsupported audio URL protocol: ${url.protocol}`);
	}
	return url.toString();
}

function hexToBase64(hex: string): string {
	if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
		throw new Error("Speech response audio is not valid hexadecimal data");
	}
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index++) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	let binary = "";
	for (let index = 0; index < bytes.length; index += 32768) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
	}
	return btoa(binary);
}
