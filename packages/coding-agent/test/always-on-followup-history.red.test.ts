import { afterEach, describe, expect, it } from "vitest";

import {
	createAlwaysOnTestHarness,
	createControlledClock,
	createTranscriptedRunExecutor,
	loadAlwaysOnAgentRegistryModule,
	loadAlwaysOnSupervisorModule,
} from "./fixtures/always-on-harness.js";

describe("always-on follow-up history and thread inspection (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("creates a linked follow-up work item and exposes lineage in jobs/runs inspection", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-followup-history-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		registry.createAgent({
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "low",
			timestamp: "2026-04-01T01:00:00.000Z",
		});

		const clock = createControlledClock("2026-04-01T01:00:00.000Z");
		const { createAlwaysOnSupervisor, renderAlwaysOnJobs, renderAlwaysOnRuns } = await loadAlwaysOnSupervisorModule();
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: clock.now,
			executeRun: createTranscriptedRunExecutor(harness.workspaceDir, {
				userText: "Initial work",
				assistantText: "Initial answer",
			}),
		});

		const initialSubmission = await supervisor.submitImmediateWork({
			instruction: "Investigate the current workspace",
			executionTarget: {
				provider: "openai-codex",
				modelId: "gpt-5.4",
				thinkingLevel: "medium",
			},
		});
		await supervisor.drainOnce();

		const initialRun = supervisor.readRuns().find((run) => run.workItemId === initialSubmission.workItemId);
		expect(initialRun).toBeDefined();

		const followUp = await supervisor.createFollowUpWorkItem({
			workItemId: initialSubmission.workItemId,
			instruction: "Continue from that run and inspect the failing edge case",
		});
		await supervisor.drainOnce();

		const followUpWorkItem = supervisor.readWorkItems().find((item) => item.workItemId === followUp.workItemId);
		expect(followUpWorkItem).toMatchObject({
			workItemId: followUp.workItemId,
			relatedWorkItemIds: [initialSubmission.workItemId],
			relatedSessionIds: [initialRun?.sessionId],
		});

		const jobsText = renderAlwaysOnJobs(harness.configDir);
		expect(jobsText).toContain(followUp.workItemId);
		expect(jobsText).toContain(initialSubmission.workItemId);
		expect(jobsText.toLowerCase()).toContain("follow-up");

		const runsText = renderAlwaysOnRuns(harness.configDir, followUp.workItemId);
		expect(runsText).toContain(followUp.workItemId);
		expect(runsText).toContain(initialSubmission.workItemId);
		expect(runsText).toContain(initialRun?.sessionId ?? "missing-session-id");
	});

	it("renders a run-linked thread inspection surface using the Mu session transcript", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-thread-surface-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		registry.createAgent({
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
			timestamp: "2026-04-01T01:05:00.000Z",
		});

		const clock = createControlledClock("2026-04-01T01:05:00.000Z");
		const { createAlwaysOnSupervisor, renderAlwaysOnThread } = await loadAlwaysOnSupervisorModule();
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: clock.now,
			executeRun: createTranscriptedRunExecutor(harness.workspaceDir, {
				userText: "Thread-linked prompt",
				assistantText: "Thread-linked response",
			}),
		});

		const submission = await supervisor.submitImmediateWork({
			instruction: "Create a run with readable transcript",
		});
		await supervisor.drainOnce();

		const run = supervisor.readRuns().find((entry) => entry.workItemId === submission.workItemId);
		expect(run).toBeDefined();

		const threadText = renderAlwaysOnThread(harness.configDir, run?.runId ?? "missing-run-id");
		expect(threadText).toContain(run?.runId ?? "missing-run-id");
		expect(threadText).toContain(run?.sessionId ?? "missing-session-id");
		expect(threadText).toContain("Thread-linked prompt");
		expect(threadText).toContain("Thread-linked response");
	});
});
