import { afterEach, describe, expect, it } from "vitest";

import {
	type AlwaysOnAgentRegistryModule,
	type AlwaysOnSupervisorModule,
	alwaysOnRunsLedgerPath,
	createAlwaysOnTestHarness,
	createControlledClock,
	createSessionBackedRunExecutor,
	loadAlwaysOnAgentRegistryModule,
	readJsonl,
} from "./fixtures/always-on-harness.js";

interface AlwaysOnServiceSnapshot {
	agents: Array<{ agentId: string }>;
	globalDefaultAgentId: string | null;
	workItems: Array<{ workItemId: string; instruction: string }>;
	runs: Array<{ runId: string; workItemId: string }>;
}

type AlwaysOnSubmissionSpec =
	| { kind: "immediate"; instruction: string; agentId?: string }
	| { kind: "once"; instruction: string; at: string; agentId?: string }
	| { kind: "follow_up"; instruction: string; parentWorkItemId: string; agentId?: string };

interface AlwaysOnService {
	readSnapshot(): AlwaysOnServiceSnapshot;
	submit(spec: AlwaysOnSubmissionSpec): Promise<{ workItemId: string; runId?: string }>;
}

interface AlwaysOnServiceModule {
	createAlwaysOnService(options: {
		baseDir: string;
		clock?: () => string;
		executeRun: Parameters<AlwaysOnSupervisorModule["createAlwaysOnSupervisor"]>[0]["executeRun"];
	}): AlwaysOnService;
}

async function loadAlwaysOnServiceModule(): Promise<AlwaysOnServiceModule> {
	try {
		return (await import("../src/always-on/service.js")) as AlwaysOnServiceModule;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Missing shared always-on service module: ${message}`);
	}
}

describe("always-on shared service (red)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("exposes one snapshot surface over the authoritative registry, work-item, and run ledgers", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-service-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = (await loadAlwaysOnAgentRegistryModule()) as AlwaysOnAgentRegistryModule;
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		const created = registry.createAgent({
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
			timestamp: "2026-04-09T14:00:00.000Z",
		});

		const { createAlwaysOnService } = await loadAlwaysOnServiceModule();
		const service = createAlwaysOnService({
			baseDir: harness.configDir,
			executeRun: createSessionBackedRunExecutor(harness.workspaceDir),
		});

		expect(service.readSnapshot()).toEqual({
			agents: [expect.objectContaining({ agentId: created.agentId })],
			globalDefaultAgentId: created.agentId,
			workItems: [],
			runs: [],
		});
	});

	it("submits immediate, one-off, and follow-up work through one primitive-oriented submit API", async () => {
		const harness = createAlwaysOnTestHarness("mu-always-on-service-submit-red-");
		cleanups.push(() => harness.cleanup());

		const { createAlwaysOnAgentRegistry } = (await loadAlwaysOnAgentRegistryModule()) as AlwaysOnAgentRegistryModule;
		const registry = createAlwaysOnAgentRegistry({ baseDir: harness.configDir });
		registry.createAgent({
			workspacePath: harness.workspaceDir,
			provider: "openai-codex",
			modelId: "gpt-5.4",
			thinkingLevel: "medium",
			timestamp: "2026-04-09T14:00:00.000Z",
		});

		const clock = createControlledClock("2026-04-09T14:00:00.000Z");
		const { createAlwaysOnService } = await loadAlwaysOnServiceModule();
		const service = createAlwaysOnService({
			baseDir: harness.configDir,
			clock: clock.now,
			executeRun: createSessionBackedRunExecutor(harness.workspaceDir),
		});

		const immediate = await service.submit({ kind: "immediate", instruction: "Summarize the README" });
		expect(immediate).toEqual({
			workItemId: expect.stringMatching(/^job-/),
			runId: expect.stringMatching(/^run-/),
		});

		const afterImmediate = service.readSnapshot();
		expect(afterImmediate.workItems).toEqual([
			expect.objectContaining({ workItemId: immediate.workItemId, instruction: "Summarize the README" }),
		]);
		expect(afterImmediate.runs).toEqual([
			expect.objectContaining({ runId: immediate.runId, workItemId: immediate.workItemId }),
		]);

		const once = await service.submit({
			kind: "once",
			instruction: "Run later",
			at: "2026-04-09T14:05:00.000Z",
		});
		expect(once).toEqual({ workItemId: expect.stringMatching(/^job-/) });

		clock.set("2026-04-09T14:05:00.000Z");
		const followUp = await service.submit({
			kind: "follow_up",
			instruction: "Continue the prior work",
			parentWorkItemId: immediate.workItemId,
		});
		expect(followUp).toEqual({
			workItemId: expect.stringMatching(/^job-/),
			runId: expect.stringMatching(/^run-/),
		});

		const runFacts = readJsonl(alwaysOnRunsLedgerPath(harness.configDir));
		expect(runFacts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "run_started", workItemId: immediate.workItemId }),
				expect.objectContaining({ type: "run_started", workItemId: followUp.workItemId }),
			]),
		);
	});
});
