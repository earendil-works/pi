import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTransport } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it } from "vitest";

import { ExtensionLoader } from "../src/extensions/loader.js";
import { ExtensionManager } from "../src/extensions/manager.js";
import { SessionManager } from "../src/session-manager.js";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { allTools } from "../src/tools/index.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

interface MissionControlRenderer {
	stop(): void;
	showError(errorMessage: string): void;
	showWarning(message: string): void;
	handleEditorTextSubmission(text: string, kind: "by-end" | "next"): Promise<void>;
	getAllSlashCommands(): Array<{ name: string; description: string }>;
}

const workspacePath = "/Users/kennyfrc/Documents/code/work/pi-mono";

async function makeRenderer(): Promise<{
	renderer: MissionControlRenderer;
	getRunCount: () => number;
	cleanup: () => void;
}> {
	initTheme("dark");
	const baseDir = mkdtempSync(join(tmpdir(), "mu-mission-control-slash-red-"));
	const previousConfigDir = process.env.MU_CODING_AGENT_DIR;
	process.env.MU_CODING_AGENT_DIR = baseDir;

	const previousOpenAiKey = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "test-openai-key";

	let runCount = 0;
	const transport: AgentTransport = {
		async *run() {
			runCount += 1;
			yield* [];
		},
	};

	const sessionManager = new SessionManager(false, undefined, false, workspacePath);
	const settingsManager = new SettingsManager(baseDir);
	const extensionManager = new ExtensionManager({
		builtInTools: allTools as never,
		sessionManager,
	});
	const extensionLoader = new ExtensionLoader(extensionManager, {
		projectDir: workspacePath,
		configDir: baseDir,
	});
	const agent = new Agent({
		transport,
		initialState: {
			model: getModel("openai", "gpt-4o-mini"),
			thinkingLevel: "medium",
			tools: Object.values(allTools),
		},
	});

	const renderer = new TuiRenderer(agent, sessionManager, settingsManager, extensionManager, extensionLoader, "0.0.0");
	await renderer.init();

	return {
		renderer: renderer as unknown as MissionControlRenderer,
		getRunCount: () => runCount,
		cleanup() {
			renderer.stop();
			if (previousConfigDir === undefined) {
				delete process.env.MU_CODING_AGENT_DIR;
			} else {
				process.env.MU_CODING_AGENT_DIR = previousConfigDir;
			}
			if (previousOpenAiKey === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previousOpenAiKey;
			}
			rmSync(baseDir, { recursive: true, force: true });
		},
	};
}

describe("mission control slash commands (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("registers /mission-halt and /mission-iterations in the live TUI renderer", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const commands = renderer.getAllSlashCommands();
		const names = commands.map((command) => command.name);

		expect(names).toContain("mission-halt");
		expect(names).toContain("mission-iterations");
		expect(commands.find((command) => command.name === "mission-halt")?.description).toMatch(/stop|halt/i);
		expect(commands.find((command) => command.name === "mission-iterations")?.description).toMatch(/iteration/i);
	});

	it("registers /mission-convergence in the live TUI renderer", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const commands = renderer.getAllSlashCommands();
		const names = commands.map((command) => command.name);

		expect(names).toContain("mission-convergence");
		expect(commands.find((command) => command.name === "mission-convergence")?.description).toMatch(
			/conver|streak|non-keep/i,
		);
	});

	it("registers /campaign-run, /campaign-exit, and /mission-exit in the live TUI renderer", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const commands = renderer.getAllSlashCommands();
		const names = commands.map((command) => command.name);

		expect(names).toContain("campaign-run");
		expect(names).toContain("campaign-exit");
		expect(names).toContain("mission-exit");
		expect(commands.find((command) => command.name === "campaign-run")?.description).toMatch(/campaign/i);
		expect(commands.find((command) => command.name === "campaign-exit")?.description).toMatch(/exit|leave|stop/i);
		expect(commands.find((command) => command.name === "mission-exit")?.description).toMatch(/exit|leave|stop/i);
	});

	it("handles /mission-halt as a built-in command instead of falling through to normal chat submission", async () => {
		const { renderer, getRunCount, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const errors: string[] = [];
		const warnings: string[] = [];
		const originalShowError = renderer.showError.bind(renderer);
		const originalShowWarning = renderer.showWarning.bind(renderer);
		renderer.showError = (message: string) => {
			errors.push(message);
			originalShowError(message);
		};
		renderer.showWarning = (message: string) => {
			warnings.push(message);
			originalShowWarning(message);
		};

		await renderer.handleEditorTextSubmission("/mission-halt", "by-end");

		expect(getRunCount()).toBe(0);
		expect(errors).toEqual([]);
		expect(warnings.join("\n")).toMatch(/no active mission/i);
	});

	it("handles /mission-iterations 3 as a built-in command instead of falling through to normal chat submission", async () => {
		const { renderer, getRunCount, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const errors: string[] = [];
		const warnings: string[] = [];
		const originalShowError = renderer.showError.bind(renderer);
		const originalShowWarning = renderer.showWarning.bind(renderer);
		renderer.showError = (message: string) => {
			errors.push(message);
			originalShowError(message);
		};
		renderer.showWarning = (message: string) => {
			warnings.push(message);
			originalShowWarning(message);
		};

		await renderer.handleEditorTextSubmission("/mission-iterations 3", "by-end");

		expect(getRunCount()).toBe(0);
		expect(errors).toEqual([]);
		expect(warnings.join("\n")).toMatch(/no active mission/i);
	});

	it("handles /mission-convergence status as a built-in command instead of falling through to normal chat submission", async () => {
		const { renderer, getRunCount, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const errors: string[] = [];
		const warnings: string[] = [];
		const originalShowError = renderer.showError.bind(renderer);
		const originalShowWarning = renderer.showWarning.bind(renderer);
		renderer.showError = (message: string) => {
			errors.push(message);
			originalShowError(message);
		};
		renderer.showWarning = (message: string) => {
			warnings.push(message);
			originalShowWarning(message);
		};

		await renderer.handleEditorTextSubmission("/mission-convergence status", "by-end");

		expect(getRunCount()).toBe(0);
		expect(errors).toEqual([]);
		expect(warnings.join("\n")).toMatch(/no active mission|no active optimize mission/i);
	});

	it("handles /mission-exit as a built-in command instead of falling through to normal chat submission", async () => {
		const { renderer, getRunCount, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const errors: string[] = [];
		const warnings: string[] = [];
		const originalShowError = renderer.showError.bind(renderer);
		const originalShowWarning = renderer.showWarning.bind(renderer);
		renderer.showError = (message: string) => {
			errors.push(message);
			originalShowError(message);
		};
		renderer.showWarning = (message: string) => {
			warnings.push(message);
			originalShowWarning(message);
		};

		await renderer.handleEditorTextSubmission("/mission-exit", "by-end");

		expect(getRunCount()).toBe(0);
		expect(errors).toEqual([]);
		expect(warnings.join("\n")).toMatch(/no active mission/i);
	});

	it("handles /campaign-exit as a built-in command instead of falling through to normal chat submission", async () => {
		const { renderer, getRunCount, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const errors: string[] = [];
		const warnings: string[] = [];
		const originalShowError = renderer.showError.bind(renderer);
		const originalShowWarning = renderer.showWarning.bind(renderer);
		renderer.showError = (message: string) => {
			errors.push(message);
			originalShowError(message);
		};
		renderer.showWarning = (message: string) => {
			warnings.push(message);
			originalShowWarning(message);
		};

		await renderer.handleEditorTextSubmission("/campaign-exit", "by-end");

		expect(getRunCount()).toBe(0);
		expect(errors).toEqual([]);
		expect(warnings.join("\n")).toMatch(/no active campaign/i);
	});
});
