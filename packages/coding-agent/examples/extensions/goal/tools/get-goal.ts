/**
 * get_goal Tool — Retrieve current goal state
 *
 * Returns the current goal snapshot or null if no goal exists.
 * Minimal field set — status, objective, completionCriterion, terminalReason.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GoalMode } from "../goal-mode.ts";

/** Fields returned by the get_goal tool. */
export interface GetGoalResult {
	status: string;
	objective: string;
	completionCriterion?: string;
	terminalReason?: string;
}

/**
 * Build a GetGoalResult from a GoalMode instance.
 * Returns null when there is no active goal (undefined or complete status).
 */
export function buildGetGoalResult(mode: GoalMode): GetGoalResult | null {
	const status = mode.getStatus();
	if (status === "undefined" || status === "complete") {
		return null;
	}

	const goal = mode.getGoal();
	const state = mode.getState();
	const result: GetGoalResult = {
		status,
		objective: goal?.title ?? "(untitled)",
	};
	if (goal?.description) {
		result.completionCriterion = goal.description;
	}
	if (state.statusReason) {
		result.terminalReason = state.statusReason;
	}

	return result;
}

export function registerGetGoal(pi: ExtensionAPI, getMode: () => GoalMode): void {
	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description:
			"Check the current goal state. Returns the objective, status, and " +
			"any terminal reason if blocked or paused. Use this to verify your " +
			"understanding of the objective and current status during a long task.",
		promptSnippet: "Check current goal state (status and objective)",
		promptGuidelines: [
			"Use get_goal to verify the current goal objective and status before " +
				"making decisions about goal lifecycle.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const mode = getMode();
			const result = buildGetGoalResult(mode);
			if (result === null) {
				return {
					content: [{ type: "text" as const, text: "No active goal." }],
					details: { goal: null },
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(result, null, 2),
					},
				],
				details: { goal: result },
			};
		},
	});
}
