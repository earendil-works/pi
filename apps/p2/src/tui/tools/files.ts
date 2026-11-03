// Copied from coding-agent core/tools/renderers/{read,write,edit,grep,find,ls}.ts. Removed (section 11): local path
// resolution, `getReadmePath` docs classification and edit's local preview (`computeEditsDiff` reads the local fs):
// the edit card shows the result's `details.diff`. Paths display relative to the session cwd.
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { renderDiff } from "../components/diff.ts";
import { safeText } from "../render-context.ts";
import { Theme } from "../theme/theme.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getTextOutput,
	invalidArgText,
	moreLinesHint,
	normalizeDisplayText,
	num,
	renderToolPath,
	replaceTabs,
	shortenPath,
	str,
	trimTrailingEmptyLines,
} from "./render-utils.ts";
import { record, type ToolArgs, type ToolRenderContext, type ToolRenderers, type ToolResultView } from "./types.ts";

const pathArg = (args: ToolArgs): string | null => str(args.file_path ?? args.path);
const textOf = (component: unknown): Text => (component instanceof Text ? component : new Text("", 0, 0));

/** Durable's truncation details (`ReadToolDetails`, grep/find/ls), read defensively. */
function truncationOf(details: unknown) {
	const truncation = record(record(details)?.truncation);
	if (!truncation || truncation.truncated !== true) return undefined;
	return {
		truncatedBy: truncation.truncatedBy,
		firstLineExceedsLimit: truncation.firstLineExceedsLimit === true,
		outputLines: num(truncation.outputLines) ?? 0,
		totalLines: num(truncation.totalLines) ?? 0,
		maxLines: num(truncation.maxLines) ?? DEFAULT_MAX_LINES,
		maxBytes: num(truncation.maxBytes) ?? DEFAULT_MAX_BYTES,
	};
}

function formatReadLineRange(args: ToolArgs, theme: Theme): string {
	const offset = num(args.offset);
	const limit = num(args.limit);
	if (offset === undefined && limit === undefined) return "";
	const startLine = offset ?? 1;
	const endLine = limit !== undefined ? startLine + limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadResult(result: ToolResultView, theme: Theme, context: ToolRenderContext): string {
	if (!context.expanded && !context.isError) return "";
	const rawPath = pathArg(context.args);
	const output = getTextOutput(result);
	const lang = !context.isError && rawPath ? Theme.language(rawPath) : undefined;
	const rendered = lang ? theme.highlight(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(rendered);
	const maxLines = context.expanded ? lines.length : 10;
	const remaining = lines.length - maxLines;
	let text = `\n${lines
		.slice(0, maxLines)
		.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))))
		.join("\n")}`;
	if (remaining > 0) text += `\n${moreLinesHint(context.ui, theme, remaining)}`;
	const truncation = truncationOf(result.details);
	if (truncation) {
		if (truncation.firstLineExceedsLimit)
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes)} limit]`)}`;
		else if (truncation.truncatedBy === "lines")
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines} line limit)]`)}`;
		else
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes)} limit)]`)}`;
	}
	return text;
}

export const readRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const text = textOf(context.lastComponent);
		text.setText(
			`${theme.fg("toolTitle", theme.bold("read"))} ${renderToolPath(pathArg(args), theme, context.cwd)}${formatReadLineRange(args, theme)}`,
		);
		return text;
	},
	renderResult(result, _options, theme, context) {
		const text = textOf(context.lastComponent);
		text.setText(formatReadResult(result, theme, context));
		return text;
	},
};

export const writeRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const rawPath = pathArg(args);
		const fileContent = str(args.content);
		let text = `${theme.fg("toolTitle", theme.bold("write"))} ${renderToolPath(rawPath, theme, context.cwd)}`;
		if (fileContent === null) text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
		else if (fileContent) {
			// Whole-file highlighting per update: p2 has no incremental highlight cache (the arguments arrive committed).
			const lang = rawPath ? Theme.language(rawPath) : undefined;
			const content = replaceTabs(normalizeDisplayText(safeText(fileContent)));
			const lines = trimTrailingEmptyLines(lang ? theme.highlight(content, lang) : content.split("\n"));
			const maxLines = context.expanded ? lines.length : 10;
			const remaining = lines.length - maxLines;
			text += `\n\n${lines
				.slice(0, maxLines)
				.map((line) => (lang ? line : theme.fg("toolOutput", line)))
				.join("\n")}`;
			if (remaining > 0)
				text += `\n${moreLinesHint(context.ui, theme, remaining, `more lines, ${lines.length} total`)}`;
		}
		const component = textOf(context.lastComponent);
		component.setText(text);
		return component;
	},
	renderResult(result, _options, theme, context) {
		const output = context.isError ? getTextOutput(result) : "";
		const component = textOf(context.lastComponent);
		component.setText(output ? `\n${theme.fg("error", output)}` : "");
		return component;
	},
};

export const editRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const text = textOf(context.lastComponent);
		text.setText(`${theme.fg("toolTitle", theme.bold("edit"))} ${renderToolPath(pathArg(args), theme, context.cwd)}`);
		return text;
	},
	renderResult(result, _options, theme, context) {
		const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
		component.clear();
		const diff = record(result.details)?.diff;
		const output = context.isError
			? theme.fg("error", getTextOutput(result))
			: typeof diff === "string"
				? renderDiff(safeText(diff), theme)
				: "";
		if (output) {
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 0, 0));
		}
		return component;
	},
};

/** grep/find/ls: a titled call line and a capped listing. */
function listingRenderers(
	name: string,
	call: (args: ToolArgs, theme: Theme, cwd: string) => string,
	previewLines: number,
	warnings: (details: Record<string, unknown> | undefined) => string[],
): ToolRenderers {
	return {
		renderCall(args, theme, context) {
			const text = textOf(context.lastComponent);
			text.setText(`${theme.fg("toolTitle", theme.bold(name))} ${call(args, theme, context.cwd)}`);
			return text;
		},
		renderResult(result, options, theme, context) {
			const output = getTextOutput(result).trim();
			let text = "";
			if (output) {
				const lines = output.split("\n");
				const maxLines = options.expanded ? lines.length : previewLines;
				const remaining = lines.length - maxLines;
				text += `\n${lines
					.slice(0, maxLines)
					.map((line) => theme.fg("toolOutput", line))
					.join("\n")}`;
				if (remaining > 0) text += `\n${moreLinesHint(context.ui, theme, remaining)}`;
			}
			const details = record(result.details);
			const notes = warnings(details);
			const truncation = truncationOf(details);
			if (truncation) notes.push(`${formatSize(truncation.maxBytes)} limit`);
			if (notes.length) text += `\n${theme.fg("warning", `[Truncated: ${notes.join(", ")}]`)}`;
			const component = textOf(context.lastComponent);
			component.setText(text);
			return component;
		},
	};
}

const pathIn = (args: ToolArgs, theme: Theme, cwd: string): string => {
	const rawPath = str(args.path);
	return theme.fg(
		"toolOutput",
		` in ${rawPath === null ? invalidArgText(theme) : safeText(shortenPath(rawPath || ".", cwd))}`,
	);
};

export const grepRenderers = listingRenderers(
	"grep",
	(args, theme, cwd) => {
		const pattern = str(args.pattern);
		const glob = str(args.glob);
		const limit = num(args.limit);
		return (
			(pattern === null ? invalidArgText(theme) : theme.fg("accent", `/${safeText(pattern)}/`)) +
			pathIn(args, theme, cwd) +
			(glob ? theme.fg("toolOutput", ` (${safeText(glob)})`) : "") +
			(limit !== undefined ? theme.fg("toolOutput", ` limit ${limit}`) : "")
		);
	},
	15,
	(details) => [
		...(num(details?.matchLimitReached) ? [`${num(details?.matchLimitReached)} matches limit`] : []),
		...(details?.linesTruncated ? ["some lines truncated"] : []),
	],
);

export const findRenderers = listingRenderers(
	"find",
	(args, theme, cwd) => {
		const pattern = str(args.pattern);
		const limit = num(args.limit);
		return (
			(pattern === null ? invalidArgText(theme) : theme.fg("accent", safeText(pattern))) +
			pathIn(args, theme, cwd) +
			(limit !== undefined ? theme.fg("toolOutput", ` (limit ${limit})`) : "")
		);
	},
	20,
	(details) => (num(details?.resultLimitReached) ? [`${num(details?.resultLimitReached)} results limit`] : []),
);

export const lsRenderers = listingRenderers(
	"ls",
	(args, theme, cwd) => {
		const rawPath = str(args.path);
		const limit = num(args.limit);
		return (
			(rawPath === null ? invalidArgText(theme) : theme.fg("accent", safeText(shortenPath(rawPath || ".", cwd)))) +
			(limit !== undefined ? theme.fg("toolOutput", ` (limit ${limit})`) : "")
		);
	},
	20,
	(details) => (num(details?.entryLimitReached) ? [`${num(details?.entryLimitReached)} entries limit`] : []),
);
