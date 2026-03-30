import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@kennyfrc/mu-ai";
import { type TSchema, Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { ExtensionLoader } from "./loader.js";
import { ExtensionManager } from "./manager.js";
import type { ExtensionFactory } from "./types.js";
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

describe("ExtensionLoader", () => {
	it("discovers, loads, and reloads extensions from project .mu/extensions", async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "mu-ext-project-"));
		const extDir = join(projectDir, ".mu", "extensions");
		await mkdir(extDir, { recursive: true });

		const extPath = join(extDir, "ext.ts");

		const version1 = `
import { Type } from "@sinclair/typebox";

export default function (mu) {
  mu.registerTool({
    label: "extra-v1",
    name: "extra",
    description: "extra",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "v1" }], details: { v: 1 } };
    }
  });
}
`;
		await writeFile(extPath, version1, "utf8");

		const mgr = new ExtensionManager({ builtInTools: makeBuiltIn() });
		const loader = new ExtensionLoader(mgr, { projectDir, configDir: join(projectDir, "_config") });

		const res1 = await loader.loadAll();
		if (!res1[0]?.ok) {
			throw new Error(res1[0]?.error || "Failed to load extension");
		}
		expect(res1.map((r) => r.ok)).toEqual([true]);

		let tools = mgr.getToolsForSelection(["bash"]);
		let extra = tools.find((t) => t.name === "extra");
		expect(extra?.label).toBe("extra-v1");

		const version2 = version1.replace("extra-v1", "extra-v2").replace("v1", "v2");
		await writeFile(extPath, version2, "utf8");

		const res2 = await loader.reloadAll();
		expect(res2.map((r) => r.ok)).toEqual([true]);

		tools = mgr.getToolsForSelection(["bash"]);
		extra = tools.find((t) => t.name === "extra");
		expect(extra?.label).toBe("extra-v2");
	});

	it("prefers TypeScript extension file when both .ts and .js exist", async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "mu-ext-project-dupe-"));
		const extDir = join(projectDir, ".mu", "extensions");
		await mkdir(extDir, { recursive: true });

		const tsPath = join(extDir, "web-tools.ts");
		const jsPath = join(extDir, "web-tools.js");

		const tsExt = `
import { Type } from "@sinclair/typebox";

export default function (mu) {
  mu.registerTool({
    label: "web_search-ts",
    name: "web_search",
    description: "ts",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ts" }], details: { source: "ts" } };
    }
  });
}
`;
		const jsExt = `
import { Type } from "@sinclair/typebox";

export default function (mu) {
  mu.registerTool({
    label: "web_search-js",
    name: "web_search",
    description: "js",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "js" }], details: { source: "js" } };
    }
  });
}
`;

		await writeFile(tsPath, tsExt, "utf8");
		await writeFile(jsPath, jsExt, "utf8");

		const mgr = new ExtensionManager({ builtInTools: makeBuiltIn() });
		const loader = new ExtensionLoader(mgr, { projectDir, configDir: join(projectDir, "_config") });
		const res = await loader.loadAll();

		expect(res.length).toBe(1);
		expect(res[0].ok).toBe(true);

		const tools = mgr.getToolsForSelection(["bash"]);
		const webSearch = tools.find((t) => t.name === "web_search");
		expect(webSearch?.label).toBe("web_search-ts");
	});

	it("loads built-in extensions after discovered files so built-ins win duplicate tool names", async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "mu-ext-project-built-ins-"));
		const extDir = join(projectDir, ".mu", "extensions");
		await mkdir(extDir, { recursive: true });

		const extPath = join(extDir, "ask-user.ts");
		await writeFile(
			extPath,
			`
import { Type } from "@sinclair/typebox";

export default function (mu) {
  mu.registerTool({
    label: "ask_user_external",
    name: "ask_user",
    description: "external ask_user",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "external" }],
        details: {
          projection: {
            version: 1,
            call: { style: "argv", text: "ask_user external", command: "ask_user", argv: ["external"] },
            summary: { text: "ok", severity: "ok" },
            output: { collapse: { maxVisualLines: 4, expandHint: "ctrl+o to expand" }, format: "markdown" }
          }
        }
      };
    }
  }, { priority: 150 });
}
`,
			"utf8",
		);

		const builtInFactory: ExtensionFactory = (mu) => {
			mu.registerTool(
				eraseAgentTool({
					label: "ask_user_builtin",
					name: "ask_user",
					description: "built-in ask_user",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "built-in" }],
						details: {
							projection: {
								version: 1 as const,
								call: {
									style: "argv" as const,
									text: "ask_user builtin",
									command: "ask_user",
									argv: ["builtin"],
								},
								summary: { text: "ok", severity: "ok" as const },
								output: {
									collapse: { maxVisualLines: 4, expandHint: "ctrl+o to expand" },
									format: "markdown" as const,
								},
							},
						},
					}),
				}),
				{ priority: 150 },
			);
		};

		const mgr = new ExtensionManager({ builtInTools: makeBuiltIn() });
		const loader = new ExtensionLoader(mgr, {
			projectDir,
			configDir: join(projectDir, "_config"),
			builtInExtensions: [{ sourceId: "built-in:ask-user", factory: builtInFactory }],
		});

		const res = await loader.loadAll();
		expect(res.map((entry) => entry.ok)).toEqual([true, true]);

		let tools = mgr.getToolsForSelection(["bash"]);
		let askUser = tools.find((tool) => tool.name === "ask_user");
		expect(askUser?.label).toBe("ask_user_builtin");

		const reload = await loader.reloadAll();
		expect(reload.map((entry) => entry.ok)).toEqual([true, true]);

		tools = mgr.getToolsForSelection(["bash"]);
		askUser = tools.find((tool) => tool.name === "ask_user");
		expect(askUser?.label).toBe("ask_user_builtin");
	});
});
