/**
 * Presentation for the codemode tool.
 *
 * The call shows the script; the result lists the nested tool calls with their status as they
 * run, followed by the script output. Nested calls are not separate tool rows because they never
 * reach the model as tool calls.
 */

import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { highlightCode, type Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { CodemodeNestedCall, CodemodeToolDetails } from "../codemode.ts";
import { getTextOutput, replaceTabs, str } from "../render-utils.ts";

const CODE_PREVIEW_LINES = 10;
const CALL_PREVIEW_COUNT = 8;
const OUTPUT_PREVIEW_LINES = 5;
const COLLAPSED_ARGS_CHARS = 80;

function expandHint(theme: Theme, hidden: number, noun: string): string {
	return `${theme.fg("muted", `... (${hidden} more ${noun},`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statusIcon(call: CodemodeNestedCall, theme: Theme): string {
	switch (call.status) {
		case "running":
			return theme.fg("warning", "…");
		case "ok":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("muted", "⊘");
	}
}

function formatCall(call: CodemodeNestedCall, theme: Theme, expanded: boolean): string {
	const args =
		!expanded && call.args.length > COLLAPSED_ARGS_CHARS
			? `${call.args.slice(0, COLLAPSED_ARGS_CHARS - 3)}...`
			: call.args;
	const duration = formatDuration(call.durationMs);
	let line = `${statusIcon(call, theme)} ${theme.fg("toolTitle", call.name)}`;
	if (args) line += ` ${theme.fg("muted", args)}`;
	if (duration) line += ` ${theme.fg("dim", duration)}`;
	if (expanded && call.error) line += `\n    ${theme.fg("error", call.error.split("\n").join("\n    "))}`;
	return line;
}

export const codemodeRenderers: Pick<
	ToolDefinition<any, CodemodeToolDetails | undefined>,
	"renderCall" | "renderResult"
> = {
	renderCall(args, theme, context) {
		// The code includes the `// @options` line, so options show as part of the script.
		const code = str((args as { code?: unknown } | undefined)?.code);
		let text = theme.fg("toolTitle", theme.bold("codemode"));
		if (code === null) {
			text += ` ${theme.fg("error", "[invalid arg]")}`;
		} else if (code) {
			const lines = highlightCode(replaceTabs(code.replace(/\r/g, "").trimEnd()), "javascript");
			const shown = context.expanded ? lines : lines.slice(0, CODE_PREVIEW_LINES);
			text += `\n${shown.join("\n")}`;
			if (shown.length < lines.length) text += `\n${expandHint(theme, lines.length - shown.length, "lines")}`;
		}
		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		component.setText(text);
		return component;
	},
	renderResult(result, options, theme, context) {
		const sections: string[] = [];
		const calls = result.details?.calls ?? [];
		if (calls.length > 0) {
			const shown = options.expanded ? calls : calls.slice(-CALL_PREVIEW_COUNT);
			const lines = shown.map((call) => formatCall(call, theme, options.expanded));
			if (shown.length < calls.length) {
				lines.unshift(
					`${theme.fg("muted", `... (${calls.length - shown.length} earlier calls,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
				);
			}
			sections.push(lines.join("\n"));
		}

		const output = options.isPartial ? "" : getTextOutput(result, context.showImages).trim();
		if (output) {
			const color = context.isError ? "error" : "toolOutput";
			const lines = replaceTabs(output).split("\n");
			const shown = options.expanded ? lines : lines.slice(0, OUTPUT_PREVIEW_LINES);
			// Highlighting only the visible slice is safe for JSON: no token spans a newline.
			const jsonCount = context.isError ? 0 : Math.min(result.details?.jsonLines ?? 0, shown.length);
			const styled = [
				...(jsonCount > 0 ? highlightCode(shown.slice(0, jsonCount).join("\n"), "json") : []),
				...shown.slice(jsonCount).map((line) => theme.fg(color, line)),
			];
			let text = styled.join("\n");
			if (shown.length < lines.length) text += `\n${expandHint(theme, lines.length - shown.length, "lines")}`;
			// The collapsed preview hides the truncation notice at the end, so name the file here.
			const fullOutputPath = result.details?.fullOutputPath;
			if (fullOutputPath && !options.expanded)
				text += `\n${theme.fg("muted", `Full return value: ${fullOutputPath}`)}`;
			sections.push(text);
		}

		const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		component.setText(sections.length > 0 ? `\n${sections.join("\n\n")}` : "");
		return component;
	},
};
