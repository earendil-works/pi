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

interface RendererForSlashTests {
	stop(): void;
	getAllSlashCommands(): Array<{ name: string; description: string }>;
}

const workspacePath = "/Users/kennyfrc/Documents/code/work/pi-mono";

const idleTransport: AgentTransport = {
	async *run() {
		yield* [];
	},
};

async function makeRenderer(): Promise<{ renderer: RendererForSlashTests; cleanup: () => void }> {
	initTheme("dark");
	const baseDir = mkdtempSync(join(tmpdir(), "mu-agents-slash-red-"));
	const previousConfigDir = process.env.MU_CODING_AGENT_DIR;
	process.env.MU_CODING_AGENT_DIR = baseDir;

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
		transport: idleTransport,
		initialState: {
			model: getModel("openai-codex", "gpt-5.4"),
			thinkingLevel: "medium",
			tools: Object.values(allTools),
		},
	});

	const renderer = new TuiRenderer(agent, sessionManager, settingsManager, extensionManager, extensionLoader, "0.0.0");

	await renderer.init();

	return {
		renderer: renderer as unknown as RendererForSlashTests,
		cleanup() {
			renderer.stop();
			if (previousConfigDir === undefined) {
				delete process.env.MU_CODING_AGENT_DIR;
			} else {
				process.env.MU_CODING_AGENT_DIR = previousConfigDir;
			}
			rmSync(baseDir, { recursive: true, force: true });
		},
	};
}

describe("/agents slash command (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("registers an /agents command in the live TUI renderer", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		const commands = renderer.getAllSlashCommands();
		const names = commands.map((command) => command.name);

		expect(names).toContain("agents");
		expect(commands.find((command) => command.name === "agents")?.description).toMatch(/agent/i);
	});
});
