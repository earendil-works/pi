import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

interface MissionResetRenderer {
	stop(): void;
	showError(errorMessage: string): void;
	showWarning(message: string): void;
	handleEditorTextSubmission(text: string, kind: "by-end" | "next"): Promise<void>;
	getAllSlashCommands(): Array<{ name: string; description: string }>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(__dirname, "fixtures", "mission-reset-control-event");
const workspacePath = "/Users/kennyfrc/Documents/code/work/pi-mono";

function copyFixtureMission(name: string): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), `mu-mission-reset-command-${name}-`));
	cpSync(join(fixtureRoot, name), dir, { recursive: true });
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

async function makeRenderer(): Promise<{
	renderer: MissionResetRenderer;
	getRunCount: () => number;
	cleanup: () => void;
}> {
	initTheme("dark");
	const baseDir = mkdtempSync(join(tmpdir(), "mu-mission-reset-command-red-"));
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
		renderer: renderer as unknown as MissionResetRenderer,
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

describe("/mission-reset slash command (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("registers /mission-reset in the live TUI renderer", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const commands = renderer.getAllSlashCommands();
		const names = commands.map((command) => command.name);

		expect(names).toContain("mission-reset");
		expect(commands.find((command) => command.name === "mission-reset")?.description).toMatch(/reset|resume/i);
	});

	it("shows usage for /mission-reset without a path and does not fall through to normal chat", async () => {
		const { renderer, getRunCount, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const errors: string[] = [];
		const originalShowError = renderer.showError.bind(renderer);
		renderer.showError = (message: string) => {
			errors.push(message);
			originalShowError(message);
		};

		await renderer.handleEditorTextSubmission("/mission-reset", "by-end");

		expect(getRunCount()).toBe(0);
		expect(errors).toContain("Usage: /mission-reset <mission-path>");
	});

	it("appends a resume-reset control event for an optimize mission and confirms the resolved path", async () => {
		const { dir, cleanup: cleanupFixture } = copyFixtureMission("optimize-converged");
		cleanups.push(cleanupFixture);

		const { renderer, getRunCount, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const warnings: string[] = [];
		const errors: string[] = [];
		const originalShowWarning = renderer.showWarning.bind(renderer);
		const originalShowError = renderer.showError.bind(renderer);
		renderer.showWarning = (message: string) => {
			warnings.push(message);
			originalShowWarning(message);
		};
		renderer.showError = (message: string) => {
			errors.push(message);
			originalShowError(message);
		};

		await renderer.handleEditorTextSubmission(`/mission-reset ${dir}`, "by-end");

		expect(getRunCount()).toBe(0);
		expect(errors).toEqual([]);
		expect(warnings.join("\n")).toContain("Mission reset appended.");
		expect(warnings.join("\n")).toContain(`Resolved path: ${dir}`);
		expect(warnings.join("\n")).toContain("Event: resume-reset");
		expect(warnings.join("\n")).toContain(`/mission-resume ${dir}`);

		const lines = readFileSync(join(dir, "EXPERIMENTS.jsonl"), "utf8").trim().split("\n");
		const appended = JSON.parse(lines[lines.length - 1] ?? "{}");
		expect(appended).toMatchObject({
			type: "control",
			kind: "resume-reset",
			note: "Manual resume reset",
		});
		expect(typeof appended.timestamp).toBe("number");
	});

	it("rejects build-mode missions clearly", async () => {
		const { dir, cleanup: cleanupFixture } = copyFixtureMission("build-reject");
		cleanups.push(cleanupFixture);

		const { renderer, getRunCount, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const errors: string[] = [];
		const originalShowError = renderer.showError.bind(renderer);
		renderer.showError = (message: string) => {
			errors.push(message);
			originalShowError(message);
		};

		await renderer.handleEditorTextSubmission(`/mission-reset ${dir}`, "by-end");

		expect(getRunCount()).toBe(0);
		expect(errors.join("\n")).toMatch(/optimize missions/i);
	});

	it("rejects malformed experiment history clearly", async () => {
		const { dir, cleanup: cleanupFixture } = copyFixtureMission("optimize-converged");
		cleanups.push(cleanupFixture);
		writeFileSync(join(dir, "EXPERIMENTS.jsonl"), '{"run":1,"status":"discard"}\nnot-json\n');

		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const errors: string[] = [];
		const originalShowError = renderer.showError.bind(renderer);
		renderer.showError = (message: string) => {
			errors.push(message);
			originalShowError(message);
		};

		await renderer.handleEditorTextSubmission(`/mission-reset ${dir}`, "by-end");

		expect(errors.join("\n")).toMatch(/malformed json/i);
	});
});
