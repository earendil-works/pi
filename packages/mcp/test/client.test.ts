import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type JsonRpcMessage,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpAbortError,
	McpClient,
	McpError,
	McpTimeoutError,
	type McpTransport,
} from "../src/index.ts";
import { createInMemoryTransportPair, type InMemoryTransport } from "../src/testing/index.ts";

interface TestServer {
	transport: InMemoryTransport;
	messages: JsonRpcMessage[];
	setHandler(method: string, handler: (request: JsonRpcRequest) => unknown | Promise<unknown>): void;
}

async function createServer(): Promise<{ clientTransport: InMemoryTransport; server: TestServer }> {
	const pair = createInMemoryTransportPair();
	const handlers = new Map<string, (request: JsonRpcRequest) => unknown | Promise<unknown>>();
	const messages: JsonRpcMessage[] = [];
	pair.server.onMessage((message) => {
		messages.push(message);
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const handler = handlers.get(request.method);
		queueMicrotask(async () => {
			try {
				if (!handler) throw new McpError(-32601, `Method not found: ${request.method}`);
				await pair.server.send({ jsonrpc: "2.0", id: request.id, result: await handler(request) });
			} catch (error) {
				const mcpError = error instanceof McpError ? error : new McpError(-32603, String(error));
				await pair.server.send({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: mcpError.code, message: mcpError.message, data: mcpError.data },
				});
			}
		});
	});
	await pair.server.start();
	const server: TestServer = {
		transport: pair.server,
		messages,
		setHandler(method, handler) {
			handlers.set(method, handler);
		},
	};
	server.setHandler("initialize", () => ({
		protocolVersion: LATEST_PROTOCOL_VERSION,
		capabilities: { tools: { listChanged: true } },
		serverInfo: { name: "test-server", version: "1.0.0" },
		instructions: "Use test tools.",
	}));
	return { clientTransport: pair.client, server };
}

async function connect(): Promise<{ client: McpClient; server: TestServer }> {
	const { clientTransport, server } = await createServer();
	const client = new McpClient({ name: "test-client", version: "2.0.0" });
	await client.connect(clientTransport);
	return { client, server };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("McpClient", () => {
	it("initializes the connection before exposing server information", async () => {
		const { client, server } = await connect();
		expect(client.connectionState).toBe("connected");
		expect(client.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
		expect(client.serverInfo).toEqual({ name: "test-server", version: "1.0.0" });
		expect(client.serverCapabilities).toEqual({ tools: { listChanged: true } });
		expect(client.instructions).toBe("Use test tools.");
		expect(server.messages).toEqual([
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "test-client", version: "2.0.0" },
				},
			},
			{ jsonrpc: "2.0", method: "notifications/initialized" },
		]);
		await client.close();
	});

	it("paginates tools and preserves protocol tool definitions", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/list", (request) => {
			const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
			return cursor === undefined
				? {
						tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
						nextCursor: "page-2",
					}
				: {
						tools: [
							{
								name: "read",
								inputSchema: { type: "object" },
								outputSchema: { type: "object" },
								annotations: { readOnlyHint: true },
							},
						],
						// Some servers end pagination with an empty cursor instead of omitting it.
						nextCursor: "",
					};
		});
		expect(await client.listTools()).toEqual([
			{ name: "search", description: "Search", inputSchema: { type: "object" } },
			{
				name: "read",
				inputSchema: { type: "object" },
				outputSchema: { type: "object" },
				annotations: { readOnlyHint: true },
			},
		]);
		await client.close();
	});

	it("lists and reads resources", async () => {
		const { client, server } = await connect();
		server.setHandler("resources/list", (request) =>
			(request.params as { cursor?: string } | undefined)?.cursor === undefined
				? { resources: [{ uri: "file:///a", name: "a", mimeType: "text/plain" }], nextCursor: "2" }
				: { resources: [{ uri: "file:///b" }] },
		);
		server.setHandler("resources/templates/list", () => ({
			resourceTemplates: [{ uriTemplate: "repo://{owner}/{repo}", name: "repo" }],
		}));
		server.setHandler("resources/read", (request) => ({
			contents: [{ uri: (request.params as { uri: string }).uri, text: "hello" }],
		}));
		// A missing name falls back to the URI.
		expect(await client.listResources()).toEqual([
			{ uri: "file:///a", name: "a", mimeType: "text/plain" },
			{ uri: "file:///b", name: "file:///b" },
		]);
		expect(await client.listResourceTemplates()).toEqual([{ uriTemplate: "repo://{owner}/{repo}", name: "repo" }]);
		// Single pages pass the cursor through.
		expect(await client.listResourcesPage()).toEqual({
			resources: [{ uri: "file:///a", name: "a", mimeType: "text/plain" }],
			nextCursor: "2",
		});
		expect(await client.listResourcesPage("2")).toEqual({ resources: [{ uri: "file:///b", name: "file:///b" }] });
		expect(await client.readResource("file:///a")).toEqual({ contents: [{ uri: "file:///a", text: "hello" }] });

		server.setHandler("resources/read", () => ({ contents: [{ uri: "file:///a" }] }));
		await expect(client.readResource("file:///a")).rejects.toThrow("Invalid contents in MCP resources/read result");
		server.setHandler("resources/list", () => ({ resources: [{ name: "no uri" }] }));
		await expect(client.listResources()).rejects.toThrow("Invalid entry in MCP resources/list result");
		await client.close();
	});

	it("returns structured tool content and surfaces JSON-RPC errors", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/call", (request) => {
			const params = request.params as { name: string; arguments?: Record<string, unknown> };
			if (params.name === "fail") throw new McpError(1234, "tool failed", { retryable: false });
			return {
				content: [{ type: "text", text: "ok" }],
				structuredContent: { count: params.arguments?.count },
			};
		});
		expect(await client.callTool("count", { count: 3 })).toEqual({
			content: [{ type: "text", text: "ok" }],
			structuredContent: { count: 3 },
		});
		await expect(client.callTool("fail")).rejects.toMatchObject({
			name: "McpError",
			code: 1234,
			message: "tool failed",
			data: { retryable: false },
		});
		await client.close();
	});

	it("renews the timeout on progress", async () => {
		vi.useFakeTimers();
		const { client, server } = await connect();
		server.setHandler("tools/call", async (request) => {
			const token = ((request.params as Record<string, unknown>)._meta as Record<string, unknown>)
				.progressToken as number;
			setTimeout(() => {
				void server.transport.send({
					jsonrpc: "2.0",
					method: "notifications/progress",
					params: { progressToken: token, progress: 1, total: 2 },
				});
			}, 40);
			await new Promise((resolve) => setTimeout(resolve, 80));
			return { content: [{ type: "text", text: "done" }] };
		});
		const progress = vi.fn();
		const result = client.callTool("slow", {}, { timeoutMs: 50, onProgress: progress });
		await vi.advanceTimersByTimeAsync(40);
		await vi.advanceTimersByTimeAsync(40);
		expect(await result).toEqual({ content: [{ type: "text", text: "done" }] });
		expect(progress).toHaveBeenCalledWith({ progressToken: 2, progress: 1, total: 2 });
		await client.close();
	});

	it("cancels aborted and timed-out requests", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/call", () => new Promise(() => {}));
		const controller = new AbortController();
		const aborted = client.callTool("wait", {}, { signal: controller.signal });
		controller.abort("stop");
		await expect(aborted).rejects.toBeInstanceOf(McpAbortError);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(server.messages).toContainEqual({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 2, reason: "stop" },
		});

		await expect(client.callTool("wait", {}, { timeoutMs: 5 })).rejects.toBeInstanceOf(McpTimeoutError);
		await client.close();
	});

	it("reports transport errors without failing pending requests", async () => {
		const { clientTransport, server } = await createServer();
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
		const errors: Error[] = [];
		client.onError((error) => errors.push(error));
		let respond = () => {};
		server.setHandler(
			"tools/call",
			() =>
				new Promise((resolve) => {
					respond = () => resolve({ content: [] });
				}),
		);
		const call = client.callTool("wait");
		await new Promise((resolve) => setTimeout(resolve, 0));
		clientTransport.emitError(new Error("stray log line"));
		respond();
		expect(await call).toEqual({ content: [] });
		expect(errors.map((error) => error.message)).toEqual(["stray log line"]);
		await client.close();
	});

	it("accepts servers that answer with an older protocol version", async () => {
		const { clientTransport, server } = await createServer();
		server.setHandler("initialize", () => ({
			protocolVersion: "2024-11-05",
			capabilities: {},
			serverInfo: { name: "old-server", version: "0.1.0" },
		}));
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
		expect(client.protocolVersion).toBe("2024-11-05");
		await client.close();

		const unsupported = await createServer();
		unsupported.server.setHandler("initialize", () => ({
			protocolVersion: "1999-01-01",
			capabilities: {},
			serverInfo: { name: "ancient-server", version: "0.1.0" },
		}));
		const rejected = new McpClient({ name: "test-client", version: "1.0.0" });
		await expect(rejected.connect(unsupported.clientTransport)).rejects.toThrow("unsupported protocol version");
		expect(rejected.connectionState).toBe("closed");
	});

	it("defaults missing tool result content to an empty list", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/call", () => ({ structuredContent: { ok: true } }));
		expect(await client.callTool("structured")).toEqual({ content: [], structuredContent: { ok: true } });
		server.setHandler("tools/call", () => ({ content: "not a list" }));
		await expect(client.callTool("broken")).rejects.toThrow("Invalid MCP tools/call result");
		await client.close();
	});

	// #10416: MCP 2026-07-28 allows any JSON value as structured content.
	it("accepts structured content that is not an object", async () => {
		const { client, server } = await connect();
		for (const structuredContent of [[{ id: 1 }, { id: 2 }], null, "text", 3, false]) {
			server.setHandler("tools/call", () => ({ content: [], structuredContent }));
			expect(await client.callTool("structured")).toEqual({ content: [], structuredContent });
		}
		await client.close();
	});

	it("does not send notifications/cancelled for a timed-out initialize", async () => {
		const { clientTransport, server } = await createServer();
		server.setHandler("initialize", () => new Promise(() => {}));
		const client = new McpClient({ name: "test-client", version: "1.0.0", requestTimeoutMs: 5 });
		await expect(client.connect(clientTransport)).rejects.toBeInstanceOf(McpTimeoutError);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			server.messages.some((message) => "method" in message && message.method === "notifications/cancelled"),
		).toBe(false);
	});

	it("notifies close listeners once when the transport drops", async () => {
		const { client, server } = await connect();
		const closed = vi.fn();
		client.onClose(closed);
		server.setHandler("tools/call", () => new Promise(() => {}));
		const pending = client.callTool("wait");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await server.transport.close();
		await expect(pending).rejects.toThrow("MCP connection closed");
		expect(client.connectionState).toBe("closed");
		await client.close();
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it("answers roots/list and dispatches notifications", async () => {
		const { clientTransport, server } = await createServer();
		const client = new McpClient({
			name: "test-client",
			version: "1.0.0",
			roots: [{ uri: "file:///workspace", name: "workspace" }],
		});
		await client.connect(clientTransport);
		const changed = vi.fn();
		client.onNotification("notifications/tools/list_changed", changed);
		await server.transport.send({ jsonrpc: "2.0", id: "roots", method: "roots/list" });
		await server.transport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(server.messages).toContainEqual({
			jsonrpc: "2.0",
			id: "roots",
			result: { roots: [{ uri: "file:///workspace", name: "workspace" }] },
		});
		expect(changed).toHaveBeenCalledWith(undefined);
		await client.close();
	});
});

const STATELESS_META = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
	"io.modelcontextprotocol/clientCapabilities": { roots: {} },
};

/** A server that only speaks MCP 2026-07-28: it rejects `initialize` as SDK servers without legacy support do. */
async function createStatelessServer(): Promise<{ clientTransport: InMemoryTransport; server: TestServer }> {
	const created = await createServer();
	created.server.setHandler("initialize", () => {
		throw new McpError(-32022, "Unsupported protocol version: 2025-11-25", {
			supported: ["2026-07-28"],
			requested: "2025-11-25",
		});
	});
	created.server.setHandler("server/discover", () => ({
		supportedVersions: ["2026-07-28"],
		capabilities: { tools: {} },
		instructions: "Stateless tools.",
		resultType: "complete",
		_meta: { "io.modelcontextprotocol/serverInfo": { name: "stateless-server", version: "3.0.0" } },
	}));
	return created;
}

function requestsOf(server: TestServer): JsonRpcRequest[] {
	return server.messages.filter((message): message is JsonRpcRequest => "method" in message && "id" in message);
}

async function connectStateless(options: { protocol?: "2026-07-28"; logLevel?: "info" } = {}) {
	const { clientTransport, server } = await createStatelessServer();
	const sent: { method: string; headers: Record<string, string> | undefined }[] = [];
	const send = clientTransport.send.bind(clientTransport);
	// The in-memory transport carries no headers; record what the client asks for.
	const transport: McpTransport = clientTransport;
	transport.send = (message, sendOptions) => {
		if ("method" in message) sent.push({ method: message.method, headers: sendOptions?.headers });
		return send(message);
	};
	const client = new McpClient({
		name: "test-client",
		version: "1.0.0",
		roots: [{ uri: "file:///workspace", name: "workspace" }],
		...options,
	});
	await client.connect(clientTransport);
	return { client, server, sent };
}

describe("McpClient on the stateless revision (2026-07-28)", () => {
	it("asks with server/discover only when the server rejects initialize", async () => {
		const { client, server } = await connectStateless({ logLevel: "info" });
		expect(client.protocolVersion).toBe("2026-07-28");
		expect(client.serverInfo).toEqual({ name: "stateless-server", version: "3.0.0" });
		expect(client.serverCapabilities).toEqual({ tools: {} });
		expect(client.instructions).toBe("Stateless tools.");
		server.setHandler("tools/list", () => ({ tools: [] }));
		await client.listTools();
		const requests = requestsOf(server);
		expect(requests.map((request) => request.method)).toEqual(["initialize", "server/discover", "tools/list"]);
		// No handshake notification; every request names the version, the client, and the log level.
		expect(server.messages).toHaveLength(requests.length);
		const meta = { ...STATELESS_META, "io.modelcontextprotocol/logLevel": "info" };
		expect(requests[1]?.params).toEqual({ _meta: meta });
		expect(requests[2]?.params).toEqual({ _meta: meta });
		await client.close();
	});

	it("speaks only the stateless revision when pinned", async () => {
		const { client, server } = await connectStateless({ protocol: "2026-07-28" });
		expect(client.protocolVersion).toBe("2026-07-28");
		expect(requestsOf(server).map((request) => request.method)).toEqual(["server/discover"]);
		await client.close();

		const legacy = await createServer();
		const pinned = new McpClient({ name: "test-client", version: "1.0.0", protocol: "2026-07-28" });
		await expect(pinned.connect(legacy.clientTransport)).rejects.toThrow("Method not found: server/discover");
		expect(requestsOf(legacy.server).map((request) => request.method)).toEqual(["server/discover"]);
	});

	it("reports the initialize error when server/discover fails too", async () => {
		const { clientTransport, server } = await createServer();
		server.setHandler("initialize", () => {
			throw new McpError(-32600, "bad initialize");
		});
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		await expect(client.connect(clientTransport)).rejects.toThrow("bad initialize");
		expect(requestsOf(server).map((request) => request.method)).toEqual(["initialize", "server/discover"]);

		// A server that ignores the request does not hold up the error for longer than the request timeout.
		const silent = await createServer();
		silent.server.setHandler("initialize", () => {
			throw new McpError(-32600, "bad initialize");
		});
		silent.server.setHandler("server/discover", () => new Promise(() => {}));
		const waiting = new McpClient({ name: "test-client", version: "1.0.0", requestTimeoutMs: 20 });
		await expect(waiting.connect(silent.clientTransport)).rejects.toThrow("bad initialize");
	});

	it("asks with server/discover when initialize is answered with the stateless revision", async () => {
		const { clientTransport, server } = await createStatelessServer();
		server.setHandler("initialize", () => ({
			protocolVersion: "2026-07-28",
			capabilities: {},
			serverInfo: { name: "stateless-server", version: "3.0.0" },
		}));
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
		expect(client.protocolVersion).toBe("2026-07-28");
		expect(server.messages.map((message) => ("method" in message ? message.method : ""))).toEqual([
			"initialize",
			"server/discover",
		]);
		await client.close();
	});

	it("reports the server/discover error when the rejection proved a stateless server", async () => {
		const { clientTransport, server } = await createStatelessServer();
		server.setHandler("server/discover", () => {
			throw new McpError(-32021, "Missing required client capability: elicitation");
		});
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		await expect(client.connect(clientTransport)).rejects.toThrow("Missing required client capability: elicitation");
	});

	it("reports the initialize rejection when the server is gone after it", async () => {
		const { clientTransport, server } = await createStatelessServer();
		server.setHandler("server/discover", async () => {
			await server.transport.close();
			return new Promise(() => {});
		});
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		await expect(client.connect(clientTransport)).rejects.toMatchObject({ code: -32022 });
	});

	it("does not ask with server/discover when initialize fails without an answer", async () => {
		const { clientTransport, server } = await createServer();
		server.setHandler("initialize", () => new Promise(() => {}));
		const client = new McpClient({ name: "test-client", version: "1.0.0", requestTimeoutMs: 5 });
		await expect(client.connect(clientTransport)).rejects.toBeInstanceOf(McpTimeoutError);
		expect(requestsOf(server).map((request) => request.method)).toEqual(["initialize"]);
	});

	it("rejects a discover result without this client's version", async () => {
		const { clientTransport, server } = await createStatelessServer();
		server.setHandler("server/discover", () => ({ supportedVersions: ["2027-01-01"], capabilities: {} }));
		const client = new McpClient({ name: "test-client", version: "1.0.0", protocol: "2026-07-28" });
		await expect(client.connect(clientTransport)).rejects.toThrow(
			"MCP server supports none of this client's protocol versions: 2027-01-01",
		);
	});

	it("answers input requests and sends the request again until it completes", async () => {
		const { client, server } = await connectStateless();
		server.setHandler("tools/call", (request) => {
			const params = request.params as Record<string, unknown>;
			if (params.requestState === undefined) {
				return {
					resultType: "input_required",
					inputRequests: { roots: { method: "roots/list" } },
					requestState: "state-1",
				};
			}
			return { resultType: "complete", content: [{ type: "text", text: JSON.stringify(params.inputResponses) }] };
		});
		const result = await client.callTool("needs-roots", { a: 1 });
		expect(result.content).toEqual([
			{
				type: "text",
				text: JSON.stringify({ roots: { roots: [{ uri: "file:///workspace", name: "workspace" }] } }),
			},
		]);
		const calls = requestsOf(server).filter((request) => request.method === "tools/call");
		expect(calls.map((request) => request.params)).toEqual([
			{ name: "needs-roots", arguments: { a: 1 }, _meta: STATELESS_META },
			{
				name: "needs-roots",
				arguments: { a: 1 },
				inputResponses: { roots: { roots: [{ uri: "file:///workspace", name: "workspace" }] } },
				requestState: "state-1",
				_meta: STATELESS_META,
			},
		]);
		// Every attempt is a new request.
		expect(new Set(calls.map((request) => request.id)).size).toBe(2);
		await client.close();
	});

	it("fails requests that ask for input the client does not provide, or that never complete", async () => {
		const { client, server } = await connectStateless();
		server.setHandler("tools/call", (request) =>
			(request.params as { name: string }).name === "form"
				? { resultType: "input_required", inputRequests: { form: { method: "elicitation/create", params: {} } } }
				: { resultType: "input_required", requestState: "again" },
		);
		await expect(client.callTool("form")).rejects.toThrow(
			"MCP server asked for input this client does not provide: elicitation/create",
		);
		await expect(client.callTool("loop")).rejects.toThrow("MCP tools/call still asks for input after 16 rounds");
		server.setHandler("tools/list", () => ({ resultType: "input_required", requestState: "x" }));
		await expect(client.listTools()).rejects.toThrow("MCP tools/list result asks for input, which it may not");
		server.setHandler("tools/list", () => ({ resultType: "task", tools: [] }));
		await expect(client.listTools()).rejects.toThrow("Unsupported MCP tools/list result type: task");
		await client.close();
	});

	it("mirrors x-mcp-header arguments into headers and leaves out tools with invalid annotations", async () => {
		const { client, server, sent } = await connectStateless();
		const errors: string[] = [];
		client.onError((error) => errors.push(error.message));
		const regionTool = {
			name: "deploy",
			inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } },
		};
		const invalidTool = {
			name: "broken",
			inputSchema: { type: "object", properties: { data: { type: "object", "x-mcp-header": "Data" } } },
		};
		server.setHandler("tools/list", () => ({ tools: [regionTool, invalidTool] }));
		expect((await client.listTools()).map((tool) => tool.name)).toEqual(["deploy"]);
		expect(errors).toEqual([
			'Excluded MCP tool "broken": x-mcp-header "Data" must be on a string, integer, or boolean property',
		]);

		server.setHandler("tools/call", () => ({ content: [] }));
		await client.callTool("deploy", { region: "us-west1" });
		expect(sent.at(-1)).toEqual({ method: "tools/call", headers: { "Mcp-Param-Region": "us-west1" } });
		await client.close();
	});

	it("lists the tools again and retries once when the server reports mismatching headers", async () => {
		const { client, server, sent } = await connectStateless();
		server.setHandler("tools/list", () => ({
			tools: [
				{
					name: "deploy",
					inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } },
				},
			],
		}));
		let calls = 0;
		server.setHandler("tools/call", () => {
			if (++calls === 1) throw new McpError(-32020, "Header mismatch: Mcp-Param-Region");
			return { content: [{ type: "text", text: "ok" }] };
		});
		// Called before the tools were listed: no bindings yet.
		expect(await client.callTool("deploy", { region: "eu" })).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(sent.slice(-3)).toEqual([
			{ method: "tools/call", headers: undefined },
			{ method: "tools/list", headers: undefined },
			{ method: "tools/call", headers: { "Mcp-Param-Region": "eu" } },
		]);

		server.setHandler("tools/call", () => {
			throw new McpError(-32020, "Header mismatch");
		});
		await expect(client.callTool("deploy", { region: "eu" })).rejects.toThrow("Header mismatch");
		await client.close();
	});
});
