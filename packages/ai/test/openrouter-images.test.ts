import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateImages } from "../src/images.ts";
import type { ImageModel, ImagesContext } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	lastRequestOptions: undefined as unknown,
	nextResponse: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown, requestOptions?: unknown) => {
					mockState.lastParams = params;
					mockState.lastRequestOptions = requestOptions;
					const signal = (requestOptions as { signal?: AbortSignal } | undefined)?.signal;
					if (signal?.aborted) {
						const error = new Error("Request aborted");
						return {
							withResponse: async () => {
								throw error;
							},
						};
					}
					const response = mockState.nextResponse ?? {
						id: "img-1",
						usage: {
							prompt_tokens: 12,
							completion_tokens: 34,
							prompt_tokens_details: { cached_tokens: 0 },
						},
						choices: [
							{
								finish_reason: "stop",
								message: {
									content: "Here is your image.",
									images: [{ image_url: "data:image/png;base64,ZmFrZS1wbmc=" }],
								},
							},
						],
					};
					const promise = Promise.resolve(response) as Promise<typeof response> & {
						withResponse: () => Promise<{
							data: typeof response;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: response,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openrouter images", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.lastRequestOptions = undefined;
		mockState.nextResponse = undefined;
	});

	it("returns text plus images in final output", async () => {
		const model: ImageModel<"openrouter-images"> = {
			type: "image",
			id: "google/gemini-3.1-flash-image-preview",
			name: "Gemini 3.1 Flash Image Preview",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["text", "image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
			headers: { "HTTP-Referer": "https://example.com" },
		};
		const context: ImagesContext = {
			input: [{ type: "text", text: "Generate a dog" }],
		};

		const output = await generateImages(model, context, { apiKey: "test" });
		expect(output.stopReason).toBe("stop");
		expect(output.responseId).toBe("img-1");
		expect(output.output[0]).toMatchObject({ type: "text", text: "Here is your image." });
		expect(output.output[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "ZmFrZS1wbmc=" });

		const params = mockState.lastParams as {
			stream?: boolean;
			modalities?: string[];
			messages?: [{ content?: [{ type: string; text?: string }] }];
		};
		expect(params.stream).toBe(false);
		expect(params.modalities).toEqual(["image", "text"]);
		expect(params.messages?.[0]?.content?.[0]).toMatchObject({ type: "text", text: "Generate a dog" });
	});

	it("passes through abort signal and returns aborted result", async () => {
		const model: ImageModel<"openrouter-images"> = {
			type: "image",
			id: "black-forest-labs/flux.2-pro",
			name: "FLUX.2 Pro",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};
		const context: ImagesContext = {
			input: [{ type: "text", text: "Generate a dog" }],
		};
		const controller = new AbortController();
		controller.abort();

		const output = await generateImages(model, context, { apiKey: "test", signal: controller.signal });
		expect(output.stopReason).toBe("aborted");
		expect(output.errorMessage).toBe("Request aborted");
		expect(mockState.lastRequestOptions).toMatchObject({ signal: controller.signal });
	});

	it("generateImages resolves the final assistant images result", async () => {
		const model: ImageModel<"openrouter-images"> = {
			type: "image",
			id: "black-forest-labs/flux.2-pro",
			name: "FLUX.2 Pro",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};
		const context: ImagesContext = {
			input: [{ type: "text", text: "Generate a dog" }],
		};

		const output = await generateImages(model, context, { apiKey: "test" });
		expect(output.output.some((item) => item.type === "image")).toBe(true);
		// Image-only models must not request text output.
		expect((mockState.lastParams as { modalities?: string[] }).modalities).toEqual(["image"]);
		expect((mockState.lastParams as { image_config?: unknown }).image_config).toBeUndefined();
	});

	it("maps aspectRatio and size options to OpenRouter image_config", async () => {
		const model: ImageModel<"openrouter-images"> = {
			type: "image",
			id: "google/gemini-2.5-flash-image",
			name: "Gemini 2.5 Flash Image",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image", "text"],
			cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.083333 },
		};
		const context: ImagesContext = {
			input: [{ type: "text", text: "A landscape" }],
		};

		const output = await generateImages(model, context, {
			apiKey: "test",
			aspectRatio: "16:9",
			size: "2K",
		});
		expect(output.stopReason).toBe("stop");
		expect((mockState.lastParams as { image_config?: unknown }).image_config).toEqual({
			aspect_ratio: "16:9",
			image_size: "2K",
		});
	});

	it("returns stopReason error and preserves reported zero cost on OpenRouter finish_reason error", async () => {
		mockState.nextResponse = {
			id: "gen-err-1",
			usage: {
				prompt_tokens: 12,
				completion_tokens: 556,
				cost: 0,
				is_byok: false,
				cost_details: {
					upstream_inference_cost: 0.00568,
					upstream_inference_prompt_cost: 0.00012,
					upstream_inference_completions_cost: 0.00556,
				},
			},
			choices: [
				{
					finish_reason: "error",
					native_finish_reason: null,
					message: { role: "assistant", content: null },
				},
			],
		};
		const model: ImageModel<"openrouter-images"> = {
			type: "image",
			id: "openai/gpt-5-image",
			name: "GPT-5 Image",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image", "text"],
			cost: { input: 10, output: 10, cacheRead: 1.25, cacheWrite: 0 },
		};

		const output = await generateImages(
			model,
			{ input: [{ type: "text", text: "A compass rose" }] },
			{ apiKey: "test" },
		);
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toBe("Provider finish_reason: error");
		expect(output.output).toEqual([]);
		expect(output.responseId).toBe("gen-err-1");
		expect(output.usage?.cost.total).toBe(0);
		expect(output.usage?.cost.totalFromProvider).toBe(true);
	});

	it("returns stopReason error when OpenRouter returns no choices or a choice error", async () => {
		const model: ImageModel<"openrouter-images"> = {
			type: "image",
			id: "openai/gpt-5-image",
			name: "GPT-5 Image",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image", "text"],
			cost: { input: 10, output: 10, cacheRead: 1.25, cacheWrite: 0 },
		};

		mockState.nextResponse = {
			id: "gen-empty",
			error: { message: null, code: null },
			choices: [],
		};
		const empty = await generateImages(
			model,
			{ input: [{ type: "text", text: "A compass rose" }] },
			{ apiKey: "test" },
		);
		expect(empty.stopReason).toBe("error");
		expect(empty.errorMessage).toBe("Provider returned no choices");

		mockState.nextResponse = {
			id: "gen-choice-err",
			error: { code: 503, message: "Top-level error" },
			choices: [
				{
					finish_reason: "error",
					error: { message: "   ", code: "" },
					message: { role: "assistant", content: null },
				},
			],
		};
		const fallbackErr = await generateImages(
			model,
			{ input: [{ type: "text", text: "A compass rose" }] },
			{ apiKey: "test" },
		);
		expect(fallbackErr.stopReason).toBe("error");
		expect(fallbackErr.errorMessage).toBe("Top-level error");

		mockState.nextResponse = {
			id: "gen-native-reason",
			choices: [
				{
					finish_reason: "error",
					native_finish_reason: "IMAGE_SAFETY",
					message: { role: "assistant", content: null },
				},
			],
		};
		const nativeReason = await generateImages(
			model,
			{ input: [{ type: "text", text: "A compass rose" }] },
			{ apiKey: "test" },
		);
		expect(nativeReason.stopReason).toBe("error");
		expect(nativeReason.errorMessage).toBe("Provider finish_reason: error (native_finish_reason: IMAGE_SAFETY)");
	});

	it("applies OpenRouter reported usage.cost on successful image generation", async () => {
		mockState.nextResponse = {
			id: "gen-ok-1",
			usage: {
				prompt_tokens: 15,
				completion_tokens: 1290,
				cost: 0.042,
				is_byok: false,
				cost_details: null,
			},
			choices: [
				{
					finish_reason: "stop",
					message: {
						content: null,
						images: [{ image_url: "data:image/png;base64,ZmFrZS1wbmc=" }],
					},
				},
			],
		};
		const model: ImageModel<"openrouter-images"> = {
			type: "image",
			id: "google/gemini-2.5-flash-image",
			name: "Gemini 2.5 Flash Image",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image", "text"],
			cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.083333 },
		};

		const output = await generateImages(
			model,
			{ input: [{ type: "text", text: "A compass rose" }] },
			{ apiKey: "test" },
		);
		expect(output.stopReason).toBe("stop");
		expect(output.usage?.cost.total).toBe(0.042);
		expect(output.usage?.cost.totalFromProvider).toBe(true);
		expect(output.usage?.reasoning).toBe(0);
		expect(output.usage?.imageOutput).toBeUndefined();
	});

	it("reports reasoning and image tokens as subsets of output tokens", async () => {
		mockState.nextResponse = {
			id: "gen-reasoning-1",
			usage: {
				prompt_tokens: 15,
				completion_tokens: 2290,
				completion_tokens_details: { reasoning_tokens: 1000, image_tokens: 1120 },
			},
			choices: [
				{
					finish_reason: "stop",
					message: {
						content: null,
						images: [{ image_url: "data:image/png;base64,ZmFrZS1wbmc=" }],
					},
				},
			],
		};
		const model: ImageModel<"openrouter-images"> = {
			type: "image",
			id: "google/gemini-3-pro-image",
			name: "Gemini 3 Pro Image",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image", "text"],
			cost: { input: 2, output: 120, cacheRead: 0.2, cacheWrite: 0.375 },
		};

		const output = await generateImages(
			model,
			{ input: [{ type: "text", text: "A compass rose" }] },
			{ apiKey: "test" },
		);
		expect(output.usage?.output).toBe(2290);
		expect(output.usage?.reasoning).toBe(1000);
		expect(output.usage?.imageOutput).toBe(1120);
	});
});
