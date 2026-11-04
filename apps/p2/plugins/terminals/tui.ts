// The terminal tool's card in the TUI: the tmux command line, then the output it returned (the last lines; expanded,
// all of it). The TUI has no terminal panel: the owner watches agent terminals in the web.

import { Text } from "@earendil-works/pi-tui";
import { contribute, defineFacet } from "@p2/app/v1";
import { getTextOutput, lineText, str, type ToolRenderers, TuiToolRenderers } from "@p2/app/v1/tui";

/** Collapsed cards show the last lines of the output; expanded ones all. */
const PREVIEW_LINES = 8;

const terminalRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		const argv = Array.isArray(args.args) ? args.args.map(str) : [];
		const line = [str(args.command), ...argv].join(" ") || "...";
		text.setText(`${theme.fg("toolTitle", theme.bold("terminal"))} ${theme.fg("accent", lineText(line))}`);
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		const all = getTextOutput(result)
			.split("\n")
			.map((line) => theme.fg(context.isError ? "error" : "toolOutput", lineText(line)));
		const shown = options.expanded ? all : all.slice(-PREVIEW_LINES);
		const hidden = all.length - shown.length;
		text.setText(
			`\n${[
				...(hidden > 0
					? [
							theme.fg(
								"muted",
								`... (${hidden} earlier lines, ${context.ui.keyText("app.tools.expand")} to expand)`,
							),
						]
					: []),
				...shown,
			].join("\n")}`,
		);
		return text;
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-terminals", (self) => {
		self.contribute(TuiToolRenderers, { terminal: terminalRenderers });
	}),
);
