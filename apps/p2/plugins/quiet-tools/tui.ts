// Quiet tool cards in the TUI: every tool call is one dim line (`› read src/foo.ts ✓`) without its output. A failed
// call, an expanded transcript (Ctrl+O) or a clicked line shows the tool's full content, drawn by the renderers this
// resolver wraps, without the card's box.

import { Box, type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { contribute, defineFacet } from "@p2/app/v1";
import {
	formatToolCallWithArgs,
	getTextOutput,
	lineText,
	moreLinesHint,
	pluginSetting,
	shortenPath,
	type ToolArgs,
	type ToolRenderContext,
	type ToolRendererResolver,
	type ToolRenderers,
	type TuiSettingField,
	TuiSettingFields,
	TuiToolRendererResolvers,
} from "@p2/app/v1/tui";

/** The `/settings` row: quiet (one line per call) or the tools' own cards. */
export const TOOL_CALLS: TuiSettingField = {
	plugin: "quiet-tools",
	name: "toolCalls",
	label: "Tool calls",
	description: "quiet: one line per call (Ctrl+O or a click shows it); full: the tools' own cards",
	values: ["quiet", "full"],
	fallback: "quiet",
};

/** Wraps every tool's renderers: one line while collapsed, the full content (without the box) when expanded or failed. */
export const quietTools: ToolRendererResolver = (name, next, settings) => {
	const full = next();
	if (pluginSetting(settings, TOOL_CALLS) === "full") return full;
	const isFull = (context: ToolRenderContext) => context.expanded || context.isError;
	return {
		// The card fixes its frame when created: no box, so a one-line call takes a blank line and the line.
		renderShell: "self",
		renderCall(args, theme, context) {
			if (isFull(context))
				return indent(
					(inner) =>
						full?.renderCall?.(args, theme, inner) ??
						new Text(formatToolCallWithArgs(name, args, theme, true), 0, 0),
					context,
				);
			const status = context.isPartial ? " …" : ` ✓${duration(context.durationMs)}`;
			const text = `${theme.fg("muted", "›")} ${theme.fg("muted", theme.bold(lineText(name)))} ${theme.fg("dim", `${summary(name, args, context)}${status}`)}`;
			return new OneLine(text, context.outputPad);
		},
		renderResult(result, options, theme, context) {
			if (!isFull(context)) return new Container();
			return indent((inner) => {
				if (full?.renderResult) return full.renderResult(result, options, theme, inner);
				// The card's own fallback for tools without a result renderer: the output, cut unless expanded.
				const lines = getTextOutput(result).split("\n");
				const shown = options.expanded ? lines : lines.slice(0, PREVIEW_LINES);
				const more = lines.length - shown.length;
				const text = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
				return new Text(more > 0 ? `${text}\n${moreLinesHint(context.ui, theme, more)}` : text, 0, 0);
			}, context);
		},
	} satisfies ToolRenderers;
	/** The wrapped content, indented as the card's box would: wrapped renderers see their own last component. */
	function indent(render: (context: ToolRenderContext) => Component, context: ToolRenderContext): Component {
		const last = context.lastComponent instanceof Indent ? context.lastComponent.children[0] : context.lastComponent;
		const content = render({ ...context, lastComponent: last });
		// A renderer that draws its own frame is already laid out.
		return full?.renderShell === "self" ? content : new Indent(content, context.outputPad);
	}
};

/** Pads the full content left and right, like the card's box without its background. */
class Indent extends Box {
	constructor(content: Component, pad: number) {
		super(pad, 0);
		this.addChild(content);
	}
}

const PREVIEW_LINES = 10;

/** One line cut to the width, indented like the answer's text. */
class OneLine implements Component {
	private text: string;
	private pad: number;
	constructor(text: string, pad: number) {
		this.text = text;
		this.pad = pad;
	}
	render(width: number): string[] {
		return [" ".repeat(this.pad) + truncateToWidth(this.text, Math.max(1, width - this.pad), "…")];
	}
	invalidate(): void {}
}

/** The argument that tells calls of a tool apart: a path, a command, a pattern, or code mode's calls. */
function summary(name: string, args: ToolArgs, context: ToolRenderContext): string {
	const path = (value: unknown) => lineText(shortenPath(value, context.cwd));
	switch (name) {
		case "read": {
			const offset = typeof args.offset === "number" ? `:${args.offset}` : "";
			return `${path(args.path ?? args.file_path)}${offset}`;
		}
		case "write":
		case "edit":
			return path(args.path ?? args.file_path);
		case "ls":
			return path(args.path) || ".";
		case "grep":
		case "find":
			return `${typeof args.pattern === "string" ? lineText(args.pattern) : ""}${args.path ? ` in ${path(args.path)}` : ""}`;
		case "bash":
		case "powershell":
			return firstLine(args.command);
		case "codemode": {
			const calls = context.calls ?? [];
			if (calls.length === 0) return firstLine(args.code);
			const names = [...new Set(calls.map((call) => lineText(call.name)))];
			return `${calls.length} call${calls.length === 1 ? "" : "s"}: ${names.join(", ")}`;
		}
		default: {
			const value = Object.values(args).find((arg) => typeof arg === "string" && arg.trim());
			return typeof value === "string" ? firstLine(value) : "";
		}
	}
}

/** The first non-empty line of a string argument, marked when more follow. */
function firstLine(value: unknown): string {
	if (typeof value !== "string") return "";
	const lines = value.split("\n").filter((line) => line.trim());
	return `${lineText(lines[0] ?? "").trim()}${lines.length > 1 ? " …" : ""}`;
}

/** A settled call's duration, when it took long enough to matter. */
function duration(ms: number | undefined): string {
	return ms !== undefined && ms >= 1000 ? ` ${(ms / 1000).toFixed(1)}s` : "";
}

export default defineFacet((host) =>
	contribute(host, "p2.tui-quiet-tools", (self) => {
		// Key 10 runs before other resolvers, so it wraps whatever they and the registry would draw.
		self.contribute(TuiToolRendererResolvers, { "10:quiet-tools": quietTools });
		self.contribute(TuiSettingFields, { "quiet-tools.toolCalls": TOOL_CALLS });
	}),
);
