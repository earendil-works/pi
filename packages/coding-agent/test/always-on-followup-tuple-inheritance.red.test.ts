import { afterEach, describe, expect, it } from "vitest";

import {
	createAlwaysOnTestHarness,
	createControlledClock,
	createSessionBackedRunExecutor,
	loadAlwaysOnAgentRegistryModule,
	loadAlwaysOnSupervisorModule,
} from "./fixtures/always-on-harness.js";

describe("always-on follow-up execution-target inheritance (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("inherits the prior run's effective tuple when a follow-up omits an explicit override", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-followup-tuple-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		registry.createAgent({
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "low",
			timestamp: "2026-04-01T01:15:00.000Z",
		});

		const clock = createControlledClock("2026-04-01T01:15:00.000Z");
		const { createAlwaysOnSupervisor } = await loadAlwaysOnSupervisorModule();
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: clock.now,
			executeRun: createSessionBackedRunExecutor(harness.workspaceDir),
		});

		const initialSubmission = await supervisor.submitImmediateWork({
			instruction: "Run with a non-default effective tuple",
			executionTarget: {
				provider: "openai-codex",
				modelId: "gpt-5.4",
				thinkingLevel: "medium",
			},
		});
		await supervisor.drainOnce();

		const initialRun = supervisor.readRuns().find((run) => run.workItemId === initialSubmission.workItemId);
		expect(initialRun).toMatchObject({
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
		});

		const followUp = await supervisor.createFollowUpWorkItem({
			workItemId: initialSubmission.workItemId,
			instruction: "Follow up without restating the tuple",
		});
		await supervisor.drainOnce();

		const followUpWorkItem = supervisor.readWorkItems().find((item) => item.workItemId === followUp.workItemId);
		expect(followUpWorkItem?.executionTarget).toEqual({
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
		});

		const followUpRun = supervisor.readRuns().find((run) => run.workItemId === followUp.workItemId);
		expect(followUpRun).toMatchObject({
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
		});
	});
});
