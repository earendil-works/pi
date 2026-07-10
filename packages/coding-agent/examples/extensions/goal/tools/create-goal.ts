/**
 * create_goal Tool — Create a new goal
 *
 * Agent-facing tool. The model calls this when the user explicitly requests
 * a goal. Fails if an unfinished goal already exists unless replace: true.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GoalMode } from "../goal-mode.ts";
import type { GoalDefinition } from "../goal-types.ts";

const MAX_FIELD_LENGTH = 4000;

const CreateGoalParams = Type.Object({
	objective: Type.String({
		description:
			"The goal objective — what should be achieved. Max 4000 characters.",
		maxLength: MAX_FIELD_LENGTH,
	}),
	completionCriterion: Type.Optional(
		Type.String({
			description:
				"Optional criterion for completion. Describes what 'done' looks like. " +
					"Max 4000 characters.",
			maxLength: MAX_FIELD_LENGTH,
		}),
	),
	replace: Type.Optional(
		Type.Boolean({
			description:
				"If true, replace any existing unfinished goal. Default: false.",
		}),
	),
});

export function registerCreateGoal(pi: ExtensionAPI, getMode: () => GoalMode): void {
	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description:
			"Create a new goal that the agent will autonomously work toward across " +
			"multiple turns. Only create a goal when explicitly requested by the user. " +
			"Do NOT infer goals from ordinary tasks — goals are for long-running " +
			"multi-turn objectives.",
		promptSnippet:
			"Create a new autonomous goal (user-requested, long-running tasks only)",
		promptGuidelines: [
			"Use create_goal only when the user explicitly asks you to create " +
				"a goal. Do NOT create goals from ordinary conversation or single-turn tasks.",
			"Goals are for long-running objectives that require multiple turns " +
				"of autonomous work. Single-turn tasks should be handled directly.",
		],
		parameters: CreateGoalParams,

		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: unknown,
		) {
			const objective = params.objective as string;
			const completionCriterion = params.completionCriterion as
				| string
				| undefined;
			const replace = (params.replace as boolean) ?? false;

			if (!objective || objective.trim() === "") {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: objective is required and cannot be empty.",
						},
					],
					isError: true,
				};
			}

			const def: GoalDefinition = { title: objective.trim() };
			if (completionCriterion?.trim()) {
				def.description = completionCriterion.trim();
			}

			try {
				const mode = getMode();
				mode.createGoal(def, { replace });
				let msg = `Goal created: "${def.title}"`;
				if (def.description) {
					msg += `\nCompletion criterion: ${def.description}`;
				}
				return {
					content: [{ type: "text" as const, text: msg }],
					details: mode.getSnapshot() as unknown as Record<string, unknown>,
				};
			} catch (e: any) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to create goal: ${e.message}. ` +
								`Use replace=true to overwrite the existing goal.`,
						},
					],
					isError: true,
				};
			}
		},
	});
}
