import type { AgentTool } from "@kennyfrc/mu-ai";
import { type TSchema, Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionManager } from "../src/extensions/manager.js";
import { eraseAgentTool } from "../src/extensions/types.js";

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

describe("Figma MCP visible status", () => {
	afterEach(() => {
		vi.doUnmock("../src/mcp/config.js");
		vi.doUnmock("../src/oauth/figma-mcp.js");
		vi.doUnmock("@kennyfrc/mu-ai");
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it("shows auth_required when no stored credentials exist", async () => {
		vi.resetModules();
		vi.doMock("../src/mcp/config.js", () => ({
			loadMcpConfig: async () => ({
				mcpServers: {
					figma: { url: "https://mcp.figma.com/mcp" },
				},
			}),
		}));
		vi.doMock("../src/oauth/figma-mcp.js", () => ({
			getFigmaOAuthAccessToken: async () => null,
		}));
		vi.doMock("@kennyfrc/mu-ai", () => ({
			loadOAuthCredentials: () => null,
		}));

		const { default: mcpExtension } = await import("../src/extensions/presets/mcp.js");
		const manager = new ExtensionManager({ builtInTools: makeBuiltInTools() });
		await manager.loadExtension(mcpExtension, "preset:mcp");

		expect(manager.getIndicators().find((indicator) => indicator.id === "mcp-status")?.label).toBe(
			"MCP auth required: figma",
		);
	});

	it("shows auth_expired when stored credentials exist but not connected", async () => {
		vi.resetModules();
		vi.doMock("../src/mcp/config.js", () => ({
			loadMcpConfig: async () => ({
				mcpServers: {
					figma: { url: "https://mcp.figma.com/mcp" },
				},
			}),
		}));
		vi.doMock("../src/oauth/figma-mcp.js", () => ({
			getFigmaOAuthAccessToken: async () => null,
		}));
		vi.doMock("@kennyfrc/mu-ai", () => ({
			loadOAuthCredentials: () => ({
				type: "oauth",
				access: "expired-token",
				refresh: "refresh-token",
				expires: Date.now() - 1000,
				client_id: "test-client",
				client_secret: "test-secret",
			}),
		}));

		const { default: mcpExtension } = await import("../src/extensions/presets/mcp.js");
		const manager = new ExtensionManager({ builtInTools: makeBuiltInTools() });
		await manager.loadExtension(mcpExtension, "preset:mcp");

		expect(manager.getIndicators().find((indicator) => indicator.id === "mcp-status")?.label).toBe(
			"MCP auth expired: figma",
		);
	});

	it("prints auth_required status from /mcp when no credentials stored", async () => {
		vi.resetModules();
		vi.doMock("../src/mcp/config.js", () => ({
			loadMcpConfig: async () => ({
				mcpServers: {
					figma: { url: "https://mcp.figma.com/mcp" },
				},
			}),
		}));
		vi.doMock("../src/oauth/figma-mcp.js", () => ({
			getFigmaOAuthAccessToken: async () => null,
		}));
		vi.doMock("@kennyfrc/mu-ai", () => ({
			loadOAuthCredentials: () => null,
		}));

		const { default: mcpExtension } = await import("../src/extensions/presets/mcp.js");
		const manager = new ExtensionManager({ builtInTools: makeBuiltInTools() });
		await manager.loadExtension(mcpExtension, "preset:mcp");

		const printed: string[] = [];
		await manager.getCommand("mcp")?.execute("", {
			send: async () => {},
			print: (text) => printed.push(text),
			setModel: async () => {},
		});

		expect(printed).toContain("MCP auth required: figma");
	});

	it("prints auth_expired status from /mcp when credentials exist but not connected", async () => {
		vi.resetModules();
		vi.doMock("../src/mcp/config.js", () => ({
			loadMcpConfig: async () => ({
				mcpServers: {
					figma: { url: "https://mcp.figma.com/mcp" },
				},
			}),
		}));
		vi.doMock("../src/oauth/figma-mcp.js", () => ({
			getFigmaOAuthAccessToken: async () => null,
		}));
		vi.doMock("@kennyfrc/mu-ai", () => ({
			loadOAuthCredentials: () => ({
				type: "oauth",
				access: "expired-token",
				refresh: "refresh-token",
				expires: Date.now() - 1000,
				client_id: "test-client",
				client_secret: "test-secret",
			}),
		}));

		const { default: mcpExtension } = await import("../src/extensions/presets/mcp.js");
		const manager = new ExtensionManager({ builtInTools: makeBuiltInTools() });
		await manager.loadExtension(mcpExtension, "preset:mcp");

		const printed: string[] = [];
		await manager.getCommand("mcp")?.execute("", {
			send: async () => {},
			print: (text) => printed.push(text),
			setModel: async () => {},
		});

		expect(printed).toContain("MCP auth expired: figma");
	});
});
