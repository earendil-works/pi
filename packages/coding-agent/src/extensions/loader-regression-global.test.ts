import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@kennyfrc/mu-ai";
import { type TSchema, Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { ExtensionLoader } from "./loader.js";
import { ExtensionManager } from "./manager.js";
import { eraseAgentTool } from "./types.js";

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

describe("ExtensionLoader global-dir regression", () => {
	it("loads only .ts when stale .js exists in config extensions dir", async () => {
		const configDir = await mkdtemp(join(tmpdir(), "mu-ext-config-regression-"));
		const extDir = join(configDir, "extensions");
		await mkdir(extDir, { recursive: true });

		const tsPath = join(extDir, "web-tools.ts");
		const jsPath = join(extDir, "web-tools.js");

		const tsExt = `
import { Type } from "@sinclair/typebox";
export default function (mu) {
  mu.registerTool({
    label: "web-tools-ts",
    name: "web_search",
    description: "from ts",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "ok" }], details: { source: "ts" } }; }
  });
}
`;

		const staleJs = `
import { eraseAgentTool } from "../types.js";
export default function () { return eraseAgentTool; }
`;

		await writeFile(tsPath, tsExt, "utf8");
		await writeFile(jsPath, staleJs, "utf8");

		const mgr = new ExtensionManager({ builtInTools: makeBuiltIn() });
		const loader = new ExtensionLoader(mgr, {
			projectDir: await mkdtemp(join(tmpdir(), "mu-ext-project-empty-")),
			configDir,
		});

		const discovered = await loader.discoverExtensionFiles();
		expect(discovered).toEqual([tsPath]);

		const results = await loader.loadAll();
		expect(results).toHaveLength(1);
		expect(results[0].ok).toBe(true);

		const names = mgr.getToolsForSelection(["bash"]).map((t) => t.name);
		expect(names).toContain("web_search");
	});
});
