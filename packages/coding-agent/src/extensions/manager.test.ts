import type { AgentTool } from "@kennyfrc/mu-ai";
import { getModel } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { resolveToolSelection } from "../tools/tool-selection.js";
import { ExtensionManager } from "./manager.js";
import { type ErasedAgentTool, eraseAgentTool } from "./types.js";

const mockToolSchema = Type.Object({});

function makeTool(name: string): AgentTool<typeof mockToolSchema, { name: string }> {
	return {
		label: name,
		name,
		description: `${name} tool`,
		parameters: mockToolSchema,
		execute: async () => ({ content: [{ type: "text", text: name }], details: { name } }),
	};
}

function toolMap(names: string[]): Record<string, ReturnType<typeof eraseAgentTool>> {
	const map: Record<string, ErasedAgentTool> = Object.create(null);
	for (const name of names) {
		map[name] = eraseAgentTool(makeTool(name));
	}
	return map;
}

describe("ExtensionManager", () => {
	it("adds extension-defined tools and can override built-ins by priority", async () => {
		const baseSchema = Type.Object({});
		const builtInBash: AgentTool<typeof baseSchema, { v: string }> = {
			label: "bash",
			name: "bash",
			description: "built-in bash",
			parameters: baseSchema,
			execute: async () => ({
				content: [{ type: "text", text: "built-in" }],
				details: { v: "built-in" },
			}),
		};

		const mgr = new ExtensionManager({ builtInTools: { bash: eraseAgentTool(builtInBash) } });

		const extraSchema = Type.Object({});
		const extBash: AgentTool<typeof extraSchema, { v: string }> = {
			label: "ext-bash",
			name: "bash",
			description: "ext bash",
			parameters: extraSchema,
			execute: async () => ({ content: [{ type: "text", text: "ext" }], details: { v: "ext" } }),
		};
		const extTool: AgentTool<typeof extraSchema, { ok: true }> = {
			label: "extra",
			name: "extra",
			description: "extra",
			parameters: extraSchema,
			execute: async () => ({ content: [{ type: "text", text: "extra" }], details: { ok: true } }),
		};

		await mgr.loadExtension((api) => {
			api.registerTool(eraseAgentTool(extBash), { priority: 200 });
			api.registerTool(eraseAgentTool(extTool));
		}, "ext");

		const tools = mgr.getToolsForSelection(["bash"]);
		const names = tools.map((t) => t.name);
		expect(names).toContain("bash");
		expect(names).toContain("extra");

		const bashTool = tools.find((t) => t.name === "bash");
		expect(bashTool?.label).toBe("ext-bash");

		const res = await bashTool!.execute("tc_1", {});
		const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("ext");
	});

	it("adds extension tools to GPT-* model defaults", async () => {
		const gptTools = resolveToolSelection(undefined, getModel("openai", "gpt-4o-mini")).toolNames;
		const mgr = new ExtensionManager({ builtInTools: toolMap(gptTools) });

		await mgr.loadExtension((api) => {
			api.registerTool(eraseAgentTool(makeTool("ext-gpt")));
		}, "ext-gpt");

		const selected = mgr.getToolsForSelection(gptTools).map((tool) => tool.name);
		expect(selected).toEqual([...gptTools, "ext-gpt"]);
	});

	it("adds extension tools to default model defaults", async () => {
		const defaultTools = resolveToolSelection(undefined, getModel("anthropic", "claude-sonnet-4-5")).toolNames;
		const mgr = new ExtensionManager({ builtInTools: toolMap(defaultTools) });

		await mgr.loadExtension((api) => {
			api.registerTool(eraseAgentTool(makeTool("ext-default")));
		}, "ext-default");

		const selected = mgr.getToolsForSelection(defaultTools).map((tool) => tool.name);
		expect(selected).toEqual([...defaultTools, "ext-default"]);
	});
});
