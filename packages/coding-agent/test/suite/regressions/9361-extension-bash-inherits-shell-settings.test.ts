import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../src/config.ts";
import type { ExtensionContext, ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { type BashOperations, createBashTool, createBashToolDefinition } from "../../../src/core/tools/bash.ts";
import { createEditTool, createEditToolDefinition } from "../../../src/core/tools/edit.ts";
import { createFindTool, createFindToolDefinition } from "../../../src/core/tools/find.ts";
import { createGrepTool, createGrepToolDefinition } from "../../../src/core/tools/grep.ts";
import { createLsTool, createLsToolDefinition } from "../../../src/core/tools/ls.ts";
import { createReadTool, createReadToolDefinition } from "../../../src/core/tools/read.ts";
import { createWriteTool, createWriteToolDefinition } from "../../../src/core/tools/write.ts";
import * as shell from "../../../src/utils/shell.ts";

// Import the shipped examples against source without requiring a distribution build.
vi.mock("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME,
	getAgentDir,
	SettingsManager,
	createBashTool,
	createBashToolDefinition,
	createEditTool,
	createEditToolDefinition,
	createFindTool,
	createFindToolDefinition,
	createGrepTool,
	createGrepToolDefinition,
	createLsTool,
	createLsToolDefinition,
	createReadTool,
	createReadToolDefinition,
	createWriteTool,
	createWriteToolDefinition,
}));

import bashSpawnHook from "../../../examples/extensions/bash-spawn-hook.ts";
import builtInToolRenderer from "../../../examples/extensions/built-in-tool-renderer.ts";
import minimalMode from "../../../examples/extensions/minimal-mode.ts";
import sandbox from "../../../examples/extensions/sandbox/index.ts";
import ssh from "../../../examples/extensions/ssh.ts";

// #9361: replacing a local tool must not silently discard the user's shell settings.
describe("bash replacement example settings", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let shellPath: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-bash-settings-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		const home = join(root, "home");
		mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
		mkdirSync(agentDir);
		mkdirSync(home);
		writeFileSync(join(home, ".profile"), "", "utf8");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("BASH_ENV", undefined);
		vi.stubEnv("ENV", undefined);
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		shellPath = shell.getShellConfig().shell;
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ shellPath, shellCommandPrefix: "export PI9361_PREFIX=global" }),
		);
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ shellCommandPrefix: "export PI9361_PREFIX=project" }),
		);
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		// Only remove this test's newly created directory.
		expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
		rmSync(root, { recursive: true, force: true });
	});

	async function start(
		extension?: ExtensionFactory,
		projectTrusted = true,
		settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted }),
		additionalExtensionPaths: string[] = [],
	) {
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: extension ? [extension] : [],
			additionalExtensionPaths,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		resourceLoader.getExtensions().runtime.flagValues.set("no-sandbox", true);
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
		}));
		await session.bindExtensions({
			onError: (error) => {
				throw new Error(error.error);
			},
		});
		return session.agent.state.tools.find((tool) => tool.name === "bash")!;
	}

	const legacyWrapper: ExtensionFactory = (pi) => {
		const bash = createBashTool(cwd);
		pi.registerTool({
			...bash,
			async execute(id, params, signal, onUpdate) {
				await Promise.resolve();
				return bash.execute(id, params, signal, onUpdate);
			},
		});
	};

	const examples = [
		["built-in", undefined],
		["extension without replacement", (() => {}) satisfies ExtensionFactory],
		["legacy wrapper without context forwarding", legacyWrapper],
		["bash-spawn-hook", bashSpawnHook],
		["built-in-tool-renderer", builtInToolRenderer],
		["minimal-mode", minimalMode],
		["ssh (local)", ssh],
		["sandbox (disabled)", sandbox],
	] as const;

	it.each(examples)("%s uses the session's in-memory settings", async (_name, extension) => {
		const settings = SettingsManager.inMemory({ shellPath, shellCommandPrefix: "export PI9361_PREFIX=memory" });
		const tool = await start(extension, true, settings);
		const result = await tool.execute("memory", { command: "printf '%s' \"$PI9361_PREFIX\"" });
		expect(result.content).toEqual([{ type: "text", text: "memory" }]);
	});

	it.each(examples)("%s uses the session's custom agent directory", async (_name, extension) => {
		agentDir = join(root, "custom-agent");
		mkdirSync(agentDir);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ shellPath, shellCommandPrefix: "export PI9361_PREFIX=custom" }),
		);
		const tool = await start(extension, false);
		const result = await tool.execute("custom", { command: "printf '%s' \"$PI9361_PREFIX\"" });
		expect(result.content).toEqual([{ type: "text", text: "custom" }]);
	});

	it.each(examples)("%s rejects a missing configured shell instead of falling back", async (_name, extension) => {
		const missingShell = join(root, "missing-shell");
		writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ shellPath: missingShell }));
		const tool = await start(extension);
		await expect(tool.execute("shell", { command: "printf fallback" })).rejects.toThrow(
			`Custom shell path not found: ${missingShell}`,
		);
	});

	it.each(examples)("%s uses the configured shell and project command prefix", async (_name, extension) => {
		const tool = await start(extension);
		const resolveShell = vi.spyOn(shell, "getShellConfig");
		const result = await tool.execute("settings", { command: "printf '%s' \"$PI9361_PREFIX\"" });
		expect(result.content).toEqual([{ type: "text", text: "project" }]);
		expect(resolveShell).toHaveBeenCalledWith(shellPath);
	});

	it.each(examples)("%s ignores untrusted project shell settings", async (_name, extension) => {
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ shellPath: join(root, "missing-shell") }),
		);
		const tool = await start(extension, false);
		const result = await tool.execute("untrusted", { command: "printf '%s' \"$PI9361_PREFIX\"" });
		expect(result.content).toEqual([{ type: "text", text: "global" }]);
	});

	it("allows an extension to explicitly choose a shell", async () => {
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ shellPath: join(root, "missing-shell") }),
		);
		const tool = await start((pi) =>
			pi.registerTool(createBashTool(cwd, { shellPath, commandPrefix: "export PI9361_PREFIX=explicit" })),
		);
		const result = await tool.execute("explicit", { command: "printf '%s' \"$PI9361_PREFIX\"" });
		expect(result.content).toEqual([{ type: "text", text: "explicit" }]);
	});

	it.each([
		["built-in", undefined],
		["legacy wrapper", legacyWrapper],
	] as const)("%s reports an existing shell path that cannot be started", async (_name, extension) => {
		const invalidShell = join(root, "invalid-bash.exe");
		writeFileSync(invalidShell, "This is not an executable.", "utf8");
		const tool = await start(extension, true, SettingsManager.inMemory({ shellPath: invalidShell }));
		await expect(tool.execute("invalid-shell", { command: "printf fallback" })).rejects.toThrow(invalidShell);
	});

	it("does not leak extension defaults into standalone tool execution", async () => {
		const tool = await start(legacyWrapper);
		expect((await tool.execute("inside", { command: "printf '%s' \"$PI9361_PREFIX\"" })).content).toEqual([
			{ type: "text", text: "project" },
		]);
		const standalone = createBashTool(cwd, { shellPath });
		expect(
			(await standalone.execute("outside", { command: "printf 'value:%s' \"$PI9361_PREFIX\"" })).content,
		).toEqual([{ type: "text", text: "value:" }]);
	});

	it("allows an explicit empty prefix to disable the session prefix", async () => {
		const tool = await start((pi) => pi.registerTool(createBashTool(cwd, { commandPrefix: "" })));
		expect((await tool.execute("empty", { command: "printf 'value:%s' \"$PI9361_PREFIX\"" })).content).toEqual([
			{ type: "text", text: "value:" },
		]);
	});

	it("inherits settings through six file-loaded extensions and a cached asynchronous wrapper", async () => {
		const paths = Array.from({ length: 6 }, (_, i) => join(root, `extension-${i}.ts`));
		for (const path of paths) {
			writeFileSync(path, "export default async function () { await Promise.resolve(); }", "utf8");
		}
		writeFileSync(
			paths[5],
			`
import { createBashTool } from "@earendil-works/pi-coding-agent";
export default async function (pi) {
	await Promise.resolve();
	const bash = createBashTool(process.cwd());
	pi.registerTool({
		...bash,
		async execute(id, params, signal, onUpdate) {
			await Promise.resolve();
			return bash.execute(id, params, signal, onUpdate);
		},
	});
}
`,
			"utf8",
		);
		const settings = SettingsManager.inMemory({ shellPath, shellCommandPrefix: "export PI9361_PREFIX=loaded" });
		const tool = await start(undefined, true, settings, paths);
		expect((await tool.execute("loaded", { command: "printf '%s' \"$PI9361_PREFIX\"" })).content).toEqual([
			{ type: "text", text: "loaded" },
		]);
		const missingShell = join(root, "missing-shell");
		settings.applyOverrides({ shellPath: missingShell });
		await expect(tool.execute("loaded-invalid", { command: "printf fallback" })).rejects.toThrow(
			`Custom shell path not found: ${missingShell}`,
		);
	});

	it("returns fresh session settings without letting snapshot mutations change the session", async () => {
		let ctx!: ExtensionContext;
		const settings = SettingsManager.inMemory({ shellPath, shellCommandPrefix: "original" });
		await start(
			(pi) => {
				pi.on("session_start", (_event, context) => {
					ctx = context;
				});
			},
			true,
			settings,
		);
		const snapshot = ctx.getBashToolOptions();
		snapshot.shellPath = "mutated";
		snapshot.commandPrefix = "mutated";
		expect(ctx.getBashToolOptions()).toEqual({ shellPath, commandPrefix: "original" });
		settings.applyOverrides({ shellPath: "updated-shell", shellCommandPrefix: "updated-prefix" });
		expect(ctx.getBashToolOptions()).toEqual({ shellPath: "updated-shell", commandPrefix: "updated-prefix" });
	});

	it.each([bashSpawnHook, legacyWrapper])(
		"keeps two sessions in the same directory isolated (%#)",
		async (extension) => {
			const first = await start(
				extension,
				true,
				SettingsManager.inMemory({ shellPath, shellCommandPrefix: "export PI9361_PREFIX=first" }),
			);
			const firstSession = session!;
			try {
				const second = await start(
					extension,
					true,
					SettingsManager.inMemory({ shellPath, shellCommandPrefix: "export PI9361_PREFIX=second" }),
				);
				await Promise.all(
					(
						[
							[second, "second"],
							[first, "first"],
						] as const
					).map(async ([tool, expected]) => {
						const result = await tool.execute(expected, { command: "printf '%s' \"$PI9361_PREFIX\"" });
						expect(result.content).toEqual([{ type: "text", text: expected }]);
					}),
				);
			} finally {
				firstSession.dispose();
			}
		},
	);

	it("uses reloaded settings and rejects contexts retained across reload and disposal", async () => {
		const contexts: ExtensionContext[] = [];
		await start((pi) => {
			bashSpawnHook(pi);
			pi.on("session_start", (_event, ctx) => {
				contexts.push(ctx);
			});
		});
		expect(contexts[0].getBashToolOptions().commandPrefix).toBe("export PI9361_PREFIX=project");
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ shellCommandPrefix: "export PI9361_PREFIX=reloaded" }),
		);
		await session!.reload();
		expect(contexts.length).toBe(2);
		expect(() => contexts[0].getBashToolOptions()).toThrow();
		expect(contexts[1].getBashToolOptions().commandPrefix).toBe("export PI9361_PREFIX=reloaded");
		const tool = session!.agent.state.tools.find((tool) => tool.name === "bash")!;
		expect((await tool.execute("reload", { command: "printf '%s' \"$PI9361_PREFIX\"" })).content).toEqual([
			{ type: "text", text: "reloaded" },
		]);
		session!.dispose();
		session = undefined;
		expect(() => contexts[1].getBashToolOptions()).toThrow();
	});

	it("applies settings changes to the built-in tool without a reload", async () => {
		const settings = SettingsManager.inMemory({ shellPath, shellCommandPrefix: "export PI9361_PREFIX=before" });
		const tool = await start(undefined, true, settings);
		expect((await tool.execute("before", { command: "printf '%s' \"$PI9361_PREFIX\"" })).content).toEqual([
			{ type: "text", text: "before" },
		]);
		const missingShell = join(root, "missing-shell");
		settings.applyOverrides({ shellPath: missingShell });
		await expect(tool.execute("invalid", { command: "printf fallback" })).rejects.toThrow(
			`Custom shell path not found: ${missingShell}`,
		);
		settings.applyOverrides({ shellPath, shellCommandPrefix: "export PI9361_PREFIX=after" });
		expect((await tool.execute("after", { command: "printf '%s' \"$PI9361_PREFIX\"" })).content).toEqual([
			{ type: "text", text: "after" },
		]);
	});

	it("allows custom operations without resolving a local shell or injecting a local prefix", async () => {
		writeFileSync(
			join(cwd, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ shellPath: join(root, "missing-shell") }),
		);
		const exec = vi.fn<BashOperations["exec"]>(async (_command, _cwd, { onData }) => {
			onData(Buffer.from("remote"));
			return { exitCode: 0 };
		});
		const tool = await start((pi) => pi.registerTool(createBashTool(cwd, { operations: { exec } })));
		const resolveShell = vi.spyOn(shell, "getShellConfig");
		const result = await tool.execute("remote", { command: "printf remote" });
		expect(result.content).toEqual([{ type: "text", text: "remote" }]);
		expect(exec).toHaveBeenCalledWith("printf remote", cwd, expect.any(Object));
		expect(resolveShell).not.toHaveBeenCalled();
	});
});
