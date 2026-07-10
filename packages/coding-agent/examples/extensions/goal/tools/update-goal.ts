/**
 * update_goal Tool — Mark goal as complete or blocked
 *
 * Agent calls this to signal completion or a blocking condition.
 * The tool description includes behavioral rules from the PRD.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { GoalMode } from "../goal-mode.ts";

const UpdateGoalStatus = StringEnum(["complete", "blocked"] as const, {
	description:
		"New goal status. 'complete' = objective achieved, 'blocked' = cannot proceed due to external dependency.",
});

const UpdateGoalParams = Type.Object({
	status: UpdateGoalStatus,
	reason: Type.Optional(
		Type.String({
			description:
				"Explanation for the status change. For 'complete': what was achieved. " +
					"For 'blocked': what external condition is blocking progress.",
		}),
	),
});

export function registerUpdateGoal(pi: ExtensionAPI, getMode: () => GoalMode): void {
	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Signal goal completion or a blocking condition. " +
			"ONLY call this when the objective is truly complete OR genuinely blocked. " +
			"Rules:\n" +
			"1. Do NOT call for routine progress — most turns should end normally.\n" +
			"2. Only call complete when the objective described in the goal has actually been achieved.\n" +
			"3. A non-terminal blocking condition must repeat for at least 3 consecutive goal turns before calling blocked.\n" +
			"4. Temporary obstacles (e.g., a single failing test, a missing file that might appear) do NOT count as blocked.",
		promptSnippet:
			"Mark goal as complete (achieved) or blocked (cannot proceed)",
		promptGuidelines: [
			"Use update_goal with status='complete' only when the current goal " +
				"objective has been fully achieved. Do not call this for routine progress.",
			"Use update_goal with status='blocked' only after the same blocking " +
				"condition has persisted for at least 3 consecutive goal turns. " +
				"Temporary obstacles do not qualify.",
			"Most goal turns should end normally without calling update_goal. " +
				"The runtime continues the goal automatically.",
		],
		parameters: UpdateGoalParams,

		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			const status = params.status as "complete" | "blocked";
			const reason = params.reason as string | undefined;

			try {
				const mode = getMode();
				if (status === "complete") {
					mode.markComplete(reason);
					return {
						content: [
							{
								type: "text" as const,
								text: `Goal marked as complete${reason ? `: ${reason}` : "."}`,
							},
						],
						details: mode.getSnapshot() as unknown as Record<string, unknown>,
					};
				} else {
					mode.markBlocked(reason || "blocked");
					return {
						content: [
							{
								type: "text" as const,
								text: `Goal marked as blocked${reason ? `: ${reason}` : "."}`,
							},
						],
						details: mode.getSnapshot() as unknown as Record<string, unknown>,
					};
				}
			} catch (e: any) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to update goal: ${e.message}`,
						},
					],
					isError: true,
				};
			}
		},
	});
}
