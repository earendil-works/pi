import { describe, expect, it, vi } from "vitest";
import {
	createVertexAnthropicFetch,
	resolveVertexApiKey,
	streamSimple as streamSimpleVertexAnthropic,
	stream as streamVertexAnthropic,
} from "../src/api/vertex-anthropic.ts";
import { normalizeContext } from "../src/compat.ts";
import { GOOGLE_VERTEX_MODELS } from "../src/providers/google-vertex.models.ts";
import { googleVertexProvider } from "../src/providers/google-vertex.ts";
import type { Model } from "../src/types.ts";

describe("google-vertex anthropic support", () => {
	const context = normalizeContext({
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	});

	it("includes Claude Opus and other Anthropic models in the google-vertex catalog", () => {
		const models = Object.values(GOOGLE_VERTEX_MODELS);
		const geminiModels = models.filter((m) => m.id.startsWith("gemini-"));
		const opusModels = models.filter((m) => m.id.startsWith("claude-opus-"));
		const sonnetModels = models.filter((m) => m.id.startsWith("claude-sonnet-"));
		const haikuModels = models.filter((m) => m.id.startsWith("claude-haiku-"));

		expect(geminiModels.length).toBeGreaterThan(0);
		expect(opusModels.length).toBeGreaterThan(0);
		expect(sonnetModels.length).toBeGreaterThan(0);
		expect(haikuModels.length).toBeGreaterThan(0);

		for (const gemini of geminiModels) {
			expect(gemini.api).toBe("google-vertex");
			expect(gemini.provider).toBe("google-vertex");
		}

		for (const opus of opusModels) {
			expect(opus.api).toBe("anthropic-messages");
			expect(opus.provider).toBe("google-vertex");
			expect(opus.baseUrl).toBe("https://{location}-aiplatform.googleapis.com");
		}
	});

	it("configures googleVertexProvider with both google-vertex and anthropic-messages APIs", () => {
		const provider = googleVertexProvider();
		const models = provider.getModels();

		const gemini = models.find((m) => m.id.startsWith("gemini-"));
		const opus = models.find((m) => m.id.startsWith("claude-opus-"));

		expect(gemini).toBeDefined();
		expect(opus).toBeDefined();
		expect(gemini?.api).toBe("google-vertex");
		expect(opus?.api).toBe("anthropic-messages");
	});

	it("resolves marker api keys as undefined so ADC is used", () => {
		expect(resolveVertexApiKey("gcp-vertex-credentials")).toBeUndefined();
		expect(resolveVertexApiKey("<authenticated>")).toBeUndefined();
		expect(resolveVertexApiKey("")).toBeUndefined();
		expect(resolveVertexApiKey(undefined)).toBeUndefined();
		expect(resolveVertexApiKey("my-real-api-key")).toBe("my-real-api-key");
	});

	describe("createVertexAnthropicFetch request rewriting", () => {
		const opusModel: Model<"anthropic-messages"> = {
			id: "claude-opus-4-8@default",
			name: "Claude Opus 4.8",
			api: "anthropic-messages",
			provider: "google-vertex",
			baseUrl: "https://{location}-aiplatform.googleapis.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: 1000000,
			maxTokens: 128000,
		};

		it("rewrites messages request URL, deletes model from body, sets version and apiKey header", async () => {
			let capturedUrl = "";
			let capturedInit: RequestInit | undefined;

			const mockFetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
				capturedUrl = url.toString();
				capturedInit = init;
				return new Response(JSON.stringify({ id: "msg_123" }), { status: 200 });
			});

			const vertexFetch = createVertexAnthropicFetch({
				project: "test-proj",
				location: "us-east5",
				apiKey: "test-api-key",
				fetch: mockFetch,
				model: opusModel,
			});

			await vertexFetch("https://vertex.googleapis.com/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": "anthropic-dummy-key",
					"anthropic-beta": "prompt-caching-2024-07-31",
				},
				body: JSON.stringify({
					model: "claude-opus-4-8@default",
					messages: [{ role: "user", content: "hi" }],
					max_tokens: 100,
					stream: true,
				}),
			});

			expect(capturedUrl).toBe(
				"https://us-east5-aiplatform.googleapis.com/v1/projects/test-proj/locations/us-east5/publishers/anthropic/models/claude-opus-4-8@default:streamRawPredict",
			);

			const headers = new Headers(capturedInit?.headers);
			expect(headers.get("x-goog-api-key")).toBe("test-api-key");
			expect(headers.get("x-api-key")).toBeNull();
			expect(headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31");

			const body = JSON.parse(capturedInit?.body as string);
			expect(body.model).toBeUndefined();
			expect(body.anthropic_version).toBe("vertex-2023-10-16");
			expect(body.max_tokens).toBe(100);
		});

		it("uses rawPredict for non-streaming calls", async () => {
			let capturedUrl = "";

			const mockFetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => {
				capturedUrl = url.toString();
				return new Response(JSON.stringify({ id: "msg_123" }), { status: 200 });
			});

			const vertexFetch = createVertexAnthropicFetch({
				project: "test-proj",
				location: "europe-west1",
				apiKey: "test-api-key",
				fetch: mockFetch,
				model: opusModel,
			});

			await vertexFetch("https://vertex.googleapis.com/v1/messages", {
				method: "POST",
				body: JSON.stringify({
					model: "claude-opus-4-8@default",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});

			expect(capturedUrl).toContain(":rawPredict");
			expect(capturedUrl).not.toContain(":streamRawPredict");
		});

		it("throws when location is missing", async () => {
			const vertexFetch = createVertexAnthropicFetch({
				project: "test-proj",
				fetch: vi.fn(),
				model: opusModel,
			});

			await expect(
				vertexFetch("https://vertex.googleapis.com/v1/messages", {
					method: "POST",
					body: JSON.stringify({ model: "claude-opus-4-8@default", messages: [] }),
				}),
			).rejects.toThrow(/Vertex AI requires a location/);
		});

		it("throws when project is missing and no apiKey provided", async () => {
			const vertexFetch = createVertexAnthropicFetch({
				location: "us-east5",
				fetch: vi.fn(),
				model: opusModel,
			});

			await expect(
				vertexFetch("https://vertex.googleapis.com/v1/messages", {
					method: "POST",
					body: JSON.stringify({ model: "claude-opus-4-8@default", messages: [] }),
				}),
			).rejects.toThrow(/Vertex AI requires a project ID/);
		});
	});

	describe("streaming integration with mock fetch", () => {
		const opusModel: Model<"anthropic-messages"> = {
			id: "claude-opus-4-8@default",
			name: "Claude Opus 4.8",
			api: "anthropic-messages",
			provider: "google-vertex",
			baseUrl: "https://{location}-aiplatform.googleapis.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: 1000000,
			maxTokens: 128000,
		};

		it("streams response events from Vertex Anthropic endpoint", async () => {
			const sseChunks = [
				'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_vertex_1","type":"message","role":"assistant","content":[],"model":"claude-opus-4-8@default","usage":{"input_tokens":12,"output_tokens":6}}}\n\n',
				'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from Opus on Vertex!"}}\n\n',
				'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
				'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}\n\n',
				'event: message_stop\ndata: {"type":"message_stop"}\n\n',
			].join("");

			const mockFetch = vi.fn(async () => {
				return new Response(sseChunks, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			});

			const stream = streamVertexAnthropic(opusModel, context, {
				apiKey: "test-api-key",
				project: "test-proj",
				location: "us-east5",
				fetch: mockFetch,
			});

			const message = await stream.result();
			expect(message.role).toBe("assistant");
			expect(message.content).toEqual([{ type: "text", text: "Hello from Opus on Vertex!" }]);
			expect(message.usage.input).toBe(12);
			expect(message.usage.output).toBe(6);
			expect(message.stopReason).toBe("stop");
			expect(message.responseId).toBe("msg_vertex_1");
		});

		it("streams simple response through streamSimpleVertexAnthropic", async () => {
			const sseChunks = [
				'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_vertex_2","type":"message","role":"assistant","content":[],"model":"claude-opus-4-8@default","usage":{"input_tokens":5,"output_tokens":3}}}\n\n',
				'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
				'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Simple test"}}\n\n',
				'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
				'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
				'event: message_stop\ndata: {"type":"message_stop"}\n\n',
			].join("");

			const mockFetch = vi.fn(async () => {
				return new Response(sseChunks, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			});

			const stream = streamSimpleVertexAnthropic(opusModel, context, {
				apiKey: "test-api-key",
				env: {
					GOOGLE_CLOUD_PROJECT: "test-proj",
					GOOGLE_CLOUD_LOCATION: "us-east5",
				},
				fetch: mockFetch,
			});

			const message = await stream.result();
			expect(message.role).toBe("assistant");
			expect(message.content).toEqual([{ type: "text", text: "Simple test" }]);
			expect(message.usage.input).toBe(5);
			expect(message.usage.output).toBe(3);
			expect(message.stopReason).toBe("stop");
		});

		it("throws when calling stream without auth", async () => {
			expect(() => {
				streamVertexAnthropic(opusModel, context, {
					env: {},
				});
			}).toThrow(/Vertex AI requires credentials/);
		});
	});
});
