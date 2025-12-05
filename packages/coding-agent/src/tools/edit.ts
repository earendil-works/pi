import * as os from "node:os";
import type { AgentTool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile, writeFile } from "fs/promises";
import { resolve as resolvePath } from "path";
import { getToolDescription } from "../prompts/index.js";

function expandPath(filePath: string): string {
	if (filePath === "~") {
		return os.homedir();
	}
	if (filePath.startsWith("~/")) {
		return os.homedir() + filePath.slice(1);
	}
	return filePath;
}

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
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!lastWasChange) {
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}

				if (!nextPartIsChange && linesToShow.length > contextLines) {
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				if (skipStart > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skipStart;
					newLineNum += skipStart;
				}

				for (const line of linesToShow) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skipEnd;
					newLineNum += skipEnd;
				}
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return output.join("\n");
}

/**
 * Escape string for use in RegExp
 */
function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Calculate Jaccard similarity between two arrays of lines (0.0 to 1.0)
 * Good for finding multi-line blocks that are "mostly" the same
 */
function calculateLineSimilarity(linesA: string[], linesB: string[]): number {
	const setA = new Set(linesA.map((l) => l.trim()).filter((l) => l.length > 0));
	const setB = new Set(linesB.map((l) => l.trim()).filter((l) => l.length > 0));

	if (setA.size === 0 && setB.size === 0) return 1.0;
	if (setA.size === 0 || setB.size === 0) return 0.0;

	let intersection = 0;
	for (const item of setA) {
		if (setB.has(item)) intersection++;
	}

	const union = setA.size + setB.size - intersection;
	return intersection / union;
}

/**
 * Simple Levenshtein distance for single-line fuzziness
 */
function levenshteinDistance(a: string, b: string): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	const matrix: number[][] = Array(b.length + 1)
		.fill(null)
		.map(() => Array(a.length + 1).fill(null) as number[]);

	for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
	for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

	for (let j = 1; j <= b.length; j++) {
		for (let i = 1; i <= a.length; i++) {
			const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[j][i] = Math.min(
				matrix[j][i - 1] + 1, // deletion
				matrix[j - 1][i] + 1, // insertion
				matrix[j - 1][i - 1] + indicator, // substitution
			);
		}
	}

	return matrix[b.length][a.length];
}

/**
 * Scan file to find a "Did you mean?" suggestion
 */
function findNearestMatch(
	fileContent: string,
	target: string,
): { similarity: number; line: number; content: string } | null {
	const targetLines = target.split(/\r?\n/);
	const fileLines = fileContent.split(/\r?\n/);

	// Heuristic: If target is short (1 line), use Levenshtein
	if (targetLines.length <= 1) {
		const targetStr = targetLines[0].trim();
		if (targetStr.length < 3) return null; // Too short to guess

		let bestScore = Infinity; // Lower is better for Levenshtein
		let bestLineIdx = -1;
		let bestContent = "";

		for (let i = 0; i < fileLines.length; i++) {
			const line = fileLines[i].trim();
			// Optimization: skip if length difference is too big
			if (Math.abs(line.length - targetStr.length) > targetStr.length * 0.5) continue;

			const score = levenshteinDistance(targetStr, line);
			if (score < bestScore) {
				bestScore = score;
				bestLineIdx = i;
				bestContent = fileLines[i];
			}
		}

		if (bestContent.length === 0) return null;

		const maxLen = Math.max(targetStr.length, bestContent.trim().length);
		const similarity = maxLen > 0 ? 1 - bestScore / maxLen : 0;

		if (similarity > 0.7) {
			return { similarity, line: bestLineIdx + 1, content: bestContent };
		}
	} else {
		// Multi-line: Use sliding window with Jaccard
		let bestSimilarity = 0;
		let bestLineIdx = -1;
		let bestContent = "";

		const windowSize = targetLines.length;
		for (let i = 0; i <= fileLines.length - windowSize; i++) {
			const windowLines = fileLines.slice(i, i + windowSize);
			const sim = calculateLineSimilarity(targetLines, windowLines);

			if (sim > bestSimilarity) {
				bestSimilarity = sim;
				bestLineIdx = i;
				bestContent = windowLines.join("\n");
			}
		}

		if (bestSimilarity > 0.6) {
			return { similarity: bestSimilarity, line: bestLineIdx + 1, content: bestContent };
		}
	}

	return null;
}

interface MatchResult {
	index: number;
	length: number;
	content: string;
}

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.String({
		description: "Text to find and replace. Include surrounding lines if the text appears multiple times.",
	}),
	newText: Type.String({ description: "New text to replace the old text with" }),
	all: Type.Optional(
		Type.Boolean({
			description: "If true, replace all occurrences. If false (default), fail if multiple occurrences found.",
		}),
	),
});

export const editTool: AgentTool<typeof editSchema> = {
	name: "edit",
	label: "edit",
	description: getToolDescription("edit"),
	parameters: editSchema,
	execute: async (
		_toolCallId: string,
		{ path, oldText, newText, all }: { path: string; oldText: string; newText: string; all?: boolean },
		signal?: AbortSignal,
		_onProgress?: (chunk: string) => void,
	) => {
		const absolutePath = resolvePath(expandPath(path));

		return new Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: { diff: string; path: string; oldText: string; newText: string; index: number } | undefined;
		}>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}

			let aborted = false;
			const onAbort = () => {
				aborted = true;
				reject(new Error("Operation aborted"));
			};

			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}

			(async () => {
				try {
					// Check file exists and is accessible
					try {
						await access(absolutePath, constants.R_OK | constants.W_OK);
					} catch {
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}
						reject(new Error(`File not found: ${path}`));
						return;
					}

					if (aborted) return;

					const fileContent = await readFile(absolutePath, "utf-8");

					if (aborted) return;

					// --- TIER 1: Exact Match ---
					const matches: MatchResult[] = [];
					let matchSource = "exact";

					let idx = fileContent.indexOf(oldText);
					while (idx !== -1) {
						matches.push({ index: idx, length: oldText.length, content: oldText });
						idx = fileContent.indexOf(oldText, idx + 1);
					}

					// --- TIER 2: Unescape Fallback ---
					// If no matches, check if model double-escaped newlines/quotes (common LLM error)
					if (matches.length === 0) {
						const unescaped = oldText
							.replace(/\\n/g, "\n")
							.replace(/\\t/g, "\t")
							.replace(/\\"/g, '"')
							.replace(/\\'/g, "'");

						if (unescaped !== oldText) {
							idx = fileContent.indexOf(unescaped);
							while (idx !== -1) {
								matches.push({ index: idx, length: unescaped.length, content: unescaped });
								idx = fileContent.indexOf(unescaped, idx + 1);
							}
							if (matches.length > 0) {
								matchSource = "unescaped";
							}
						}
					}

					// --- TIER 3: Flexible Whitespace Match ---
					// If still no matches, try ignoring whitespace differences
					if (matches.length === 0) {
						const parts = oldText.trim().split(/\s+/);
						if (parts.length > 0 && parts[0].length > 0) {
							const pattern = parts.map(escapeRegExp).join("\\s+");
							const regex = new RegExp(pattern, "g");

							let match: RegExpExecArray | null;
							// biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop pattern
							while ((match = regex.exec(fileContent)) !== null) {
								matches.push({ index: match.index, length: match[0].length, content: match[0] });
							}
							if (matches.length > 0) {
								matchSource = "flexible";
							}
						}
					}

					// --- Result Handling ---

					if (matches.length === 0) {
						// No match found - provide suggestion
						const suggestion = findNearestMatch(fileContent, oldText);
						let errorMsg = `Could not find the text in ${path}.`;

						if (suggestion) {
							errorMsg += `\n\nDid you mean this at line ${suggestion.line}?\n${suggestion.content}`;
							if (suggestion.similarity > 0.9) {
								errorMsg +=
									"\n(Very close match - check for hidden characters or minor whitespace differences)";
							}
						} else {
							errorMsg += "\nThe text must match the file content. Use the read tool to verify.";
						}

						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}
						reject(new Error(errorMsg));
						return;
					}

					if (matches.length > 1 && !all) {
						// Multiple matches without 'all' flag
						const lineNumbers = matches
							.map((m) => fileContent.substring(0, m.index).split("\n").length)
							.join(", ");
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}
						reject(
							new Error(
								`Found ${matches.length} occurrences of the text in ${path} at lines: ${lineNumbers}.\n` +
									`Please provide more surrounding context in 'oldText' to uniquely identify the location, ` +
									`or set 'all: true' to replace all occurrences.`,
							),
						);
						return;
					}

					if (aborted) return;

					// --- Apply Edits ---
					let newContent = fileContent;

					// Sort matches in reverse order to preserve indices during replacement
					const sortedMatches = [...matches].sort((a, b) => b.index - a.index);

					for (const match of sortedMatches) {
						newContent =
							newContent.substring(0, match.index) + newText + newContent.substring(match.index + match.length);
					}

					if (fileContent === newContent) {
						if (signal) {
							signal.removeEventListener("abort", onAbort);
						}
						reject(new Error(`No changes made to ${path}. The replacement produced identical content.`));
						return;
					}

					await writeFile(absolutePath, newContent, "utf-8");

					if (aborted) return;

					if (signal) {
						signal.removeEventListener("abort", onAbort);
					}

					// Build success message
					const matchType = matchSource === "exact" ? "" : ` (using ${matchSource} match)`;
					const countStr = matches.length > 1 ? ` (${matches.length} occurrences)` : "";

					// For details, use first match (in file order) for undo support
					const firstMatch = [...matches].sort((a, b) => a.index - b.index)[0];

					resolve({
						content: [
							{
								type: "text",
								text: `Successfully replaced text in ${path}${matchType}${countStr}.`,
							},
						],
						details: {
							diff: generateDiffString(fileContent, newContent),
							path: absolutePath,
							oldText: firstMatch.content,
							newText,
							index: firstMatch.index,
						},
					});
				} catch (error: unknown) {
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
