import { afterEach, describe, expect, it } from "vitest";

import {
	alwaysOnRunsLedgerPath,
	alwaysOnWorkItemsLedgerPath,
	createAlwaysOnTestHarness,
	createIsoSequenceClock,
	createSessionBackedRunExecutor,
	loadAlwaysOnAgentRegistryModule,
	loadAlwaysOnSupervisorModule,
	readJsonl,
} from "./fixtures/always-on-harness.js";

describe("always-on immediate send-to-run lifecycle (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("creates a durable work item, a durable run lifecycle, and a linked Mu session id for immediate work", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-send-run-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		const createdAgent = registry.createAgent({
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "low",
			timestamp: "2026-03-31T14:20:00.000Z",
		});

		const { createAlwaysOnSupervisor } = await loadAlwaysOnSupervisorModule();
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: createIsoSequenceClock([
				"2026-03-31T14:20:01.000Z",
				"2026-03-31T14:20:02.000Z",
				"2026-03-31T14:20:03.000Z",
			]),
			executeRun: createSessionBackedRunExecutor(harness.workspaceDir),
		});

		const submission = await supervisor.submitImmediateWork({ instruction: "Summarize the workspace README" });
		const drain = await supervisor.drainOnce();

		const workItems = supervisor.readWorkItems();
		expect(workItems).toHaveLength(1);
		expect(workItems[0]).toMatchObject({
			workItemId: submission.workItemId,
			agentId: createdAgent.agentId,
			instruction: "Summarize the workspace README",
			createdAt: "2026-03-31T14:20:01.000Z",
		});

		const runs = supervisor.readRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			workItemId: submission.workItemId,
			agentId: createdAgent.agentId,
			trigger: "manual",
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "low",
			startedAt: "2026-03-31T14:20:02.000Z",
			finishedAt: "2026-03-31T14:20:03.000Z",
			outcome: "completed",
		});
		expect(runs[0]?.sessionId).toMatch(/[0-9a-f-]{8,}/i);
		expect(drain.startedRuns[0]?.runId).toBe(runs[0]?.runId);

		const workItemFacts = readJsonl(alwaysOnWorkItemsLedgerPath(harness.configDir));
		expect(workItemFacts).toHaveLength(1);
		expect(workItemFacts[0]).toMatchObject({
			type: "work_item_created",
			workItemId: submission.workItemId,
			agentId: createdAgent.agentId,
			instruction: "Summarize the workspace README",
			timestamp: "2026-03-31T14:20:01.000Z",
		});

		const runFacts = readJsonl(alwaysOnRunsLedgerPath(harness.configDir));
		expect(runFacts).toHaveLength(2);
		expect(runFacts[0]).toMatchObject({
			type: "run_started",
			runId: runs[0]?.runId,
			workItemId: submission.workItemId,
			agentId: createdAgent.agentId,
			trigger: "manual",
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "low",
			sessionId: runs[0]?.sessionId,
			timestamp: "2026-03-31T14:20:02.000Z",
		});
		expect(runFacts[1]).toMatchObject({
			type: "run_finished",
			runId: runs[0]?.runId,
			outcome: "completed",
			timestamp: "2026-03-31T14:20:03.000Z",
		});
	});
});
