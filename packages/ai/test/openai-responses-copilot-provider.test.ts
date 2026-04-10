import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);

	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key?.toLowerCase() === lowerName);
		return match?.[1] ?? null;
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return typeof value === "string" ? value : value.join(", ");
	}
	return null;
}

async function captureOpenAIResponseHeaders(
	options: Parameters<typeof streamOpenAIResponses>[2],
): Promise<{ sessionId: string | null; clientRequestId: string | null }> {
	const captured = { sessionId: null as string | null, clientRequestId: null as string | null };
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const stream = streamOpenAIResponses(
		getModel("openai", "gpt-5.4"),
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key", ...options },
	);

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits reasoning when no reasoning is requested", async () => {
		const model = getModel("github-copilot", "gpt-5-mini");
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload).not.toMatchObject({
			reasoning: expect.anything(),
		});
	});

	it("sets cache-affinity headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured).toEqual({ sessionId: "session-123", clientRequestId: "session-123" });
	});

	it("lets explicit headers override the default OpenAI cache-affinity headers", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			headers: {
				session_id: "override-session",
				"x-client-request-id": "override-request",
			},
		});

		expect(captured).toEqual({ sessionId: "override-session", clientRequestId: "override-request" });
	});

	it("omits OpenAI cache-affinity headers when cacheRetention is none", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured).toEqual({ sessionId: null, clientRequestId: null });
	});
});
