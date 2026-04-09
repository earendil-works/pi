import type { AgentTool } from "@kennyfrc/mu-ai";
import { type TSchema, Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { builtInExtensions } from "../src/extensions/built-ins.js";
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

describe("MCP reload/runtime integration", () => {
	it("registers the built-in MCP extension preset", () => {
		expect(builtInExtensions.map((entry) => entry.sourceId)).toContain("preset:mcp");
	});

	it("loads the MCP built-in extension and removes its surfaced artifacts on unload", async () => {
		const manager = new ExtensionManager({ builtInTools: makeBuiltInTools() });
		const preset = builtInExtensions.find((entry) => entry.sourceId === "preset:mcp");

		expect(preset).toBeDefined();
		await manager.loadExtension(preset!.factory, preset!.sourceId);

		expect(manager.getCommand("mcp")).toBeDefined();
		expect(manager.getToolsForSelection(["bash"]).find((tool) => tool.name === "mcp")).toBeDefined();
		expect(manager.getIndicators().some((indicator) => indicator.id === "mcp-status")).toBe(true);

		manager.unloadBySourceId("preset:mcp");

		expect(manager.getCommand("mcp")).toBeUndefined();
		expect(manager.getToolsForSelection(["bash"]).find((tool) => tool.name === "mcp")).toBeUndefined();
		expect(manager.getIndicators().some((indicator) => indicator.id === "mcp-status")).toBe(false);
	});
});
