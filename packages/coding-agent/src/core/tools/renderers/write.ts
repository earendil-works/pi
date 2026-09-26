/**
 * Presentation for the write tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `write.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import {
	getLanguageFromPath,
	getThemeInstance,
	highlightCode,
	type Theme,
} from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import {
	normalizeDisplayText,
	renderToolPath,
	replaceTabs,
	type StreamingHighlight,
	str,
	updateStreamingHighlight,
} from "../render-utils.ts";

class WriteCallRenderComponent extends Text {
	cache?: StreamingHighlight;

	constructor() {
		super("", 0, 0);
	}
}
function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}
function formatWriteCall(
	args: { path?: string; file_path?: string; content?: string } | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	cache: StreamingHighlight | undefined,
	cwd: string,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const fileContent = str(args?.content);
	const pathDisplay = renderToolPath(rawPath, theme, cwd);
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}`;

	if (fileContent === null) {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
	} else if (fileContent) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const renderedLines = lang
			? (cache?.highlighted ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
			: normalizeDisplayText(fileContent).split("\n");
		const lines = trimTrailingEmptyLines(renderedLines);
		const totalLines = lines.length;
		const maxLines = options.expanded ? lines.length : 10;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	return text;
}
function formatWriteResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean },
	theme: Theme,
): string | undefined {
	if (!result.isError) {
		return undefined;
	}
	const output = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("\n");
	if (!output) {
		return undefined;
	}
	return `\n${theme.fg("error", output)}`;
}

export const writeRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const renderArgs = args as { path?: string; file_path?: string; content?: string } | undefined;
		const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
		const fileContent = str(renderArgs?.content);
		const component =
			(context.lastComponent as WriteCallRenderComponent | undefined) ?? new WriteCallRenderComponent();
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		component.cache =
			fileContent !== null && lang
				? updateStreamingHighlight(component.cache, fileContent, {
						language: lang,
						theme: getThemeInstance(),
						complete: context.argsComplete,
						highlight: (code) => highlightCode(code, lang),
					})
				: undefined;
		component.setText(
			formatWriteCall(
				renderArgs,
				{ expanded: context.expanded, isPartial: context.isPartial },
				theme,
				component.cache,
				context.cwd,
			),
		);
		return component;
	},
	renderResult(result, _options, theme, context) {
		const output = formatWriteResult({ ...result, isError: context.isError }, theme);
		if (!output) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			return component;
		}
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(output);
		return text;
	},
};
