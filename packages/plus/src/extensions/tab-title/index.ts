/**
 * pi-plus-tab-title: "pi+" tab branding plus a busy spinner in the terminal
 * window/tab title.
 *
 * Upstream sets the tab title to "APP_TITLE - [sessionName -] cwdBasename" at
 * startup and on session switches (interactive-mode updateTerminalTitle,
 * driven by the plus config wrapper's APP_TITLE). This extension owns the same
 * title shape via ctx.ui.setTitle so a spinner frame can be prepended while
 * the agent is working:
 *
 * - session_start / session_info_changed: re-apply the base title (covers
 *   session switches and renames; upstream re-titles on those too, and both
 *   write the identical "pi+" format, so they cannot disagree).
 * - agent_start: mark the agent run active; the ticker prepends the current
 *   braille frame to the base title on each tick.
 * - agent_settled / turn_end: end the agent run and refresh — the ticker
 *   stops only if no compaction is running. Settled is the primary stop
 *   signal; turn_end is the backstop (only for turns whose stopReason is not
 *   toolUse, since toolUse turns continue the run).
 * - session_before_compact: mark compaction active (manual /compact while
 *   idle, or auto/overflow compaction mid-run) so the tab spins through it.
 * - session_compact / session_compact_failed: end compaction and refresh —
 *   the ticker keeps running if the agent run is still active.
 * - session_shutdown: clear the ticker so reloads and session replacements
 *   leak no intervals.
 *
 * TUI mode only: print mode's UI context is a no-op and RPC clients own
 * their own window titles.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "../../../../coding-agent/src/core/extensions/types.ts";
import { APP_TITLE } from "../../coding-agent/core/config.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;

export function registerTabTitle(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let frameIndex = 0;
	// The most recent TUI context: sessionManager stays live across events, so
	// the ticker always reads the current session name/cwd from it.
	let latestCtx: ExtensionContext | undefined;
	// Busy sources: the agent run (agent_start until agent_settled) and context
	// compaction (session_before_compact until session_compact/_failed). The
	// spinner runs while either is active — compaction can happen mid-run
	// (overflow recovery, auto-compact between turns) or while idle (manual
	// /compact), and manual compaction aborts the run first, so a single flag
	// would leave the tab static through long compactions.
	let agentRunActive = false;
	let compacting = false;

	const baseTitle = (ctx: ExtensionContext): string => {
		const cwdBasename = basename(ctx.sessionManager.getCwd());
		const sessionName = ctx.sessionManager.getSessionName();
		return sessionName ? `${APP_TITLE} - ${sessionName} - ${cwdBasename}` : `${APP_TITLE} - ${cwdBasename}`;
	};

	const stopSpinner = () => {
		if (timer === undefined) return;
		clearInterval(timer);
		timer = undefined;
	};

	const startSpinner = (ctx: ExtensionContext) => {
		latestCtx = ctx;
		if (timer !== undefined) return;
		frameIndex = 0;
		timer = setInterval(() => {
			const current = latestCtx;
			if (!current) return;
			const frame = SPINNER_FRAMES[frameIndex++ % SPINNER_FRAMES.length];
			current.ui.setTitle(`${frame} ${baseTitle(current)}`);
		}, SPINNER_INTERVAL_MS);
		timer.unref();
	};

	const applyBase = (ctx: ExtensionContext) => {
		latestCtx = ctx;
		ctx.ui.setTitle(baseTitle(ctx));
	};

	// Start or stop the ticker to match the current busy state.
	const refresh = (ctx: ExtensionContext) => {
		latestCtx = ctx;
		if (agentRunActive || compacting) {
			startSpinner(ctx);
		} else {
			stopSpinner();
			ctx.ui.setTitle(baseTitle(ctx));
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		agentRunActive = false;
		compacting = false;
		stopSpinner();
		applyBase(ctx);
	});

	pi.on("session_info_changed", (_event, ctx) => {
		if (ctx.mode !== "tui" || timer !== undefined) return;
		applyBase(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		agentRunActive = true;
		refresh(ctx);
	});

	const settle = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		agentRunActive = false;
		refresh(ctx);
	};
	pi.on("agent_settled", settle);
	// turn_end fires after EVERY assistant message, including ones whose tool
	// calls keep the run going — settling there would stop the ticker a couple
	// seconds into a long multi-step run and never restart it (agent_start is
	// once per run). Only a non-toolUse stop reason means the run is actually
	// ending; agent_settled remains the primary stop signal (it fires in the
	// run's finally, so aborts/errors are covered too).
	pi.on("turn_end", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.message.role === "assistant" && event.message.stopReason === "toolUse") return;
		settle(event, ctx);
	});

	// Compaction: session_before_compact fires before both manual and automatic
	// compaction (including when a before-handler cancels or supplies the
	// summary), and exactly one of session_compact / session_compact_failed
	// fires afterwards, so the flag always resets.
	pi.on("session_before_compact", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		compacting = true;
		refresh(ctx);
	});
	const compactionDone = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		compacting = false;
		refresh(ctx);
	};
	pi.on("session_compact", compactionDone);
	pi.on("session_compact_failed", compactionDone);

	pi.on("session_shutdown", () => {
		agentRunActive = false;
		compacting = false;
		stopSpinner();
	});
}
