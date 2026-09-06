import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createAllToolDefinitions, createAllTools } from "../src/core/tools/index.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

const strictToolNames = ["read", "bash", "powershell", "edit", "write"] as const;

describe("strict built-in tools", () => {
	afterEach(() => vi.unstubAllEnvs());

	it.each([undefined, "0", "1"])("prefers strict sampling with PI_EXPERIMENTAL=%s", (experimental) => {
		vi.stubEnv("PI_EXPERIMENTAL", experimental);
		const definitions = createAllToolDefinitions(process.cwd());
		const tools = createAllTools(process.cwd());
		for (const name of strictToolNames) {
			expect(definitions[name].constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
			expect(tools[name].constrainedSampling).toEqual(definitions[name].constrainedSampling);
		}
		for (const name of ["grep", "find", "ls"] as const) {
			expect(definitions[name].constrainedSampling).toBeUndefined();
		}
		// Strictness is a provider-side conversion, not a change to the execution schema.
		expect(definitions.read.parameters.required).toEqual(["path"]);
		expect(definitions.bash.parameters.required).toEqual(["command"]);
	});

	it("preserves explicit opt-outs when wrapping definitions for execution", () => {
		const definitions = createAllToolDefinitions(process.cwd());
		for (const name of strictToolNames) {
			const definition = definitions[name];
			const override = { ...definition, constrainedSampling: false as const };
			expect(wrapToolDefinition(override).constrainedSampling).toBe(false);
			expect(override.execute).toBe(definition.execute);
			expect(override.prepareArguments).toBe(definition.prepareArguments);
			expect(override.renderCall).toBe(definition.renderCall);
			expect(override.renderResult).toBe(definition.renderResult);
			expect(override.promptGuidelines).toBe(definition.promptGuidelines);
			expect(definition.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		}
	});

	it.each([{ activeTools: [] }, { activeTools: ["read"] }, { activeTools: [...strictToolNames] }])(
		"allows extensions to re-register tools without strict sampling: $activeTools",
		async ({ activeTools }) => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-non-strict-tools-"));
			const agentDir = join(cwd, "agent");
			const settingsManager = SettingsManager.inMemory({ defaultTools: activeTools });
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							const definitions = createAllToolDefinitions(cwd);
							for (const name of strictToolNames) {
								pi.registerTool({ ...definitions[name], constrainedSampling: false });
							}
							pi.setActiveTools(activeTools);
						});
					},
				],
			});
			try {
				await resourceLoader.reload();
				const { session } = await createAgentSession({
					cwd,
					agentDir,
					model: getModel("anthropic", "claude-sonnet-4-5"),
					settingsManager,
					sessionManager: SessionManager.inMemory(cwd),
					resourceLoader,
				});
				try {
					const originalPrompt = session.systemPrompt;
					await session.bindExtensions({});
					expect(session.getActiveToolNames()).toEqual(activeTools);
					expect(session.systemPrompt).toBe(originalPrompt);
					for (const name of strictToolNames) {
						expect(session.getToolDefinition(name)?.constrainedSampling).toBe(false);
					}
					for (const tool of session.agent.state.tools) {
						expect(tool.constrainedSampling).toBe(false);
					}
					if (activeTools.includes("read")) {
						writeFileSync(join(cwd, "sample.txt"), "still works");
						const read = session.agent.state.tools.find((tool) => tool.name === "read")!;
						const result = await read.execute("read-test", { path: "sample.txt" });
						expect(result.content).toEqual([{ type: "text", text: "still works" }]);
					}
				} finally {
					session.dispose();
				}
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	);
});
