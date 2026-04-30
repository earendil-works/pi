/**
 * Working Indicator Extension
 *
 * Demonstrates `ctx.ui.setWorkingIndicator()` for customizing the inline
 * working indicator shown while pi is streaming a response.
 *
 * Usage:
 *   pi --extension examples/extensions/working-indicator.ts
 *
 * Commands:
 *   /working-indicator           Show current mode
 *   /working-indicator dot       Use a static dot indicator
 *   /working-indicator pulse     Use a custom animated indicator
 *   /working-indicator none      Hide the indicator entirely
 *   /working-indicator spinner   Restore an animated spinner
 *   /working-indicator reset     Restore pi's default spinner
 */

import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@mariozechner/pi-coding-agent";

type WorkingIndicatorMode = "dot" | "none" | "pulse" | "spinner" | "default";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PASTEL_RAINBOW = [
	"\x1b[38;2;255;179;186m",
	"\x1b[38;2;255;223;186m",
	"\x1b[38;2;255;255;186m",
	"\x1b[38;2;186;255;201m",
	"\x1b[38;2;186;225;255m",
	"\x1b[38;2;218;186;255m",
];
const RESET_FG = "\x1b[39m";
const HIDDEN_INDICATOR: WorkingIndicatorOptions = {
	frames: [],
};

function colorize(text: string, color: string): string {
	return `${color}${text}${RESET_FG}`;
}

function getIndicator(mode: WorkingIndicatorMode): WorkingIndicatorOptions | undefined {
	switch (mode) {
		case "dot":
			return {
				frames: [colorize("●", PASTEL_RAINBOW[0])],
			};
		case "none":
			return HIDDEN_INDICATOR;
		case "pulse":
			return {
				frames: [
					colorize("·", PASTEL_RAINBOW[0]),
					colorize("•", PASTEL_RAINBOW[2]),
					colorize("●", PASTEL_RAINBOW[4]),
					colorize("•", PASTEL_RAINBOW[5]),
				],
				intervalMs: 120,
			};
		case "spinner":
			return {
				frames: SPINNER_FRAMES.map((frame, index) =>
					colorize(frame, PASTEL_RAINBOW[index % PASTEL_RAINBOW.length]!),
				),
				intervalMs: 80,
			};
		case "default":
			return undefined;
	}
}

function describeMode(mode: WorkingIndicatorMode): string {
	switch (mode) {
		case "dot":
			return "static dot";
		case "none":
			return "hidden";
		case "pulse":
			return "custom pulse";
		case "spinner":
			return "custom spinner";
		case "default":
			return "pi default spinner";
	}
}

export default function (pi: ExtensionAPI) {
	let mode: WorkingIndicatorMode = "spinner";

	const applyIndicator = (ctx: ExtensionContext) => {
		ctx.ui.setWorkingIndicator(getIndicator(mode));
		ctx.ui.setStatus("working-indicator", ctx.ui.theme.fg("dim", `Indicator: ${describeMode(mode)}`));
	};

	pi.on("session_start", async (_event, ctx) => {
		applyIndicator(ctx);
	});

	pi.registerCommand("working-indicator", {
		description: "Set the streaming working indicator: dot, pulse, none, spinner, or reset.",
		handler: async (args, ctx) => {
			const nextMode = args.trim().toLowerCase();
			if (!nextMode) {
				ctx.ui.notify(`Working indicator: ${describeMode(mode)}`, "info");
				return;
			}

			if (
				nextMode !== "dot" &&
				nextMode !== "none" &&
				nextMode !== "pulse" &&
				nextMode !== "spinner" &&
				nextMode !== "reset"
			) {
				ctx.ui.notify("Usage: /working-indicator [dot|pulse|none|spinner|reset]", "error");
				return;
			}

			mode = nextMode === "reset" ? "default" : nextMode;
			applyIndicator(ctx);
			ctx.ui.notify(`Working indicator set to: ${describeMode(mode)}`, "info");
		},
	});
}
