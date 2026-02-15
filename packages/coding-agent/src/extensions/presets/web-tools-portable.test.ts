import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@kennyfrc/mu-ai";
import { type TSchema, Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { ExtensionLoader } from "../loader.js";
import { ExtensionManager } from "../manager.js";
import { eraseAgentTool } from "../types.js";

function makeBuiltIn(): Record<string, AgentTool<TSchema, unknown>> {
	const schema = Type.Object({});
	const read: AgentTool<typeof schema, { ok: true }> = {
		label: "read",
		name: "read",
		description: "read",
		parameters: schema,
		execute: async () => ({ content: [{ type: "text", text: "read" }], details: { ok: true } }),
	};
	return { read: eraseAgentTool(read) };
}

describe("web-tools preset portability", () => {
	it("loads when copied as a single extension file under ~/.mu/agent/extensions", async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "mu-web-tools-portable-project-"));
		const configDir = await mkdtemp(join(tmpdir(), "mu-web-tools-portable-config-"));
		const extDir = join(configDir, "extensions");
		await mkdir(extDir, { recursive: true });

		const presetSourcePath = join(process.cwd(), "src", "extensions", "presets", "web-tools.ts");
		const presetSource = await readFile(presetSourcePath, "utf8");
		await writeFile(join(extDir, "web-tools.ts"), presetSource, "utf8");

		const mgr = new ExtensionManager({ builtInTools: makeBuiltIn() });
		const loader = new ExtensionLoader(mgr, { projectDir, configDir });
		const res = await loader.loadAll();

		expect(res).toHaveLength(1);
		expect(res[0].ok).toBe(true);

		const names = mgr.getToolsForSelection(["read"]).map((t) => t.name);
		expect(names).toContain("web_search");
		expect(names).toContain("fetch");
	});
});
