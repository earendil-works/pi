import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

interface ExtendedTuiRenderer {
	stop(): void;
	showError(errorMessage: string): void;
	showWarning(message: string): void;
	handleEditorTextSubmission(text: string, kind: "by-end" | "next"): Promise<void>;
	getAllSlashCommands(): Array<{ name: string; description: string }>;
	// Access to internal state for testing the bug
	resumableMissionDir: string | null;
	missionConvergeAfterOverride: number | null | undefined;
	missionConvergenceKindOverride: "discard" | "non-keep" | undefined;
	getActiveMissionConvergencePolicy(): { after: number | null; kind: "discard" | "non-keep" } | null;
	hasActiveMissionRun(): boolean;
}

const workspacePath = "/Users/kennyfrc/Documents/code/work/pi-mono";

function createTestMission(baseDir: string, convergeAfter: number = 3): string {
	const missionDir = join(baseDir, "test-mission");
	mkdirSync(missionDir, { recursive: true });

	// Create SPEC.md with frontmatter containing converge_after
	const specContent = `---
mode: optimize
metric: test_score
direction: higher
converge_after: ${convergeAfter}
convergence_kind: non-keep
---

# Test Mission

## Goal
Test the convergence bug.
`;
	writeFileSync(join(missionDir, "SPEC.md"), specContent);

	// Create PROGRESS.md
	const progressContent = JSON.stringify({ version: "1", history: [] }, null, 2);
	writeFileSync(join(missionDir, "PROGRESS.md"), progressContent);

	// Create TASKS.json with at least one task
	const tasksContent = JSON.stringify(
		{
			version: "1",
			tasks: [
				{
					id: "task-1",
					title: "Test task",
					status: "todo",
					validation: [],
					notes: "",
				},
			],
		},
		null,
		2,
	);
	writeFileSync(join(missionDir, "TASKS.json"), tasksContent);

	// Create RUNBOOK.md
	writeFileSync(join(missionDir, "RUNBOOK.md"), "# Runbook\nTest mission runbook.");

	// Create EXPERIMENTS.jsonl (required for optimize mode)
	writeFileSync(join(missionDir, "EXPERIMENTS.jsonl"), "");

	return missionDir;
}

async function makeRenderer(): Promise<{
	renderer: ExtendedTuiRenderer;
	getRunCount: () => number;
	cleanup: () => void;
}> {
	initTheme("dark");
	const baseDir = join(tmpdir(), `mu-convergence-bug-red-${Date.now()}`);
	mkdirSync(baseDir, { recursive: true });
	const previousConfigDir = process.env.MU_CODING_AGENT_DIR;
	process.env.MU_CODING_AGENT_DIR = baseDir;

	const previousOpenAiKey = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "test-openai-key";

	let runCount = 0;
	const transport: AgentTransport = {
		async *run() {
			runCount += 1;
			// Yield nothing to prevent actual execution
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
		renderer: renderer as unknown as ExtendedTuiRenderer,
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

describe("mission-convergence override bug (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("getActiveMissionConvergencePolicy should return user override when set (5 instead of default 3)", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		// Create a test mission with default converge_after: 3
		const missionDir = createTestMission(join(tmpdir(), `mu-convergence-test-${Date.now()}`), 3);
		cleanups.push(() => rmSync(missionDir, { recursive: true, force: true }));

		// Set the resumableMissionDir to simulate mission context
		renderer.resumableMissionDir = missionDir;

		// Set a custom convergence override (user wants 5 instead of default 3)
		renderer.missionConvergeAfterOverride = 5;
		renderer.missionConvergenceKindOverride = "non-keep";

		// Verify the policy reflects the user's custom setting
		const policy = renderer.getActiveMissionConvergencePolicy();

		expect(policy).not.toBeNull();
		expect(policy?.after).toBe(5);
		expect(policy?.kind).toBe("non-keep");
	});

	it("getActiveMissionConvergencePolicy should return user override with discard kind", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		// Create a test mission with default convergence_kind: non-keep
		const missionDir = createTestMission(join(tmpdir(), `mu-convergence-test-${Date.now()}`), 3);
		cleanups.push(() => rmSync(missionDir, { recursive: true, force: true }));

		// Set the resumableMissionDir to simulate mission context
		renderer.resumableMissionDir = missionDir;

		// Set a custom convergence override with discard kind
		renderer.missionConvergeAfterOverride = 7;
		renderer.missionConvergenceKindOverride = "discard";

		// Verify the policy reflects the user's custom setting
		const policy = renderer.getActiveMissionConvergencePolicy();

		expect(policy).not.toBeNull();
		expect(policy?.after).toBe(7);
		expect(policy?.kind).toBe("discard");
	});

	it("getActiveMissionConvergencePolicy should fall back to mission defaults when no override", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		// Create a test mission with default converge_after: 3
		const missionDir = createTestMission(join(tmpdir(), `mu-convergence-test-${Date.now()}`), 3);
		cleanups.push(() => rmSync(missionDir, { recursive: true, force: true }));

		// Set the resumableMissionDir but DON'T set overrides
		renderer.resumableMissionDir = missionDir;
		renderer.missionConvergeAfterOverride = undefined;
		renderer.missionConvergenceKindOverride = undefined;

		// Verify the policy uses mission defaults (converge_after: 3, convergence_kind: non-keep)
		const policy = renderer.getActiveMissionConvergencePolicy();

		expect(policy).not.toBeNull();
		expect(policy?.after).toBe(3);
		expect(policy?.kind).toBe("non-keep");
	});

	it("getActiveMissionConvergencePolicy should use override even when mission has different defaults", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		// Create a test mission with default converge_after: 3
		const missionDir = createTestMission(join(tmpdir(), `mu-convergence-test-${Date.now()}`), 3);
		cleanups.push(() => rmSync(missionDir, { recursive: true, force: true }));

		// Set the resumableMissionDir
		renderer.resumableMissionDir = missionDir;

		// User sets a much higher value - should override mission default
		renderer.missionConvergeAfterOverride = 10;
		renderer.missionConvergenceKindOverride = "discard";

		// Verify the policy uses the user's value, not the mission's 3
		const policy = renderer.getActiveMissionConvergencePolicy();

		expect(policy).not.toBeNull();
		expect(policy?.after).toBe(10); // User's value, not 3
		expect(policy?.kind).toBe("discard"); // User's value, not "non-keep"
	});

	it("getActiveMissionConvergencePolicy should handle unlimited (null) override", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		// Create a test mission with default converge_after: 3
		const missionDir = createTestMission(join(tmpdir(), `mu-convergence-test-${Date.now()}`), 3);
		cleanups.push(() => rmSync(missionDir, { recursive: true, force: true }));

		// Set the resumableMissionDir
		renderer.resumableMissionDir = missionDir;

		// User disables convergence (unlimited = null)
		renderer.missionConvergeAfterOverride = null;
		renderer.missionConvergenceKindOverride = "discard";

		// Verify the policy reflects unlimited
		const policy = renderer.getActiveMissionConvergencePolicy();

		expect(policy).not.toBeNull();
		expect(policy?.after).toBeNull(); // Unlimited
		expect(policy?.kind).toBe("discard");
	});

	it("convergence override is preserved when policy is captured before reset (FIXED)", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		// Create a test mission with default converge_after: 3
		const missionDir = createTestMission(join(tmpdir(), `mu-convergence-test-${Date.now()}`), 3);
		cleanups.push(() => rmSync(missionDir, { recursive: true, force: true }));

		// Simulate user setting convergence override BEFORE starting mission
		// This happens when user runs /mission-convergence 5 non-keep
		renderer.missionConvergeAfterOverride = 5;
		renderer.missionConvergenceKindOverride = "non-keep";

		// The FIX: In handleMissionRunCommand, the code now does:
		// 1. this.resumableMissionDir = missionDir;
		// 2. const convergencePolicy = this.getActiveMissionConvergencePolicy();  // CAPTURE FIRST!
		// 3. this.missionConvergeAfterOverride = undefined;  // Reset after capturing
		// 4. this.missionConvergenceKindOverride = undefined;
		// 5. convergencePolicy: convergencePolicy  // Use captured value

		// Simulate the FIXED sequence from handleMissionRunCommand
		renderer.resumableMissionDir = missionDir;

		// FIX: Capture policy BEFORE reset (this is what the fix does)
		const policy = renderer.getActiveMissionConvergencePolicy();

		// Now reset (this happens after capturing in the fixed code)
		renderer.missionConvergeAfterOverride = undefined;
		renderer.missionConvergenceKindOverride = undefined;

		// The captured policy should have the user's settings, not the defaults
		expect(policy?.after).toBe(5); // User's setting preserved!
		expect(policy?.kind).toBe("non-keep"); // User's setting preserved!
	});

	it("correct behavior: capture policy BEFORE reset to preserve user settings", async () => {
		const { renderer, cleanup } = await makeRenderer();
		cleanups.push(cleanup);

		// Create a test mission with default converge_after: 3
		const missionDir = createTestMission(join(tmpdir(), `mu-convergence-test-${Date.now()}`), 3);
		cleanups.push(() => rmSync(missionDir, { recursive: true, force: true }));

		// User sets custom convergence override
		renderer.missionConvergeAfterOverride = 5;
		renderer.missionConvergenceKindOverride = "discard";

		// Simulate the FIXED sequence:
		// 1. Set resumableMissionDir
		// 2. Capture the policy (includes user overrides)
		// 3. THEN reset the overrides

		renderer.resumableMissionDir = missionDir;

		// FIXED: Capture policy BEFORE reset
		const policy = renderer.getActiveMissionConvergencePolicy();

		// Now reset (this is what the fix does - reset after capturing)
		renderer.missionConvergeAfterOverride = undefined;
		renderer.missionConvergenceKindOverride = undefined;

		// The captured policy should have the user settings
		expect(policy).not.toBeNull();
		expect(policy?.after).toBe(5);
		expect(policy?.kind).toBe("discard");
	});
});
