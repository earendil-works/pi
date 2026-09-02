import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import { AnthropicVertex, type ClientOptions } from "@anthropic-ai/vertex-sdk";
import { describe, expect, it } from "vitest";

interface CapturedRequest {
	url: string;
	method: string;
	headers: Headers;
	body: Record<string, unknown>;
	signal: AbortSignal;
}

function fakeAuthClient(
	projectId: string | null = "credential-project",
	token = "google-token",
	userProject?: string,
): NonNullable<ClientOptions["authClient"]> {
	return {
		projectId,
		getRequestHeaders: async () => ({
			Authorization: `Bearer ${token}`,
			...(userProject ? { "x-goog-user-project": userProject } : {}),
		}),
	} as unknown as NonNullable<ClientOptions["authClient"]>;
}

function requestBody(): MessageCreateParamsStreaming {
	return {
		model: "claude-sonnet-5",
		max_tokens: 128,
		messages: [{ role: "user", content: "hello" }],
		stream: true,
		tools: [
			{
				name: "lookup",
				description: "Look up a value",
				input_schema: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
				},
				eager_input_streaming: true,
			},
		],
	};
}

function captureFetch(status = 200): {
	fetch: NonNullable<ClientOptions["fetch"]>;
	requests: CapturedRequest[];
} {
	const requests: CapturedRequest[] = [];
	const fetch: NonNullable<ClientOptions["fetch"]> = async (input, init) => {
		const request = new Request(input, init);
		const rawBody = await request.clone().text();
		requests.push({
			url: request.url,
			method: request.method,
			headers: request.headers,
			body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
			signal: request.signal,
		});
		return new Response(status === 200 ? "" : JSON.stringify({ error: { message: `status ${status}` } }), {
			status,
			headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" },
		});
	};
	return { fetch, requests };
}

describe("Anthropic Vertex SDK contract", () => {
	it.each([
		["global", "https://aiplatform.googleapis.com/v1"],
		["us", "https://aiplatform.us.rep.googleapis.com/v1"],
		["eu", "https://aiplatform.eu.rep.googleapis.com/v1"],
		["us-east5", "https://us-east5-aiplatform.googleapis.com/v1"],
	])("derives the %s endpoint and Vertex streaming path", async (region, baseUrl) => {
		const captured = captureFetch();
		const client = new AnthropicVertex({
			projectId: "explicit-project",
			region,
			authClient: fakeAuthClient(),
			fetch: captured.fetch,
		});

		await client.messages.create(requestBody(), { maxRetries: 0 }).asResponse();

		expect(captured.requests).toHaveLength(1);
		expect(captured.requests[0]?.url).toBe(
			`${baseUrl}/projects/explicit-project/locations/${region}/publishers/anthropic/models/claude-sonnet-5:streamRawPredict`,
		);
		expect(captured.requests[0]?.method).toBe("POST");
	});

	it("infers project identity from Google auth and transforms the body exactly once", async () => {
		const captured = captureFetch();
		const client = new AnthropicVertex({
			projectId: null,
			region: "global",
			authClient: fakeAuthClient("inferred-project"),
			fetch: captured.fetch,
		});

		await client.messages.create(requestBody(), { maxRetries: 0 }).asResponse();

		expect(captured.requests[0]?.url).toContain("/projects/inferred-project/locations/global/");
		expect(captured.requests[0]?.headers.get("authorization")).toBe("Bearer google-token");
		expect(captured.requests[0]?.headers.has("x-api-key")).toBe(false);
		expect(captured.requests[0]?.body).toMatchObject({
			anthropic_version: "vertex-2023-10-16",
			max_tokens: 128,
			stream: true,
			tools: [
				expect.objectContaining({
					name: "lookup",
					eager_input_streaming: true,
				}),
			],
		});
		expect(captured.requests[0]?.body).not.toHaveProperty("model");
	});

	it("infers project identity from the Google quota-project header", async () => {
		const captured = captureFetch();
		const client = new AnthropicVertex({
			projectId: null,
			region: "global",
			authClient: fakeAuthClient(null, "google-token", "quota-project"),
			fetch: captured.fetch,
		});

		await client.messages.create(requestBody(), { maxRetries: 0 }).asResponse();

		expect(captured.requests[0]?.url).toContain("/projects/quota-project/locations/global/");
	});

	it("uses SDK endpoint derivation when baseURL is explicitly null", async () => {
		const previous = process.env.ANTHROPIC_VERTEX_BASE_URL;
		process.env.ANTHROPIC_VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
		try {
			const captured = captureFetch();
			const client = new AnthropicVertex({
				projectId: "explicit-project",
				region: "us",
				baseURL: null,
				authClient: fakeAuthClient(),
				fetch: captured.fetch,
			});

			await client.messages.create(requestBody(), { maxRetries: 0 }).asResponse();

			expect(captured.requests[0]?.url).toBe(
				"https://aiplatform.us.rep.googleapis.com/v1/projects/explicit-project/locations/us/publishers/anthropic/models/claude-sonnet-5:streamRawPredict",
			);
		} finally {
			if (previous === undefined) delete process.env.ANTHROPIC_VERTEX_BASE_URL;
			else process.env.ANTHROPIC_VERTEX_BASE_URL = previous;
		}
	});

	it("preserves custom base-URL path prefixes while Google auth replaces constructor defaults", async () => {
		const captured = captureFetch();
		const client = new AnthropicVertex({
			projectId: "explicit-project",
			region: "global",
			baseURL: "https://proxy.example.test/gateway/vertex/v1",
			defaultHeaders: { Authorization: "Bearer caller-override" },
			authClient: fakeAuthClient(),
			fetch: captured.fetch,
		});

		await client.messages.create(requestBody(), { maxRetries: 0 }).asResponse();

		expect(captured.requests[0]?.url).toBe(
			"https://proxy.example.test/gateway/vertex/v1/projects/explicit-project/locations/global/publishers/anthropic/models/claude-sonnet-5:streamRawPredict",
		);
		expect(captured.requests[0]?.headers.get("authorization")).toBe("Bearer google-token");
	});

	it("preserves an intentional request-level Authorization override", async () => {
		const captured = captureFetch();
		const client = new AnthropicVertex({
			projectId: "explicit-project",
			region: "global",
			authClient: fakeAuthClient(),
			fetch: captured.fetch,
		});

		await client.messages
			.create(requestBody(), {
				maxRetries: 0,
				headers: { Authorization: "Bearer caller-override" },
			})
			.asResponse();

		expect(captured.requests[0]?.headers.get("authorization")).toBe("Bearer caller-override");
	});

	it.each([403, 429, 503])(
		"performs one SDK attempt for HTTP %s when request retries are disabled",
		async (status) => {
			const captured = captureFetch(status);
			const client = new AnthropicVertex({
				projectId: "explicit-project",
				region: "global",
				authClient: fakeAuthClient(),
				fetch: captured.fetch,
			});

			await expect(client.messages.create(requestBody(), { maxRetries: 0 }).asResponse()).rejects.toMatchObject({
				status,
			});
			expect(captured.requests).toHaveLength(1);
		},
	);

	it("performs one auth attempt and no fetch when credential acquisition fails", async () => {
		const captured = captureFetch();
		let authAttempts = 0;
		const authClient = {
			projectId: "credential-project",
			getRequestHeaders: async () => {
				authAttempts += 1;
				throw new Error("synthetic credential failure");
			},
		} as unknown as NonNullable<ClientOptions["authClient"]>;
		const client = new AnthropicVertex({
			region: "global",
			authClient,
			fetch: captured.fetch,
		});

		await expect(client.messages.create(requestBody(), { maxRetries: 0 }).asResponse()).rejects.toThrow(
			"synthetic credential failure",
		);
		expect(authAttempts).toBe(1);
		expect(captured.requests).toEqual([]);
	});
});
