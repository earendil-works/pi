import { describe, expect, it } from "vitest";
import type { MiniMaxImagesOptions } from "../src/api/minimax-images.ts";
import { generateImages } from "../src/images.ts";
import type { ImagesContext, ImagesModel } from "../src/types.ts";

function createModel(baseUrl = "https://api.minimax.io/v1/image_generation"): ImagesModel<"minimax-images"> {
	return {
		id: "image-01",
		name: "image-01",
		api: "minimax-images",
		provider: baseUrl.includes("minimaxi.com") ? "minimax-cn" : "minimax",
		baseUrl,
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const context: ImagesContext = {
	input: [{ type: "text", text: "Generate a blue square" }],
};

describe("MiniMax image generation", () => {
	it("sends the documented request fields and parses base64 images", async () => {
		let request: { url: string; init?: RequestInit } | undefined;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			request = { url: String(input), init };
			return new Response(
				JSON.stringify({
					id: "trace-123",
					data: { image_urls: ["iVBORw0KGgo"] },
					metadata: { success_count: 1, failed_count: 0 },
					base_resp: { status_code: 0, status_msg: "success" },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		const options: MiniMaxImagesOptions = {
			apiKey: "test-key",
			fetch,
			subjectReference: [{ type: "character", imageFile: "https://example.test/face.jpg" }],
			aspectRatio: "16:9",
			width: 1024,
			height: 768,
			responseFormat: "base64",
			seed: 123,
			n: 2,
			promptOptimizer: true,
		};

		const output = await generateImages(createModel(), context, options);

		expect(request?.url).toBe("https://api.minimax.io/v1/image_generation");
		expect(request?.init?.headers).toMatchObject({
			Authorization: "Bearer test-key",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(request?.init?.body))).toEqual({
			model: "image-01",
			prompt: "Generate a blue square",
			subject_reference: [{ type: "character", image_file: "https://example.test/face.jpg" }],
			aspect_ratio: "16:9",
			width: 1024,
			height: 768,
			response_format: "base64",
			seed: 123,
			n: 2,
			prompt_optimizer: true,
		});
		expect(output).toMatchObject({
			stopReason: "stop",
			responseId: "trace-123",
			output: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo" }],
		});
	});

	it("downloads URL responses into image content", async () => {
		const requests: string[] = [];
		const fetch: typeof globalThis.fetch = async (input) => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/image.png")) {
				return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
					status: 200,
					headers: { "content-type": "image/png" },
				});
			}
			return new Response(
				JSON.stringify({
					data: { image_urls: ["https://cdn.example.test/image.png"] },
					base_resp: { status_code: 0 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const output = await generateImages(createModel("https://api.minimaxi.com/v1/image_generation"), context, {
			apiKey: "test-key",
			fetch,
			responseFormat: "url",
		});

		expect(requests).toEqual(["https://api.minimaxi.com/v1/image_generation", "https://cdn.example.test/image.png"]);
		expect(output.output).toEqual([{ type: "image", mimeType: "image/png", data: "iVBORw==" }]);
	});

	it("returns the provider error from base_resp", async () => {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: "authentication failed" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});

		const output = await generateImages(createModel(), context, { apiKey: "test-key", fetch });

		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("MiniMax image API error 1004: authentication failed");
	});
});
