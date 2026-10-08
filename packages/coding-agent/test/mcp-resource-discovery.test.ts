import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION, type Resource } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { createMcpExtension } from "../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore, McpServerConnection } from "../src/extensions/mcp/runtime.ts";
import { createHarness, getToolResult } from "./suite/harness.ts";

const entry = { name: "docs", config: { command: "unused", exposure: "direct" as const }, source: "test" };
const tool = { name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } };

function createServer(block?: string, tools = true) {
	const pair = createInMemoryTransportPair();
	const pending: JsonRpcRequest[] = [];
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		if (message.method === block) {
			pending.push(message);
			return;
		}
		const result =
			message.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { resources: {}, ...(tools ? { tools: {} } : {}) },
						serverInfo: { name: "docs", version: "1" },
					}
				: message.method === "tools/list"
					? { tools: [tool] }
					: message.method === "resources/list"
						? { resources: [{ uri: "docs://initial", name: "initial" }] }
						: message.method === "resources/templates/list"
							? { resourceTemplates: [] }
							: { content: [{ type: "text", text: "ok" }] };
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	void pair.server.start();
	return {
		...pair,
		pending,
		answer: async (result: Record<string, unknown>) => {
			const request = pending.shift();
			if (!request) throw new Error("No blocked request");
			await pair.server.send({ jsonrpc: "2.0", id: request.id, result });
		},
	};
}

function deferredResources() {
	let resolve!: (resources: Resource[]) => void;
	const promise = new Promise<Resource[]>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// #10526: resource discovery must not keep a server's tools behind the connection barrier.
describe("MCP background resource discovery", () => {
	const connections: McpServerConnection[] = [];
	afterEach(async () => {
		for (const connection of connections.splice(0)) await connection.close();
		vi.restoreAllMocks();
	});

	function connect(servers: ReturnType<typeof createServer>[]) {
		const onTools = vi.fn();
		let index = 0;
		const connection = new McpServerConnection({
			entry,
			cwd: process.cwd(),
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			createTransport: () => servers[index++].client,
			onTools,
		});
		connections.push(connection);
		return { connection, onTools };
	}

	for (const [block, tools] of [
		["resources/list", true],
		["resources/templates/list", true],
		["resources/list", false],
	] as const) {
		it(`connects while ${block} is pending (tools=${tools})`, async () => {
			const server = createServer(block, tools);
			const { connection, onTools } = connect([server]);
			const opening = connection.getClient();
			void opening.catch(() => {});
			await vi.waitFor(() => expect(connection.state).toBe("connected"));
			await opening;
			expect(connection.hasResources).toBe(true);
			expect(connection.tools).toEqual(tools ? [tool] : []);
			expect(onTools).toHaveBeenCalledTimes(1);
			if (tools)
				expect(await connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
			await vi.waitFor(() => expect(server.pending).toHaveLength(1));
			await server.answer(
				block === "resources/list"
					? {
							resources: [
								{ uri: "docs://late", name: "late" },
								{ uri: "ui://hidden", name: "hidden" },
							],
						}
					: {
							resourceTemplates: [
								{ uriTemplate: "docs://{name}", name: "late" },
								{ uriTemplate: "ui://{name}", name: "hidden" },
							],
						},
			);
			await vi.waitFor(() => expect(onTools).toHaveBeenCalledTimes(2));
			expect(
				block === "resources/list"
					? connection.resources.map((item) => item.name)
					: connection.resourceTemplates.map((item) => item.name),
			).toEqual(["late"]);
		});
	}

	it("ignores a resource refresh that finishes after the connection closes", async () => {
		const server = createServer();
		const { connection, onTools } = connect([server]);
		const client = await connection.getClient();
		await vi.waitFor(() => expect(connection.resources).toHaveLength(1));
		const pending = deferredResources();
		const listing = vi.spyOn(client, "listResources").mockReturnValue(pending.promise);
		await server.server.send({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
		await vi.waitFor(() => expect(listing).toHaveBeenCalledOnce());
		await connection.close();
		const calls = onTools.mock.calls.length;
		pending.resolve([{ uri: "docs://stale", name: "stale" }]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(connection.state).toBe("closed");
		expect(connection.resources[0].name).toBe("initial");
		expect(onTools).toHaveBeenCalledTimes(calls);
	});

	it("keeps tools usable when resource enumeration fails", async () => {
		const server = createServer("resources/list");
		const { connection, onTools } = connect([server]);
		await connection.getClient();
		await vi.waitFor(() => expect(server.pending).toHaveLength(1));
		const request = server.pending.shift()!;
		await server.server.send({
			jsonrpc: "2.0",
			id: request.id,
			error: { code: -32603, message: "listing unavailable" },
		});
		await vi.waitFor(() => expect(onTools).toHaveBeenCalledTimes(2));
		expect(connection.state).toBe("connected");
		expect(connection.resources).toEqual([]);
		expect(connection.error).toBeUndefined();
		expect(await connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
	});

	it("keeps a reconnect independent of the old resource request", async () => {
		const first = createServer();
		const second = createServer("resources/list");
		const { connection } = connect([first, second]);
		const client = await connection.getClient();
		await vi.waitFor(() => expect(connection.resources).toHaveLength(1));
		const stale = deferredResources();
		const listing = vi.spyOn(client, "listResources").mockReturnValue(stale.promise);
		await first.server.send({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
		await vi.waitFor(() => expect(listing).toHaveBeenCalledOnce());
		const reconnecting = connection.reconnect();
		void reconnecting.catch(() => {});
		await vi.waitFor(() => expect(second.pending).toHaveLength(1));
		expect(connection.state).toBe("connected");
		await reconnecting;
		expect(connection.resources).toEqual([]);
		stale.resolve([{ uri: "docs://stale", name: "stale" }]);
		await second.answer({ resources: [{ uri: "docs://new", name: "new" }] });
		await vi.waitFor(() => expect(connection.resources.map((item) => item.name)).toEqual(["new"]));
	});

	it("keeps the newest resource refresh when replies arrive out of order", async () => {
		const server = createServer();
		const { connection } = connect([server]);
		const client = await connection.getClient();
		await vi.waitFor(() => expect(connection.resources).toHaveLength(1));
		const older = deferredResources();
		const newer = deferredResources();
		const listing = vi
			.spyOn(client, "listResources")
			.mockReturnValueOnce(older.promise)
			.mockReturnValueOnce(newer.promise);
		for (let count = 1; count <= 2; count++) {
			await server.server.send({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
			await vi.waitFor(() => expect(listing).toHaveBeenCalledTimes(count));
		}
		newer.resolve([{ uri: "docs://new", name: "new" }]);
		await vi.waitFor(() => expect(connection.resources[0].name).toBe("new"));
		older.resolve([{ uri: "docs://old", name: "old" }]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(connection.resources[0].name).toBe("new");
	});

	it("registers and executes a direct MCP tool before resource enumeration finishes", async () => {
		const server = createServer("resources/list");
		const harness = await createHarness({
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					createTransport: () => server.client,
				}),
			],
		});
		try {
			await harness.session.bindExtensions({});
			await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toContain("mcp__docs__echo"));
			expect(harness.session.getCallableToolNames()).toContain("read_mcp_resource");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("mcp__docs__echo", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("use the tool");
			expect(getToolResult(harness, "mcp__docs__echo").isError).toBe(false);
			expect(server.pending).toHaveLength(1);
		} finally {
			harness.cleanup();
			await server.server.close();
		}
	});
});
