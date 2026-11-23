import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LATEST_PROTOCOL_VERSION, McpClient, StreamableHttpTransport } from "../src/index.ts";
import { closeServers, listen, readBody } from "./helpers.ts";

interface RecordedRequest {
	method: string;
	headers: IncomingMessage["headers"];
	message?: Record<string, unknown>;
}

type Reply = (message: Record<string, unknown>, response: ServerResponse) => boolean | Promise<boolean>;

const TOOLS = [
	{
		name: "query",
		inputSchema: {
			type: "object",
			properties: {
				region: { type: "string", "x-mcp-header": "Region" },
				verbose: { type: "boolean", "x-mcp-header": "Verbose" },
				sql: { type: "string" },
			},
		},
	},
	{
		name: "broken",
		inputSchema: { type: "object", properties: { data: { type: "object", "x-mcp-header": "Data" } } },
	},
];

function json(response: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
	response.writeHead(status, { "content-type": "application/json", ...headers });
	response.end(JSON.stringify(body));
}

/** A modern server; `reply` may answer a message first. It hands out a session id that clients must ignore. */
async function startModernServer(reply?: Reply): Promise<{ url: string; requests: RecordedRequest[] }> {
	const requests: RecordedRequest[] = [];
	const origin = await listen(async (request, response) => {
		if (request.method !== "POST") {
			requests.push({ method: request.method ?? "", headers: request.headers });
			response.statusCode = 405;
			response.end();
			return;
		}
		const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
		requests.push({ method: "POST", headers: request.headers, message });
		if (reply && (await reply(message, response))) return;
		const session = { "mcp-session-id": "should-be-ignored" };
		switch (message.method) {
			case "server/discover":
				json(
					response,
					{
						jsonrpc: "2.0",
						id: message.id,
						result: {
							resultType: "complete",
							supportedVersions: ["2026-07-28"],
							capabilities: { tools: { listChanged: true } },
							ttlMs: 0,
							cacheScope: "public",
						},
					},
					200,
					session,
				);
				return;
			case "tools/list":
				json(
					response,
					{ jsonrpc: "2.0", id: message.id, result: { resultType: "complete", tools: TOOLS } },
					200,
					session,
				);
				return;
			case "tools/call":
				json(response, { jsonrpc: "2.0", id: message.id, result: { resultType: "complete", content: [] } });
				return;
			default:
				json(
					response,
					{ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } },
					404,
				);
		}
	});
	return { url: `${origin}/mcp`, requests };
}

async function connect(url: string): Promise<McpClient> {
	const client = new McpClient({ name: "test-client", version: "1.0.0", protocol: "auto" });
	await client.connect(new StreamableHttpTransport({ url }));
	return client;
}

afterEach(closeServers);

describe("StreamableHttpTransport with the stateless protocol", () => {
	it("sends the version, method, and name headers and no session", async () => {
		const { url, requests } = await startModernServer();
		const client = await connect(url);
		expect(client.protocolEra).toBe("modern");
		await client.listTools();
		await client.callTool("query", { region: "eu-wést", verbose: false, sql: "select 1" });

		const [discover, list, call] = requests;
		expect(discover!.headers).toMatchObject({
			"mcp-protocol-version": "2026-07-28",
			"mcp-method": "server/discover",
		});
		expect(list!.headers["mcp-session-id"]).toBeUndefined();
		expect(call!.headers).toMatchObject({
			"mcp-protocol-version": "2026-07-28",
			"mcp-method": "tools/call",
			"mcp-name": "query",
			"mcp-param-region": "=?base64?ZXUtd8Opc3Q=?=",
			"mcp-param-verbose": "false",
		});
		expect(call!.headers["mcp-param-sql"]).toBeUndefined();
		await client.close();
		// No GET stream, and no DELETE: there is no session.
		expect(requests.filter((request) => request.method !== "POST")).toEqual([]);
	});

	it("leaves out tools with invalid x-mcp-header annotations and reports them", async () => {
		const { url } = await startModernServer();
		const client = await connect(url);
		const errors: string[] = [];
		client.onError((error) => errors.push(error.message));
		expect((await client.listTools()).map((tool) => tool.name)).toEqual(["query"]);
		expect(errors).toEqual([
			'Excluded MCP tool "broken": x-mcp-header "Data" must be on a string, integer, or boolean property',
		]);
		await client.close();
	});

	it("delivers JSON-RPC errors of 4xx responses, so version errors are retried", async () => {
		let rejected = false;
		const { url, requests } = await startModernServer((message, response) => {
			if (message.method !== "server/discover" || rejected) return false;
			rejected = true;
			json(
				response,
				{
					jsonrpc: "2.0",
					id: null,
					error: {
						code: -32022,
						message: "Unsupported protocol version",
						data: { supported: ["2026-07-28"], requested: "x" },
					},
				},
				400,
			);
			return true;
		});
		const client = await connect(url);
		expect(client.protocolEra).toBe("modern");
		expect(requests.filter((request) => request.message?.method === "server/discover")).toHaveLength(2);
		await expect(client.request("prompts/list")).rejects.toMatchObject({ code: -32601 });
		await client.close();
	});

	it("falls back to initialize when a legacy server rejects the probe", async () => {
		const requests: RecordedRequest[] = [];
		const origin = await listen(async (request, response) => {
			if (request.method !== "POST") {
				response.statusCode = 405;
				response.end();
				return;
			}
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			requests.push({ method: "POST", headers: request.headers, message });
			if (message.method === "initialize") {
				json(
					response,
					{
						jsonrpc: "2.0",
						id: message.id,
						result: {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: {},
							serverInfo: { name: "legacy", version: "1" },
						},
					},
					200,
					{ "mcp-session-id": "legacy-session" },
				);
			} else if (!("id" in message)) {
				response.statusCode = 202;
				response.end();
			} else if (!request.headers["mcp-session-id"]) {
				// What the TypeScript SDK answers before initialization.
				json(
					response,
					{ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: Server not initialized" } },
					400,
				);
			} else {
				json(response, { jsonrpc: "2.0", id: message.id, result: { tools: [] } });
			}
		});
		const client = await connect(`${origin}/mcp`);
		expect(client.protocolEra).toBe("legacy");
		expect(await client.listTools()).toEqual([]);
		expect(requests.map((request) => request.message?.method)).toEqual([
			"server/discover",
			"initialize",
			"notifications/initialized",
			"tools/list",
		]);
		expect(requests[3]!.headers).toMatchObject({ "mcp-session-id": "legacy-session" });
		expect(requests[3]!.headers["mcp-method"]).toBeUndefined();
		await client.close();
	});

	it("fails a request whose response stream ends early, without trying to resume it", async () => {
		const { url, requests } = await startModernServer((message, response) => {
			if (message.method !== "tools/call") return false;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("id: 1\n");
			response.end(
				`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: (message.params as { _meta: { progressToken: number } })._meta.progressToken, progress: 1 } })}\n\n`,
			);
			return true;
		});
		const client = await connect(url);
		const progress = vi.fn();
		await expect(client.callTool("query", {}, { onProgress: progress })).rejects.toThrow(
			"MCP response stream failed: stream ended without a response",
		);
		expect(progress).toHaveBeenCalledTimes(1);
		expect(requests.filter((request) => request.method === "GET")).toEqual([]);
		await client.close();
	});

	it("cancels by closing the response stream instead of posting notifications/cancelled", async () => {
		let streamClosed!: () => void;
		const closed = new Promise<void>((resolve) => {
			streamClosed = resolve;
		});
		const { url, requests } = await startModernServer((message, response) => {
			if (message.method !== "tools/call") return false;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(": open\n\n");
			response.on("close", streamClosed);
			return true;
		});
		const client = await connect(url);
		const controller = new AbortController();
		const call = client.callTool("query", {}, { signal: controller.signal });
		await vi.waitFor(() => expect(requests.some((request) => request.message?.method === "tools/call")).toBe(true));
		controller.abort("stop");
		await expect(call).rejects.toMatchObject({ name: "AbortError" });
		await closed;
		expect(requests.some((request) => request.message?.method === "notifications/cancelled")).toBe(false);
		await client.close();
	});

	it("streams notifications of a subscription", async () => {
		const { url } = await startModernServer((message, response) => {
			if (message.method !== "subscriptions/listen") return false;
			response.writeHead(200, { "content-type": "text/event-stream" });
			const meta = { "io.modelcontextprotocol/subscriptionId": message.id };
			response.write(
				`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: meta, notifications: { toolsListChanged: true } } })}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: meta } })}\n\n`,
			);
			return true;
		});
		const client = await connect(url);
		const changed = vi.fn();
		client.onNotification("notifications/tools/list_changed", changed);
		const subscription = await client.listen({ toolsListChanged: true });
		await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
		subscription.close();
		await subscription.closed;
		await client.close();
	});
});
