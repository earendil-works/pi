/**
 * GoalExtension — Wiring Module
 *
 * Centralizes all pi runtime wiring for the goal extension:
 *   - Hook registration (session_start, context, message_end, turn_end)
 *   - Tool registration (create_goal, update_goal, get_goal)
 *   - /goal command registration & subcommand dispatch
 *   - Status display updates
 *   - Esc abort detection → pause
 *   - Auto-continuation loop via turn_end + followUp
 *   - Persistence triggers on state changes
 *
 * Dependency:
 *   GoalMode — pure state machine (goal-mode.ts)
 *   GoalExtension owns a GoalMode instance. A custom factory can be
 *   injected via constructor for testing.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { GoalMode, type GoalEventListener } from "./goal-mode.ts";
import { loadGoalState, saveGoalState } from "./goal-persistence.ts";
import {
	buildGoalInjection,
	CONTINUATION_PROMPT,
} from "./goal-injector.ts";
import { registerCreateGoal } from "./tools/create-goal.ts";
import { registerUpdateGoal } from "./tools/update-goal.ts";
import { registerGetGoal } from "./tools/get-goal.ts";
import type { GoalDefinition, GoalStatus } from "./goal-types.ts";

// ── Shared helpers ───────────────────────────────────────────────

/** Single icon for each goal status — shared by updateStatus and formatGoalStatus. */
function getStatusIcon(s: GoalStatus): string {
	switch (s) {
		case "active": return "▶";
		case "paused": return "⏸";
		case "blocked": return "⊘";
		default: return "?";
	}
}

function formatGoalStatus(mode: GoalMode): string {
	const s = mode.getStatus();
	if (s === "undefined") return "No active goal.";

	const goal = mode.getGoal();
	const reason = mode.getState().statusReason;
	const icon = getStatusIcon(s);
	let text = `Goal: ${icon} ${goal?.title ?? "(untitled)"} [${s}]`;
	if (goal?.description) text += `\nCriterion: ${goal.description}`;
	if (reason) text += `\nReason: ${reason}`;
	return text;
}

// ── GoalExtension class ──────────────────────────────────────────

export class GoalExtension {
	private mode: GoalMode;
	private lastCtx: ExtensionContext | null = null;
	private pi: ExtensionAPI;

	/**
	 * @param pi         The extension API from the pi runtime.
	 * @param modeFactory Optional factory to create/inject a GoalMode.
	 *                    Receives the onTransition callback. Defaults to
	 *                    creating a fresh GoalMode.
	 */
	constructor(
		pi: ExtensionAPI,
		modeFactory?: (onTransition: GoalEventListener) => GoalMode,
	) {
		this.pi = pi;

		const onTransition: GoalEventListener = () => {
			if (this.lastCtx) this.updateStatus(this.lastCtx);
			saveGoalState(pi, this.mode);
		};

		this.mode = modeFactory
			? modeFactory(onTransition)
			: new GoalMode(undefined, onTransition);

		// ── Session start: load persisted state ───────────────────────
		pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
			this.lastCtx = ctx;
			const loaded = loadGoalState(ctx, onTransition);
			if (loaded) {
				this.mode = loaded;
			}
			this.updateStatus(ctx);
		});

		// ── Context hook: inject goal reminder before each LLM call ────
		pi.on("context", async (event: any, _ctx: ExtensionContext) => {
			const injection = buildGoalInjection(this.mode);
			if (!injection) return;

			const goalMessage = {
				role: "user" as const,
				content: [{ type: "text" as const, text: injection }],
				timestamp: Date.now(),
			};

			if (Array.isArray(event.messages)) {
				event.messages.unshift(goalMessage);
			}

			return { messages: event.messages };
		});

		// ── message_end: detect Esc abort → pause goal ─────────────────
		pi.on("message_end", async (event: any, ctx: ExtensionContext) => {
			this.lastCtx = ctx;

			if (
				event.message?.role === "assistant" &&
				event.message?.stopReason === "aborted"
			) {
				if (this.mode.getStatus() === "active") {
					this.mode.pauseGoal("Paused by user (Esc)");
					this.updateStatus(ctx);
				}
			}
		});

		// ── turn_end: auto-continuation if goal is active ──────────────
		pi.on("turn_end", async (event: any, ctx: ExtensionContext) => {
			this.lastCtx = ctx;

			if (
				this.mode.getStatus() === "active" &&
				event.message?.stopReason === "stop"
			) {
				pi.sendUserMessage(CONTINUATION_PROMPT, {
					deliverAs: "followUp",
				});
			}
		});

		// ── Register tools ────────────────────────────────────────────
		const getMode = (): GoalMode => this.mode;
		registerCreateGoal(pi, getMode);
		registerUpdateGoal(pi, getMode);
		registerGetGoal(pi, getMode);

		// ── Register /goal command ────────────────────────────────────
		pi.registerCommand("goal", {
			description:
				"Manage goals — type an objective to create, or use: status, pause, resume, cancel",
			handler: async (args: string, ctx: ExtensionContext) => {
				this.lastCtx = ctx;

				if (!args || args.trim() === "") {
					ctx.ui.notify(formatGoalStatus(this.mode), "info");
					return;
				}

				const trimmed = args.trim();
				const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
				const rest = trimmed.slice(firstWord.length).trim();

				if (this.subcommands[firstWord]) {
					try {
						const msg = this.subcommands[firstWord].fn(ctx, rest || undefined);
						ctx.ui.notify(msg, "success");
					} catch (e: any) {
						ctx.ui.notify(`Error: ${e.message}`, "error");
					}
					return;
				}

				// Not a subcommand → treat as goal objective → create directly
				const def: GoalDefinition = { title: trimmed };
				const existingStatus = this.mode.getStatus();

				try {
					if (existingStatus !== "undefined") {
						const choice = await ctx.ui.select(
							`A goal is already ${existingStatus}. Replace it?`,
							["Replace existing goal", "Cancel"],
						);
						if (!choice?.startsWith("Replace")) {
							ctx.ui.notify("Goal creation cancelled.", "info");
							return;
						}
						this.mode.createGoal(def, { replace: true });
					} else {
						this.mode.createGoal(def);
					}
					this.updateStatus(ctx);
					ctx.ui.notify(`Goal created: "${trimmed}"`, "success");
					pi.sendUserMessage(
						`Work on this goal: "${trimmed}". Use get_goal to confirm the objective, then proceed.`,
						{ deliverAs: "followUp" },
					);
				} catch (e: any) {
					ctx.ui.notify(`Error: ${e.message}`, "error");
				}
			},
		});
	}

	// ── Public accessors ───────────────────────────────────────────

	/** Expose the current GoalMode (for tests and external inspection). */
	getMode(): GoalMode {
		return this.mode;
	}

	// ── Subcommand dispatch ═════════════════════════════════════════
	//   /goal <objective>  → directly create goal
	//   /goal status       → check goal status
	//   /goal pause        → pause active goal
	//   /goal resume       → resume paused/blocked goal
	//   /goal cancel       → remove goal (pauses first if active)
	// 'block' is agent-only (update_goal tool), not exposed as command.

	private get subcommands(): Record<string, {
		desc: string;
		fn: (ctx: ExtensionContext, reason?: string) => string;
	}> {
		return {
			status: {
				desc: "Show current goal status",
				fn: (_ctx) => formatGoalStatus(this.mode),
			},
			pause: {
				desc: "Pause the active goal",
				fn: (ctx, reason) => {
					this.mode.pauseGoal(reason || "Paused by user");
					this.updateStatus(ctx);
					return `Goal paused${reason ? `: ${reason}` : "."}`;
				},
			},
			resume: {
				desc: "Resume a paused or blocked goal",
				fn: (ctx, reason) => {
					this.mode.resumeGoal(reason);
					this.updateStatus(ctx);
					this.pi.sendUserMessage(
						"Goal resumed. Continue working toward the goal.",
						{ deliverAs: "followUp" },
					);
					return `Goal resumed${reason ? `: ${reason}` : "."}`;
				},
			},
			cancel: {
				desc: "Cancel the current goal",
				fn: (ctx, reason) => {
					this.mode.cancelGoal(reason || "Cancelled by user");
					this.updateStatus(ctx);
					return `Goal cancelled${reason ? `: ${reason}` : "."}`;
				},
			},
		};
	}

	// ── Internal helpers ───────────────────────────────────────────

	private updateStatus(ctx: ExtensionContext): void {
		const s = this.mode.getStatus();
		if (s === "undefined") {
			ctx.ui.setStatus("goal", undefined);
			return;
		}
		const icon = getStatusIcon(s);
		ctx.ui.setStatus("goal", ctx.ui.theme.fg("accent", `${icon} Goal [${s}]`));
	}
}
