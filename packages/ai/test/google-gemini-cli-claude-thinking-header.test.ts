import { afterEach, describe, expect, it, vi } from "vitest";
import { streamGoogleGeminiCli } from "../src/providers/google-gemini-cli.ts";
import type { Context, Model } from "../src/types.ts";

const originalFetch = global.fetch;
const apiKey = JSON.stringify({ token: "token", projectId: "project" });

const createSseResponse = () => {
	const sse = `${[
		`data: ${JSON.stringify({
			response: {
				candidates: [
					{
						content: { role: "model", parts: [{ text: "Hello" }] },
						finishReason: "STOP",
					},
				],
			},
		})}`,
	].join("\n\n")}\n\n`;

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(sse));
			controller.close();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
};

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("google-gemini-cli Claude thinking header", () => {
	const context: Context = {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};

	it("adds anthropic-beta for Claude thinking models", async () => {
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
			return createSseResponse();
		});

		global.fetch = fetchMock as typeof fetch;

		const model: Model<"google-gemini-cli"> = {
			id: "claude-opus-4-5-thinking",
			name: "Claude Opus 4.5 Thinking",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://cloudcode-pa.googleapis.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};

		const stream = streamGoogleGeminiCli(model, context, { apiKey });
		for await (const _event of stream) {
			// exhaust stream
		}
		await stream.result();
	});

	it("does not add anthropic-beta for Gemini models", async () => {
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.has("anthropic-beta")).toBe(false);
			return createSseResponse();
		});

		global.fetch = fetchMock as typeof fetch;

		const model: Model<"google-gemini-cli"> = {
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: "https://cloudcode-pa.googleapis.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};

		const stream = streamGoogleGeminiCli(model, context, { apiKey });
		for await (const _event of stream) {
			// exhaust stream
		}
		await stream.result();
	});
});
