import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { getApiProvider, getModel, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession, type InlineExtension } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createCodemodeExtension } from "../src/extensions/codemode/index.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

// Regression for #10245: reload must apply configuration additions without replacing runtime choices.
describe("reloading the default tool selection", () => {
	let cwd: string;
	let agentDir: string;
	const sessions: AgentSession[] = [];
	const harnesses: Harness[] = [];

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-default-tools-reload-"));
		agentDir = join(cwd, "agent");
		mkdirSync(agentDir);
		mkdirSync(join(cwd, ".pi"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		unregisterApiProviders("default-tools-reload-test");
		while (sessions.length) sessions.pop()?.dispose();
		while (harnesses.length) harnesses.pop()?.cleanup();
		rmSync(cwd, { recursive: true, force: true });
	});

	function writeDefaults(defaultTools?: string[], project = false) {
		writeFileSync(join(project ? join(cwd, ".pi") : agentDir, "settings.json"), JSON.stringify({ defaultTools }));
	}

	async function setup(
		options: Partial<CreateAgentSessionOptions> = {},
		extensionFactories: InlineExtension[] = [],
		projectTrusted = true,
	) {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [createCodemodeExtension(), ...extensionFactories],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			...options,
		});
		sessions.push(session);
		return { session, settingsManager, resourceLoader };
	}

	it("adds selected tools without reasserting unchanged defaults or applying removals", async () => {
		const { session } = await setup();
		session.setActiveToolsByName(["read", "edit", "write"]);
		writeDefaults(["+grep", "+codemode"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read", "edit", "write", "grep", "codemode"]);

		writeDefaults(["-write"]);
		await session.reload();
		expect(session.getActiveToolNames()).toContain("write");
		session.setActiveToolsByName(["read"]);
		writeDefaults(["+codemode"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read", "write", "codemode"]);
		session.setActiveToolsByName(["read", "write"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read", "write"]);
	});

	it("tracks an empty selection and ignores reordering and duplicates", async () => {
		writeDefaults([]);
		const { session } = await setup();
		writeDefaults(["grep", "read"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["grep", "read"]);
		session.setActiveToolsByName(["read"]);
		writeDefaults(["read", "grep", "grep"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("uses the fallback selection when the field is deleted", async () => {
		writeDefaults(["grep"]);
		const { session } = await setup();
		writeDefaults();
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["grep", "read", "bash", "edit", "write"]);
	});

	it("uses the merged project selection and respects project replacement", async () => {
		writeDefaults(["read"]);
		writeDefaults(["+grep"], true);
		const { session } = await setup();
		writeDefaults(["+grep", "+codemode"], true);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read", "grep", "codemode"]);
		writeDefaults(["read"], true);
		await session.reload();
		session.setActiveToolsByName(["read"]);
		writeDefaults(["read", "find"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("preserves project trust while reloading global additions", async () => {
		writeDefaults(["read"]);
		const { session, settingsManager } = await setup({}, [], false);
		writeDefaults(["read", "find"], true);
		writeDefaults(["read", "grep"]);
		await session.reload();
		expect(settingsManager.isProjectTrusted()).toBe(false);
		expect(session.getActiveToolNames()).toEqual(["read", "grep"]);
	});

	it.each<Pick<CreateAgentSessionOptions, "tools" | "noTools">>([
		{ tools: ["read"] },
		{ tools: [] },
		{ noTools: "all" },
		{ noTools: "builtin" },
	])("preserves explicit startup selection %j", async (options) => {
		const { session } = await setup(options);
		const initial = session.getActiveToolNames();
		writeDefaults(["+grep", "+codemode"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(initial);
	});

	it("keeps registration exclusions authoritative", async () => {
		const { session } = await setup({ excludeTools: ["grep", "codemode"] });
		writeDefaults(["+grep", "+codemode", "+find"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "find"]);
	});

	it("tracks defaults through service-based session creation", async () => {
		writeDefaults(["read"]);
		const services = await createAgentSessionServices({ cwd, agentDir });
		const { session } = await createAgentSessionFromServices({
			services,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			sessionManager: SessionManager.inMemory(cwd),
		});
		sessions.push(session);
		writeDefaults(["read", "grep"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read", "grep"]);
	});

	it("does not infer configuration tracking for direct constructor callers", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["read"], settings: { defaultTools: ["read"] } });
		harnesses.push(harness);
		vi.spyOn(harness.settingsManager, "getDefaultTools").mockReturnValue(["read", "grep"]);
		await harness.session.reload();
		expect(harness.session.getActiveToolNames()).toEqual(["read"]);
	});

	it("retries additions after resource loading rejects", async () => {
		writeDefaults(["read"]);
		const { session, resourceLoader } = await setup();
		writeDefaults(["read", "grep"]);
		vi.spyOn(resourceLoader, "reload").mockRejectedValueOnce(new Error("load failed"));
		await expect(session.reload()).rejects.toThrow("load failed");
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read", "grep"]);
	});

	it("commits the snapshot only after the reload lifecycle completes", async () => {
		writeDefaults(["read"]);
		const { session } = await setup();
		await session.bindExtensions({ uiContext: createTestUiContext() });
		writeDefaults(["read", "grep"]);
		await expect(
			session.reload({
				beforeSessionStart: () => {
					throw new Error("binding failed");
				},
			}),
		).rejects.toThrow("binding failed");
		expect(session.getActiveToolNames()).toContain("grep");
		session.setActiveToolsByName(["read"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read", "grep"]);
	});

	it("saves the selection used for rebuilding rather than later callback changes", async () => {
		writeDefaults(["read"]);
		const { session, settingsManager } = await setup();
		await session.bindExtensions({ uiContext: createTestUiContext() });
		writeDefaults(["read", "grep"]);
		await session.reload({
			beforeSessionStart: () => {
				writeDefaults(["read", "grep", "find"]);
				settingsManager.applyOverrides({ defaultTools: ["read", "grep", "find"] });
			},
		});
		expect(session.getActiveToolNames()).toEqual(["read", "grep"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read", "grep", "find"]);
	});

	it("consumes unavailable names after normal return and leaves later activation to extensions", async () => {
		let available = false;
		const extension: InlineExtension = (pi) => {
			if (available) {
				pi.registerTool({
					name: "inactive_tool",
					label: "Inactive",
					description: "Registered inactive",
					parameters: Type.Object({}),
					defaultActive: false,
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			}
			pi.on("session_start", (event) => {
				if (event.reason === "reload" && available) pi.setActiveTools(["read"]);
			});
		};
		writeDefaults(["read"]);
		const { session } = await setup({}, [extension]);
		writeDefaults(["read", "inactive_tool"]);
		await session.reload();
		available = true;
		await session.reload();
		expect(session.getAllTools().map((tool) => tool.name)).toContain("inactive_tool");
		expect(session.getActiveToolNames()).toEqual(["read"]);
		await session.bindExtensions({ uiContext: createTestUiContext() });
		writeDefaults(["read"]);
		await session.reload();
		writeDefaults(["read", "inactive_tool"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("does not treat reported extension errors as reload rejection", async () => {
		const { session } = await setup({}, [
			(pi) => {
				pi.on("session_start", (event) => {
					if (event.reason === "reload") throw new Error("reported failure");
				});
			},
		]);
		const errors: string[] = [];
		await session.bindExtensions({ onError: (error) => errors.push(error.error) });
		writeDefaults(["+grep"]);
		await session.reload();
		expect(errors).toContain("reported failure");
		expect(session.getActiveToolNames()).toContain("grep");
		session.setActiveToolsByName(["read"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it.each(["on", "only"] as const)("projects reloaded codemode declarations in %s mode", async (mode) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const apiProvider = getApiProvider(harness.faux.api)!;
		const settings = { codemode: { mode }, compaction: { enabled: false } };
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ...settings, defaultTools: ["read"] }));
		const { session } = await setup({
			model: harness.getModel(),
			modelRuntime: harness.session.modelRuntime,
		});
		const declared: string[][] = [];
		const record: Parameters<Harness["setResponses"]>[0][number] = (context) => {
			declared.push(getCurrentTools(context.messages).map((tool) => tool.name));
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([record]);
		await session.prompt("before reload");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ ...settings, defaultTools: ["read", "codemode"] }),
		);
		await session.reload();
		// Reload resets compat API registrations, including the test-only faux provider.
		registerApiProvider(apiProvider, "default-tools-reload-test");
		harness.setResponses([record]);
		await session.prompt("after reload");
		expect(declared[0]).toEqual(["read"]);
		expect(declared[1]).toEqual(mode === "only" ? ["codemode"] : ["read", "codemode"]);
		expect(session.getCallableToolNames()).toContain("read");
	});
});
