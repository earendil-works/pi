import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type PiMessagesOptions, stream, streamSimple } from "../src/api/pi-messages.ts";
import type { Api, AssistantMessageEvent, Context, Model } from "../src/types.ts";

type RecordedRequest = {
	url: string;
	headers: IncomingMessage["headers"];
	body: unknown;
};

type ResponderOptions = {
	status?: number;
	headers?: Record<string, string>;
	events?: unknown[];
	rawBody?: string;
};

let server: Server | undefined;

afterEach(() => {
	server?.close();
	server = undefined;
});

async function startServer(options: ResponderOptions): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
	const requests: RecordedRequest[] = [];

	server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf-8");
			requests.push({
				url: request.url ?? "",
				headers: request.headers,
				body: raw ? JSON.parse(raw) : undefined,
			});

			if (options.status && options.status !== 200) {
				response.statusCode = options.status;
				response.setHeader("content-type", "application/json");
				response.end(options.rawBody ?? "{}");
				return;
			}

			response.statusCode = 200;
			response.setHeader("content-type", "text/event-stream");
			for (const [name, value] of Object.entries(options.headers ?? {})) {
				response.setHeader(name, value);
			}
			for (const event of options.events ?? []) {
				response.write(`data: ${JSON.stringify(event)}\n\n`);
			}
			response.end();
		});
	});

	await new Promise<void>((resolve) => {
		server!.listen(0, "127.0.0.1", () => resolve());
	});

	const address = server!.address() as AddressInfo;
	return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

function createModel(baseUrl: string): Model<"pi-messages"> {
	return {
		id: "auto",
		name: "Radius Auto",
		api: "pi-messages",
		provider: "radius",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

describe("pi-messages", () => {
	it("streams text and tool calls and resolves the terminal message", async () => {
		const { baseUrl, requests } = await startServer({
			events: [
				{ type: "start" },
				{ type: "text_start", contentIndex: 0 },
				{ type: "text_delta", contentIndex: 0, delta: "Hel" },
				{ type: "text_delta", contentIndex: 0, delta: "lo" },
				{ type: "text_end", contentIndex: 0, content: "Hello" },
				{ type: "toolcall_start", contentIndex: 1, id: "call_1", toolName: "read" },
				{ type: "toolcall_delta", contentIndex: 1, delta: '{"path":' },
				{ type: "toolcall_delta", contentIndex: 1, delta: '"a.txt"}' },
				{
					type: "toolcall_end",
					contentIndex: 1,
					toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } },
				},
				{ type: "done", reason: "toolUse", usage, responseId: "resp_1" },
			],
		});
		const model = createModel(baseUrl);

		const events: AssistantMessageEvent[] = [];
		const eventStream = stream(model, context, {
			apiKey: "test-key",
			sessionId: "session-1",
			toolChoice: "auto",
			maxTokens: 100,
			headers: { "x-custom": "1" },
		});
		for await (const event of eventStream) {
			events.push(event);
		}
		const message = await eventStream.result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.usage).toEqual(usage);
		expect(message.responseId).toBe("resp_1");
		expect(message.model).toBe("auto");
		expect(message.provider).toBe("radius");
		expect(message.content).toEqual([
			{ type: "text", text: "Hello", textSignature: undefined },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } },
		]);
		expect(events.some((event) => event.type === "text_delta")).toBe(true);
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);

		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request.url).toBe("/v1/messages");
		expect(request.headers.authorization).toBe("Bearer test-key");
		expect(request.headers["x-custom"]).toBe("1");
		expect(request.body).toEqual({
			model: "auto",
			context,
			options: { maxTokens: 100, sessionId: "session-1", toolChoice: "auto" },
		});
	});

	it("appends debug=1 and reports response headers via onResponse", async () => {
		const { baseUrl, requests } = await startServer({
			headers: { "x-pi-gateway-upstream-provider": "anthropic" },
			events: [{ type: "done", reason: "stop", usage }],
		});
		const model = createModel(baseUrl);

		let observedHeaders: Record<string, string> | undefined;
		const options: PiMessagesOptions = {
			apiKey: "test-key",
			debug: true,
			onResponse: (response) => {
				observedHeaders = response.headers;
			},
		};
		const message = await streamSimple(model, context, options).result();

		expect(message.stopReason).toBe("stop");
		expect(requests[0].url).toBe("/v1/messages?debug=1");
		expect(observedHeaders?.["x-pi-gateway-upstream-provider"]).toBe("anthropic");
	});

	it("surfaces backend error responses with diagnostics", async () => {
		const { baseUrl } = await startServer({
			status: 401,
			rawBody: JSON.stringify({ error: { message: "Token expired", code: "unauthorized" } }),
		});
		const model = createModel(baseUrl);

		const message = await stream(model, context, { apiKey: "stale" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("401");
		expect(message.errorMessage).toContain("Token expired");
		expect(message.errorMessage).toContain("unauthorized");
		expect(message.diagnostics?.[0]?.type).toBe("pi_messages_response_failure");
		expect(message.diagnostics?.[0]?.details?.status).toBe(401);
	});

	it("propagates server-sent error events", async () => {
		const { baseUrl } = await startServer({
			events: [{ type: "start" }, { type: "error", reason: "error", usage, errorMessage: "Upstream failed" }],
		});
		const model = createModel(baseUrl);

		const message = await stream(model, context, { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Upstream failed");
		expect(message.usage).toEqual(usage);
	});

	it("errors when no API key is provided", async () => {
		const model = createModel("http://127.0.0.1:1/v1");

		const message = await stream(model, context).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("No API key provided");
	});

	it("errors when the stream ends without a terminal event", async () => {
		const { baseUrl } = await startServer({
			events: [
				{ type: "start" },
				{ type: "text_start", contentIndex: 0 },
				{ type: "text_delta", contentIndex: 0, delta: "partial" },
			],
		});
		const model = createModel(baseUrl);

		const message = await stream(model, context, { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("stream ended without a terminal event");
	});
});

describe("pi-messages api registration", () => {
	it("is registered as a builtin api provider", async () => {
		const { getApiProvider } = await import("../src/compat.ts");
		expect(getApiProvider("pi-messages")).toBeDefined();
	});

	it("is a known api usable on models", () => {
		const api: Api = "pi-messages";
		expect(api).toBe("pi-messages");
	});
});
