import type { AgentTool } from "@kennyfrc/mu-ai";
import { getModel } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { resolveToolSelection } from "../tools/tool-selection.js";
import { ExtensionManager } from "./manager.js";
import { type ErasedAgentTool, eraseAgentTool } from "./types.js";

const mockToolSchema = Type.Object({});

function muDisplayForTest(argv: string[]): { version: 1; call: { style: "argv"; text: string; argv: string[] } } {
	return {
		version: 1,
		call: {
			style: "argv",
			text: ["(test)", ...argv].join(" "),
			argv,
		},
	};
}

function makeTool(name: string): AgentTool<typeof mockToolSchema, { name: string; projection: unknown }> {
	return {
		label: name,
		name,
		description: `${name} tool`,
		parameters: mockToolSchema,
		execute: async () => ({
			content: [{ type: "text", text: name }],
			details: { name, projection: muDisplayForTest([name]) },
		}),
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
		const extBash: AgentTool<typeof extraSchema, { v: string; projection: unknown }> = {
			label: "ext-bash",
			name: "bash",
			description: "ext bash",
			parameters: extraSchema,
			execute: async () => ({
				content: [{ type: "text", text: "ext" }],
				details: { v: "ext", projection: muDisplayForTest(["bash", "ext"]) },
			}),
		};
		const extTool: AgentTool<typeof extraSchema, { ok: true; projection: unknown }> = {
			label: "extra",
			name: "extra",
			description: "extra",
			parameters: extraSchema,
			execute: async () => ({
				content: [{ type: "text", text: "extra" }],
				details: { ok: true, projection: muDisplayForTest(["extra"]) },
			}),
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

	it("throws a strict error when an extension tool result is missing projection", async () => {
		const mgr = new ExtensionManager({ builtInTools: toolMap(["bash"]) });

		const schema = Type.Object({});
		const badTool: AgentTool<typeof schema, { ok: true }> = {
			label: "bad",
			name: "bad",
			description: "bad",
			parameters: schema,
			execute: async () => ({
				content: [{ type: "text", text: "hello" }],
				details: { ok: true },
			}),
		};

		await mgr.loadExtension((api) => {
			api.registerTool(eraseAgentTool(badTool));
		}, "ext-bad");

		const tools = mgr.getToolsForSelection(["bash"]);
		const bad = tools.find((t) => t.name === "bad");
		expect(bad).toBeTruthy();

		await expect(bad!.execute("tc_1", {})).rejects.toThrow(/projection/);
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

// VAL-CORE-003: Built-in tool selection semantics survive core opening
describe("VAL-CORE-003: Built-in tool selection semantics", () => {
	it("exposes only selected built-ins in the active tool surface", () => {
		// Setup: multiple built-in tools
		const mgr = new ExtensionManager({
			builtInTools: toolMap(["bash", "read", "edit", "write"]),
		});

		// Select only bash and read
		const tools = mgr.getToolsForSelection(["bash", "read"]);
		const names = tools.map((t) => t.name);

		// Only selected built-ins should appear
		expect(names).toContain("bash");
		expect(names).toContain("read");

		// Unselected built-ins should NOT appear
		expect(names).not.toContain("edit");
		expect(names).not.toContain("write");
	});

	it("exposes selected built-ins or their active same-name overrides", async () => {
		// Setup: built-in bash + extension that overrides it
		const mgr = new ExtensionManager({
			builtInTools: toolMap(["bash", "read"]),
		});

		// Extension overrides bash with higher priority
		const extBash: AgentTool<typeof mockToolSchema, { v: string; projection: unknown }> = {
			label: "ext-bash",
			name: "bash",
			description: "extension bash",
			parameters: mockToolSchema,
			execute: async () => ({
				content: [{ type: "text", text: "ext-bash" }],
				details: { v: "ext", projection: muDisplayForTest(["bash"]) },
			}),
		};

		await mgr.loadExtension((api) => {
			api.registerTool(eraseAgentTool(extBash), { priority: 200 });
		}, "ext");

		const tools = mgr.getToolsForSelection(["bash", "read"]);
		const bashTool = tools.find((t) => t.name === "bash");

		// Extension override should win
		expect(bashTool?.label).toBe("ext-bash");
	});

	it("does not leak unselected built-ins into active runtime", () => {
		// Setup: many built-ins, select a subset
		const builtIns = ["bash", "read", "edit", "write", "memory_search", "memory_read", "memory_store"];
		const mgr = new ExtensionManager({
			builtInTools: toolMap(builtIns),
		});

		// Select only bash
		const tools = mgr.getToolsForSelection(["bash"]);
		const names = tools.map((t) => t.name);

		// Only bash should appear
		expect(names).toEqual(["bash"]);

		// All other built-ins should be excluded
		for (const unselected of ["read", "edit", "write", "memory_search", "memory_read", "memory_store"]) {
			expect(names).not.toContain(unselected);
		}
	});

	it("extension-only tools remain additive to selected built-ins", async () => {
		// Setup: built-in tools + extension-only tools
		const mgr = new ExtensionManager({
			builtInTools: toolMap(["bash", "read"]),
		});

		// Extension adds new tools (not overriding built-ins)
		await mgr.loadExtension((api) => {
			api.registerTool(eraseAgentTool(makeTool("websearch")));
			api.registerTool(eraseAgentTool(makeTool("webfetch")));
		}, "ext");

		const tools = mgr.getToolsForSelection(["bash"]);
		const names = tools.map((t) => t.name);

		// Selected built-in appears
		expect(names).toContain("bash");

		// Extension-only tools are added
		expect(names).toContain("websearch");
		expect(names).toContain("webfetch");

		// Unselected built-in does not appear
		expect(names).not.toContain("read");
	});
});
