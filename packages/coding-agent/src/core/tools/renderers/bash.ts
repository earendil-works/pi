/**
 * Presentation for the shell tools.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `bash.ts` spreads these into the shell
 * tool definition, so the tool's public shape is unchanged.
 */

import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../../modes/interactive/components/visual-truncate.ts";
import {
	getLanguageFromPath,
	getThemeInstance,
	highlightCode,
	type Theme,
	theme,
} from "../../../modes/interactive/theme/theme.ts";
import { splitShellCommand } from "../../../utils/shell-embedded-code.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { BashToolDetails } from "../bash.ts";
import {
	getTextOutput,
	invalidArgText,
	type StreamingHighlight,
	str,
	updateStreamingHighlight,
} from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

const BASH_PREVIEW_LINES = 5;
/** Lines of each heredoc body or inline script shown before the call is expanded. */
const EMBEDDED_CODE_PREVIEW_LINES = 10;
export const BASH_UPDATE_THROTTLE_MS = 100;
type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};
class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}
function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;

	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;

	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}
function styleShellLines(text: string): string[] {
	return text.split("\n").map((line) => (line ? theme.fg("toolTitle", theme.bold(line)) : ""));
}
/** Style normalized embedded code. Data with no known language keeps the plain output color. */
function styleEmbeddedLines(code: string, language: string | undefined): string[] {
	if (!language) return code.split("\n").map((line) => theme.fg("toolOutput", line));
	return highlightCode(code, language);
}

/**
 * Lines to show for one embedded segment. The first line continues the preceding shell line and the
 * last line continues into the following shell text, so collapsed previews keep both and elide the
 * middle.
 */
function formatEmbeddedCode(lines: string[], expanded: boolean): string[] {
	const hidden = lines.length - 1 - EMBEDDED_CODE_PREVIEW_LINES;
	if (expanded || hidden <= 0) return lines;
	const hint = `${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	return [...lines.slice(0, EMBEDDED_CODE_PREVIEW_LINES), hint, lines[lines.length - 1]];
}

class ShellCallRenderComponent extends Text {
	theme: Theme | undefined;
	command: string | undefined;
	expanded = false;
	timeout: number | undefined;
	/** Formatted call text for the fields above. */
	rendered: string | undefined;
	/** Highlights of the embedded segments of `command`, in order. */
	embedded: StreamingHighlight[] = [];

	constructor() {
		super("", 0, 0);
	}
}

function formatShellCall(
	component: ShellCallRenderComponent,
	args: { command?: string; timeout?: number } | undefined,
	prompt: string,
	options: { expanded: boolean; embeddedCode: boolean; argsComplete: boolean },
): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	if (!command || !options.embeddedCode) {
		component.rendered = undefined;
		const commandDisplay =
			command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
		return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
	}

	const currentTheme = getThemeInstance();
	// renderCall also runs for every throttled output update with unchanged arguments. Reuse the text
	// unless the theme changed or the final arguments still need a full highlight.
	if (
		component.rendered !== undefined &&
		component.theme === currentTheme &&
		component.command === command &&
		component.expanded === options.expanded &&
		component.timeout === timeout &&
		(!options.argsComplete || component.embedded.every((entry) => entry.exact))
	) {
		return component.rendered;
	}

	const lines = [""];
	const append = (styled: string[]) => {
		lines[lines.length - 1] += styled[0] ?? "";
		for (let i = 1; i < styled.length; i++) lines.push(styled[i]);
	};
	append(styleShellLines(`${prompt} `));
	const embedded: StreamingHighlight[] = [];
	for (const segment of splitShellCommand(command, { languageFromPath: getLanguageFromPath })) {
		if (!segment.embedded) {
			append(styleShellLines(segment.text));
			continue;
		}
		const language = segment.language;
		const highlight = updateStreamingHighlight(component.embedded[embedded.length], segment.text, {
			language,
			theme: currentTheme,
			complete: options.argsComplete,
			highlight: (code) => styleEmbeddedLines(code, language),
		});
		embedded.push(highlight);
		append(formatEmbeddedCode(highlight.highlighted, options.expanded));
	}

	component.theme = currentTheme;
	component.command = command;
	component.expanded = options.expanded;
	component.timeout = timeout;
	component.embedded = embedded;
	component.rendered = lines.join("\n") + timeoutSuffix;
	return component.rendered;
}
function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

/**
 * Shell renderers are shared by bash and powershell. `embeddedCode` highlights heredoc bodies and
 * inline scripts, which is only implemented for POSIX shell syntax.
 */
export function createShellRenderers(
	prompt: string,
	options: { embeddedCode: boolean },
): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
	return {
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const component =
				(context.lastComponent as ShellCallRenderComponent | undefined) ?? new ShellCallRenderComponent();
			const previous = component.rendered;
			const text = formatShellCall(component, args as { command?: string; timeout?: number } | undefined, prompt, {
				expanded: context.expanded,
				embeddedCode: options.embeddedCode,
				argsComplete: context.argsComplete,
			});
			// setText drops the wrapped-line cache, so skip it when output updates leave the call unchanged.
			if (text !== previous) component.setText(text);
			return component;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}
