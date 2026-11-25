// The TUI facet: the tool's card in the terminal transcript.
import { Text } from "@earendil-works/pi-tui";
import { contribute, defineFacet } from "@p2/app/v1";
import { getTextOutput, lineText, record, str, type ToolRenderers, TuiToolRenderers } from "@p2/app/v1/tui";

export const wordCountRenderers: ToolRenderers = {
	renderCall: (args, theme) =>
		new Text(
			`${theme.fg("toolTitle", theme.bold("word_count"))} ${theme.fg("muted", lineText(str(args.text) ?? ""))}`,
			0,
			0,
		),
	renderResult: (result, _options, theme, context) => {
		const details = record(result.details);
		const counts =
			typeof details?.words === "number" ? `${details.words} words, ${details.lines} lines` : getTextOutput(result);
		return new Text(theme.fg(context.isError ? "error" : "toolOutput", counts), 0, 0);
	},
};

export default defineFacet((host) => {
	contribute(host, "p2.tui-word-count", (self) => {
		self.contribute(TuiToolRenderers, { word_count: wordCountRenderers });
	});
});
