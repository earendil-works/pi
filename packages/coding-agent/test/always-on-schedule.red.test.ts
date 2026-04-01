import { afterEach, describe, expect, it } from "vitest";

import {
	alwaysOnRunsLedgerPath,
	createAlwaysOnTestHarness,
	createControlledClock,
	createSessionBackedRunExecutor,
	loadAlwaysOnAgentRegistryModule,
	loadAlwaysOnSupervisorModule,
	readJsonl,
} from "./fixtures/always-on-harness.js";

describe("always-on one-off scheduling (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("runs a one-off scheduled job exactly when reconciliation reaches the due timestamp", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-schedule-red-");
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

		const clock = createControlledClock("2026-04-01T00:00:00.000Z");
		const { createAlwaysOnSupervisor } = await loadAlwaysOnSupervisorModule();
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: clock.now,
			executeRun: createSessionBackedRunExecutor(harness.workspaceDir),
		});

		const scheduled = await supervisor.scheduleWork({
			instruction: "Run once when due",
			schedule: { kind: "once", at: "2026-04-01T00:05:00.000Z" },
		});

		expect(supervisor.readWorkItems()[0]).toMatchObject({
			workItemId: scheduled.workItemId,
			instruction: "Run once when due",
			schedule: { kind: "once", at: "2026-04-01T00:05:00.000Z" },
		});

		const beforeDue = await supervisor.reconcileOnce();
		expect(beforeDue.startedRuns).toHaveLength(0);

		clock.set("2026-04-01T00:05:00.000Z");
		const due = await supervisor.reconcileOnce();
		expect(due.startedRuns).toHaveLength(1);
		expect(due.startedRuns[0]).toMatchObject({
			workItemId: scheduled.workItemId,
			trigger: "schedule",
			scheduledOccurrenceKey: "2026-04-01T00:05:00.000Z",
		});

		expect(readJsonl(alwaysOnRunsLedgerPath(harness.configDir))[0]).toMatchObject({
			type: "run_started",
			trigger: "schedule",
			scheduledOccurrenceKey: "2026-04-01T00:05:00.000Z",
		});
	});
});
