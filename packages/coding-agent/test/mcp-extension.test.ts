import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JsonRpcMessage, LATEST_PROTOCOL_VERSION, McpSessionExpiredError } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { loadMcpConfig, type McpServerEntry } from "../src/extensions/mcp/config.ts";
import { McpOAuthCredentialStore, McpServerConnection } from "../src/extensions/mcp/runtime.ts";
import { convertMcpResult, createMcpToolName } from "../src/extensions/mcp/tools.ts";

// Config values are resolved at connect time, so the literal reference must survive loading.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
const TOKEN_HEADER = "Bearer ${TOKEN}";

describe("MCP config", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function setup(global: unknown, project: unknown) {
		const root = mkdtempSync(join(tmpdir(), "pi-mcp-config-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(global));
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify(project));
		return { agentDir, cwd };
	}

	it("merges global and trusted project servers and validates entries", () => {
		const paths = setup(
			{
				mcpServers: {
					shared: { command: "global-cmd" },
					remote: { url: "https://example.com/mcp", headers: { Authorization: TOKEN_HEADER } },
					off: { command: "x", enabled: false },
					bad: { args: ["no command"] },
					legacy: { type: "sse", url: "https://example.com/sse" },
				},
			},
			{ mcpServers: { shared: { command: "project-cmd", exposure: "direct" } } },
		);

		const trusted = loadMcpConfig({ ...paths, projectTrusted: true });
		expect(trusted.servers.map((server) => [server.name, server.config])).toEqual([
			["shared", { command: "project-cmd", exposure: "direct" }],
			["remote", { url: "https://example.com/mcp", headers: { Authorization: TOKEN_HEADER } }],
		]);
		expect(trusted.errors).toHaveLength(2);
		expect(trusted.errors[0]).toContain('server "bad" needs either "command"');
		expect(trusted.errors[1]).toContain("legacy SSE transport is not supported");

		// Untrusted projects cannot add or override servers, since stdio servers run commands.
		const untrusted = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(untrusted.servers.find((server) => server.name === "shared")?.config).toEqual({ command: "global-cmd" });
	});
});

describe("MCP tools", () => {
	it("creates provider-safe tool names", () => {
		expect(createMcpToolName("docs", "search")).toBe("mcp__docs__search");
		expect(createMcpToolName("my-server", "get.item/v2")).toBe("mcp__my-server__get_item_v2");
		const long = createMcpToolName("server", "x".repeat(100));
		expect(long).toHaveLength(64);
		expect(long).toMatch(/^mcp__server__x+_[0-9a-f]{8}$/);
		expect(createMcpToolName("server", `${"x".repeat(100)}y`)).not.toBe(long);
	});

	it("converts results, keeping structured content and throwing for errors", () => {
		expect(
			convertMcpResult("docs", "t", {
				content: [
					{ type: "resource_link", uri: "file:///a", name: "a" },
					{ type: "resource", resource: { uri: "file:///b", text: "b text" } },
					{ type: "audio", data: "", mimeType: "audio/wav" },
				],
				structuredContent: { ok: true },
			}),
		).toEqual({
			content: [
				{ type: "text", text: "a: file:///a" },
				{ type: "text", text: "b text" },
				{ type: "text", text: "[audio audio/wav omitted]" },
			],
			details: { server: "docs", tool: "t" },
			structuredContent: { ok: true },
		});
		expect(convertMcpResult("docs", "t", { content: [], structuredContent: { n: 1 } }).content).toEqual([
			{ type: "text", text: '{\n  "n": 1\n}' },
		]);
		expect(() => convertMcpResult("docs", "t", { content: [{ type: "text", text: "nope" }], isError: true })).toThrow(
			"nope",
		);
	});
});

describe("MCP connections", () => {
	/** In-memory server that answers initialize, tools/list, and tools/call with "ok". */
	function createTransport(options: { expireFirstCall?: boolean } = {}) {
		const pair = createInMemoryTransportPair();
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			const result =
				message.method === "initialize"
					? {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "fake", version: "1.0.0" },
						}
					: message.method === "tools/list"
						? { tools: [] }
						: { content: [{ type: "text", text: "ok" }] };
			queueMicrotask(() => void pair.server.send({ jsonrpc: "2.0", id: message.id, result }));
		});
		void pair.server.start();
		if (options.expireFirstCall) {
			const send = pair.client.send.bind(pair.client);
			// Simulates the HTTP transport's 404 for a session the server no longer knows.
			pair.client.send = async (message: JsonRpcMessage) => {
				if ("method" in message && message.method === "tools/call") throw new McpSessionExpiredError("gone");
				return send(message);
			};
		}
		return pair.client;
	}

	function connect(entry: McpServerEntry, transports: (() => ReturnType<typeof createTransport>)[]) {
		let opened = 0;
		const connection = new McpServerConnection({
			entry,
			cwd: process.cwd(),
			createTransport: () => transports[opened++](),
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			onTools: () => {},
		});
		return { connection, opened: () => opened };
	}

	it("starts a new session and retries once when the session expired", async () => {
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport({ expireFirstCall: true }),
			() => createTransport(),
		]);
		const results = await Promise.all([connection.callTool("echo", {}, {}), connection.callTool("echo", {}, {})]);
		expect(results).toEqual([
			{ content: [{ type: "text", text: "ok" }] },
			{ content: [{ type: "text", text: "ok" }] },
		]);
		expect(opened()).toBe(2);
		await connection.close();
	});

	it("resolves the OAuth client secret lazily", async () => {
		const { connection } = connect(
			{
				name: "fake",
				config: { url: "http://unused.invalid", oauth: { clientSecret: "!exit 1" } },
				source: "test",
			},
			[() => createTransport()],
		);
		expect(await connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(() => connection.oauthSettings()).toThrow("oauth.clientSecret");
		await connection.close();
	});
});
