import { describe, expect, it, vi } from "vitest";

describe("anthropic-vertex messages client", () => {
	it("rewrites Anthropic message requests to the Vertex streamRawPredict endpoint", async () => {
		const { createAnthropicVertexMessagesClient } = await import("../src/providers/anthropic-vertex.ts");

		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		const client = createAnthropicVertexMessagesClient({
			projectId: "test-project",
			region: "global",
			authClient: {
				projectId: "test-project",
				getRequestHeaders: async () => ({ Authorization: "Bearer test-token" }),
			},
			fetch: fetchMock,
		});

		await client.messages
			.create({
				model: "claude-opus-4-6",
				max_tokens: 16,
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			})
			.asResponse();

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(
			"https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/anthropic/models/claude-opus-4-6:streamRawPredict",
		);
		expect(init).toMatchObject({
			method: "POST",
			headers: expect.objectContaining({
				Authorization: "Bearer test-token",
				accept: "application/json",
				"content-type": "application/json",
			}),
		});
		expect(JSON.parse(String(init.body))).toEqual({
			anthropic_version: "vertex-2023-10-16",
			max_tokens: 16,
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		});
	});

	it("retries retryable failures when maxRetries is set", async () => {
		const { createAnthropicVertexMessagesClient } = await import("../src/providers/anthropic-vertex.ts");

		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		fetchMock.mockResolvedValueOnce(new Response("temporary outage", { status: 503 }));
		fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		const client = createAnthropicVertexMessagesClient({
			projectId: "test-project",
			region: "global",
			authClient: {
				projectId: "test-project",
				getRequestHeaders: async () => ({ Authorization: "Bearer test-token" }),
			},
			fetch: fetchMock as unknown as typeof fetch,
		});

		await client.messages
			.create(
				{
					model: "claude-opus-4-6",
					max_tokens: 16,
					stream: true,
					messages: [{ role: "user", content: "retry me" }],
				},
				{ maxRetries: 1 },
			)
			.asResponse();

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each([
		["global", "https://aiplatform.googleapis.com"],
		["us", "https://aiplatform.us.rep.googleapis.com"],
		["eu", "https://aiplatform.eu.rep.googleapis.com"],
		["us-central1", "https://us-central1-aiplatform.googleapis.com"],
	])("uses the correct Vertex host for %s", async (region, expectedBaseUrl) => {
		const { createAnthropicVertexMessagesClient } = await import("../src/providers/anthropic-vertex.ts");

		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		const client = createAnthropicVertexMessagesClient({
			projectId: "test-project",
			region,
			authClient: {
				projectId: "test-project",
				getRequestHeaders: async () => ({ Authorization: "Bearer test-token" }),
			},
			fetch: fetchMock,
		});

		await client.messages
			.create({
				model: "claude-opus-4-6",
				max_tokens: 16,
				stream: true,
				messages: [{ role: "user", content: "hi" }],
			})
			.asResponse();

		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toBe(
			`${expectedBaseUrl}/v1/projects/test-project/locations/${region}/publishers/anthropic/models/claude-opus-4-6:streamRawPredict`,
		);
	});
});
