import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	LATEST_PROTOCOL_VERSION,
	type McpAuthRequiredError,
	McpClient,
	McpSessionExpiredError,
	StreamableHttpTransport,
} from "../src/index.ts";
import { consumeSseStream, type SseEvent } from "../src/transports/streamable-http.ts";
import { closeServers, listen, readBody } from "./helpers.ts";

interface RecordedRequest {
	method: string;
	headers: IncomingMessage["headers"];
	message?: Record<string, unknown>;
}

async function startServer(
	handler: (request: IncomingMessage, response: ServerResponse, requests: RecordedRequest[]) => Promise<void>,
): Promise<{ url: string; requests: RecordedRequest[] }> {
	const requests: RecordedRequest[] = [];
	const origin = await listen((request, response) => handler(request, response, requests));
	return { url: `${origin}/mcp`, requests };
}

async function protocolHandler(
	request: IncomingMessage,
	response: ServerResponse,
	requests: RecordedRequest[],
): Promise<void> {
	if (request.method === "GET") {
		requests.push({ method: "GET", headers: request.headers });
		response.statusCode = 405;
		response.end();
		return;
	}
	if (request.method === "DELETE") {
		requests.push({ method: "DELETE", headers: request.headers });
		response.statusCode = 200;
		response.end();
		return;
	}
	const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
	requests.push({ method: request.method ?? "", headers: request.headers, message });
	if (!("id" in message)) {
		response.statusCode = 202;
		response.end();
		return;
	}
	if (message.method === "initialize") {
		response.writeHead(200, {
			"content-type": "application/json",
			"mcp-session-id": "session-1",
		});
		response.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "http-fixture", version: "1.0.0" },
				},
			}),
		);
		return;
	}
	if (message.method === "tools/list") {
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
			}),
		);
		return;
	}
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write("id: tool-result\n");
	response.end(
		`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "hello" }] } })}\n\n`,
	);
}

afterEach(closeServers);

describe("consumeSseStream", () => {
	it("parses chunked CRLF events, comments, IDs, and multiline data", async () => {
		const encoder = new TextEncoder();
		const chunks = [': keepalive\r\nid: 7\r\ndata: {"one":\r\n', "data: 1}\r\n\r\n"];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});
		const events: SseEvent[] = [];
		await consumeSseStream(stream, { onEvent: (event) => events.push(event) });
		expect(events).toEqual([{ id: "7", data: '{"one":\n1}' }]);
	});
});

describe("StreamableHttpTransport", () => {
	it("handles JSON and SSE responses with session and protocol headers", async () => {
		const { url, requests } = await startServer(protocolHandler);
		const transport = new StreamableHttpTransport({ url });
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(transport);
		expect(transport.sessionId).toBe("session-1");
		expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
		expect(await client.callTool("echo", { text: "hello" })).toEqual({
			content: [{ type: "text", text: "hello" }],
		});
		await client.close();

		const listRequest = requests.find((entry) => entry.message?.method === "tools/list");
		expect(listRequest?.headers["mcp-session-id"]).toBe("session-1");
		expect(listRequest?.headers["mcp-protocol-version"]).toBe(LATEST_PROTOCOL_VERSION);
		expect(requests.some((entry) => entry.method === "GET")).toBe(true);
		expect(requests.some((entry) => entry.method === "DELETE")).toBe(true);
	});

	it("classifies authentication failures", async () => {
		const { url } = await startServer(async (request, response) => {
			await readBody(request);
			response.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="https://example.com/meta"' });
			response.end("login required");
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await expect(client.connect(new StreamableHttpTransport({ url }))).rejects.toMatchObject({
			name: "McpAuthRequiredError",
			status: 401,
			body: "login required",
			wwwAuthenticate: 'Bearer resource_metadata="https://example.com/meta"',
		} satisfies Partial<McpAuthRequiredError>);
	});

	it("classifies an expired established session", async () => {
		let posts = 0;
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method === "POST" && posts++ >= 2) {
				await readBody(request);
				response.statusCode = 404;
				response.end("gone");
				return;
			}
			await protocolHandler(request, response, requests);
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		await expect(client.listTools()).rejects.toBeInstanceOf(McpSessionExpiredError);
		await client.close();
	});
});
