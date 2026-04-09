import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

async function readJson(req: IncomingMessage): Promise<JsonRpcRequest> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcRequest;
}

async function startFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== "POST") {
			res.writeHead(405, { "content-type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
			return;
		}

		const body = await readJson(req);
		if (body.method === "initialize") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id ?? 1,
					result: {
						protocolVersion: "2025-03-26",
						serverInfo: { name: "fixture-mcp", version: "1.0.0" },
						capabilities: { tools: {} },
					},
				}),
			);
			return;
		}

		if (body.method === "tools/list") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id ?? 1,
					result: {
						tools: [
							{
								name: "echo",
								description: "Echo fixture text",
								inputSchema: {
									type: "object",
									properties: { text: { type: "string" } },
									required: ["text"],
								},
							},
						],
					},
				}),
			);
			return;
		}

		if (body.method === "tools/call") {
			const args = ((body.params?.arguments as Record<string, unknown> | undefined) ?? {}) as {
				text?: unknown;
			};
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id ?? 1,
					result: {
						content: [{ type: "text", text: String(args.text ?? "") }],
						isError: false,
					},
				}),
			);
			return;
		}

		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Unknown method" }, id: body.id ?? 1 }));
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		close: async () => {
			await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
		},
	};
}

async function startStreamableFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const sessionId = "session-fixture-123";
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== "POST") {
			res.writeHead(405, { "content-type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
			return;
		}

		if (req.headers.accept !== "application/json, text/event-stream") {
			res.writeHead(406, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32000, message: "Client must accept both application/json and text/event-stream" },
					id: null,
				}),
			);
			return;
		}

		const body = await readJson(req);
		const headers: Record<string, string> = {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			"Mcp-Session-Id": sessionId,
		};

		if (body.method !== "initialize" && req.headers["mcp-session-id"] !== sessionId) {
			res.writeHead(400, headers);
			res.end(
				`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Missing session id" }, id: body.id ?? 1 })}\n\n`,
			);
			return;
		}

		if (body.method === "initialize") {
			res.writeHead(200, headers);
			res.end(
				`event: message\ndata: ${JSON.stringify({
					jsonrpc: "2.0",
					id: body.id ?? 1,
					result: {
						protocolVersion: "2025-03-26",
						serverInfo: { name: "streamable-fixture", version: "1.0.0" },
						capabilities: { tools: {} },
					},
				})}\n\n`,
			);
			return;
		}

		if (body.method === "tools/list") {
			res.writeHead(200, headers);
			res.end(
				`event: message\ndata: ${JSON.stringify({
					jsonrpc: "2.0",
					id: body.id ?? 1,
					result: {
						tools: [
							{
								name: "echo",
								description: "Echo streamable fixture text",
								inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
							},
						],
					},
				})}\n\n`,
			);
			return;
		}

		if (body.method === "tools/call") {
			const args = ((body.params?.arguments as Record<string, unknown> | undefined) ?? {}) as { text?: unknown };
			res.writeHead(200, headers);
			res.end(
				`event: message\ndata: ${JSON.stringify({
					jsonrpc: "2.0",
					id: body.id ?? 1,
					result: { content: [{ type: "text", text: String(args.text ?? "") }], isError: false },
				})}\n\n`,
			);
			return;
		}

		res.writeHead(404, headers);
		res.end(
			`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Unknown method" }, id: body.id ?? 1 })}\n\n`,
		);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		close: async () => {
			await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
		},
	};
}

describe("McpServerManager HTTP runtime", () => {
	const closers: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (closers.length > 0) {
			await closers.pop()?.();
		}
	});

	it("connects to an HTTP MCP server, initializes it, and discovers tools", async () => {
		const fixture = await startFixtureServer();
		closers.push(fixture.close);

		const { McpServerManager } = await import("../src/mcp/server-manager.js");
		const manager = new McpServerManager();
		const connection = await manager.connect("fixture", { url: fixture.url });

		expect(connection.status).toBe("connected");
		expect(connection.tools).toEqual([
			expect.objectContaining({
				name: "echo",
				description: "Echo fixture text",
			}),
		]);
	});

	it("calls a discovered tool through the connected HTTP MCP server", async () => {
		const fixture = await startFixtureServer();
		closers.push(fixture.close);

		const { McpServerManager } = await import("../src/mcp/server-manager.js");
		const manager = new McpServerManager();
		await manager.connect("fixture", { url: fixture.url });

		const result = await manager.callTool("fixture", "echo", { text: "hello from mu" });
		expect(result).toEqual(
			expect.objectContaining({
				content: [{ type: "text", text: "hello from mu" }],
				isError: false,
			}),
		);
	});

	it("captures and reuses Mcp-Session-Id for streamable HTTP follow-up requests", async () => {
		const fixture = await startStreamableFixtureServer();
		closers.push(fixture.close);

		const { McpServerManager } = await import("../src/mcp/server-manager.js");
		const manager = new McpServerManager();
		const connection = await manager.connect("fixture", { url: fixture.url });

		expect(connection.status).toBe("connected");
		expect(connection.sessionId).toBe("session-fixture-123");
		expect(connection.tools).toEqual([
			expect.objectContaining({
				name: "echo",
				description: "Echo streamable fixture text",
			}),
		]);

		const result = await manager.callTool("fixture", "echo", { text: "hello from streamable" });
		expect(result).toEqual(
			expect.objectContaining({
				content: [{ type: "text", text: "hello from streamable" }],
				isError: false,
			}),
		);
	});

	it("exposes a proxy-style Mu tool that accepts structured args without manual JSON escaping", async () => {
		const fixture = await startFixtureServer();
		closers.push(fixture.close);

		const { McpServerManager } = await import("../src/mcp/server-manager.js");
		const { createMcpProxyTool } = await import("../src/mcp/proxy-tool.js");
		const manager = new McpServerManager();
		await manager.connect("fixture", { url: fixture.url });

		const tool = createMcpProxyTool(manager);
		const result = await tool.execute("tc_1", {
			tool: "echo",
			server: "fixture",
			args: { text: "hello from proxy tool" },
		});

		expect(result.content).toEqual([{ type: "text", text: "hello from proxy tool" }]);
	});

	it("surfaces an explicit error when the HTTP handshake fails", async () => {
		const { McpServerManager } = await import("../src/mcp/server-manager.js");
		const manager = new McpServerManager();

		await expect(manager.connect("broken", { url: "http://127.0.0.1:1/mcp" })).rejects.toThrow();
	});

	it("sends bearer auth from configured env-backed token for HTTP MCP servers", async () => {
		vi.stubEnv("FIGMA_OAUTH_TOKEN", "figma-test-token");
		const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
			if (req.headers.authorization !== "Bearer figma-test-token") {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
				return;
			}

			const body = await readJson(req);
			if (body.method === "initialize") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id ?? 1,
						result: {
							protocolVersion: "2025-03-26",
							serverInfo: { name: "auth-fixture", version: "1.0.0" },
							capabilities: { tools: {} },
						},
					}),
				);
				return;
			}

			if (body.method === "tools/list") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: { tools: [] } }));
				return;
			}

			res.writeHead(404, { "content-type": "application/json" });
			res.end(
				JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Unknown method" }, id: body.id ?? 1 }),
			);
		});

		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		closers.push(async () => {
			await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
		});
		const address = server.address() as AddressInfo;

		const { McpServerManager } = await import("../src/mcp/server-manager.js");
		const manager = new McpServerManager();
		const connection = await manager.connect("figma", {
			url: `http://127.0.0.1:${address.port}/mcp`,
			bearerTokenEnvVar: "FIGMA_OAUTH_TOKEN",
		});

		expect(connection.status).toBe("connected");
	});
});
