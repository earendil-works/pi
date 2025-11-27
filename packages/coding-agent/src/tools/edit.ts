import * as os from "node:os";
import type { AgentTool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile, writeFile } from "fs/promises";
import { resolve as resolvePath } from "path";

/**
 * Expand ~ to home directory
 */
function expandPath(filePath: string): string {
	if (filePath === "~") {
		return os.homedir();
	}
	if (filePath.startsWith("~/")) {
		return os.homedir() + filePath.slice(1);
	}
	return filePath;
}

/**
 * Generate a unified diff string with line numbers and context
 */
function generateDiffString(oldContent: string, newContent: string, contextLines = 4): string {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				// Show context
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!lastWasChange) {
					// Show only last N lines as leading context
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}

				if (!nextPartIsChange && linesToShow.length > contextLines) {
					// Show only first N lines as trailing context
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				// Add ellipsis if we skipped lines at start
				if (skipStart > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					// Update line numbers for the skipped leading context
					oldLineNum += skipStart;
					newLineNum += skipStart;
				}

				for (const line of linesToShow) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				// Add ellipsis if we skipped lines at end
				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					// Update line numbers for the skipped trailing context
					oldLineNum += skipEnd;
					newLineNum += skipEnd;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return output.join("\n");
}

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
	newText: Type.String({ description: "New text to replace the old text with" }),
});

export const editTool: AgentTool<typeof editSchema> = {
	name: "edit",
	label: "edit",
	description:
		"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
	parameters: editSchema,
	execute: async (
		_toolCallId: string,
		{ path, oldText, newText }: { path: string; oldText: string; newText: string },
		signal?: AbortSignal,
	) => {
		const absolutePath = resolvePath(expandPath(path));

		return new Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: { diff: string } | undefined;
		}>((resolve, reject) => {
			// Check if already aborted
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}

			let aborted = false;

			// Set up abort handler
			const onAbort = () => {
				aborted = true;
				reject(new Error("Operation aborted"));
			};

			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}

			// Perform the edit operation
			(async () => {
				try {
					// Check if file exists
					try {
						await access(absolutePath, constants.R_OK | constants.W_OK);
					} catch {
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}
						reject(new Error(`File not found: ${path}`));
						return;
					}

					// Check if aborted before reading
					if (aborted) {
						return;
					}

					// Read the file
					const content = await readFile(absolutePath, "utf-8");

					// Check if aborted after reading
					if (aborted) {
						return;
					}

					// Check if old text exists
					if (!content.includes(oldText)) {
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

					// Count occurrences
					const occurrences = content.split(oldText).length - 1;

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

					// Check if aborted before writing
					if (aborted) {
						return;
					}

					// Perform replacement using indexOf + substring (raw string replace, no special character interpretation)
					// String.replace() interprets $ in the replacement string, so we do manual replacement
					const index = content.indexOf(oldText);
					const newContent = content.substring(0, index) + newText + content.substring(index + oldText.length);

					// Verify the replacement actually changed something
					if (content === newContent) {
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

					await writeFile(absolutePath, newContent, "utf-8");

					// Check if aborted after writing
					if (aborted) {
						return;
					}

					// Clean up abort handler
					if (signal) {
						signal.removeEventListener("abort", onAbort);
					}

					resolve({
						content: [
							{
								type: "text",
								text: `Successfully replaced text in ${path}. Changed ${oldText.length} characters to ${newText.length} characters.`,
							},
						],
						details: { diff: generateDiffString(content, newContent) },
					});
				} catch (error: any) {
					// Clean up abort handler
					if (signal) {
						signal.removeEventListener("abort", onAbort);
					}

					if (!aborted) {
						reject(error);
					}
				}
			})();
		});
	},
};
