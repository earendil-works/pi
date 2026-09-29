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
 * - agent_start: start a braille frame ticker; each tick prepends the current
 *   frame to the base title. Nested/sequential agent loops reuse the ticker.
 * - agent_settled / turn_end: stop the ticker and restore the base title.
 *   Settled is the primary stop signal; turn_end is the backstop so an
 *   unexpected settle-skip cannot leave the tab spinning forever.
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

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		stopSpinner();
		applyBase(ctx);
	});

	pi.on("session_info_changed", (_event, ctx) => {
		if (ctx.mode !== "tui" || timer !== undefined) return;
		applyBase(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		startSpinner(ctx);
	});

	const settle = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		latestCtx = ctx;
		stopSpinner();
		ctx.ui.setTitle(baseTitle(ctx));
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

	pi.on("session_shutdown", () => stopSpinner());
}
