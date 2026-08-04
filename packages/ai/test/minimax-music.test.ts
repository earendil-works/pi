import { describe, expect, it } from "vitest";
import { generateMusic } from "../src/music.ts";
import { getMusicModel, getMusicModels } from "../src/music-model-catalog.ts";

describe("MiniMax music generation and cover", () => {
	it("sends a cover request to the global endpoint and parses URL audio output", async () => {
		const model = getMusicModel("minimax", "music-cover");
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		let responseStatus = 0;
		const fetchMock: typeof fetch = async (input, init) => {
			requestUrl = String(input);
			requestInit = init;
			return new Response(
				JSON.stringify({
					trace_id: "trace-cover-global",
					data: { status: 2, audio: "https://example.test/cover.mp3" },
					base_resp: { status_code: 0, status_msg: "success" },
				}),
				{ status: 200, headers: { "x-request-id": "req-cover-global" } },
			);
		};

		const result = await generateMusic(
			model,
			{
				outputFormat: "url",
				audioUrl: "https://example.test/reference.mp3",
				coverFeatureId: "feature-1",
				audioSetting: { format: "mp3" },
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
			model: "music-cover",
			output_format: "url",
			audio_setting: { format: "mp3" },
			audio_url: "https://example.test/reference.mp3",
			cover_feature_id: "feature-1",
		});
		expect(responseStatus).toBe(200);
		expect(result).toMatchObject({
			responseId: "trace-cover-global",
			status: "completed",
			stopReason: "stop",
			output: [{ type: "audio", data: "https://example.test/cover.mp3", outputFormat: "url", audioFormat: "mp3" }],
		});
	});

	it("sends a cover request to the CN endpoint with aigc_watermark and parses hexadecimal audio", async () => {
		const model = getMusicModel("minimax-cn", "music-cover-free");
		let requestUrl = "";
		let payload: Record<string, unknown> = {};
		const fetchMock: typeof fetch = async (input, init) => {
			requestUrl = String(input);
			payload = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					trace_id: "trace-cover-cn",
					data: { status: 2, audio: "0a0b0c0d" },
					base_resp: { status_code: 0 },
				}),
				{ status: 200 },
			);
		};

		const result = await generateMusic(
			model,
			{
				outputFormat: "hex",
				audioBase64: "ZmFrZS1hdWRpbw==",
				aigcWatermark: true,
			},
			{ apiKey: "test-key", fetch: fetchMock },
		);

		expect(requestUrl).toBe("https://api.minimaxi.com/v1/music_generation");
		expect(payload).toMatchObject({
			model: "music-cover-free",
			output_format: "hex",
			audio_base64: "ZmFrZS1hdWRpbw==",
			aigc_watermark: true,
		});
		expect(result.output[0]).toEqual({
			type: "audio",
			data: "0a0b0c0d",
			outputFormat: "hex",
		});
	});

	it("rejects cover requests without exactly one reference input", async () => {
		const model = getMusicModel("minimax", "music-cover");
		const fetchMock: typeof fetch = async () =>
			new Response(JSON.stringify({ data: { status: 2, audio: "0a" }, base_resp: { status_code: 0 } }), {
				status: 200,
			});

		const missing = await generateMusic(model, {}, { apiKey: "test-key", fetch: fetchMock });
		expect(missing.stopReason).toBe("error");
		expect(missing.errorMessage).toContain("exactly one of audio_url or audio_base64");

		const both = await generateMusic(
			model,
			{ audioUrl: "https://example.test/a.mp3", audioBase64: "ZmFrZQ==" },
			{ apiKey: "test-key", fetch: fetchMock },
		);
		expect(both.stopReason).toBe("error");
		expect(both.errorMessage).toContain("exactly one of audio_url or audio_base64");
	});

	it("rejects cover reference audio that exceeds the documented size limit", async () => {
		const model = getMusicModel("minimax", "music-cover");
		const oversized = "A".repeat(70 * 1024 * 1024); // base64 representing well over 50 MB of audio
		const result = await generateMusic(
			model,
			{ audioBase64: oversized },
			{ apiKey: "test-key", fetch: async () => new Response("{}", { status: 200 }) },
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("50 MB size limit");
	});

	it("returns in-progress responses for async cover generation", async () => {
		const model = getMusicModel("minimax", "music-cover");
		const fetchMock: typeof fetch = async () =>
			new Response(JSON.stringify({ data: { status: 1 }, base_resp: { status_code: 0 } }), { status: 200 });

		const result = await generateMusic(
			model,
			{ audioUrl: "https://example.test/reference.mp3" },
			{ apiKey: "test-key", fetch: fetchMock },
		);
		expect(result).toMatchObject({ status: "in_progress", stopReason: "in_progress" });
		expect(result.output).toEqual([]);
	});

	it("returns an error result when the API status code is non-zero", async () => {
		const model = getMusicModel("minimax-cn", "music-cover");
		const fetchMock: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					data: { status: 2, audio: "0a" },
					base_resp: { status_code: 1001, status_msg: "request rejected" },
				}),
				{ status: 200 },
			);

		const result = await generateMusic(
			model,
			{ audioBase64: "ZmFrZQ==" },
			{ apiKey: "test-key", fetch: fetchMock },
		);
		expect(result.stopReason).toBe("error");
		expect(result.output).toEqual([]);
		expect(result.errorMessage).toContain("MiniMax music API error (1001): request rejected");
	});

	it("exposes generation and cover models in both regional catalogs", () => {
		for (const provider of ["minimax", "minimax-cn"] as const) {
			const models = getMusicModels(provider);
			expect(models.map((model) => model.id)).toEqual([
				"music-3.0",
				"music-2.6",
				"music-3.0-free",
				"music-2.6-free",
				"music-cover",
				"music-cover-free",
			]);
			const coverModels = models.filter((model) => model.cover);
			expect(coverModels.map((model) => model.id)).toEqual(["music-cover", "music-cover-free"]);
			expect(coverModels.every((model) => model.cover?.inputOneOf.join(",") === "audio_url,audio_base64")).toBe(
				true,
			);
			expect(coverModels.every((model) => model.cover?.inputMaxMb === 50)).toBe(true);
			expect(models.every((model) => model.outputFormats.join(",") === "url,hex")).toBe(true);
			expect(models.every((model) => model.streamOutputFormats.join(",") === "hex")).toBe(true);
			expect(models.every((model) => model.audioFormats.join(",") === "mp3,wav,pcm")).toBe(true);
			expect(models.every((model) => model.urlTtlHours === 24)).toBe(true);
		}

		expect(getMusicModel("minimax", "music-cover").region).toBe("global_en");
		expect(getMusicModel("minimax-cn", "music-cover").regionalFields).toEqual(["aigc_watermark"]);
		expect(getMusicModel("minimax", "music-cover").regionalFields).toEqual([]);
	});
});
