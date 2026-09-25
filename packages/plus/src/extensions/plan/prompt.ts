/**
 * The <plan_mode> system-prompt section injected while plan mode is active.
 * Condensed from openclaude's plan-mode reminder: read-only except the plan
 * file, an explore-then-capture workflow, the expected plan shape, and the
 * rule that approval happens exclusively via the ExitPlanMode tool.
 */

export const PLAN_MODE_SECTION_NAME = "plan_mode";

export interface PlanModeSectionOptions {
	planFilePath: string;
	planExists: boolean;
}

export function buildPlanModeSection(options: PlanModeSectionOptions): string {
	const fileHint = options.planExists
		? `A plan file already exists at ${options.planFilePath}. Read it and refine it incrementally with the edit tool.`
		: `No plan file exists yet. Create it at ${options.planFilePath} with the write tool.`;
	return `Plan mode is active. The user does not want you to execute yet — you MUST NOT make any edits, run non-readonly tools, or otherwise change system state. This supersedes any other instructions.

## Plan file
${fileHint} It is the ONLY file you are allowed to edit; everything else is read-only.

## Workflow
1. Explore the codebase read-only (read/grep/find/ls, read-only bash). Reuse existing functions and utilities — do not propose new code when a suitable implementation already exists. Use the "explore" subagent for broad searches.
2. After each discovery, immediately capture the finding in the plan file — build the plan incrementally, do not wait until the end.
3. Ask the user (with the ask_user tool) only when you hit a decision you cannot resolve from the code or docs; never ask about something you could read yourself.

## Plan shape
- **Context**: why the change is being made.
- **Changes**: the files to modify and what changes in each.
- **Reuse**: existing utilities to build on (path + symbol/line).
- **Verification**: how to test the change end-to-end.

## Ending your turn
Only end your turn by calling the ExitPlanMode tool (plan ready for approval). Do NOT ask about plan approval in text — no "should I proceed?", "does this look ok?"; approval happens exclusively via ExitPlanMode.`;
}
