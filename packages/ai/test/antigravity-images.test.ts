import { afterEach, describe, expect, it, vi } from "vitest";
import { type AntigravityImagesOptions, generateImages } from "../src/api/antigravity-images.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { generateImages as generateGlobalImages } from "../src/images.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { builtinModels } from "../src/providers/all.ts";
import { antigravityProvider } from "../src/providers/antigravity.ts";
import type { ImageModel, ImagesContext } from "../src/types.ts";

const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
const apiKey = JSON.stringify({ token: "fake-token", projectId: "fake-project" });
const model: ImageModel<"antigravity-images"> = {
	type: "image",
	id: "gemini-3-pro-image",
	name: "Gemini image",
	api: "antigravity-images",
	provider: "antigravity",
	baseUrl: "https://daily-cloudcode-pa.googleapis.com",
	input: ["text"],
	output: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: ImagesContext = { input: [{ type: "text", text: "A red circle" }] };
function frame(
	parts: unknown[] = [{ text: "Here it is" }, { inlineData: { data: image.data, mimeType: image.mimeType } }],
	finishReason = "STOP",
) {
	return {
		response: {
			responseId: "image-response",
			candidates: [{ content: { parts }, finishReason }],
			usageMetadata: {
				promptTokenCount: 12,
				cachedContentTokenCount: 2,
				candidatesTokenCount: 7,
				totalTokenCount: 19,
			},
		},
	};
}
function sse(...frames: unknown[]) {
	return frames.map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`).join("");
}
function success() {
	return new Response(sse(frame()), { headers: { "content-type": "text/event-stream" } });
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("native Antigravity generateImages", () => {
	it("uses the image request format and returns native text/image content without file paths", async () => {
		const order: string[] = [];
		const result = await generateImages(
			{ ...model, headers: { "X-Model": "keep", "X-Override": "old", "X-Remove": "old" } },
			context,
			{
				apiKey,
				metadata: { aspectRatio: "16:9" },
				headers: { "x-override": "new", "x-remove": null },
				onPayload: async (payload) => {
					order.push("payload");
					await Promise.resolve();
					return { ...(payload as object), marker: true };
				},
				onResponse: (incoming) => {
					order.push("response");
					expect(incoming.status).toBe(200);
				},
				fetch: async (url, init) => {
					order.push("fetch");
					expect(String(url)).toContain("/v1internal:streamGenerateContent?alt=sse");
					const headers = new Headers(init?.headers);
					expect(headers.get("authorization")).toBe("Bearer fake-token");
					expect(headers.get("x-model")).toBe("keep");
					expect(headers.get("x-override")).toBe("new");
					expect(headers.has("x-remove")).toBe(false);
					expect(JSON.parse(String(init?.body))).toMatchObject({
						project: "fake-project",
						model: model.id,
						marker: true,
						requestType: "agent",
						userAgent: "antigravity",
						requestId: expect.stringMatching(/^agent\//),
						request: {
							contents: [{ role: "user", parts: [{ text: "A red circle" }] }],
							generationConfig: { candidateCount: 1, imageConfig: { aspectRatio: "16:9" } },
						},
					});
					return success();
				},
			},
		);
		expect(order).toEqual(["payload", "fetch", "response"]);
		expect(result).toMatchObject({
			api: "antigravity-images",
			provider: "antigravity",
			model: model.id,
			responseId: "image-response",
			stopReason: "stop",
			output: [{ type: "text", text: "Here it is" }, image],
			usage: { input: 10, cacheRead: 2, output: 7, totalTokens: 19 },
		});
		expect(result).not.toHaveProperty("savedPaths");
	});

	it("preserves inline reference inputs for models advertising image support and hook mutations", async () => {
		const result = await generateImages(
			{ ...model, input: ["text", "image"] },
			{ input: [...context.input, image] },
			{
				apiKey,
				aspectRatio: "4:3",
				metadata: { aspectRatio: "16:9" },
				onPayload: (payload) => {
					(payload as { marker?: boolean }).marker = true;
				},
				fetch: async (_url, init) => {
					expect(JSON.parse(String(init?.body))).toMatchObject({
						marker: true,
						request: {
							contents: [
								{
									parts: [
										{ text: "A red circle" },
										{ inlineData: { data: image.data, mimeType: image.mimeType } },
									],
								},
							],
							generationConfig: { imageConfig: { aspectRatio: "4:3" } },
						},
					});
					return success();
				},
			},
		);
		expect(result.stopReason).toBe("stop");
	});

	it.each(["", "[DONE]"])("handles trailing/chunked SSE with terminal %s", async (marker) => {
		const body = sse(frame(undefined, marker ? "" : "STOP")) + (marker ? `data: ${marker}` : "");
		const chunks = [body.slice(0, 35), body.slice(35).trimEnd()];
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				const next = chunks.shift();
				if (next === undefined) controller.close();
				else controller.enqueue(new TextEncoder().encode(next));
			},
			cancel,
		});
		const result = await generateImages(model, context, { apiKey, fetch: async () => new Response(stream) });
		expect(result.stopReason).toBe("stop");
		expect(result.output[1]).toEqual(image);
		expect(stream.locked).toBe(false);
	});

	it.each(["truncated", "malformed", "provider", "blocked", "empty"])(
		"rejects %s responses and clears partial images",
		async (failure) => {
			let body = sse(frame(undefined, ""));
			if (failure === "malformed") body += "data: invalid\n\n";
			if (failure === "provider") body += sse({ error: { message: "generation failed" } });
			if (failure === "blocked") body += sse(frame([], "SAFETY"));
			if (failure === "empty") body = sse(frame([{ text: "No image" }]));
			const result = await generateImages(model, context, { apiKey, fetch: async () => new Response(body) });
			expect(result.stopReason).toBe("error");
			expect(result.output).toEqual([]);
			expect(result.errorMessage).toBeTruthy();
		},
	);

	it.each(["ratio", "prompt", "credentials", "reference", "model"])(
		"validates %s without sending",
		async (invalid) => {
			const fetch = vi.fn();
			const options: AntigravityImagesOptions = {
				apiKey,
				fetch,
				...(invalid === "ratio" ? { metadata: { aspectRatio: "99:1" } } : {}),
				...(invalid === "credentials" ? { apiKey: undefined } : {}),
			};
			const result = await generateImages(
				invalid === "model" ? { ...model, id: "claude-test" } : model,
				invalid === "prompt"
					? { input: [] }
					: invalid === "reference"
						? { input: [...context.input, image] }
						: context,
				options,
			);
			expect(result.stopReason).toBe("error");
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("does not silently switch image models on endpoint failure", async () => {
		const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body)).model).toBe(model.id);
			return Response.json({ error: { message: "not available" } }, { status: 404 });
		});
		const result = await generateImages(model, context, { apiKey, fetch });
		expect(result.stopReason).toBe("error");
		expect(result.model).toBe(model.id);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("cancels the body if a response hook fails", async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({ cancel });
		const result = await generateImages(model, context, {
			apiKey,
			fetch: async () => new Response(stream),
			onResponse: () => {
				throw new Error("hook failed");
			},
		});
		expect(result.stopReason).toBe("error");
		expect(cancel).toHaveBeenCalledOnce();
		expect(stream.locked).toBe(false);
	});

	it("aborts and cancels an in-flight body", async () => {
		const controller = new AbortController();
		const cancel = vi.fn();
		let stream: ReadableStream<Uint8Array> | undefined;
		const result = await generateImages(model, context, {
			apiKey,
			signal: controller.signal,
			fetch: async () => {
				stream = new ReadableStream<Uint8Array>({
					pull() {
						controller.abort();
					},
					cancel,
				});
				return new Response(stream);
			},
		});
		expect(result.stopReason).toBe("aborted");
		expect(result.output).toEqual([]);
		expect(cancel).toHaveBeenCalledOnce();
		expect(stream!.locked).toBe(false);
	});

	it("honors scoped header and stall timeout overrides, including disabling the stall timer", async () => {
		vi.useFakeTimers();
		vi.stubEnv("ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS", "1");
		vi.stubEnv("ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS", "1");
		let fetched!: () => void;
		const fetchStarted = new Promise<void>((resolve) => {
			fetched = resolve;
		});
		let finishHeaders!: (response: Response) => void;
		let finishBody!: () => void;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				finishBody = () => {
					controller.enqueue(new TextEncoder().encode(sse(frame())));
					controller.close();
				};
			},
		});
		let responded!: () => void;
		const responseReceived = new Promise<void>((resolve) => {
			responded = resolve;
		});
		const pending = generateImages(model, context, {
			apiKey,
			env: { ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS: "50", ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS: "0" },
			onResponse: () => responded(),
			fetch: async (_url, init) => {
				fetched();
				return new Promise<Response>((resolve, reject) => {
					finishHeaders = resolve;
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				});
			},
		});
		await fetchStarted;
		await vi.advanceTimersByTimeAsync(20);
		finishHeaders(new Response(body));
		await responseReceived;
		await vi.advanceTimersByTimeAsync(200_000);
		finishBody();
		expect((await pending).stopReason).toBe("stop");
	});

	it("enforces request timeout", async () => {
		const result = await generateImages(model, context, {
			apiKey,
			timeoutMs: 10,
			fetch: async (_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		});
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("no response headers");
	});
});

describe("native image registration", () => {
	it("uses the same OAuth credentials through Models and registers the global generateImages entry point", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("antigravity", async () => ({
			type: "oauth",
			access: "fake-token",
			refresh: "fake-refresh",
			expires: Date.now() + 3600000,
			projectId: "fake-project",
		}));
		const models = builtinModels({ credentials });
		const selected = models.getModelOfType("image", "antigravity", model.id)!;
		expect(selected).toMatchObject({ type: "image", api: "antigravity-images" });
		expect(models.getModel("antigravity", model.id)).toBeUndefined();
		const result = await models.generateImages(selected, context, {
			metadata: { aspectRatio: "16:9" },
			fetch: async (_url, init) => {
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-token");
				expect(JSON.parse(String(init?.body)).request.generationConfig.imageConfig.aspectRatio).toBe("16:9");
				return success();
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(
			(await generateGlobalImages(selected, context, { apiKey, fetch: async () => success() })).output[1],
		).toEqual(image);
	});

	it("discovers and persists image models independently from chat models", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("antigravity", async () => ({
			type: "oauth",
			access: "fake-token",
			refresh: "fake-refresh",
			expires: Date.now() + 3600000,
			projectId: "fake-project",
		}));
		const modelsStore = new InMemoryModelsStore();
		const models = createModels({ credentials, modelsStore });
		models.setProvider(antigravityProvider());
		vi.stubGlobal("fetch", async () =>
			Response.json({
				models: {
					"gemini-9-image": { supportsImages: true, displayName: "New image model" },
					"gemini-hidden-image": { isInternal: true },
				},
			}),
		);
		expect((await models.refresh({ allowNetwork: true })).errors.size).toBe(0);
		expect(models.getModelOfType("image", "antigravity", "gemini-9-image")).toMatchObject({
			input: ["text", "image"],
			name: "New image model",
		});
		expect(models.getModelOfType("image", "antigravity", "gemini-hidden-image")).toBeUndefined();
		expect(models.getModels("antigravity").every((entry) => !entry.id.includes("image"))).toBe(true);
		const restored = createModels({ modelsStore });
		restored.setProvider(antigravityProvider());
		await restored.refresh({ allowNetwork: false });
		expect(restored.getModelsOfType("image", "antigravity")).toEqual(models.getModelsOfType("image", "antigravity"));
	});
});
