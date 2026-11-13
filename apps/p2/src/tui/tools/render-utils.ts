// Copied from coding-agent core/tools/render-utils.ts without `node:os` homedir, `pathToFileURL` hyperlinks or local
// path resolution (section 11): paths display relative to the session cwd. Output text is sanitized server text.
import { getImageDimensions, imageFallback } from "@earendil-works/pi-tui";
import { keyHint, type RenderContext, safeText } from "../render-context.ts";
import type { Theme } from "../theme/theme.ts";
import type { ToolResultView } from "./types.ts";

/** Paths under the session cwd display relative to it. */
export function shortenPath(path: unknown, cwd = ""): string {
	if (typeof path !== "string") return "";
	const root = cwd.replace(/\/+$/, "");
	if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
	return path;
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

/** Text of a result with image placeholders (the worker never draws images). */
export function getTextOutput(result: ToolResultView | undefined): string {
	if (!result) return "";
	let output = result.content
		.flatMap((part) => (part.type === "text" ? [safeText(part.text)] : []))
		.join("\n")
		.replace(/\r/g, "");
	const images = result.content.flatMap((part) => (part.type === "image" ? [part] : []));
	if (images.length > 0) {
		const indicators = images
			.map((image) =>
				imageFallback(
					safeText(image.mimeType ?? "image/unknown"),
					image.data ? (getImageDimensions(image.data, image.mimeType) ?? undefined) : undefined,
				),
			)
			.join("\n");
		output = output ? `${output}\n${indicators}` : indicators;
	}
	return output;
}

const COLLAPSED_ARGS_CHARS = 100;

/** Generic tool call header: the title followed by the arguments (collapsed `key=value`, expanded `key: value` lines). */
export function formatToolCallWithArgs(title: string, args: unknown, theme: Theme, expanded: boolean): string {
	const header = theme.fg("toolTitle", theme.bold(safeText(title)));
	if (args == null) return header;
	const entries =
		typeof args === "object" && !Array.isArray(args)
			? Object.entries(args)
			: ([["args", args]] as [string, unknown][]);
	if (entries.length === 0) return header;
	if (expanded) {
		const lines = entries.map(([key, value]) => {
			const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			return `  ${key}: ${replaceTabs(safeText(text)).split("\n").join("\n    ")}`;
		});
		return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
	}
	const pairs = safeText(
		entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" "),
	).replace(/\n/g, " ");
	const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
	return `${header} ${theme.fg("muted", preview)}`;
}

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return theme.fg("accent", safeText(shortenPath(value, cwd)));
}

/** "... (N more lines, ctrl+o to expand)" */
export function moreLinesHint(ui: RenderContext, theme: Theme, remaining: number, noun = "more lines"): string {
	return `${theme.fg("muted", `... (${remaining} ${noun},`)} ${keyHint(ui, "app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

/** Durable's `formatSize` (truncate.ts). */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Durable's DEFAULT_MAX_BYTES / DEFAULT_MAX_LINES. */
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;

export function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}
