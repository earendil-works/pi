import { afterEach, describe, expect, it, vi } from "vitest";

import {
	alwaysOnWorkItemsLedgerPath,
	createAlwaysOnTestHarness,
	createControlledClock,
	createSessionBackedRunExecutor,
	loadAlwaysOnAgentRegistryModule,
	loadAlwaysOnSupervisorModule,
	writeJsonl,
} from "./fixtures/always-on-harness.js";

describe("always-on reconciliation tick and recurrence catch-up (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		vi.useRealTimers();
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("runs only the latest missed recurring occurrence when reconciliation catches up after downtime", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-reconcile-red-");
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

		await supervisor.scheduleWork({
			instruction: "Run every five minutes",
			schedule: { kind: "recurring", cron: "*/5 * * * *", timezone: "UTC" },
		});

		clock.set("2026-04-01T00:17:00.000Z");
		const catchUp = await supervisor.reconcileOnce();
		expect(catchUp.startedRuns).toHaveLength(1);
		expect(catchUp.startedRuns[0]).toMatchObject({
			trigger: "schedule",
			scheduledOccurrenceKey: "2026-04-01T00:15:00.000Z",
		});

		const secondTick = await supervisor.reconcileOnce();
		expect(secondTick.startedRuns).toHaveLength(0);
		expect(
			supervisor.readRuns().filter((run) => run.scheduledOccurrenceKey === "2026-04-01T00:15:00.000Z"),
		).toHaveLength(1);
	});

	it("runs due scheduled work from a periodic wake loop without a human CLI read command", async () => {
		vi.useFakeTimers();

		const harness = createAlwaysOnTestHarness("mu-always-on-periodic-tick-red-");
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
		const wakes: string[] = [];
		const { createAlwaysOnSupervisor } = await loadAlwaysOnSupervisorModule();
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: clock.now,
			onWake: (reason) => wakes.push(reason),
			executeRun: createSessionBackedRunExecutor(harness.workspaceDir),
		});

		await supervisor.scheduleWork({
			instruction: "Wake-loop one-off",
			schedule: { kind: "once", at: "2026-04-01T00:01:00.000Z" },
		});

		supervisor.startWakeLoop({ tickMs: 1000 });
		clock.set("2026-04-01T00:01:00.000Z");
		await vi.advanceTimersByTimeAsync(1000);

		const runs = supervisor.readRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			trigger: "schedule",
			scheduledOccurrenceKey: "2026-04-01T00:01:00.000Z",
			outcome: "completed",
		});
		expect(wakes).toContain("new_work");
		expect(wakes).toContain("tick");

		await supervisor.stopWakeLoop();
	});

	it("keeps exactly one latest follow-on recurring occurrence queued while the current run is still active", async () => {
		vi.useFakeTimers();

		const harness = createAlwaysOnTestHarness("mu-always-on-overlap-red-");
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
		let callCount = 0;
		let resolveFirstRun: ((value: { outcome: "completed" }) => void) | undefined;
		const firstRunCompletion = new Promise<{ outcome: "completed" }>((resolve) => {
			resolveFirstRun = resolve;
		});

		const { createAlwaysOnSupervisor } = await loadAlwaysOnSupervisorModule();
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: clock.now,
			executeRun: () => {
				callCount += 1;
				return {
					sessionId: `session-${callCount}`,
					completion: callCount === 1 ? firstRunCompletion : Promise.resolve({ outcome: "completed" }),
				};
			},
		});

		await supervisor.scheduleWork({
			instruction: "Recurring overlap",
			schedule: { kind: "recurring", cron: "*/5 * * * *", timezone: "UTC" },
		});

		supervisor.startWakeLoop({ tickMs: 1000 });

		clock.set("2026-04-01T00:05:00.000Z");
		await vi.advanceTimersByTimeAsync(1000);
		expect(supervisor.readRuns()).toHaveLength(1);
		expect(supervisor.readRuns()[0]).toMatchObject({
			scheduledOccurrenceKey: "2026-04-01T00:05:00.000Z",
		});
		expect(supervisor.readRuns()[0]?.finishedAt).toBeUndefined();

		clock.set("2026-04-01T00:17:00.000Z");
		await vi.advanceTimersByTimeAsync(2000);
		expect(supervisor.readRuns()).toHaveLength(1);

		if (!resolveFirstRun) {
			throw new Error("Expected first recurring run resolver to be available");
		}
		resolveFirstRun({ outcome: "completed" });
		await vi.advanceTimersByTimeAsync(1000);

		const runs = supervisor.readRuns();
		expect(runs).toHaveLength(2);
		expect(runs.map((run) => run.scheduledOccurrenceKey)).toEqual([
			"2026-04-01T00:05:00.000Z",
			"2026-04-01T00:15:00.000Z",
		]);
		expect(runs.filter((run) => run.scheduledOccurrenceKey === "2026-04-01T00:10:00.000Z")).toHaveLength(0);

		await supervisor.stopWakeLoop();
	});

	it("wakes a running supervisor from external work-items ledger appends without waiting for the next tick", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-file-watch-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		registry.createAgent({
			agentId: "watch-agent",
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
			timestamp: "2026-04-01T00:00:00.000Z",
		});

		const clock = createControlledClock("2026-04-01T00:01:00.000Z");
		const { createAlwaysOnSupervisor } = await loadAlwaysOnSupervisorModule();
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: clock.now,
			executeRun: createSessionBackedRunExecutor(harness.workspaceDir),
		});

		supervisor.startWakeLoop({ tickMs: 60_000 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(supervisor.readRuns()).toHaveLength(0);

		writeJsonl(alwaysOnWorkItemsLedgerPath(harness.configDir), [
			{
				type: "work_item_created",
				workItemId: "job-watch",
				agentId: "watch-agent",
				instruction: "Wake from file watch",
				schedule: { kind: "once", at: "2026-04-01T00:01:00.000Z" },
				timestamp: "2026-04-01T00:00:00.000Z",
			},
		]);

		const deadline = Date.now() + 500;
		while (supervisor.readRuns().length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		expect(supervisor.readRuns()).toHaveLength(1);
		expect(supervisor.readRuns()[0]).toMatchObject({
			workItemId: "job-watch",
			trigger: "schedule",
			scheduledOccurrenceKey: "2026-04-01T00:01:00.000Z",
		});

		await supervisor.stopWakeLoop();
	});
});
