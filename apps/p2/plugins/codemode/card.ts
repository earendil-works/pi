// Code mode's card in the TUI, copied from coding-agent extensions/codemode/renderer.ts. The call shows the script; the
// result lists the nested tool calls (`context.calls`: live `pi.live.nestedTools` slots while running, with depth and
// running output, then the settled `details.calls`, as nested.ts reads them), followed by the script output without
// Durable's "Script completed|failed / Wall time / Output:" header (durable/src/codemode/output.ts).
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
	getTextOutput,
	lineText,
	moreLinesHint,
	type NestedCall,
	record,
	replaceTabs,
	safeText,
	str,
	type Theme,
	type ToolRenderContext,
	type ToolRenderers,
	VisualLinePreview,
} from "@p2/app/v1/tui";

const CODE_PREVIEW_LINES = 10;
const CALL_PREVIEW_COUNT = 8;
const OUTPUT_PREVIEW_LINES = 5;
const COLLAPSED_ARGS_CHARS = 80;
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n\n?/;

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statusIcon(call: NestedCall, theme: Theme): string {
	switch (call.status) {
		case "pending":
		case "running":
			return theme.fg("warning", "…");
		case "done":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "interrupted":
			return theme.fg("muted", "⊘");
	}
}

/** One line of a call's arguments: its JSON (as pi), or the cut JSON text a settled list keeps. */
function argsText(args: NestedCall["args"]): string {
	const text = typeof args === "string" ? args : JSON.stringify(args);
	return text === "{}" ? "" : lineText(text);
}

function formatCall(call: NestedCall, theme: Theme, expanded: boolean): string {
	const full = argsText(call.args);
	const args =
		!expanded && full.length > COLLAPSED_ARGS_CHARS ? `${full.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : full;
	const indent = "  ".repeat(call.depth);
	const duration = formatDuration(call.durationMs);
	let line = `${indent}${statusIcon(call, theme)} ${theme.fg("toolTitle", safeText(call.name))}`;
	if (args) line += ` ${theme.fg("muted", args)}`;
	if (duration) line += ` ${theme.fg("dim", duration)}`;
	if (call.error && (expanded || call.status === "error"))
		line += `\n${indent}    ${theme.fg(
			"error",
			safeText(expanded ? call.error : (call.error.split("\n")[0] ?? ""))
				.split("\n")
				.join(`\n${indent}    `),
		)}`;
	// A running call's newest output line, as the web card shows it.
	const live = call.status === "running" ? call.output?.trimEnd().split("\n").at(-1)?.trim() : undefined;
	if (live) line += `\n${indent}    ${theme.fg("dim", lineText(live))}`;
	return line;
}

function callLines(calls: readonly NestedCall[], theme: Theme, context: ToolRenderContext): string[] {
	const shown = context.expanded ? calls : calls.slice(-CALL_PREVIEW_COUNT);
	const lines = shown.map((call) => formatCall(call, theme, context.expanded));
	if (shown.length < calls.length)
		lines.unshift(moreLinesHint(context.ui, theme, calls.length - shown.length, "earlier calls"));
	return lines;
}

export const codemodeCard: ToolRenderers = {
	renderCall(args, theme, context) {
		const code = str(args.code);
		const title = theme.fg("toolTitle", theme.bold("codemode"));
		const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
		component.clear();
		if (code === null) {
			component.addChild(new Text(`${title} ${theme.fg("error", "[invalid arg]")}`, 0, 0));
			return component;
		}
		component.addChild(new Text(title, 0, 0));
		if (code) {
			const highlighted = theme.highlight(replaceTabs(safeText(code).trimEnd()), "javascript").join("\n");
			component.addChild(
				context.expanded
					? new Text(highlighted, 0, 0)
					: new VisualLinePreview({
							text: highlighted,
							maxVisualLines: CODE_PREVIEW_LINES,
							keep: "start",
							formatHint: (hidden) => moreLinesHint(context.ui, theme, hidden, "more lines"),
						}),
			);
		}
		return component;
	},
	renderResult(result, options, theme, context) {
		const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
		component.clear();
		const calls = context.calls ?? [];
		if (calls.length > 0) {
			component.addChild(new Spacer(1));
			component.addChild(new Text(callLines(calls, theme, context).join("\n"), 0, 0));
		}
		const output = options.isPartial ? "" : getTextOutput(result).replace(SCRIPT_HEADER, "").trim();
		if (output) {
			const color = context.isError ? "error" : "toolOutput";
			const styled = replaceTabs(output)
				.split("\n")
				.map((line) => theme.fg(color, line))
				.join("\n");
			component.addChild(new Spacer(1));
			if (options.expanded) component.addChild(new Text(styled, 0, 0));
			else {
				// Limit wrapped lines, not logical ones: script output is often one long JSON line.
				component.addChild(
					new VisualLinePreview({
						text: styled,
						maxVisualLines: OUTPUT_PREVIEW_LINES,
						keep: "start",
						formatHint: (hidden) => moreLinesHint(context.ui, theme, hidden, "more lines"),
					}),
				);
				const fullOutputPath = record(result.details)?.fullOutputPath;
				if (typeof fullOutputPath === "string")
					component.addChild(new Text(theme.fg("muted", `Full output: ${lineText(fullOutputPath)}`), 0, 0));
			}
		}
		return component;
	},
};
