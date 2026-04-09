import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentTool } from "@kennyfrc/mu-ai";
import { type TSchema, Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionManager } from "../src/extensions/manager.js";
import { eraseAgentTool } from "../src/extensions/types.js";

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

function makeBuiltInTools(): Record<string, AgentTool<TSchema, unknown>> {
	const schema = Type.Object({});
	const bash: AgentTool<typeof schema, { projection: unknown }> = {
		label: "bash",
		name: "bash",
		description: "bash",
		parameters: schema,
		execute: async () => ({
			content: [{ type: "text", text: "bash" }],
			details: {
				projection: {
					version: 1,
					call: { style: "argv", text: "bash", argv: [] },
				},
			},
		}),
	};
	return { bash: eraseAgentTool(bash) };
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
								inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
							},
						],
					},
				}),
			);
			return;
		}

		if (body.method === "tools/call") {
			const args = ((body.params?.arguments as Record<string, unknown> | undefined) ?? {}) as { text?: unknown };
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: body.id ?? 1,
					result: { content: [{ type: "text", text: String(args.text ?? "") }], isError: false },
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

describe("live MCP extension preset", () => {
	const closers: Array<() => Promise<void>> = [];

	afterEach(async () => {
		vi.doUnmock("../src/mcp/config.js");
		vi.resetModules();
		vi.restoreAllMocks();
		while (closers.length > 0) {
			await closers.pop()?.();
		}
	});

	it("connects to configured servers on load and reports connected status", async () => {
		const fixture = await startFixtureServer();
		closers.push(fixture.close);

		vi.doMock("../src/mcp/config.js", () => ({
			loadMcpConfig: async () => ({
				mcpServers: {
					figma: { url: fixture.url },
				},
			}),
		}));

		const { default: mcpExtension } = await import("../src/extensions/presets/mcp.js");
		const manager = new ExtensionManager({ builtInTools: makeBuiltInTools() });
		await manager.loadExtension(mcpExtension, "preset:mcp");

		expect(manager.getIndicators().find((indicator) => indicator.id === "mcp-status")?.label).toBe(
			"MCP: 1/1 connected",
		);

		const printed: string[] = [];
		await manager.getCommand("mcp")?.execute("", {
			send: async () => {},
			print: (text) => printed.push(text),
			setModel: async () => {},
		});
		expect(printed[0]).toBe("MCP: 1/1 connected");
	});

	it("allows the built-in mcp tool to call a configured live server with structured args", async () => {
		const fixture = await startFixtureServer();
		closers.push(fixture.close);

		vi.doMock("../src/mcp/config.js", () => ({
			loadMcpConfig: async () => ({
				mcpServers: {
					figma: { url: fixture.url },
				},
			}),
		}));

		const { default: mcpExtension } = await import("../src/extensions/presets/mcp.js");
		const manager = new ExtensionManager({ builtInTools: makeBuiltInTools() });
		await manager.loadExtension(mcpExtension, "preset:mcp");

		const tool = manager.getToolsForSelection(["bash"]).find((entry) => entry.name === "mcp");
		const result = await tool?.execute("tc-1", {
			server: "figma",
			tool: "echo",
			args: { text: "hello from extension" },
		});

		expect(result?.content).toEqual([{ type: "text", text: "hello from extension" }]);
	});

	it("refreshes the footer indicator after Figma auth succeeds", async () => {
		let token: string | null = null;
		let storedCredentials: { type: "oauth"; access: string; refresh: string; expires: number } | null = null;
		const authState: { emitChange: null | (() => void) } = { emitChange: null };

		vi.doMock("../src/mcp/config.js", () => ({
			loadMcpConfig: async () => ({
				mcpServers: {
					figma: { url: "https://mcp.figma.com/mcp" },
				},
			}),
		}));
		vi.doMock("../src/mcp/server-manager.js", () => ({
			McpServerManager: class {
				private connection: { status: "connected"; tools: Array<{ name: string }> } | null = null;

				async connect() {
					this.connection = { status: "connected", tools: [{ name: "echo" }] };
					return this.connection;
				}

				async callTool() {
					return { content: [{ type: "text", text: "ok" }], isError: false };
				}

				getConnection() {
					return this.connection;
				}

				async close() {
					this.connection = null;
				}
			},
		}));
		vi.doMock("../src/oauth/figma-mcp.js", () => ({
			getFigmaOAuthAccessToken: async () => token,
			onFigmaOAuthStateChange: (listener: () => void) => {
				authState.emitChange = listener;
				return () => {};
			},
		}));
		vi.doMock("@kennyfrc/mu-ai", async () => {
			const actual = await vi.importActual<typeof import("@kennyfrc/mu-ai")>("@kennyfrc/mu-ai");
			return {
				...actual,
				loadOAuthCredentials: () => storedCredentials,
			};
		});

		const { default: mcpExtension } = await import("../src/extensions/presets/mcp.js");
		const manager = new ExtensionManager({ builtInTools: makeBuiltInTools() });
		await manager.loadExtension(mcpExtension, "preset:mcp");

		expect(manager.getIndicators().find((indicator) => indicator.id === "mcp-status")?.label).toBe(
			"MCP auth required: figma",
		);

		storedCredentials = {
			type: "oauth",
			access: "fresh-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};
		token = "fresh-token";

		const emitChange = authState.emitChange;
		if (typeof emitChange === "function") {
			emitChange();
		}
		await vi.waitFor(() => {
			expect(manager.getIndicators().find((indicator) => indicator.id === "mcp-status")?.label).toBe(
				"MCP: 1/1 connected",
			);
		});
	});
});
