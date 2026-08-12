import { describe, expect, it, vi } from "vitest";
import { generateSpeech } from "../src/speech.ts";
import { getSpeechModel, getSpeechModels } from "../src/speech-models.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", "x-request-id": "request-1" },
	});
}

describe("MiniMax speech", () => {
	it("catalogs every configured model for global and CN endpoints", () => {
		expect(getSpeechModels("minimax").map((model) => model.id)).toEqual([
			"speech-2.8-hd",
			"speech-2.8-turbo",
			"speech-2.6-hd",
			"speech-2.6-turbo",
			"speech-02-hd",
			"speech-02-turbo",
			"speech-01-hd",
			"speech-01-turbo",
		]);
		expect(getSpeechModels("minimax-cn")).toHaveLength(8);
		expect(getSpeechModel("minimax", "speech-2.8-hd").baseUrl).toBe("https://api.minimax.io/v1/t2a_v2");
		expect(getSpeechModel("minimax-cn", "speech-2.8-hd").baseUrl).toBe("https://api.minimaxi.com/v1/t2a_v2");
	});

	it("sends the synchronous request schema and converts hexadecimal audio to base64", async () => {
		const fetch = vi.fn(
			async (_input: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]) =>
				jsonResponse({
					data: { audio: "48656c6c6f", status: 2 },
					trace_id: "trace-1",
					base_resp: { status_code: 0, status_msg: "success" },
				}),
		);
		const onResponse = vi.fn();
		const model = getSpeechModel("minimax", "speech-2.8-hd");

		const result = await generateSpeech(
			model,
			{ text: "Hello" },
			{
				apiKey: "test-key",
				fetch,
				onResponse,
				languageBoost: "English",
				voiceSetting: { voiceId: "English_expressive_narrator", speed: 1, volume: 0.8, pitch: 0 },
				pronunciationDictionary: { tone: ["Omg/Oh my god"] },
				audioSetting: { sampleRate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
				voiceModification: { pitch: 0, intensity: 1, timbre: 2, soundEffects: "spacious_echo" },
				subtitleEnabled: true,
			},
		);

		expect(result).toMatchObject({
			stopReason: "stop",
			responseId: "trace-1",
			output: [{ type: "audio", data: "SGVsbG8=", mimeType: "audio/mpeg" }],
		});
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://api.minimax.io/v1/t2a_v2");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "speech-2.8-hd",
			text: "Hello",
			stream: false,
			output_format: "hex",
			language_boost: "English",
			voice_setting: {
				voice_id: "English_expressive_narrator",
				speed: 1,
				vol: 0.8,
				pitch: 0,
			},
			pronunciation_dict: { tone: ["Omg/Oh my god"] },
			audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
			voice_modify: { pitch: 0, intensity: 1, timbre: 2, sound_effects: "spacious_echo" },
			subtitle_enable: true,
		});
		expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }), model);
	});

	it("uses the CN endpoint and preserves URL output", async () => {
		const fetch = vi.fn(
			async (_input: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]) =>
				jsonResponse({
					data: { audio: "https://audio.example.test/result.wav", status: 2 },
					base_resp: { status_code: 0, status_msg: "success" },
				}),
		);
		const result = await generateSpeech(
			getSpeechModel("minimax-cn", "speech-2.8-turbo"),
			{ text: "你好" },
			{
				apiKey: "test-key",
				fetch,
				outputFormat: "url",
				audioSetting: { format: "wav" },
			},
		);

		expect(fetch.mock.calls[0][0]).toBe("https://api.minimaxi.com/v1/t2a_v2");
		expect(result.output).toEqual([
			{ type: "audio", url: "https://audio.example.test/result.wav", mimeType: "audio/wav" },
		]);
	});

	it("returns API status failures as error results", async () => {
		const result = await generateSpeech(
			getSpeechModel("minimax", "speech-2.8-hd"),
			{ text: "Hello" },
			{
				apiKey: "test-key",
				fetch: async () =>
					jsonResponse({
						data: null,
						base_resp: { status_code: 2013, status_msg: "invalid input parameters" },
					}),
			},
		);

		expect(result.stopReason).toBe("error");
		expect(result.output).toEqual([]);
		expect(result.errorMessage).toContain("2013");
	});

	it("rejects incomplete audio responses", async () => {
		const result = await generateSpeech(
			getSpeechModel("minimax", "speech-2.8-hd"),
			{ text: "Hello" },
			{
				apiKey: "test-key",
				fetch: async () =>
					jsonResponse({
						data: { audio: "4869", status: 1 },
						base_resp: { status_code: 0, status_msg: "success" },
					}),
			},
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("incomplete");
	});

	it("passes through abort signals", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await generateSpeech(
			getSpeechModel("minimax", "speech-2.8-hd"),
			{ text: "Hello" },
			{
				apiKey: "test-key",
				signal: controller.signal,
				fetch: async (_input, init) => {
					init?.signal?.throwIfAborted();
					return jsonResponse({});
				},
			},
		);

		expect(result.stopReason).toBe("aborted");
		expect(result.output).toEqual([]);
	});
});
