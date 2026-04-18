import { resolve } from "node:path";

import { createAlwaysOnAgentRegistry } from "./agent-registry.js";
import {
	type AlwaysOnExecutionTarget,
	type AlwaysOnRun,
	type AlwaysOnSchedule,
	type AlwaysOnSupervisorExecutionRequest,
	type AlwaysOnSupervisorStartedExecution,
	type AlwaysOnWorkItem,
	createAlwaysOnSupervisor,
	renderAlwaysOnThread,
} from "./supervisor.js";

export type AlwaysOnSubmissionSpec =
	| {
			kind: "immediate";
			instruction: string;
			agentId?: string;
			workspacePath?: string;
			executionTarget?: AlwaysOnExecutionTarget;
	  }
	| {
			kind: "once";
			instruction: string;
			at: string;
			agentId?: string;
			executionTarget?: AlwaysOnExecutionTarget;
	  }
	| {
			kind: "recurring";
			instruction: string;
			cron: string;
			timezone?: string;
			agentId?: string;
			executionTarget?: AlwaysOnExecutionTarget;
	  }
	| {
			kind: "follow_up";
			instruction: string;
			parentWorkItemId: string;
			agentId?: string;
			executionTarget?: AlwaysOnExecutionTarget;
	  };

export interface AlwaysOnServiceSnapshot {
	agents: ReturnType<ReturnType<typeof createAlwaysOnAgentRegistry>["readState"]>["agents"];
	globalDefaultAgentId: string | null;
	workItems: AlwaysOnWorkItem[];
	runs: AlwaysOnRun[];
}

export interface AlwaysOnService {
	readSnapshot(): AlwaysOnServiceSnapshot;
	readThread(runId: string): string;
	submit(spec: AlwaysOnSubmissionSpec): Promise<{ workItemId: string; runId?: string }>;
}

export function createAlwaysOnService(options: {
	baseDir?: string;
	clock?: () => string;
	executeRun: (request: AlwaysOnSupervisorExecutionRequest) => AlwaysOnSupervisorStartedExecution;
}): AlwaysOnService {
	const registry = createAlwaysOnAgentRegistry({ baseDir: options.baseDir });
	const supervisor = createAlwaysOnSupervisor({
		baseDir: options.baseDir,
		clock: options.clock,
		executeRun: options.executeRun,
	});

	const readSnapshot = (): AlwaysOnServiceSnapshot => {
		const state = registry.readState();
		return {
			agents: state.agents,
			globalDefaultAgentId: state.globalDefaultAgentId,
			workItems: supervisor.readWorkItems(),
			runs: supervisor.readRuns(),
		};
	};

	const resolveRunIdForWorkItem = (workItemId: string, startedRunId?: string): string | undefined => {
		if (startedRunId) {
			return startedRunId;
		}
		const latestRun = supervisor
			.readRuns()
			.filter((entry) => entry.workItemId === workItemId)
			.at(-1);
		return latestRun?.runId;
	};

	const scheduleFromSpec = (
		spec: Extract<AlwaysOnSubmissionSpec, { kind: "once" | "recurring" }>,
	): AlwaysOnSchedule => {
		if (spec.kind === "once") {
			return { kind: "once", at: spec.at };
		}
		return { kind: "recurring", cron: spec.cron, timezone: spec.timezone };
	};

	return {
		readSnapshot,

		readThread(runId: string): string {
			return renderAlwaysOnThread(options.baseDir, runId);
		},

		async submit(spec: AlwaysOnSubmissionSpec): Promise<{ workItemId: string; runId?: string }> {
			if (spec.kind === "immediate") {
				const submission = await supervisor.submitImmediateWork({
					agentId: spec.agentId,
					workspacePath: spec.workspacePath ? resolve(spec.workspacePath) : undefined,
					instruction: spec.instruction,
					executionTarget: spec.executionTarget,
				});
				const drain = await supervisor.drainOnce();
				return {
					workItemId: submission.workItemId,
					runId: resolveRunIdForWorkItem(
						submission.workItemId,
						drain.startedRuns.find((entry) => entry.workItemId === submission.workItemId)?.runId,
					),
				};
			}

			if (spec.kind === "once" || spec.kind === "recurring") {
				const scheduled = await supervisor.scheduleWork({
					agentId: spec.agentId,
					instruction: spec.instruction,
					schedule: scheduleFromSpec(spec),
					executionTarget: spec.executionTarget,
				});
				return { workItemId: scheduled.workItemId };
			}

			const followUp = await supervisor.createFollowUpWorkItem({
				workItemId: spec.parentWorkItemId,
				instruction: spec.instruction,
				executionTarget: spec.executionTarget,
			});
			const drain = await supervisor.drainOnce();
			return {
				workItemId: followUp.workItemId,
				runId: resolveRunIdForWorkItem(
					followUp.workItemId,
					drain.startedRuns.find((entry) => entry.workItemId === followUp.workItemId)?.runId,
				),
			};
		},
	};
}
