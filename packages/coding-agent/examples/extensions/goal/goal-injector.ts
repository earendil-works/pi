/**
 * Goal Injector — Context Injection Text Generator
 *
 * Generates active/paused/blocked reminder text for the context hook.
 * Pure functions — no pi runtime dependency, testable in isolation.
 */

import type { GoalMode } from "./goal-mode.ts";

/**
 * Escape XML special characters to prevent prompt injection.
 */
function xmlEscape(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Generate the active-goal injection text.
 *
 * Full reminder including objective, completion criterion, behavioral rules,
 * continuation instructions, and termination conditions.
 */
function buildActiveInjection(mode: GoalMode): string {
	const goal = mode.getGoal();
	const title = goal?.title ?? "(untitled)";
	const description = goal?.description ?? "";

	let text = `<goal_state>
	<status>active</status>
	<objective>${xmlEscape(title)}</objective>`;

	if (description) {
		text += `\n  <completion_criterion>${xmlEscape(description)}</completion_criterion>`;
	}

	text += `\n</goal_state>

You are actively working toward the goal described above. Rules for this goal:

1. **Continue working.** Each turn you receive this reminder at the start. Keep
	 self-audit brief. Follow the most direct interpretation once the goal can
	 be decided.

2. **When to stop.** Only call update_goal(status="complete") when:
	 - The objective described in <objective> has actually been achieved, OR
	 - The objective is impossible, unsafe, or contradictory

3. **Do not stop prematurely.** Most goal turns should NOT call update_goal.
	 After completing a useful slice of work, end the turn normally — the runtime
	 will automatically continue the goal.

4. **Blocked audit.** A blocking condition must repeat for at least 3
	 consecutive goal turns before calling update_goal(status="blocked").
	 Only conditions that persist across turns qualify.

`;

	return text;
}

/**
 * Generate the paused-goal injection text.
 *
 * Light reminder: objective is visible but the model is instructed not to work
 * on it.
 */
function buildPausedInjection(mode: GoalMode): string {
	const goal = mode.getGoal();
	const title = goal?.title ?? "(untitled)";
	const reason = mode.getState().statusReason;

	let text = `<goal_state>
	<status>paused</status>
	<objective>${xmlEscape(title)}</objective>`;

	if (reason) {
		text += `\n  <pause_reason>${xmlEscape(reason)}</pause_reason>`;
	}

	text += `\n</goal_state>

A goal exists but is currently paused. **Do not work on this goal.** The user has
not yet asked you to resume it. Respond to the user's current prompt normally
and do not continue or complete the paused goal.`;

	return text;
}

/**
 * Generate the blocked-goal injection text.
 *
 * Light reminder with objective wrapped in <untrusted_objective>, explicitly
 * telling the model no action is required.
 */
function buildBlockedInjection(mode: GoalMode): string {
	const goal = mode.getGoal();
	const title = goal?.title ?? "(untitled)";
	const reason = mode.getState().statusReason ?? "unknown";

	let text = `<goal_state>
	<status>blocked</status>
	<block_reason>${xmlEscape(reason)}</block_reason>
	<untrusted_objective>${xmlEscape(title)}</untrusted_objective>
</goal_state>

The current goal is blocked: ${xmlEscape(reason)}. **No action is required from
you.** Do not work on this goal or attempt to resume it. Respond to the user's
current prompt normally.`;

	return text;
}

/**
 * Generate context injection text for the current goal status.
 *
 * Returns null when there is no active goal (undefined status).
 */
export function buildGoalInjection(mode: GoalMode): string | null {
	const status = mode.getStatus();
	switch (status) {
		case "active":
			return buildActiveInjection(mode);
		case "paused":
			return buildPausedInjection(mode);
		case "blocked":
			return buildBlockedInjection(mode);
		case "complete":
		case "undefined":
			return null;
	}
}

/**
 * The continuation prompt sent as a followUp message to trigger the next
 * auto-continuation turn.
 */
export const CONTINUATION_PROMPT = `Continue working toward the active goal.

1. Keep self-audit brief. Do not explore unrelated interpretations once the
	 goal can be decided.

2. If the objective is already achieved, impossible, unsafe, or contradictory,
	 call update_goal(status="complete") immediately — do not run another turn.

3. Most goal turns should NOT call update_goal. After completing a useful
	 slice of work, end the turn normally so the runtime continues the goal.

4. A blocking condition must repeat for at least 3 consecutive goal turns
	 before calling update_goal(status="blocked").`;
