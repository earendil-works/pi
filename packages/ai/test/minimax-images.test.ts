import { describe, expect, it } from "vitest";
import type { MiniMaxImagesOptions } from "../src/api/minimax-images.ts";
import { getImageModel } from "../src/image-models.ts";
import { generateImages } from "../src/images.ts";
import type { ImagesContext } from "../src/types.ts";

const globalModel = getImageModel("minimax", "image-01-live");
const cnModel = getImageModel("minimax-cn", "image-01-live");

const referenceImage = { type: "image", mimeType: "image/png", data: "aVZCT1J3" } as const;

function promptWithReference(): ImagesContext {
	return {
		input: [{ type: "text", text: "Place this person in a library" }, referenceImage],
	};
}

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("MiniMax image generation", () => {
	it("sends context image inputs as subject references and parses base64 images", async () => {
		let request: { url: string; init?: RequestInit } | undefined;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			request = { url: String(input), init };
			return jsonResponse({
				id: "trace-1",
				data: { image_base64: ["/9j/generated"] },
				metadata: { success_count: 1, failed_count: 0 },
				base_resp: { status_code: 0, status_msg: "success" },
			});
		};

		const output = await generateImages(globalModel, promptWithReference(), { apiKey: "test-key", fetch });

		expect(request?.url).toBe("https://api.minimax.io/v1/image_generation");
		expect(request?.init?.headers).toMatchObject({
			Authorization: "Bearer test-key",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(request?.init?.body))).toEqual({
			model: "image-01-live",
			prompt: "Place this person in a library",
			subject_reference: [{ type: "character", image_file: "data:image/png;base64,aVZCT1J3" }],
			response_format: "base64",
		});
		expect(output).toMatchObject({
			stopReason: "stop",
			responseId: "trace-1",
			output: [{ type: "image", mimeType: "image/jpeg", data: "/9j/generated" }],
		});
	});

	it("forwards explicit subject references and optional fields to the regional endpoint", async () => {
		let body: unknown;
		let url: string | undefined;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			url = String(input);
			body = JSON.parse(String(init?.body));
			return jsonResponse({ data: { image_base64: ["ZmFrZQ=="] }, base_resp: { status_code: 0 } });
		};
		const options: MiniMaxImagesOptions = {
			apiKey: "test-key",
			fetch,
			subjectReference: [{ type: "character", imageFile: "https://example.test/portrait.jpg" }],
			aspectRatio: "16:9",
			width: 1280,
			height: 720,
			responseFormat: "base64",
			seed: 7,
			n: 2,
			promptOptimizer: true,
		};

		const output = await generateImages(cnModel, promptWithReference(), options);

		expect(url).toBe("https://api.minimaxi.com/v1/image_generation");
		expect(body).toEqual({
			model: "image-01-live",
			prompt: "Place this person in a library",
			subject_reference: [{ type: "character", image_file: "https://example.test/portrait.jpg" }],
			aspect_ratio: "16:9",
			width: 1280,
			height: 720,
			response_format: "base64",
			seed: 7,
			n: 2,
			prompt_optimizer: true,
		});
		expect(output.stopReason).toBe("stop");
	});

	it("downloads url responses into image content", async () => {
		const requests: string[] = [];
		const fetch: typeof globalThis.fetch = async (input) => {
			const requested = String(input);
			requests.push(requested);
			if (requested.endsWith("/generated.png")) {
				return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
					status: 200,
					headers: { "content-type": "image/png" },
				});
			}
			return jsonResponse({
				data: { image_urls: ["https://cdn.example.test/generated.png"] },
				base_resp: { status_code: 0 },
			});
		};

		const output = await generateImages(globalModel, promptWithReference(), {
			apiKey: "test-key",
			fetch,
			responseFormat: "url",
		});

		expect(requests).toEqual([
			"https://api.minimax.io/v1/image_generation",
			"https://cdn.example.test/generated.png",
		]);
		expect(output.output).toEqual([{ type: "image", mimeType: "image/png", data: "iVBORw==" }]);
	});

	it("reports the service status code as an error", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			jsonResponse({ base_resp: { status_code: 1026, status_msg: "sensitive prompt" } });

		const output = await generateImages(globalModel, promptWithReference(), { apiKey: "test-key", fetch });

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("Image generation failed with status 1026: sensitive prompt");
	});

	it("reports images rejected by content safety", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			jsonResponse({ data: {}, metadata: { success_count: 0, failed_count: 2 }, base_resp: { status_code: 0 } });

		const output = await generateImages(globalModel, promptWithReference(), { apiKey: "test-key", fetch });

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("2 rejected by content safety");
	});

	it("surfaces the http error body", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response("quota exhausted", { status: 429, statusText: "Too Many Requests" });

		const output = await generateImages(globalModel, promptWithReference(), { apiKey: "test-key", fetch });

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("quota exhausted");
	});

	it("passes through abort signals", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			init?.signal?.throwIfAborted();
			return jsonResponse({ data: { image_base64: ["ZmFrZQ=="] }, base_resp: { status_code: 0 } });
		};

		const output = await generateImages(globalModel, promptWithReference(), {
			apiKey: "test-key",
			fetch,
			signal: controller.signal,
		});

		expect(output.stopReason).toBe("aborted");
	});

	it("fails without an api key", async () => {
		const output = await generateImages(globalModel, promptWithReference(), {});

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("No API key for provider: minimax");
	});
});
