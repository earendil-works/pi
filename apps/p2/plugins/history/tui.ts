// History tool cards in the TUI (docs/history-tool.md section 5), after the web's: a search names its query and hit
// count, a read its mode and count, a handoff its text; expanded, the hit and entry lines.
import { Text } from "@earendil-works/pi-tui";
import { contribute, defineFacet } from "@p2/app/v1";
import { getTextOutput, lineText, record, str, type ToolRenderers, TuiToolRenderers } from "@p2/app/v1/tui";
import { HISTORY_HANDOFF, HISTORY_READ, HISTORY_SEARCH } from "./tools.ts";

type Row = { entry: number; role: string; author?: string; text: string };

/** The hit or entry rows of a card's details. */
function rows(value: unknown, field: "snippet" | "preview"): Row[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((each) => {
		const row = record(each);
		if (typeof row?.entry !== "number") return [];
		return [
			{
				entry: row.entry,
				role: String(row.role ?? ""),
				...(typeof row.author === "string" ? { author: row.author } : {}),
				text: String(row[field] ?? ""),
			},
		];
	});
}

const text = (context: { lastComponent?: unknown }) =>
	context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);

function listRenderers(name: string, field: "snippet" | "preview", list: "hits" | "entries"): ToolRenderers {
	return {
		renderCall(args, theme, context) {
			const component = text(context);
			const what =
				name === HISTORY_SEARCH
					? lineText(str(args.query) ?? "")
					: `${str(args.mode) ?? ""}${typeof args.from === "number" ? ` from #${args.from}` : ""}`;
			component.setText(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", what)}`);
			return component;
		},
		renderResult(result, options, theme, context) {
			const component = text(context);
			if (context.isError) {
				component.setText(`\n${theme.fg("error", getTextOutput(result))}`);
				return component;
			}
			const details = record(result.details);
			const found = rows(details?.[list], field);
			const marks = [
				`${found.length} ${list === "hits" ? (found.length === 1 ? "hit" : "hits") : found.length === 1 ? "entry" : "entries"}`,
				...(details?.more === true ? ["more"] : []),
				...(details?.truncated === true ? ["truncated"] : []),
			];
			const lines = options.expanded
				? found.map(
						(row) =>
							`${theme.fg("dim", `#${row.entry}`)} ${theme.fg("muted", row.author ?? row.role)} ${lineText(row.text)}`,
					)
				: [];
			component.setText(`\n${theme.fg("muted", marks.join(" · "))}${lines.length ? `\n${lines.join("\n")}` : ""}`);
			return component;
		},
	};
}

const handoffRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const component = text(context);
		const first = (str(args.text) ?? "").split("\n").find((line) => line.trim()) ?? "";
		component.setText(`${theme.fg("toolTitle", theme.bold(HISTORY_HANDOFF))} ${lineText(first)}`);
		return component;
	},
	renderResult(result, options, theme, context) {
		if (context.isError) {
			const component = text(context);
			component.setText(`\n${theme.fg("error", getTextOutput(result))}`);
			return component;
		}
		const handoff = str(record(result.details)?.text) ?? "";
		const note = theme.fg("muted", "New context started; earlier history stays searchable.");
		const component = text(context);
		const lines = options.expanded ? handoff.split("\n").map((line) => lineText(line)) : [];
		component.setText(`\n${[...lines, note].join("\n")}`);
		return component;
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-history", (self) => {
		self.contribute(TuiToolRenderers, {
			[HISTORY_SEARCH]: listRenderers(HISTORY_SEARCH, "snippet", "hits"),
			[HISTORY_READ]: listRenderers(HISTORY_READ, "preview", "entries"),
			[HISTORY_HANDOFF]: handoffRenderers,
		});
	}),
);
