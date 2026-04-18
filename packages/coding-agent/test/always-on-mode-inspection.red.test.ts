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

type InspectionRenderer = {
	init(): Promise<void>;
	stop(): void;
	getAllSlashCommands(): Array<{ name: string; description: string }>;
	handleEditorTextSubmission(text: string, kind: "by-end" | "next"): Promise<void>;
	alwaysOnService?: {
		readSnapshot(): {
			agents: Array<{ agentId: string }>;
			globalDefaultAgentId: string | null;
			workItems: Array<{ workItemId: string; instruction: string }>;
			runs: Array<{ runId: string; workItemId: string }>;
		};
		submit(spec: { kind: "immediate"; instruction: string }): Promise<{ workItemId: string; runId?: string }>;
	};
	onInputCallback?: (text: string) => void;
};

const workspacePath = "/Users/kennyfrc/Documents/code/work/pi-mono-kenn-dev";

const idleTransport: AgentTransport = {
	async *run() {
		yield* [];
	},
};

async function makeSlashRenderer(): Promise<{ renderer: InspectionRenderer; cleanup: () => void }> {
	initTheme("dark");
	const baseDir = mkdtempSync(join(tmpdir(), "mu-always-on-inspection-surface-red-"));
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
		renderer: renderer as unknown as InspectionRenderer,
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

function createExtensionManagerStub() {
	return {
		listCommands: () => [],
		getCommand: () => undefined,
		getIndicators: () => [],
		applyInputHooks: async (text: string) => ({ handled: false, text }),
		composeToolResultTransformer: <T>(base: T) => base,
	};
}

describe("always-on inspection surface (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("registers the inspection and agent-selection slash commands in the live slash surface", async () => {
		const { renderer, cleanup } = await makeSlashRenderer();
		cleanups.push(cleanup);

		const names = renderer.getAllSlashCommands().map((command) => command.name);
		expect(names).toEqual(
			expect.arrayContaining(["always-on-agent", "always-on-jobs", "always-on-runs", "always-on-thread"]),
		);
	});

	it("handles /always-on-jobs as an inspection command instead of submitting a new immediate job", async () => {
		initTheme("dark");
		const configDir = mkdtempSync(join(tmpdir(), "mu-always-on-inspection-red-"));
		cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

		const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-openai-key";
		cleanups.push(() => {
			if (previousOpenAiApiKey === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previousOpenAiApiKey;
			}
		});

		const agent = new Agent({
			transport: {
				async *run() {
					yield* [];
				},
			} as never,
			initialState: {
				model: getModel("openai", "gpt-4o-mini"),
				thinkingLevel: "medium",
			},
		});

		const renderer = new TuiRenderer(
			agent,
			{
				appendContextCompaction: () => {},
				loadTitle: () => null,
				getSessionId: () => "always-on-inspection-red",
				reset: () => {},
			} as never,
			new SettingsManager(configDir),
			createExtensionManagerStub() as never,
			{} as never,
			"0.0.0",
		) as unknown as InspectionRenderer;

		await renderer.init();
		cleanups.push(() => renderer.stop());

		const normalChatSubmissions: string[] = [];
		const immediateSubmissions: Array<{ kind: "immediate"; instruction: string }> = [];
		let readSnapshotCalls = 0;
		renderer.onInputCallback = (text: string) => {
			normalChatSubmissions.push(text);
		};
		renderer.alwaysOnService = {
			readSnapshot: () => {
				readSnapshotCalls += 1;
				return {
					agents: [{ agentId: "ao-red" }],
					globalDefaultAgentId: "ao-red",
					workItems: [{ workItemId: "job-red", instruction: "Inspect jobs" }],
					runs: [{ runId: "run-red", workItemId: "job-red" }],
				};
			},
			submit: async (spec) => {
				immediateSubmissions.push(spec);
				return { workItemId: "job-red", runId: "run-red" };
			},
		};

		await renderer.handleEditorTextSubmission("/always-on", "by-end");
		await renderer.handleEditorTextSubmission("/always-on-jobs", "by-end");

		expect(readSnapshotCalls).toBe(1);
		expect(immediateSubmissions).toEqual([]);
		expect(normalChatSubmissions).toEqual([]);
	});
});
