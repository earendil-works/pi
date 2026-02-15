import type { AgentTool } from "@kennyfrc/mu-ai";
import { type TSchema, Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { ExtensionManager } from "../manager.js";
import { eraseAgentTool } from "../types.js";
import webToolsExtension from "./web-tools.js";

function makeBuiltIn(): Record<string, AgentTool<TSchema, unknown>> {
	const schema = Type.Object({});
	const bash: AgentTool<typeof schema, { ok: true }> = {
		label: "bash",
		name: "bash",
		description: "bash",
		parameters: schema,
		execute: async () => ({ content: [{ type: "text", text: "bash" }], details: { ok: true } }),
	};
	return { bash: eraseAgentTool(bash) };
}

describe("web-tools preset extension", () => {
	it("registers web_search + fetch tools", async () => {
		const mgr = new ExtensionManager({ builtInTools: makeBuiltIn() });
		await mgr.loadExtension(webToolsExtension, "preset:web-tools");

		const tools = mgr.getToolsForSelection(["bash"]);
		const names = tools.map((t) => t.name);
		expect(names).toContain("web_search");
		expect(names).toContain("fetch");
	});
});
