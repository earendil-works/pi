import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type JsonRpcMessage,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpAbortError,
	McpClient,
	McpError,
	McpTimeoutError,
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
