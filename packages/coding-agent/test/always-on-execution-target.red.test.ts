import { afterEach, describe, expect, it } from "vitest";

import {
	type AlwaysOnSupervisorExecutionRequest,
	alwaysOnWorkItemsLedgerPath,
	createAlwaysOnTestHarness,
	createIsoSequenceClock,
	createSessionBackedRunExecutor,
	loadAlwaysOnAgentRegistryModule,
	loadAlwaysOnSupervisorModule,
	readJsonl,
} from "./fixtures/always-on-harness.js";

describe("always-on execution-target override precedence (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("uses the work-item override tuple instead of the stored agent default for the resulting run", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-execution-target-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = await loadAlwaysOnAgentRegistryModule();
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		registry.createAgent({
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "low",
			timestamp: "2026-03-31T14:22:00.000Z",
		});

		const captured: AlwaysOnSupervisorExecutionRequest[] = [];
		const baseExecutor = createSessionBackedRunExecutor(harness.workspaceDir);

		const { createAlwaysOnSupervisor } = await loadAlwaysOnSupervisorModule();
		const supervisor = createAlwaysOnSupervisor({
			baseDir: harness.configDir,
			clock: createIsoSequenceClock([
				"2026-03-31T14:22:01.000Z",
				"2026-03-31T14:22:02.000Z",
				"2026-03-31T14:22:03.000Z",
			]),
			executeRun: (request) => {
				captured.push(request);
				return baseExecutor(request);
			},
		});

		await supervisor.submitImmediateWork({
			instruction: "Run with a non-default thinking override",
			executionTarget: {
				provider: "openai-codex",
				modelId: "gpt-5.4",
				thinkingLevel: "medium",
			},
		});
		await supervisor.drainOnce();

		expect(captured).toHaveLength(1);
		expect(captured[0]?.effectiveTarget).toEqual({
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
		});
		expect(supervisor.readWorkItems()[0]?.executionTarget).toEqual({
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
		});
		expect(supervisor.readRuns()[0]).toMatchObject({
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
		});

		const workItemFacts = readJsonl(alwaysOnWorkItemsLedgerPath(harness.configDir));
		expect(workItemFacts[0]).toMatchObject({
			type: "work_item_created",
			executionTarget: {
				provider: "openai-codex",
				modelId: "gpt-5.4",
				thinkingLevel: "medium",
			},
		});
	});
});
