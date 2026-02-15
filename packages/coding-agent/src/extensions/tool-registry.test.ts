import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./tool-registry.js";

describe("ToolRegistry", () => {
	it("selects the highest priority registration (then last write wins)", () => {
		const schema = Type.Object({});
		const base: AgentTool<typeof schema, { v: string }> = {
			label: "Base",
			name: "echo",
			description: "base",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "base" }], details: { v: "base" } }),
		};
		const ext: AgentTool<typeof schema, { v: string }> = {
			label: "Ext",
			name: "echo",
			description: "ext",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "ext" }], details: { v: "ext" } }),
		};

		const reg = new ToolRegistry();
		reg.registerTool(base, { sourceId: "built-in", priority: 100 });
		reg.registerTool(ext, { sourceId: "ext", priority: 0 });
		expect(reg.getTool("echo")?.label).toBe("Base");

		reg.registerTool(ext, { sourceId: "ext", priority: 200 });
		expect(reg.getTool("echo")?.label).toBe("Ext");
	});

	it("unregisterBySourceId removes tools and reveals previous registrations", () => {
		const schema = Type.Object({});
		const base: AgentTool<typeof schema, { v: string }> = {
			label: "Base",
			name: "echo",
			description: "base",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "base" }], details: { v: "base" } }),
		};
		const ext: AgentTool<typeof schema, { v: string }> = {
			label: "Ext",
			name: "echo",
			description: "ext",
			parameters: schema,
			execute: async () => ({ content: [{ type: "text", text: "ext" }], details: { v: "ext" } }),
		};

		const reg = new ToolRegistry();
		reg.registerTool(base, { sourceId: "built-in", priority: 0 });
		reg.registerTool(ext, { sourceId: "ext", priority: 0 });
		expect(reg.getTool("echo")?.label).toBe("Ext");

		reg.unregisterBySourceId("ext");
		expect(reg.getTool("echo")?.label).toBe("Base");
	});
});
