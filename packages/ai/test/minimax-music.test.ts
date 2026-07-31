import { describe, expect, it } from "vitest";
import { generateMusic } from "../src/music.ts";
import { getMusicModel, getMusicModels } from "../src/music-model-catalog.ts";

describe("MiniMax music generation", () => {
	it("sends every generation field to the global endpoint and parses hexadecimal audio", async () => {
		const model = getMusicModel("minimax", "music-3.0");
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		let responseStatus = 0;
		const fetchMock: typeof fetch = async (input, init) => {
			requestUrl = String(input);
			requestInit = init;
			return new Response(
				JSON.stringify({
					trace_id: "trace-global",
					data: { status: 2, audio: "0a0b0c" },
					base_resp: { status_code: 0, status_msg: "success" },
				}),
				{ status: 200, headers: { "x-request-id": "req-global" } },
			);
		};

		const result = await generateMusic(
			model,
			{
				prompt: "A cinematic instrumental",
				lyrics: "[Verse]\nA quiet night",
				stream: true,
				outputFormat: "hex",
				audioSetting: { sampleRate: 44100, bitrate: 256000, format: "wav" },
				lyricsOptimizer: true,
				isInstrumental: false,
				audioUrl: "https://example.test/input.mp3",
				audioBase64: "ZmFrZS1hdWRpbw==",
				coverFeatureId: "feature-1",
				aigcWatermark: true,
			},
			{
				apiKey: "test-key",
				fetch: fetchMock,
				headers: { "x-client": "pi" },
				onResponse: (response) => {
					responseStatus = response.status;
				},
			},
		);

		expect(requestUrl).toBe("https://api.minimax.io/v1/music_generation");
		expect(requestInit?.method).toBe("POST");
		const headers = new Headers(requestInit?.headers);
		expect(headers.get("authorization")).toBe("Bearer test-key");
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("x-client")).toBe("pi");
		expect(JSON.parse(String(requestInit?.body))).toEqual({
			model: "music-3.0",
			prompt: "A cinematic instrumental",
			lyrics: "[Verse]\nA quiet night",
			stream: true,
			output_format: "hex",
			audio_setting: { sample_rate: 44100, bitrate: 256000, format: "wav" },
			lyrics_optimizer: true,
			is_instrumental: false,
			audio_url: "https://example.test/input.mp3",
			audio_base64: "ZmFrZS1hdWRpbw==",
			cover_feature_id: "feature-1",
		});
		expect(responseStatus).toBe(200);
		expect(result).toMatchObject({
			responseId: "trace-global",
			status: "completed",
			stopReason: "stop",
			output: [
				{
					type: "audio",
					data: "0a0b0c",
					outputFormat: "hex",
					audioFormat: "wav",
				},
			],
		});
	});

	it("uses the CN endpoint, sends the regional watermark, and parses URL output", async () => {
		const model = getMusicModel("minimax-cn", "music-2.6");
		let requestUrl = "";
		let payload: Record<string, unknown> = {};
		const fetchMock: typeof fetch = async (input, init) => {
			requestUrl = String(input);
			payload = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					trace_id: "trace-cn",
					data: { status: 2, audio: "https://example.test/output.mp3" },
					base_resp: { status_code: 0 },
				}),
				{ status: 200 },
			);
		};

		const result = await generateMusic(
			model,
			{
				prompt: "An upbeat instrumental",
				outputFormat: "url",
				audioSetting: { format: "mp3" },
				aigcWatermark: true,
			},
			{ apiKey: "test-key", fetch: fetchMock },
		);

		expect(requestUrl).toBe("https://api.minimaxi.com/v1/music_generation");
		expect(payload).toMatchObject({
			model: "music-2.6",
			output_format: "url",
			audio_setting: { format: "mp3" },
			aigc_watermark: true,
		});
		expect(result.output[0]).toEqual({
			type: "audio",
			data: "https://example.test/output.mp3",
			outputFormat: "url",
			audioFormat: "mp3",
		});
		expect(model.urlTtlHours).toBe(24);
	});

	it("exposes every generation model and supported output format in both regional catalogs", () => {
		for (const provider of ["minimax", "minimax-cn"] as const) {
			const models = getMusicModels(provider);
			expect(models.map((model) => model.id)).toEqual([
				"music-3.0",
				"music-2.6",
				"music-3.0-free",
				"music-2.6-free",
			]);
			expect(models.every((model) => model.outputFormats.join(",") === "url,hex")).toBe(true);
			expect(models.every((model) => model.audioFormats.join(",") === "mp3,wav,pcm")).toBe(true);
		}
	});

	it("returns in-progress responses and rejects URL output for streaming requests", async () => {
		const model = getMusicModel("minimax", "music-3.0");
		const fetchMock: typeof fetch = async () =>
			new Response(JSON.stringify({ data: { status: 1, audio: "0a" }, base_resp: { status_code: 0 } }), {
				status: 200,
			});

		const inProgress = await generateMusic(model, { stream: true }, { apiKey: "test-key", fetch: fetchMock });
		expect(inProgress).toMatchObject({ status: "in_progress", stopReason: "in_progress" });
		expect(inProgress.output[0]).toMatchObject({ outputFormat: "hex", data: "0a" });

		const invalid = await generateMusic(
			model,
			{ stream: true, outputFormat: "url" },
			{ apiKey: "test-key", fetch: fetchMock },
		);
		expect(invalid.stopReason).toBe("error");
		expect(invalid.errorMessage).toContain("streaming supports hex output only");
	});

	it("returns an error result when the API status code is non-zero", async () => {
		const model = getMusicModel("minimax", "music-3.0");
		const fetchMock: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					data: { status: 2, audio: "0a" },
					base_resp: { status_code: 1001, status_msg: "request rejected" },
				}),
				{ status: 200 },
			);

		const result = await generateMusic(model, {}, { apiKey: "test-key", fetch: fetchMock });
		expect(result.stopReason).toBe("error");
		expect(result.output).toEqual([]);
		expect(result.errorMessage).toContain("MiniMax music API error (1001): request rejected");
	});
});
