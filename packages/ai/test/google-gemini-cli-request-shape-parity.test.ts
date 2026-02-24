import { HarmBlockThreshold, HarmCategory } from "@google/genai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamGoogleGeminiCli } from "../src/providers/google-gemini-cli.js";
import type { Context, Model } from "../src/types.js";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

function createModel(): Model<"google-gemini-cli"> {
	return {
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	};
}

function createContext(): Context {
	return {
		systemPrompt: "System prompt",
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		tools: [
			{
				name: "sum",
				description: "Sum numbers",
				parameters: Type.Object({
					a: Type.Number(),
					b: Type.Number(),
				}),
			},
		],
	};
}

function createSseResponse(): Response {
	const event = {
		response: {
			candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
			usageMetadata: {
				promptTokenCount: 1,
				candidatesTokenCount: 1,
				thoughtsTokenCount: 0,
				totalTokenCount: 2,
				cachedContentTokenCount: 0,
			},
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("google-gemini-cli request shape parity", () => {
	it("sends upstream-style request envelope fields and nested request fields", async () => {
		let capturedInput: Parameters<typeof fetch>[0] | undefined;
		let capturedInit: RequestInit | undefined;

		global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			capturedInput = input;
			capturedInit = init;
			return createSseResponse();
		}) as typeof fetch;

		const stream = streamGoogleGeminiCli(createModel(), createContext(), {
			apiKey: JSON.stringify({ token: "test-token", projectId: "proj-123" }),
			toolChoice: "any",
			temperature: 0.2,
			maxTokens: 128,
			sessionId: "session-1",
			userPromptId: "prompt-1",
			labels: { source: "mu-ai" },
			cachedContent: "cached/abc",
			safetySettings: [
				{
					category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
					threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
				},
			],
			generationConfig: {
				topP: 0.9,
				candidateCount: 1,
			},
			thinking: { enabled: true, budgetTokens: 1024 },
		});

		for await (const _event of stream) {
			// consume
		}
		await stream.result();

		expect(capturedInput).toBeDefined();
		expect(capturedInit).toBeDefined();
		expect(String(capturedInput)).toBe(
			"https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		);

		const headers = new Headers(capturedInit?.headers);
		expect(headers.get("authorization")).toBe("Bearer test-token");
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("accept")).toBeNull();

		const body = JSON.parse(String(capturedInit?.body ?? "{}")) as Record<string, unknown>;
		expect(body.project).toBe("proj-123");
		expect(body.model).toBe("gemini-2.5-pro");
		expect(body.user_prompt_id).toBe("prompt-1");
		expect(body.requestId).toBeUndefined();
		expect(body.userAgent).toBeUndefined();

		const request = body.request as Record<string, unknown>;
		expect(request.contents).toBeDefined();
		expect(request.systemInstruction).toEqual({
			role: "user",
			parts: [{ text: "System prompt" }],
		});
		expect(request.cachedContent).toBe("cached/abc");
		expect(request.labels).toEqual({ source: "mu-ai" });
		expect(request.safetySettings).toEqual([
			{
				category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
				threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
			},
		]);
		expect(request.session_id).toBe("session-1");
		expect(request.generationConfig).toEqual({
			temperature: 0.2,
			maxOutputTokens: 128,
			topP: 0.9,
			candidateCount: 1,
			thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
		});
	});

	it("always sends user_prompt_id even when caller does not provide one", async () => {
		let capturedInit: RequestInit | undefined;

		global.fetch = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			capturedInit = init;
			return createSseResponse();
		}) as typeof fetch;

		const stream = streamGoogleGeminiCli(createModel(), createContext(), {
			apiKey: JSON.stringify({ token: "test-token", projectId: "proj-123" }),
		});

		for await (const _event of stream) {
			// consume
		}
		await stream.result();

		const body = JSON.parse(String(capturedInit?.body ?? "{}")) as Record<string, unknown>;
		expect(typeof body.user_prompt_id).toBe("string");
		expect(String(body.user_prompt_id)).toMatch(/^mu-/);
		expect(body.requestId).toBeUndefined();
		expect(body.userAgent).toBeUndefined();
	});
});
