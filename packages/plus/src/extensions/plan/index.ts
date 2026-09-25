/**
 * Plan mode (openclaude/Claude Code style): a read-only research phase where
 * the model investigates the codebase, writes an implementation plan to the
 * session plan file (<agentDir>/plans/<sessionId>.md — the only file it may
 * edit), and ends by calling ExitPlanMode to present the plan for approval.
 *
 * Entry points: the model calls EnterPlanMode (asks the user to confirm), or
 * the user runs /plan, presses ctrl+alt+p, prompts "enter plan mode" /
 * "exit plan mode", or launches with --plan. While active, a <plan_mode>
 * system-prompt section drives the workflow and the
 * tool_call gate (gate.ts) enforces read-only: edit/write are restricted to
 * the plan file, bash to a read-only allowlist, powershell and non-allowlisted
 * custom tools (subagent unless the read-only "explore" type) are blocked.
 *
 * ExitPlanMode shows the plan with Approve / Stay / Edit options; approval
 * turns plan mode off and returns the approved plan to the model with full
 * tool access. State is per-session in memory (reset on new/resume/fork).
 */

import * as fs from "node:fs";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "../../../../coding-agent/src/core/extensions/types.ts";
import { gateToolCall } from "./gate.ts";
import { planFilePathFor, readPlan, writePlan } from "./plan-file.ts";
import { buildPlanModeSection, PLAN_MODE_SECTION_NAME } from "./prompt.ts";
import { createPlanState, type PlanModeState, updateStatus } from "./state.ts";
import { EnterPlanModeParams, ExitPlanModeParams } from "./tools.ts";

function sessionIdFor(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId() || "default";
	} catch {
		return "default";
	}
}

export function registerPlan(pi: ExtensionAPI): void {
	const state: PlanModeState = createPlanState();

	function activate(ctx: ExtensionContext): void {
		state.planFilePath = planFilePathFor(sessionIdFor(ctx));
		state.enabled = true;
		updateStatus(ctx, state);
	}

	function deactivate(ctx: ExtensionContext): void {
		state.enabled = false;
		state.planFilePath = undefined;
		updateStatus(ctx, state);
	}

	function toggle(ctx: ExtensionContext): void {
		if (state.enabled) {
			deactivate(ctx);
			ctx.ui.notify("Plan mode off — full tool access restored.", "info");
		} else {
			activate(ctx);
			ctx.ui.notify(`Plan mode on — read-only. Plan file: ${state.planFilePath}`, "info");
		}
	}

	async function editPlan(ctx: ExtensionContext): Promise<void> {
		if (!state.planFilePath) {
			ctx.ui.notify("Plan mode is not active.", "warning");
			return;
		}
		const current = await readPlan(state.planFilePath);
		const edited = await ctx.ui.editor("Edit the plan", current);
		if (edited === undefined) {
			ctx.ui.notify("Plan edit cancelled.", "info");
			return;
		}
		await writePlan(state.planFilePath, edited);
		ctx.ui.notify(`Plan saved to ${state.planFilePath}`, "info");
	}

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only; the model writes a plan for approval before changing anything)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode (no args), or /plan show | /plan edit the current plan",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "") {
				toggle(ctx);
				return;
			}
			if (arg === "show") {
				if (!state.planFilePath) {
					ctx.ui.notify("Plan mode is not active.", "warning");
					return;
				}
				const plan = await readPlan(state.planFilePath);
				ctx.ui.notify(plan.trim().length > 0 ? plan : `Plan file is empty: ${state.planFilePath}`, "info");
				return;
			}
			if (arg === "edit") {
				await editPlan(ctx);
				return;
			}
			ctx.ui.notify("Usage: /plan (toggle) | /plan show | /plan edit", "info");
		},
	});

	// ctrl+p / shift+ctrl+p cycle models; ctrl+alt+p is free (same chord the
	// coding-agent plan-mode example uses) and works under the vim editor.
	pi.registerShortcut("ctrl+alt+p", {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			toggle(ctx);
		},
	});

	// Natural-language toggle: a bare "enter plan mode" / "exit plan mode"
	// prompt is consumed here (like /plan) instead of being sent to the model.
	pi.on("input", async (event, ctx) => {
		if (event.images && event.images.length > 0) return { action: "continue" };
		const text = event.text.trim().toLowerCase();
		if (text === "enter plan mode" || text === "exit plan mode") {
			const enabling = text === "enter plan mode";
			if (enabling === state.enabled) {
				ctx.ui.notify(`Plan mode is already ${state.enabled ? "on" : "off"}.`, "info");
				return { action: "handled" };
			}
			toggle(ctx);
			return { action: "handled" };
		}
		return { action: "continue" };
	});

	pi.registerTool({
		name: "EnterPlanMode",
		label: "Enter Plan Mode",
		description:
			"Enter plan mode: a read-only research phase. You investigate the codebase, write an " +
			"implementation plan to the session plan file (the only file you may edit), and end by " +
			"calling ExitPlanMode to present the plan for approval. Use when the user asks you to plan " +
			"first, investigate before implementing, or design an approach before making changes.",
		parameters: EnterPlanModeParams,
		executionMode: "sequential",

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (state.enabled) {
				return {
					content: [
						{ type: "text", text: `Plan mode is already active. The plan file is ${state.planFilePath}.` },
					],
					details: undefined,
				};
			}
			if (!ctx.hasUI) {
				throw new Error(
					"EnterPlanMode requires the interactive TUI (the user must confirm); continuing without plan mode.",
				);
			}
			const yes = await ctx.ui.confirm(
				"Enter plan mode?",
				"The agent becomes read-only and writes an implementation plan for your approval before making any changes.",
			);
			if (!yes) {
				return {
					content: [
						{ type: "text", text: "The user declined to enter plan mode. Proceed with normal execution." },
					],
					details: undefined,
				};
			}
			activate(ctx);
			return {
				content: [
					{
						type: "text",
						text:
							`Plan mode activated. Plan file: ${state.planFilePath}\n` +
							"Research the codebase read-only and write the plan to that file (it is the only file you may edit), " +
							"then call ExitPlanMode when the plan is ready for approval.",
					},
				],
				details: undefined,
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("EnterPlanMode")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
		},
	});

	pi.registerTool({
		name: "ExitPlanMode",
		label: "Exit Plan Mode",
		description:
			"Present the finished plan to the user for approval and exit plan mode. Call only when the " +
			"plan file is complete. On approval plan mode ends, full tool access is restored, and you " +
			"begin implementing the approved plan; on rejection you remain in plan mode with the user's " +
			"feedback. Never ask about plan approval in text — this tool is the approval flow.",
		parameters: ExitPlanModeParams,
		executionMode: "sequential",

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!state.enabled || !state.planFilePath) {
				throw new Error(
					"Plan mode is not active. This tool is only for exiting plan mode after writing a plan. " +
						"If your plan was already approved, continue with implementation.",
				);
			}
			if (!ctx.hasUI) {
				throw new Error(
					"Plan approval requires the interactive TUI. Ask the user to run /plan to toggle plan mode off, then continue.",
				);
			}
			const plan = await readPlan(state.planFilePath);
			if (plan.trim().length === 0) {
				throw new Error(
					`The plan file is empty. Write the plan to ${state.planFilePath} first, then call ExitPlanMode again.`,
				);
			}

			const choice = await ctx.ui.select(`Plan ready for review:\n\n${plan}\n\nWhat next?`, [
				"Approve and proceed",
				"Stay in plan mode",
				"Edit plan",
			]);

			if (choice === "Approve and proceed") {
				deactivate(ctx);
				return {
					content: [
						{
							type: "text",
							text:
								"User has approved your plan. Plan mode is now OFF and you have full tool access. " +
								"Implement the approved plan exactly as written:\n\n" +
								plan +
								"\n\nBegin implementation now.",
						},
					],
					details: undefined,
				};
			}

			if (choice === "Edit plan") {
				const edited = await ctx.ui.editor("Edit the plan", plan);
				if (edited !== undefined && edited.trim().length > 0) {
					await writePlan(state.planFilePath, edited);
					return {
						content: [
							{
								type: "text",
								text: `The user edited the plan; updated contents:\n\n${edited}\n\nContinue in plan mode and call ExitPlanMode when ready.`,
							},
						],
						details: undefined,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: "Plan edit cancelled; the plan file is unchanged. Continue in plan mode and call ExitPlanMode when ready.",
						},
					],
					details: undefined,
				};
			}

			// "Stay in plan mode" (or the dialog was dismissed).
			return {
				content: [
					{
						type: "text",
						text: "The user is not ready to approve. Remain in plan mode; continue researching or refining the plan file, then call ExitPlanMode again.",
					},
				],
				details: undefined,
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("ExitPlanMode")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
		},
	});

	// Read-only gate: blocks mutating tool calls while plan mode is active.
	pi.on("tool_call", async (event, ctx) => {
		return gateToolCall(event, state, ctx.cwd);
	});

	// Drive the workflow via a system-prompt section while plan mode is active.
	pi.on("before_agent_start", async (event) => {
		if (!state.enabled || !state.planFilePath) return;
		event.systemPromptOptions.sections[PLAN_MODE_SECTION_NAME] = buildPlanModeSection({
			planFilePath: state.planFilePath,
			planExists: fs.existsSync(state.planFilePath),
		});
	});

	// Per-session state lifecycle.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			state.enabled = false;
			state.planFilePath = undefined;
		}
		if (pi.getFlag("plan") === true && (event.reason === "startup" || event.reason === "new")) {
			state.enabled = true;
		}
		// Recompute the plan file path (also covers /reload, where the flag and
		// enabled state survive but the session id context is fresh).
		if (state.enabled && !state.planFilePath) {
			state.planFilePath = planFilePathFor(sessionIdFor(ctx));
		}
		updateStatus(ctx, state);
	});
}

// Re-exported for tests and the plus extensions index.
export type { PlanModeState } from "./state.ts";
