import { describe, expect, it, vi } from "vitest";
import {
	type JsonRpcMessage,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpClient,
	type McpClientOptions,
	McpError,
	type McpTransport,
} from "../src/index.ts";
import { createInMemoryTransportPair, type InMemoryTransport } from "../src/testing/index.ts";

type Handler = (request: JsonRpcRequest) => unknown | Promise<unknown>;

interface FakeServer {
	transport: InMemoryTransport;
	messages: JsonRpcMessage[];
	requests(method: string): JsonRpcRequest[];
	setHandler(method: string, handler: Handler): void;
	notify(method: string, params?: Record<string, unknown>): Promise<void>;
}

const DISCOVER_RESULT = {
	resultType: "complete",
	supportedVersions: ["2026-07-28"],
	capabilities: { tools: { listChanged: true } },
	instructions: "Use modern tools.",
	_meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-server", version: "3.0.0" } },
	ttlMs: 0,
	cacheScope: "public",
};

/** A server over the in-memory transport. `legacy` answers `initialize`; `modern` answers `server/discover`. */
async function createServer(
	era: "legacy" | "modern" | "dual",
): Promise<{ client: InMemoryTransport; server: FakeServer }> {
	const pair = createInMemoryTransportPair();
	const handlers = new Map<string, Handler>();
	const messages: JsonRpcMessage[] = [];
	pair.server.onMessage((message) => {
		messages.push(message);
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const handler = handlers.get(request.method);
		queueMicrotask(async () => {
			try {
				if (!handler) throw new McpError(-32601, `Method not found: ${request.method}`);
				const result = await handler(request);
				if (result === NO_RESPONSE) return;
				await pair.server.send({ jsonrpc: "2.0", id: request.id, result });
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
	const server: FakeServer = {
		transport: pair.server,
		messages,
		requests: (method) =>
			messages.filter(
				(message): message is JsonRpcRequest => "id" in message && "method" in message && message.method === method,
			),
		setHandler: (method, handler) => handlers.set(method, handler),
		notify: (method, params) => pair.server.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
	};
	if (era !== "modern") {
		server.setHandler("initialize", () => ({
			protocolVersion: LATEST_PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: "legacy-server", version: "1.0.0" },
		}));
	}
	if (era !== "legacy") server.setHandler("server/discover", () => DISCOVER_RESULT);
	return { client: pair.client, server };
}

const NO_RESPONSE = Symbol("no response");

function meta(request: JsonRpcRequest): Record<string, unknown> {
	return ((request.params as Record<string, unknown>)._meta ?? {}) as Record<string, unknown>;
}

async function connect(
	era: "legacy" | "modern" | "dual",
	options: Partial<McpClientOptions> = {},
): Promise<{ client: McpClient; server: FakeServer }> {
	const { client: transport, server } = await createServer(era);
	const client = new McpClient({ name: "test-client", version: "2.0.0", protocol: "auto", ...options });
	await client.connect(transport);
	return { client, server };
}

describe("McpClient protocol detection", () => {
	it("speaks the stateless protocol to a server that answers server/discover", async () => {
		const { client, server } = await connect("dual", { logLevel: "info" });
		expect(client.protocolEra).toBe("modern");
		expect(client.protocolVersion).toBe("2026-07-28");
		expect(client.serverInfo).toEqual({ name: "modern-server", version: "3.0.0" });
		expect(client.serverCapabilities).toEqual({ tools: { listChanged: true } });
		expect(client.instructions).toBe("Use modern tools.");
		expect(server.requests("initialize")).toEqual([]);

		server.setHandler("tools/list", () => ({ resultType: "complete", tools: [] }));
		await client.listTools();
		const [request] = server.requests("tools/list");
		expect(meta(request!)).toEqual({
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientInfo": { name: "test-client", version: "2.0.0" },
			"io.modelcontextprotocol/clientCapabilities": {},
			"io.modelcontextprotocol/logLevel": "info",
		});
		// No handshake notification either.
		expect(
			server.messages.some((message) => "method" in message && message.method === "notifications/initialized"),
		).toBe(false);
		await client.close();
	});

	it("falls back to initialize when the server answers server/discover like a legacy server", async () => {
		const { client, server } = await connect("legacy");
		expect(client.protocolEra).toBe("legacy");
		expect(client.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
		expect(server.messages.map((message) => ("method" in message ? message.method : "response"))).toEqual([
			"server/discover",
			"initialize",
			"notifications/initialized",
		]);
		// Legacy requests carry no modern metadata.
		server.setHandler("tools/list", () => ({ tools: [] }));
		await client.listTools();
		expect(server.requests("tools/list")[0]!.params).toBeUndefined();
		await client.close();
	});

	it("falls back to initialize when the server does not answer server/discover in time", async () => {
		const { client: transport, server } = await createServer("legacy");
		server.setHandler("server/discover", () => NO_RESPONSE);
		const client = new McpClient({ name: "test-client", version: "2.0.0", protocol: "auto", requestTimeoutMs: 20 });
		await client.connect(transport);
		expect(client.protocolEra).toBe("legacy");
		// The probe is not cancelled: a legacy server would not know the request.
		expect(
			server.messages.some((message) => "method" in message && message.method === "notifications/cancelled"),
		).toBe(false);
		await client.close();
	});

	it("retries server/discover once with a version from an UnsupportedProtocolVersionError", async () => {
		const { client: transport, server } = await createServer("modern");
		let rejected = false;
		server.setHandler("server/discover", () => {
			if (rejected) return DISCOVER_RESULT;
			rejected = true;
			throw new McpError(-32022, "Unsupported protocol version", {
				supported: ["2026-07-28"],
				requested: "2026-07-28",
			});
		});
		const client = new McpClient({ name: "test-client", version: "2.0.0", protocol: "auto" });
		await client.connect(transport);
		expect(client.protocolEra).toBe("modern");
		expect(server.requests("server/discover")).toHaveLength(2);
		await client.close();
	});

	it("uses initialize with a dual-era server that supports no modern version this client knows", async () => {
		const { client: transport, server } = await createServer("dual");
		server.setHandler("server/discover", () => {
			throw new McpError(-32022, "Unsupported protocol version", {
				supported: ["2099-01-01"],
				requested: "2026-07-28",
			});
		});
		const client = new McpClient({ name: "test-client", version: "2.0.0", protocol: "auto" });
		await client.connect(transport);
		expect(client.protocolEra).toBe("legacy");
		await client.close();
	});

	it("does not fall back on modern errors or with protocol: modern", async () => {
		const mismatch = await createServer("dual");
		mismatch.server.setHandler("server/discover", () => {
			throw new McpError(-32020, "Header mismatch");
		});
		const client = new McpClient({ name: "test-client", version: "2.0.0", protocol: "auto" });
		await expect(client.connect(mismatch.client)).rejects.toMatchObject({ code: -32020 });
		expect(mismatch.server.requests("initialize")).toEqual([]);

		const legacy = await createServer("legacy");
		const strict = new McpClient({ name: "test-client", version: "2.0.0", protocol: "2026-07-28" });
		await expect(strict.connect(legacy.client)).rejects.toMatchObject({ code: -32601 });
		expect(strict.connectionState).toBe("closed");
	});

	it("uses only the pinned version", async () => {
		const { client: transport, server } = await createServer("modern");
		server.setHandler("server/discover", () => ({ ...DISCOVER_RESULT, supportedVersions: ["2099-01-01"] }));
		const pinned = new McpClient({ name: "test-client", version: "2.0.0", protocol: "2026-07-28" });
		await expect(pinned.connect(transport)).rejects.toThrow("supports none of this client's protocol versions");
		const [discover] = server.requests("server/discover");
		expect(meta(discover!)["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
	});

	it("uses only the legacy protocol by default and over transports that do not declare modern support", async () => {
		const byDefault = await createServer("dual");
		const client = new McpClient({ name: "test-client", version: "2.0.0" });
		await client.connect(byDefault.client);
		expect(client.protocolEra).toBe("legacy");
		expect(byDefault.server.requests("server/discover")).toEqual([]);
		await client.close();

		const custom = await createServer("dual");
		const legacyOnly: McpTransport = {
			start: () => custom.client.start(),
			send: (message) => custom.client.send(message),
			close: () => custom.client.close(),
			onMessage: (listener) => custom.client.onMessage(listener),
			onError: (listener) => custom.client.onError(listener),
			onClose: (listener) => custom.client.onClose(listener),
		};
		const auto = new McpClient({ name: "test-client", version: "2.0.0", protocol: "auto" });
		await auto.connect(legacyOnly);
		expect(auto.protocolEra).toBe("legacy");
		expect(custom.server.requests("server/discover")).toEqual([]);
		await auto.close();
	});
});

describe("McpClient multi round-trip requests", () => {
	it("answers input requests and retries with the request state, as a new request", async () => {
		const { client, server } = await connect("modern", { roots: [{ uri: "file:///workspace", name: "workspace" }] });
		server.setHandler("tools/call", (request) => {
			const params = request.params as Record<string, unknown>;
			if (!params.inputResponses) {
				return {
					resultType: "input_required",
					inputRequests: { where: { method: "roots/list" } },
					requestState: "state-1",
				};
			}
			return { resultType: "complete", content: [{ type: "text", text: JSON.stringify(params.inputResponses) }] };
		});
		const result = await client.callTool("locate", { file: "a.ts" });
		expect(result.content).toEqual([
			{
				type: "text",
				text: JSON.stringify({ where: { roots: [{ uri: "file:///workspace", name: "workspace" }] } }),
			},
		]);
		const [first, retry] = server.requests("tools/call");
		expect(retry!.id).not.toBe(first!.id);
		expect(retry!.params).toMatchObject({
			name: "locate",
			arguments: { file: "a.ts" },
			inputResponses: { where: { roots: [{ uri: "file:///workspace", name: "workspace" }] } },
			requestState: "state-1",
		});
		expect(meta(retry!)["io.modelcontextprotocol/clientCapabilities"]).toEqual({ roots: {} });
		await client.close();
	});

	it("leaves out request state the server did not send and keeps rounds apart from other requests", async () => {
		const { client, server } = await connect("modern", { roots: [] });
		server.setHandler("tools/call", (request) => {
			const params = request.params as Record<string, unknown>;
			if (params.name === "unrelated") return { content: [] };
			if (!params.inputResponses)
				return { resultType: "input_required", inputRequests: { r: { method: "roots/list" } } };
			return { content: [] };
		});
		await Promise.all([client.callTool("asks"), client.callTool("unrelated")]);
		const calls = server.requests("tools/call").map((request) => request.params as Record<string, unknown>);
		expect(calls.find((params) => params.name === "unrelated")).not.toHaveProperty("inputResponses");
		const retry = calls.find((params) => params.inputResponses !== undefined);
		expect(retry).toBeDefined();
		expect(retry).not.toHaveProperty("requestState");
		await client.close();
	});

	it("uses registered handlers for other input requests and fails for input it cannot provide", async () => {
		const { client, server } = await connect("modern");
		server.setHandler("tools/call", (request) => {
			const params = request.params as Record<string, unknown>;
			if (params.inputResponses) return { content: [{ type: "text", text: JSON.stringify(params.inputResponses) }] };
			return {
				resultType: "input_required",
				inputRequests: { confirm: { method: "elicitation/create", params: { message: "Sure?" } } },
				requestState: "s",
			};
		});
		await expect(client.callTool("confirm")).rejects.toThrow("does not provide: elicitation/create");

		const elicit = vi.fn(() => ({ action: "accept", content: { confirmed: true } }));
		client.setRequestHandler("elicitation/create", elicit);
		const result = await client.callTool("confirm");
		expect(elicit).toHaveBeenCalledWith({ message: "Sure?" }, expect.anything());
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify({ confirm: { action: "accept", content: { confirmed: true } } }) },
		]);
		await client.close();
	});

	it("gives up on a server that keeps asking for input", async () => {
		const { client, server } = await connect("modern");
		server.setHandler("tools/call", () => ({ resultType: "input_required", requestState: "again" }));
		await expect(client.callTool("loop")).rejects.toThrow("still asks for input");
		expect(server.requests("tools/call")).toHaveLength(17);
		await client.close();
	});

	it("rejects results of unknown types", async () => {
		const { client, server } = await connect("modern");
		server.setHandler("tools/call", () => ({ resultType: "task", taskId: "1" }));
		await expect(client.callTool("t")).rejects.toThrow("Unsupported MCP tools/call result type: task");
		server.setHandler("tools/list", () => ({ resultType: "input_required", requestState: "x" }));
		await expect(client.listTools()).rejects.toThrow("Unsupported MCP tools/list result type");
		await client.close();
	});

	it("retries a request once with the version an UnsupportedProtocolVersionError names", async () => {
		const { client, server } = await connect("modern");
		let calls = 0;
		server.setHandler("tools/call", () => {
			calls++;
			if (calls === 1) {
				throw new McpError(-32022, "Unsupported protocol version", { supported: ["2026-07-28"], requested: "x" });
			}
			return { content: [] };
		});
		expect(await client.callTool("t")).toEqual({ content: [] });
		expect(calls).toBe(2);
		await client.close();
	});
});

describe("McpClient subscriptions", () => {
	it("delivers notifications of an acknowledged subscription and cancels it on close", async () => {
		const { client, server } = await connect("modern");
		server.setHandler("subscriptions/listen", async (request) => {
			await server.notify("notifications/subscriptions/acknowledged", {
				_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
				notifications: { toolsListChanged: true },
			});
			return NO_RESPONSE;
		});
		const changed = vi.fn();
		client.onNotification("notifications/tools/list_changed", changed);
		const subscription = await client.listen({ toolsListChanged: true, promptsListChanged: true });
		expect(subscription.notifications).toEqual({ toolsListChanged: true });
		const [listen] = server.requests("subscriptions/listen");
		expect(listen!.params).toMatchObject({ notifications: { toolsListChanged: true, promptsListChanged: true } });

		await server.notify("notifications/tools/list_changed", {
			_meta: { "io.modelcontextprotocol/subscriptionId": listen!.id },
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(changed).toHaveBeenCalledTimes(1);

		subscription.close();
		await subscription.closed;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(server.messages).toContainEqual({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: listen!.id, reason: "closed" },
		});
		await client.close();
	});

	it("ends when the server completes the request or cancels it", async () => {
		const { client, server } = await connect("modern");
		let finish = () => {};
		server.setHandler("subscriptions/listen", async (request) => {
			await server.notify("notifications/subscriptions/acknowledged", {
				_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
				notifications: {},
			});
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return { resultType: "complete", _meta: { "io.modelcontextprotocol/subscriptionId": request.id } };
		});
		const graceful = await client.listen({ toolsListChanged: true });
		finish();
		await expect(graceful.closed).resolves.toBeUndefined();

		server.setHandler("subscriptions/listen", async (request) => {
			await server.notify("notifications/subscriptions/acknowledged", {
				_meta: { "io.modelcontextprotocol/subscriptionId": request.id },
				notifications: {},
			});
			return NO_RESPONSE;
		});
		const torn = await client.listen({ toolsListChanged: true });
		const [, second] = server.requests("subscriptions/listen");
		await server.notify("notifications/cancelled", { requestId: second!.id, reason: "shutdown" });
		await expect(torn.closed).resolves.toBeUndefined();
		await client.close();
	});

	it("rejects for legacy servers and when the stream ends before it is acknowledged", async () => {
		const legacy = await connect("legacy");
		await expect(legacy.client.listen({ toolsListChanged: true })).rejects.toThrow("needs a modern MCP server");
		await legacy.client.close();

		const { client, server } = await connect("modern");
		server.setHandler("subscriptions/listen", () => ({ resultType: "complete" }));
		await expect(client.listen({ toolsListChanged: true })).rejects.toThrow(
			"ended before the server acknowledged it",
		);
		await client.close();
	});
});
