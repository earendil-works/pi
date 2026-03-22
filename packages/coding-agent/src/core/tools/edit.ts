import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Container, Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { renderDiff } from "../../modes/interactive/components/diff.js";
import type { ToolDefinition } from "../extensions/types.js";
import {
	computeEditDiff,
	detectLineEnding,
	type EditDiffError,
	type EditDiffResult,
	fuzzyFindText,
	generateDiffString,
	normalizeForFuzzyMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import { invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

type EditRenderState = {
	argsKey?: string;
	preview?: EditDiffResult | EditDiffError;
};

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
});

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
	/** Unified diff of the changes made */
	diff: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
}

function formatEditCall(
	args: { path?: string; file_path?: string; oldText?: string; newText?: string } | undefined,
	state: EditRenderState,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const invalidArg = invalidArgText(theme);
	const rawPath = str(args?.file_path ?? args?.path);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	let text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

	if (state.preview) {
		if ("error" in state.preview) {
			text += `\n\n${theme.fg("error", state.preview.error)}`;
		} else if (state.preview.diff) {
			text += `\n\n${renderDiff(state.preview.diff, { filePath: rawPath ?? undefined })}`;
		}
	}

	return text;
}

function formatEditResult(
	args: { path?: string; file_path?: string; oldText?: string; newText?: string } | undefined,
	state: EditRenderState,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: EditToolDetails;
	},
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		return errorText ? `\n${theme.fg("error", errorText)}` : undefined;
	}

	const previewDiff = state.preview && !("error" in state.preview) ? state.preview.diff : undefined;
	const resultDiff = result.details?.diff;
	if (!resultDiff || resultDiff === previewDiff) {
		return undefined;
	}
	return `\n${renderDiff(resultDiff, { filePath: rawPath ?? undefined })}`;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		promptSnippet: "Make surgical edits to files (find exact text and replace)",
		promptGuidelines: ["Use edit for precise changes (old text must match exactly)."],
		parameters: editSchema,
		async execute(
			_toolCallId,
			{ path, oldText, newText }: { path: string; oldText: string; newText: string },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			const absolutePath = resolveToCwd(path, cwd);

			return withFileMutationQueue(
				absolutePath,
				() =>
					new Promise<{
						content: Array<{ type: "text"; text: string }>;
						details: EditToolDetails | undefined;
					}>((resolve, reject) => {
						// Check if already aborted.
						if (signal?.aborted) {
							reject(new Error("Operation aborted"));
							return;
						}

						let aborted = false;

						// Set up abort handler.
						const onAbort = () => {
							aborted = true;
							reject(new Error("Operation aborted"));
						};

						if (signal) {
							signal.addEventListener("abort", onAbort, { once: true });
						}

						// Perform the edit operation.
						(async () => {
							try {
								// Check if file exists.
								try {
									await ops.access(absolutePath);
								} catch {
									if (signal) {
										signal.removeEventListener("abort", onAbort);
									}
									reject(new Error(`File not found: ${path}`));
									return;
								}

								// Check if aborted before reading.
								if (aborted) {
									return;
								}

								// Read the file.
								const buffer = await ops.readFile(absolutePath);
								const rawContent = buffer.toString("utf-8");

								// Check if aborted after reading.
								if (aborted) {
									return;
								}

								// Strip BOM before matching. The model will not include an invisible BOM in oldText.
								const { bom, text: content } = stripBom(rawContent);

								const originalEnding = detectLineEnding(content);
								const normalizedContent = normalizeToLF(content);
								const normalizedOldText = normalizeToLF(oldText);
								const normalizedNewText = normalizeToLF(newText);

								// Find the old text using fuzzy matching. This tries exact match first, then a normalized fallback.
								const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);

								if (!matchResult.found) {
									if (signal) {
										signal.removeEventListener("abort", onAbort);
									}
									reject(
										new Error(
											`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
										),
									);
									return;
								}

								// Count occurrences using fuzzy-normalized content for consistency with the matcher.
								const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
								const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
								const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;

								if (occurrences > 1) {
									if (signal) {
										signal.removeEventListener("abort", onAbort);
									}
									reject(
										new Error(
											`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
										),
									);
									return;
								}

								// Check if aborted before writing.
								if (aborted) {
									return;
								}

								// Perform replacement using the matched text position.
								// When fuzzy matching was used, contentForReplacement is the normalized version.
								const baseContent = matchResult.contentForReplacement;
								const newContent =
									baseContent.substring(0, matchResult.index) +
									normalizedNewText +
									baseContent.substring(matchResult.index + matchResult.matchLength);

								// Verify the replacement actually changed something.
								if (baseContent === newContent) {
									if (signal) {
										signal.removeEventListener("abort", onAbort);
									}
									reject(
										new Error(
											`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
										),
									);
									return;
								}

								const finalContent = bom + restoreLineEndings(newContent, originalEnding);
								await ops.writeFile(absolutePath, finalContent);

								// Check if aborted after writing.
								if (aborted) {
									return;
								}

								// Clean up abort handler.
								if (signal) {
									signal.removeEventListener("abort", onAbort);
								}

								const diffResult = generateDiffString(baseContent, newContent);
								resolve({
									content: [
										{
											type: "text",
											text: `Successfully replaced text in ${path}.`,
										},
									],
									details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
								});
							} catch (error: any) {
								// Clean up abort handler.
								if (signal) {
									signal.removeEventListener("abort", onAbort);
								}

								if (!aborted) {
									reject(error);
								}
							}
						})();
					}),
			);
		},
		renderCall(args, theme, context) {
			const isSingleMode =
				typeof args?.path === "string" && typeof args?.oldText === "string" && typeof args?.newText === "string";
			if (context.argsComplete && isSingleMode) {
				const argsKey = JSON.stringify({ path: args.path, oldText: args.oldText, newText: args.newText });
				if (context.state.argsKey !== argsKey) {
					context.state.argsKey = argsKey;
					computeEditDiff(args.path!, args.oldText!, args.newText!, context.cwd).then((preview) => {
						if (context.state.argsKey === argsKey) {
							context.state.preview = preview;
							context.invalidate();
						}
					});
				}
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatEditCall(args, context.state, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const output = formatEditResult(context.args, context.state, result as any, theme, context.isError);
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
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}

/** Default edit tool using process.cwd() for backwards compatibility. */
export const editToolDefinition = createEditToolDefinition(process.cwd());
export const editTool = createEditTool(process.cwd());
