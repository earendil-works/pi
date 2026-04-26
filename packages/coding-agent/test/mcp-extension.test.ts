/**
 * Unit tests for the MCP extension.
 * Tests config loading, schema validation, transport creation, and the extension factory.
 * The MCP SDK (Client, transports) is mocked — no real MCP server is required.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the imports that trigger them.
// The MCP SDK lives in .pi/extensions/mcp/node_modules; vitest resolves it
// from there via the moduleDirectories/resolve config. We mock it at the
// module-identifier level so the source files don't need a real install.
// ---------------------------------------------------------------------------

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn().mockImplementation(() => ({ type: "stdio" })),
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: vi.fn().mockImplementation(() => ({ type: "sse" })),
}));

// ---------------------------------------------------------------------------
// Source imports — use relative paths so vitest can find them without the
// extension's node_modules in the resolution chain.
// ---------------------------------------------------------------------------
import { loadConfig, resolveEnvValue } from "../../../.pi/extensions/mcp/config.js";
import { validateParams, wrapSchema } from "../../../.pi/extensions/mcp/schema.js";
import { createTransport } from "../../../.pi/extensions/mcp/transport.js";

// ---------------------------------------------------------------------------
// config.ts
// ---------------------------------------------------------------------------

describe("config: resolveEnvValue", () => {
	it("replaces ${VAR} with the environment value", () => {
		process.env.MCP_TEST_TOKEN = "secret-value";
		try {
			expect(resolveEnvValue("${MCP_TEST_TOKEN}")).toBe("secret-value");
		} finally {
			delete process.env.MCP_TEST_TOKEN;
		}
	});

	it("replaces multiple placeholders in one string", () => {
		process.env.HOST = "localhost";
		process.env.PORT = "3000";
		try {
			expect(resolveEnvValue("http://${HOST}:${PORT}/sse")).toBe("http://localhost:3000/sse");
		} finally {
			delete process.env.HOST;
			delete process.env.PORT;
		}
	});

	it("leaves the string unchanged when no placeholders match", () => {
		expect(resolveEnvValue("literal-value")).toBe("literal-value");
	});

	it("replaces unset env vars with empty string", () => {
		delete process.env.MISSING_VAR;
		expect(resolveEnvValue("prefix-${MISSING_VAR}-suffix")).toBe("prefix--suffix");
	});
});

describe("config: loadConfig", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-mcp-config-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty servers when no config files exist", () => {
		const config = loadConfig(tempDir);
		expect(config.servers).toEqual([]);
	});

	it("reads project-local mcp.json", () => {
		const piDir = join(tempDir, ".pi");
		mkdirSync(piDir);
		writeFileSync(
			join(piDir, "mcp.json"),
			JSON.stringify({ servers: [{ name: "local", command: "echo", args: ["hello"] }] }),
		);

		const config = loadConfig(tempDir);
		expect(config.servers).toHaveLength(1);
		expect(config.servers[0]!.name).toBe("local");
	});

	it("silently skips a config file with invalid JSON", () => {
		const piDir = join(tempDir, ".pi");
		mkdirSync(piDir);
		writeFileSync(join(piDir, "mcp.json"), "{ invalid json }");

		const config = loadConfig(tempDir);
		expect(config.servers).toEqual([]);
	});

	it("silently skips server entries with a missing or empty name field", () => {
		const piDir = join(tempDir, ".pi");
		mkdirSync(piDir);
		writeFileSync(
			join(piDir, "mcp.json"),
			JSON.stringify({
				servers: [
					{ command: "echo" },            // missing name
					{ name: "", command: "echo" },  // empty name
					{ name: "valid", command: "echo" },
				],
			}),
		);

		const config = loadConfig(tempDir);
		expect(config.servers).toHaveLength(1);
		expect(config.servers[0]!.name).toBe("valid");
	});

	it("silently skips a config file missing the servers array", () => {
		const piDir = join(tempDir, ".pi");
		mkdirSync(piDir);
		writeFileSync(join(piDir, "mcp.json"), JSON.stringify({ other: "stuff" }));

		const config = loadConfig(tempDir);
		expect(config.servers).toEqual([]);
	});

	it("interpolates ${ENV_VAR} in server env values", () => {
		process.env.MY_SECRET = "token123";
		try {
			const piDir = join(tempDir, ".pi");
			mkdirSync(piDir);
			writeFileSync(
				join(piDir, "mcp.json"),
				JSON.stringify({
					servers: [{ name: "s", command: "cmd", env: { TOKEN: "${MY_SECRET}" } }],
				}),
			);

			const config = loadConfig(tempDir);
			expect(config.servers[0]!.env!.TOKEN).toBe("token123");
		} finally {
			delete process.env.MY_SECRET;
		}
	});

	it("interpolates ${ENV_VAR} in command, args, and url fields", () => {
		process.env.MCP_CMD = "real-command";
		process.env.MCP_ARG = "real-arg";
		process.env.MCP_URL = "http://real-host/sse";
		try {
			const piDir = join(tempDir, ".pi");
			mkdirSync(piDir);
			writeFileSync(
				join(piDir, "mcp.json"),
				JSON.stringify({
					servers: [
						{ name: "s1", command: "${MCP_CMD}", args: ["--flag", "${MCP_ARG}"] },
						{ name: "s2", url: "${MCP_URL}" },
					],
				}),
			);

			const config = loadConfig(tempDir);
			expect(config.servers[0]!.command).toBe("real-command");
			expect(config.servers[0]!.args).toEqual(["--flag", "real-arg"]);
			expect(config.servers[1]!.url).toBe("http://real-host/sse");
		} finally {
			delete process.env.MCP_CMD;
			delete process.env.MCP_ARG;
			delete process.env.MCP_URL;
		}
	});
});

// ---------------------------------------------------------------------------
// schema.ts
// ---------------------------------------------------------------------------

describe("schema: wrapSchema", () => {
	it("returns a TypeBox TSchema for a schema with properties", () => {
		const schema = wrapSchema({
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		});
		expect(schema).toBeDefined();
		expect(typeof schema).toBe("object");
	});

	it("returns a default object schema when given an empty object", () => {
		const schema = wrapSchema({});
		expect(schema).toBeDefined();
		expect(typeof schema).toBe("object");
	});
});

describe("schema: validateParams", () => {
	const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };

	it("returns valid for a correct input", () => {
		const result = validateParams(schema, { name: "Alice" });
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it("returns invalid for missing required field", () => {
		const result = validateParams(schema, {});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes('"name"'))).toBe(true);
	});

	it("returns invalid when params is not an object", () => {
		const result = validateParams(schema, "not-an-object");
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it("returns invalid for array when object expected", () => {
		const result = validateParams(schema, [1, 2, 3]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("array"))).toBe(true);
	});

	it("returns valid for schema with no required fields and an empty object", () => {
		const noRequired = { type: "object", properties: { x: { type: "number" } } };
		const result = validateParams(noRequired, {});
		expect(result.valid).toBe(true);
	});

	it("returns valid for a completely empty schema (MCP servers that accept anything)", () => {
		const result = validateParams({}, { anything: true });
		expect(result.valid).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// transport.ts
//
// NOTE: The MCP SDK lives in .pi/extensions/mcp/node_modules/, not in
// packages/coding-agent/node_modules/. vi.mock() intercepts the test-file's
// own imports but NOT the transitive imports inside transport.ts (which
// resolve to a different absolute path). Tests therefore verify observable
// behaviour (return type, throws) rather than constructor call counts.
// ---------------------------------------------------------------------------

describe("transport: createTransport", () => {
	it("returns an object (StdioClientTransport) when command is configured", () => {
		// The transport is constructed against the real SDK in .pi/extensions/mcp/node_modules.
		// We verify it returns a truthy object without throwing.
		const transport = createTransport({ name: "fs", command: "echo", args: ["hello"] });
		expect(transport).toBeDefined();
		expect(typeof transport).toBe("object");
	});

	it("returns an object (SSEClientTransport) when url is configured", () => {
		const transport = createTransport({ name: "remote", url: "http://localhost:3000/sse" });
		expect(transport).toBeDefined();
		expect(typeof transport).toBe("object");
	});

	it("throws when neither command nor url is present", () => {
		expect(() => createTransport({ name: "bad" })).toThrow(/neither "command".*nor "url"/);
	});

	it("error message includes the server name", () => {
		expect(() => createTransport({ name: "my-server" })).toThrow(/my-server/);
	});
});

// ---------------------------------------------------------------------------
// index.ts — extension factory structural behaviour via a lightweight pi mock
//
// NOTE ON MOCK SCOPE: The MCP SDK's Client, StdioClientTransport, and
// SSEClientTransport live in .pi/extensions/mcp/node_modules/. When index.ts
// imports them, Node resolves those imports to absolute paths within that
// directory — different from what vi.mock() registers in the test-file context
// (packages/coding-agent/). As a result, vi.mock() cannot intercept the
// Client constructor that index.ts actually calls at runtime.
//
// What these tests CAN reliably verify:
//   - factory registers event handlers and commands with the pi mock
//   - session_start error-handling path (real spawn fails → notify("error"))
//   - factory returns immediately with no side effects for empty config
//
// The tool-registration path (session_start happy path) is covered by the
// integration test in the Testing Strategy section of the plan.
// ---------------------------------------------------------------------------

describe("extension factory (index.ts)", () => {
	function makePiMock() {
		const tools: Array<{ name: string; promptSnippet?: string }> = [];
		const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
		const commands: string[] = [];

		const ctx = {
			ui: { notify: vi.fn(), setStatus: vi.fn() },
		};

		const pi = {
			registerTool: vi.fn((def: { name: string; promptSnippet?: string }) => {
				tools.push({ name: def.name, promptSnippet: def.promptSnippet });
			}),
			registerCommand: vi.fn((name: string) => { commands.push(name); }),
			on: vi.fn((event: string, handler: (e: unknown, c: unknown) => unknown) => {
				if (!handlers[event]) handlers[event] = [];
				handlers[event]!.push(handler);
			}),
		};

		async function emit(event: string, eventData: unknown = {}) {
			for (const handler of handlers[event] ?? []) {
				await handler(eventData, ctx);
			}
		}

		return { pi, ctx, tools, handlers, commands, emit };
	}

	it("registers session_start and session_shutdown handlers and /mcp command", async () => {
		const tempDir = join(tmpdir(), `pi-mcp-struct-${Date.now()}`);
		const piDir = join(tempDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			join(piDir, "mcp.json"),
			JSON.stringify({ servers: [{ name: "fs", command: "echo" }] }),
		);
		const origCwd = process.cwd;
		process.cwd = () => tempDir;

		try {
			const { pi, handlers, commands } = makePiMock();
			const { default: factory } = await import("../../../.pi/extensions/mcp/index.js");
			factory(pi as never);

			expect(handlers["session_start"]).toHaveLength(1);
			expect(handlers["session_shutdown"]).toHaveLength(1);
			expect(commands).toContain("mcp");
		} finally {
			process.cwd = origCwd;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not crash when one server fails to connect, and notifies with error", async () => {
		// Uses a real spawn with a nonexistent command so the SDK itself throws.
		const tempDir = join(tmpdir(), `pi-mcp-fail-${Date.now()}`);
		const piDir = join(tempDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			join(piDir, "mcp.json"),
			JSON.stringify({ servers: [{ name: "broken", command: "__nonexistent_cmd__" }] }),
		);
		const origCwd = process.cwd;
		process.cwd = () => tempDir;

		try {
			const { pi, ctx, emit } = makePiMock();
			const { default: factory } = await import("../../../.pi/extensions/mcp/index.js");
			factory(pi as never);

			await expect(emit("session_start")).resolves.not.toThrow();
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("failed"),
				"error",
			);
		} finally {
			process.cwd = origCwd;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("returns immediately (no handlers registered) when no servers are configured", async () => {
		const tempDir = join(tmpdir(), `pi-mcp-empty-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		const origCwd = process.cwd;
		process.cwd = () => tempDir;

		try {
			const { pi, emit } = makePiMock();
			const { default: factory } = await import("../../../.pi/extensions/mcp/index.js");
			factory(pi as never);
			await emit("session_start");

			expect(pi.registerTool).not.toHaveBeenCalled();
			expect(pi.registerCommand).not.toHaveBeenCalled();
		} finally {
			process.cwd = origCwd;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
