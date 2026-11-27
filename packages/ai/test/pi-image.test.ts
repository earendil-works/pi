import { describe, expect, it, vi } from "vitest";
import { generateImages } from "../src/api/pi-image.ts";
import type { ImageModel, ImagesContext } from "../src/types.ts";

const model: ImageModel<"pi-image"> = {
	type: "image",
	id: "nano-banana",
	name: "Nano Banana",
	api: "pi-image",
	provider: "radius",
	baseUrl: "https://radius.example/v1",
	input: ["text", "image"],
	output: ["image", "text"],
	cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.083333 },
};

const context: ImagesContext = {
	input: [{ type: "text", text: "A red fox in the snow" }],
};

describe("Pi Image", () => {
	it("posts canonical context and options to /image and returns output blocks with authoritative cost", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					output: [
						{ type: "text", text: "Here is your fox." },
						{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
					],
					usage: {
						input: 15,
						output: 1290,
						cacheRead: 0,
						cacheWrite: 0,
						reasoning: 200,
						totalTokens: 1305,
						cost: {
							input: 0.0000045,
							output: 0.003225,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0.0032295,
							totalFromProvider: true,
						},
					},
					responseId: "gen-img-1",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const result = await generateImages(model, context, {
			apiKey: "radius-key",
			aspectRatio: "16:9",
			size: "2K",
			sessionId: "sess-1",
			metadata: { tag: "demo" },
			fetch: fetchMock,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("https://radius.example/v1/image");
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "nano-banana",
			context: { input: context.input },
			options: {
				aspectRatio: "16:9",
				size: "2K",
				sessionId: "sess-1",
				metadata: { tag: "demo" },
			},
		});

		expect(result).toMatchObject({
			api: "pi-image",
			provider: "radius",
			model: "nano-banana",
			stopReason: "stop",
			output: [
				{ type: "text", text: "Here is your fox." },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
			usage: {
				input: 15,
				output: 1290,
				reasoning: 200,
				totalTokens: 1305,
				cost: { total: 0.0032295, totalFromProvider: true },
			},
			responseId: "gen-img-1",
		});
	});

	it("calculates cost from model pricing when usage omits cost", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					output: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
					usage: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, totalTokens: 3000 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const result = await generateImages(model, context, { apiKey: "radius-key", fetch: fetchMock });
		expect(result.stopReason).toBe("stop");
		expect(result.usage?.cost.input).toBeCloseTo(0.0003);
		expect(result.usage?.cost.output).toBeCloseTo(0.005);
		expect(result.usage?.cost.total).toBeCloseTo(0.0053);
		expect(result.usage?.reasoning).toBeUndefined();
	});

	it("accepts provider-reported cost without token counts", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					output: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
					usage: {
						cost: { input: 0, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.04, totalFromProvider: true },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const result = await generateImages(model, context, { apiKey: "radius-key", fetch: fetchMock });
		expect(result.stopReason).toBe("stop");
		expect(result.usage?.cost).toMatchObject({ total: 0.04, totalFromProvider: true });
	});

	it("returns an error result when the backend responds with an error envelope", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: { message: "Insufficient credits", code: "insufficient_credits" },
				}),
				{ status: 402, headers: { "content-type": "application/json" } },
			),
		);

		const result = await generateImages(model, context, { apiKey: "radius-key", maxRetries: 0, fetch: fetchMock });

		expect(result.stopReason).toBe("error");
		expect(result.output).toEqual([]);
		expect(result.errorMessage).toContain("Insufficient credits");
	});

	it("reports an error response to onResponse even when its body fails", async () => {
		const body = new ReadableStream({
			start(controller) {
				controller.error(new Error("body stream failed"));
			},
		});
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(body, { status: 503, headers: { "retry-after": "7" } }));
		const onResponse = vi.fn();

		const result = await generateImages(model, context, {
			apiKey: "radius-key",
			maxRetries: 0,
			fetch: fetchMock,
			onResponse,
		});

		expect(result.stopReason).toBe("error");
		expect(onResponse).toHaveBeenCalledTimes(1);
		expect(onResponse.mock.calls[0][0]).toMatchObject({ status: 503, headers: { "retry-after": "7" } });
	});

	it("rejects malformed output blocks", async () => {
		const badFetch = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					output: [{ type: "image", data: "", mimeType: "image/png" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const result = await generateImages(model, context, { apiKey: "radius-key", fetch: badFetch });
		expect(result.stopReason).toBe("error");
		expect(result.output).toEqual([]);
		expect(result.errorMessage).toContain("invalid image block");
	});

	it("forwards input images when supported and rejects them on text-only models", async () => {
		const inputWithImage: ImagesContext = {
			input: [
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", text: "Make it blue" },
			],
		};
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					output: [{ type: "image", data: "BBBB", mimeType: "image/png" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const ok = await generateImages(model, inputWithImage, { apiKey: "radius-key", fetch: fetchMock });
		expect(ok.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const textOnlyModel: ImageModel<"pi-image"> = { ...model, input: ["text"] };
		const rejected = await generateImages(textOnlyModel, inputWithImage, { apiKey: "radius-key", fetch: fetchMock });
		expect(rejected.stopReason).toBe("error");
		expect(rejected.errorMessage).toContain("does not support image input");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reports aborted when signal is aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("Aborted", "AbortError"));

		const result = await generateImages(model, context, {
			apiKey: "radius-key",
			signal: controller.signal,
			fetch: fetchMock,
		});

		expect(result.stopReason).toBe("aborted");
		expect(result.output).toEqual([]);
	});
});
