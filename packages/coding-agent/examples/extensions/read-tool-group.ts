/**
 * Read Tool Group Example - Group consecutive read calls into one compact block
 *
 * Demonstrates the tool group API added by `registerToolGroup()`.
 * Instead of overriding the `read` tool or tracking batches through event hooks,
 * this example lets the framework group consecutive `read` calls and render them
 * through a single component.
 *
 * What this shows:
 * - `registerToolGroup()` with a simple `match()` function
 * - Rendering a grouped summary from `members`
 * - Collapsed vs expanded output via `context.expanded`
 * - Pending, success, image, and failure states per member
 *
 * Usage:
 *   pi -e ./read-tool-group.ts
 */

import * as nodePath from "node:path";
import type { ExtensionAPI, ReadToolDetails, ToolGroupMember } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

type ThemeLike = {
	bold: (text: string) => string;
	fg: (color: "accent" | "dim" | "muted" | "success" | "text" | "warning", text: string) => string;
};

type ToolContentBlock = {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
};

function pluralizeFiles(count: number): string {
	return `${count} file${count === 1 ? "" : "s"}`;
}

function pluralizeLines(count: number): string {
	return `${count} line${count === 1 ? "" : "s"}`;
}

function isWithinDirectory(absolutePath: string, cwd: string): boolean {
	const relativePath = nodePath.relative(cwd, absolutePath);
	return relativePath === "" || (!relativePath.startsWith("..") && !nodePath.isAbsolute(relativePath));
}

function toDisplaySeparators(path: string): string {
	return path.replaceAll("\\", "/");
}

function normalizeDisplayPath(inputPath: unknown, cwd: string = process.cwd()): string {
	if (typeof inputPath !== "string") return "(unknown path)";

	const trimmed = inputPath.trim();
	const stripped = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
	if (!stripped) return "(unknown path)";

	const absolutePath = nodePath.isAbsolute(stripped) ? nodePath.normalize(stripped) : nodePath.resolve(cwd, stripped);

	if (isWithinDirectory(absolutePath, cwd)) {
		const relativePath = nodePath.relative(cwd, absolutePath);
		return toDisplaySeparators(relativePath || ".");
	}

	return toDisplaySeparators(absolutePath);
}

function stylePath(path: string, theme: ThemeLike): string {
	const normalizedPath = toDisplaySeparators(path);
	const segments = normalizedPath.split("/").filter(Boolean);
	if (segments.length <= 1) {
		return theme.fg("accent", normalizedPath);
	}

	const fileName = segments[segments.length - 1] ?? normalizedPath;
	const directory = segments.slice(0, -1).join("/");
	return `${theme.fg("dim", `${directory}/`)}${theme.fg("accent", fileName)}`;
}

function getTextContent(content: ToolContentBlock[] | undefined): string | undefined {
	if (!content) return undefined;
	const textBlock = content.find((block) => block.type === "text" && typeof block.text === "string");
	return textBlock?.text;
}

function extractLineCountFromText(text: string): number {
	const showingMatch = text.match(
		/\[Showing lines (\d+)-(\d+) of \d+(?: \([^)]+\))?\. Use offset=\d+ to continue\.\]\s*$/,
	);
	if (showingMatch) {
		const start = Number.parseInt(showingMatch[1], 10);
		const end = Number.parseInt(showingMatch[2], 10);
		if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
			return end - start + 1;
		}
	}

	const textWithoutNotice = text
		.replace(/\n\n\[Showing lines \d+-\d+ of \d+(?: \([^)]+\))?\. Use offset=\d+ to continue\.\]\s*$/, "")
		.replace(/\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]\s*$/, "");

	if (!textWithoutNotice) {
		return 0;
	}

	return textWithoutNotice.split("\n").length;
}

function extractReadLineCount(member: ToolGroupMember): number | undefined {
	const details = member.result?.details as ReadToolDetails | undefined;
	if (details?.truncation && typeof details.truncation.outputLines === "number") {
		return details.truncation.outputLines;
	}

	const text = getTextContent(member.result?.content as ToolContentBlock[] | undefined);
	if (typeof text !== "string") {
		return undefined;
	}

	return extractLineCountFromText(text);
}

function isImageResult(member: ToolGroupMember): boolean {
	return (member.result?.content as ToolContentBlock[] | undefined)?.some((block) => block.type === "image") === true;
}

function getPreviewText(member: ToolGroupMember): string | undefined {
	const text = getTextContent(member.result?.content as ToolContentBlock[] | undefined);
	if (!text) return undefined;

	const firstMeaningfulLine = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstMeaningfulLine) return undefined;

	return firstMeaningfulLine.length > 80 ? `${firstMeaningfulLine.slice(0, 77)}...` : firstMeaningfulLine;
}

type AggregatedReadEntry = {
	path: string;
	totalLineCount: number;
	hasError: boolean;
	hasImage: boolean;
	hasPending: boolean;
	previewText?: string;
};

function aggregateMembersByPath(members: ToolGroupMember[], cwd: string): AggregatedReadEntry[] {
	const entries = new Map<string, AggregatedReadEntry>();

	for (const member of members) {
		const rawPath = (member.args as { path?: unknown } | undefined)?.path;
		const path = normalizeDisplayPath(rawPath, cwd);
		let entry = entries.get(path);
		if (!entry) {
			entry = {
				path,
				totalLineCount: 0,
				hasError: false,
				hasImage: false,
				hasPending: false,
			};
			entries.set(path, entry);
		}

		const lineCount = extractReadLineCount(member);
		if (typeof lineCount === "number") {
			entry.totalLineCount += lineCount;
		}

		if (member.result?.isError) {
			entry.hasError = true;
		}
		if (isImageResult(member)) {
			entry.hasImage = true;
		}
		if (member.isPartial) {
			entry.hasPending = true;
		}

		const previewText = getPreviewText(member);
		if (previewText) {
			entry.previewText = previewText;
		}
	}

	return Array.from(entries.values());
}

function getEntryStatus(entry: AggregatedReadEntry, theme: ThemeLike): string {
	if (entry.hasError) {
		return `${theme.fg("dim", "[")}${theme.fg("warning", "Read failed")}${theme.fg("dim", "]")}`;
	}

	if (entry.hasImage) {
		return `${theme.fg("dim", "[")}${theme.fg("muted", "Read image")}${theme.fg("dim", "]")}`;
	}

	if (entry.totalLineCount > 0) {
		return `${theme.fg("dim", "[")}${theme.fg("muted", `Read ${pluralizeLines(entry.totalLineCount)}`)}${theme.fg("dim", "]")}`;
	}

	if (entry.hasPending) {
		return `${theme.fg("dim", "[")}${theme.fg("muted", "Reading...")}${theme.fg("dim", "]")}`;
	}

	return `${theme.fg("dim", "[")}${theme.fg("muted", "Read file")}${theme.fg("dim", "]")}`;
}

export default function readToolGroupExample(pi: ExtensionAPI) {
	pi.registerToolGroup({
		name: "read-summary",
		lifecycle: { scope: "toolRun" },
		match: (toolName) => toolName === "read",
		render: (members, theme, context) => {
			return {
				render(width: number): string[] {
					const safeWidth = Math.max(1, width);
					const entries = aggregateMembersByPath(members, context.cwd);
					const fileCount = entries.length;
					const failedCount = entries.filter((entry) => entry.hasError).length;
					const completeCount = members.filter((member) => !member.isPartial).length;
					const allComplete = completeCount === members.length;

					const statusDot = allComplete ? theme.fg("success", "●") : theme.fg("text", "○");
					const statusText = allComplete
						? theme.fg("success", `Read ${pluralizeFiles(fileCount)}`)
						: theme.fg("accent", `Reading ${pluralizeFiles(fileCount)}...`);

					let header = `${statusDot} ${theme.bold(statusText)}`;
					if (failedCount > 0) {
						header += ` ${theme.fg("warning", `(${failedCount} failed)`)}`;
					}

					const lines = [truncateToWidth(header, safeWidth)];

					for (const entry of entries) {
						const pathLabel = stylePath(entry.path, theme);
						const status = getEntryStatus(entry, theme);
						lines.push(truncateToWidth(`${theme.fg("dim", "└─ ")}${pathLabel} ${status}`, safeWidth));

						if (context.expanded && entry.previewText) {
							lines.push(
								truncateToWidth(`${theme.fg("dim", "   ")} ${theme.fg("muted", entry.previewText)}`, safeWidth),
							);
						}
					}

					return lines;
				},
				invalidate() {},
			};
		},
	});
}
