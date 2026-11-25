// A shell command's card, for plugins whose tools run commands (`createShellRenderers(prompt)`), copied from
// coding-agent core/tools/renderers/bash.ts. Durable's shell result carries no `details` (the spill path is a
// diagnostic), so the truncation footer is not shown; the recorded duration comes from the result.
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { VisualLinePreview } from "../components/visual-truncate.ts";
import { keyHint, safeText } from "../render-context.ts";
import type { Theme } from "../theme/theme.ts";
import { getTextOutput, invalidArgText, num, str } from "./render-utils.ts";
import type { ToolArgs, ToolRenderContext, ToolRenderers, ToolRenderResultOptions, ToolResultView } from "./types.ts";

const SHELL_PREVIEW_LINES = 5;

function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

function formatShellCall(args: ToolArgs, prompt: string, theme: Theme): string {
	const command = str(args.command);
	const timeout = num(args.timeout);
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay =
		command === null ? invalidArgText(theme) : command ? safeText(command) : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildShellResult(
	component: Container,
	result: ToolResultView,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	component.clear();
	const output = getTextOutput(result).trim();
	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");
		if (options.expanded) component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		else {
			component.addChild(new Spacer(1));
			component.addChild(
				new VisualLinePreview({
					text: styledOutput,
					maxVisualLines: SHELL_PREVIEW_LINES,
					keep: "end",
					formatHint: (hidden) =>
						theme.fg("muted", `... (${hidden} earlier lines,`) +
						` ${keyHint(context.ui, "app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
				}),
			);
		}
	}
	// A final result's recorded duration wins; the card's own clock is the fallback for live progress.
	if (!options.isPartial && context.durationMs !== undefined)
		component.addChild(new Text(`\n${theme.fg("muted", `Took ${formatDuration(context.durationMs)}`)}`, 0, 0));
	else if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		component.addChild(
			new Text(`\n${theme.fg("muted", `${label} ${formatDuration((endedAt ?? Date.now()) - startedAt)}`)}`, 0, 0),
		);
	}
}

/**
 * The card of a tool that runs `args.command` (and an optional `args.timeout` in seconds): `$ command`, the output's
 * last lines, how long it took. Shells differ only in the prompt they display (`prompt`).
 */
export function createShellRenderers(prompt: string): ToolRenderers {
	return {
		renderCall(args, theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatShellCall(args, prompt, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const state = context.state;
			// The card's own clock only for runs it watched: a stored result without a duration shows none.
			if (options.isPartial) state.watched = true;
			else if (state.watched !== true) state.startedAt = undefined;
			if (state.startedAt !== undefined && options.isPartial && state.interval === undefined)
				state.interval = setInterval(() => context.invalidate(), 1000);
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval !== undefined) {
					clearInterval(state.interval as ReturnType<typeof setInterval>);
					state.interval = undefined;
				}
			}
			const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
			rebuildShellResult(component, result, options, theme, context, num(state.startedAt), num(state.endedAt));
			component.invalidate();
			return component;
		},
	};
}
