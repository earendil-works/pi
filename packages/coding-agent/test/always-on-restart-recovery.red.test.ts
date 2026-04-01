import { afterEach, describe, expect, it } from "vitest";

import {
	alwaysOnRunsLedgerPath,
	createAlwaysOnTestHarness,
	createControlledClock,
	createSessionBackedRunExecutor,
	loadAlwaysOnAgentRegistryModule,
	loadAlwaysOnSupervisorModule,
	readJsonl,
	writeJsonl,
} from "./fixtures/always-on-harness.js";

describe("always-on restart recovery for scheduled work (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("marks an interrupted scheduled run abandoned and creates exactly one replacement run on restart", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-restart-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		const createdAgent = registry.createAgent({
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
			timestamp: "2026-04-01T00:00:00.000Z",
		});

		const clock = createControlledClock("2026-04-01T00:15:00.000Z");
		const { createAlwaysOnSupervisor } = await loadAlwaysOnSupervisorModule();
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: clock.now,
			executeRun: createSessionBackedRunExecutor(harness.workspaceDir),
		});

		const scheduled = await supervisor.scheduleWork({
			instruction: "Run every fifteen minutes",
			schedule: { kind: "recurring", cron: "*/15 * * * *", timezone: "UTC" },
		});

		writeJsonl(alwaysOnRunsLedgerPath(harness.configDir), [
			{
				type: "run_started",
				runId: "run-interrupted",
				workItemId: scheduled.workItemId,
				agentId: createdAgent.agentId,
				trigger: "schedule",
				scheduledOccurrenceKey: "2026-04-01T00:15:00.000Z",
				provider: "openai-codex",
				modelId: "gpt-5.4",
				thinkingLevel: "medium",
				sessionId: "session-interrupted",
				timestamp: "2026-04-01T00:15:00.000Z",
			},
		]);

		const restarted = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: clock.now,
			executeRun: createSessionBackedRunExecutor(harness.workspaceDir),
		});

		const recovery = await restarted.reconcileOnce();
		expect(recovery.startedRuns).toHaveLength(1);

		const runs = restarted.readRuns();
		expect(runs.find((run) => run.runId === "run-interrupted")).toMatchObject({
			outcome: "abandoned",
			scheduledOccurrenceKey: "2026-04-01T00:15:00.000Z",
		});

		const replacement = runs.find((run) => run.runId !== "run-interrupted");
		expect(replacement).toMatchObject({
			workItemId: scheduled.workItemId,
			trigger: "schedule",
			scheduledOccurrenceKey: "2026-04-01T00:15:00.000Z",
			outcome: "completed",
		});

		expect(
			runs.filter((run) => run.scheduledOccurrenceKey === "2026-04-01T00:15:00.000Z" && run.outcome === "completed"),
		).toHaveLength(1);
	});

	it("records run_started before scheduled execution begins so crash recovery has durable state", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-run-start-order-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		registry.createAgent({
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
			timestamp: "2026-04-01T00:00:00.000Z",
		});

		const clock = createControlledClock("2026-04-01T00:05:00.000Z");
		const { createAlwaysOnSupervisor } = await loadAlwaysOnSupervisorModule();
		let sawStartedFactDuringExecution = false;
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: clock.now,
			executeRun: () => ({
				sessionId: "session-started-before-execution",
				completion: Promise.resolve().then(() => {
					try {
						const facts = readJsonl(alwaysOnRunsLedgerPath(harness.configDir));
						sawStartedFactDuringExecution =
							facts.length > 0 &&
							JSON.stringify(facts[0]).includes('"type":"run_started"') &&
							JSON.stringify(facts[0]).includes('"scheduledOccurrenceKey":"2026-04-01T00:05:00.000Z"');
					} catch {
						sawStartedFactDuringExecution = false;
					}
					return {
						outcome: "completed",
					};
				}),
			}),
		});

		await supervisor.scheduleWork({
			instruction: "Run once with durable start",
			schedule: { kind: "once", at: "2026-04-01T00:05:00.000Z" },
		});

		await supervisor.reconcileOnce();
		expect(sawStartedFactDuringExecution).toBe(true);
	});
});
