import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	alwaysOnRunsLedgerPath,
	createAlwaysOnTestHarness,
	createIsoSequenceClock,
	loadAlwaysOnAgentRegistryModule,
	loadAlwaysOnSupervisorModule,
	readJsonl,
} from "./fixtures/always-on-harness.js";

describe("always-on supervisor wake and failure handling (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("wakes on newly accepted work and records an error outcome when execution fails", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-supervisor-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		const createdAgent = registry.createAgent({
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
			timestamp: "2026-03-31T14:21:00.000Z",
		});

		const missingWorkspace = join(harness.rootDir, "missing-workspace");
		const wakes: string[] = [];

		const { createAlwaysOnSupervisor } = await loadAlwaysOnSupervisorModule();
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: createIsoSequenceClock([
				"2026-03-31T14:21:01.000Z",
				"2026-03-31T14:21:02.000Z",
				"2026-03-31T14:21:03.000Z",
			]),
			onWake: (reason) => wakes.push(reason),
			executeRun: () => ({
				sessionId: "failed-session-id",
				completion: Promise.resolve({
					outcome: "error",
					errorMessage: `Workspace path does not exist: ${missingWorkspace}`,
				}),
			}),
		});

		await supervisor.submitImmediateWork({
			instruction: "Attempt work in a missing workspace",
			workspacePath: missingWorkspace,
		});
		expect(wakes).toContain("new_work");

		await supervisor.drainOnce();

		const runs = supervisor.readRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			agentId: createdAgent.agentId,
			trigger: "manual",
			outcome: "error",
			sessionId: "failed-session-id",
		});

		const runFacts = readJsonl(alwaysOnRunsLedgerPath(harness.configDir));
		expect(runFacts[0]).toMatchObject({
			type: "run_started",
			agentId: createdAgent.agentId,
			sessionId: "failed-session-id",
			timestamp: "2026-03-31T14:21:02.000Z",
		});
		expect(runFacts[1]).toMatchObject({
			type: "run_finished",
			outcome: "error",
			errorMessage: `Workspace path does not exist: ${missingWorkspace}`,
			timestamp: "2026-03-31T14:21:03.000Z",
		});
	});
});
