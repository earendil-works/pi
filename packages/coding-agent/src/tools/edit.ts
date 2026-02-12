import * as os from "node:os";
import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { createHash } from "crypto";
import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile, writeFile } from "fs/promises";
import { resolve as resolvePath } from "path";
import { getToolDescription } from "../prompts/index.js";
import { computeLineHash } from "../utils/hashline.js";

function expandPath(filePath: string): string {
	if (filePath === "~") {
		return os.homedir();
	}
	if (filePath.startsWith("~/")) {
		return os.homedir() + filePath.slice(1);
	}
	return filePath;
}

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
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

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// LLMs often produce these instead of ASCII. Length-preserving (1:1) for safe index matching.
const CONFUSABLE_MAP: Readonly<Record<string, string>> = {
	"\u2018": "'",
	"\u2019": "'",
	"\u201C": '"',
	"\u201D": '"', // curly quotes
	"\u201A": "'",
	"\u201E": '"',
	"\u00AB": '"',
	"\u00BB": '"', // low-9, guillemets
	"\u2039": "'",
	"\u203A": "'", // single angle quotes
	"\u2013": "-",
	"\u2014": "-",
	"\u2010": "-",
	"\u2011": "-", // en/em dash, hyphens
	"\u2012": "-",
	"\u2015": "-",
	"\u2212": "-", // figure dash, bar, minus
	"\u00A0": " ",
	"\u2002": " ",
	"\u2003": " ",
	"\u2007": " ", // nbsp, en/em/figure space
	"\u2009": " ",
	"\u200A": " ",
	"\u202F": " ",
	"\u205F": " ",
	"\u3000": " ", // thin/hair/narrow/math/ideo space
	"\u2024": ".",
	"\uFF0E": ".",
	"\uFF0C": ",", // dot leader, fullwidth period/comma
};

// Zero-width chars that break matching invisibly
const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
	"\u200B",
	"\u200C",
	"\u200D",
	"\u200E",
	"\u200F",
	"\uFEFF",
	"\u2060",
]);

function normalizeConfusables(input: string): string {
	let result = input;
	for (const char of INVISIBLE_CHARS) {
		result = result.split(char).join("");
	}
	for (const [from, to] of Object.entries(CONFUSABLE_MAP)) {
		result = result.split(from).join(to);
	}
	return result;
}

// Expand quotes/dashes to character classes matching all variants (straight + curly)
function makeConfusableFlexiblePattern(escapedLiteral: string): string {
	return escapedLiteral
		.replace(/['\u2018\u2019\u201A\u2039\u203A]/g, "['\u2018\u2019\u201A\u2039\u203A]")
		.replace(/["\u201C\u201D\u201E\u00AB\u00BB]/g, '["\u201C\u201D\u201E\u00AB\u00BB]')
		.replace(/[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "[-\u2010\u2011\u2012\u2013\u2014\u2015\u2212]")
		.replace(/\\\.\\\.\\\./g, "(?:\\.{3}|\u2026)");
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

// Hashline batch edit schemas
const setLineSchema = Type.Object({
	set_line: Type.Object({
		anchor: Type.String({ description: 'Line reference "LINE:HASH"' }),
		new_text: Type.String({ description: 'Replacement text. Use "" to delete.' }),
	}),
});

const replaceLinesSchema = Type.Object({
	replace_lines: Type.Object({
		start_anchor: Type.String({ description: 'Start line "LINE:HASH"' }),
		end_anchor: Type.String({ description: 'End line "LINE:HASH"' }),
		new_text: Type.String({ description: 'Replacement text. Use "" to delete range.' }),
	}),
});

const insertAfterSchema = Type.Object({
	insert_after: Type.Object({
		anchor: Type.String({ description: 'Insert after this line "LINE:HASH"' }),
		text: Type.String({ description: "Content to insert (non-empty)" }),
	}),
});

const replaceSchema = Type.Object({
	replace: Type.Object({
		old_text: Type.String({ description: "Text to find (fuzzy matching)" }),
		new_text: Type.String({ description: "Replacement text" }),
		all: Type.Optional(Type.Boolean({ description: "Replace all occurrences" })),
	}),
});

const hashlineEditItemSchema = Type.Union([setLineSchema, replaceLinesSchema, insertAfterSchema, replaceSchema]);

// Single top-level object schema for provider compatibility.
// Runtime validation below enforces valid combinations:
// - legacy mode requires oldText + newText
// - batch mode requires edits
const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	oldText: Type.Optional(
		Type.String({
			description: "Legacy mode: text to find and replace.",
		}),
	),
	newText: Type.Optional(
		Type.String({
			description: "Legacy mode: replacement text for oldText.",
		}),
	),
	all: Type.Optional(
		Type.Boolean({
			description: "Legacy mode: replace all occurrences instead of requiring a unique match.",
		}),
	),
	edits: Type.Optional(Type.Array(hashlineEditItemSchema, { description: "Batch mode: array of hashline edits." })),
});

// Type guards for batch operations
function isBatchEdit(input: unknown): input is { path: string; edits: unknown[] } {
	if (typeof input !== "object" || input === null) return false;
	const candidate = input as { edits?: unknown };
	return Array.isArray(candidate.edits);
}

// Regex patterns for prefix stripping
const HASHLINE_PREFIX_RE = /^\d+:[a-z0-9]{2}\|/;
const DIFF_PLUS_RE = /^\+(?!\+)/; // + but not ++

/**
 * Get leading whitespace of a string
 */
function leadingWhitespace(s: string): string {
	const match = s.match(/^\s*/);
	return match ? match[0] : "";
}

/**
 * Restore original indentation to a line if model didn't provide any
 */
function restoreLeadingIndent(templateLine: string, line: string): string {
	if (line.length === 0) return line;
	const templateIndent = leadingWhitespace(templateLine);
	if (templateIndent.length === 0) return line;
	const indent = leadingWhitespace(line);
	if (indent.length > 0) return line; // Model provided indent, trust it
	return templateIndent + line;
}

/**
 * Restore indentation for all lines in a replacement
 */
function restoreIndentForReplacement(oldLines: string[], newLines: string[]): string[] {
	if (oldLines.length !== newLines.length) return newLines;

	let changed = false;
	const out = new Array<string>(newLines.length);
	for (let i = 0; i < newLines.length; i++) {
		const restored = restoreLeadingIndent(oldLines[i], newLines[i]);
		out[i] = restored;
		if (restored !== newLines[i]) changed = true;
	}
	return changed ? out : newLines;
}

/**
 * Strip hashline prefixes and diff + markers from replacement lines.
 * Models frequently copy LINE:HASH| prefixes or include diff + markers.
 */
function stripNewLinePrefixes(text: string): string {
	const lines = text.split("\n");

	// Count non-empty lines and prefix matches
	let nonEmpty = 0;
	let hashPrefixCount = 0;
	let diffPlusCount = 0;

	for (const line of lines) {
		if (line.length === 0) continue;
		nonEmpty++;
		if (HASHLINE_PREFIX_RE.test(line)) hashPrefixCount++;
		if (DIFF_PLUS_RE.test(line)) diffPlusCount++;
	}

	if (nonEmpty === 0) return text;

	// Determine if we should strip (majority > 50%)
	const stripHash = hashPrefixCount > 0 && hashPrefixCount >= nonEmpty * 0.5;
	const stripPlus = !stripHash && diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5;

	if (!stripHash && !stripPlus) return text;

	return lines
		.map((line) => {
			if (stripHash) return line.replace(HASHLINE_PREFIX_RE, "");
			if (stripPlus) return line.replace(DIFF_PLUS_RE, "");
			return line;
		})
		.join("\n");
}

// Parse line reference "LINE:HASH" or "LINE:HASH-LINE:HASH" (for ranges, handled separately)
function parseLineRef(ref: string): { line: number; hash: string } {
	// Strip display suffix if present: "5:ab|content" -> "5:ab"
	const cleaned = ref.replace(/\|.*$/, "").trim();
	const match = cleaned.match(/^(\d+):([a-z0-9]{2})$/i);
	if (!match) {
		throw new Error(`Invalid line reference "${ref}". Expected format "LINE:HASH" (e.g., "5:ab").`);
	}
	return { line: parseInt(match[1], 10), hash: match[2].toLowerCase() };
}

// Hash mismatch error with rich context
export class HashlineMismatchError extends Error {
	constructor(
		public readonly mismatches: Array<{ line: number; expected: string; actual: string }>,
		public readonly fileLines: string[],
	) {
		super(HashlineMismatchError.formatMessage(mismatches, fileLines));
		this.name = "HashlineMismatchError";
	}

	static formatMessage(
		mismatches: Array<{ line: number; expected: string; actual: string }>,
		fileLines: string[],
	): string {
		const lines: string[] = [];
		lines.push(
			`${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} hash mismatch - changed since last read. Use the updated LINE:HASH references shown below (>>> marks changed lines).`,
		);
		lines.push("");

		// Show context around each mismatch
		const contextLines = new Set<number>();
		for (const m of mismatches) {
			for (let i = Math.max(1, m.line - 2); i <= Math.min(fileLines.length, m.line + 2); i++) {
				contextLines.add(i);
			}
		}

		const sorted = [...contextLines].sort((a, b) => a - b);
		let prev = -1;
		for (const lineNum of sorted) {
			if (prev !== -1 && lineNum > prev + 1) {
				lines.push("    ...");
			}
			prev = lineNum;
			const content = fileLines[lineNum - 1] ?? "";
			const hash = computeLineHash(lineNum, content);
			const isMismatch = mismatches.some((m) => m.line === lineNum);
			lines.push(`${isMismatch ? ">>>" : "   "} ${lineNum}:${hash}|${content}`);
		}

		// Quick fix section
		lines.push("");
		lines.push("Quick fix — replace stale refs:");
		for (const m of mismatches) {
			const actualHash = computeLineHash(m.line, fileLines[m.line - 1]);
			lines.push(`\t${m.line}:${m.expected} → ${m.line}:${actualHash}`);
		}

		return lines.join("\n");
	}
}

// Apply batch hashline edits
async function applyBatchEdits(
	absolutePath: string,
	edits: any[],
	_signal?: AbortSignal,
): Promise<{ content: string; diff: string }> {
	const fileContent = await readFile(absolutePath, "utf-8");
	const fileLines = fileContent.split("\n");
	const originalLines = [...fileLines];

	if (edits.length === 0) {
		throw new Error("edits array must not be empty");
	}

	// Build hash -> line index map for relocation
	const hashToLine = new Map<string, number>();
	const duplicateHashes = new Set<string>();
	for (let i = 0; i < fileLines.length; i++) {
		const hash = computeLineHash(i + 1, fileLines[i]);
		if (hashToLine.has(hash)) {
			duplicateHashes.add(hash);
		} else {
			hashToLine.set(hash, i + 1);
		}
	}

	// Track hashes referenced by the model - if same hash appears in multiple anchors, it's ambiguous
	const hashReferenceCount = new Map<string, number>();
	for (const edit of edits) {
		let anchor: string | undefined;
		if ("set_line" in edit) anchor = edit.set_line.anchor;
		else if ("insert_after" in edit) anchor = edit.insert_after.anchor;
		else if ("replace_lines" in edit) {
			anchor = edit.replace_lines.start_anchor;
			const endHash = parseLineRef(edit.replace_lines.end_anchor).hash;
			hashReferenceCount.set(endHash, (hashReferenceCount.get(endHash) || 0) + 1);
		}
		if (anchor) {
			const { hash } = parseLineRef(anchor);
			hashReferenceCount.set(hash, (hashReferenceCount.get(hash) || 0) + 1);
		}
	}
	// Mark hashes referenced multiple times as "ambiguous" (don't relocate)
	for (const [hash, count] of hashReferenceCount) {
		if (count > 1) {
			duplicateHashes.add(hash);
		}
	}

	// Parse and validate all edits first
	const parsedEdits: Array<{
		type: "set_line" | "replace_lines" | "insert_after" | "replace";
		startLine: number;
		endLine: number;
		newLines: string[];
		originalAnchor?: string;
	}> = [];
	const mismatches: Array<{ line: number; expected: string; actual: string }> = [];

	for (const edit of edits) {
		if ("set_line" in edit) {
			const { anchor, new_text } = edit.set_line;
			let { line, hash } = parseLineRef(anchor);
			const actualHash = computeLineHash(line, fileLines[line - 1]);

			if (actualHash !== hash) {
				// Try relocation
				const relocatedLine = hashToLine.get(hash);
				if (relocatedLine && !duplicateHashes.has(hash)) {
					line = relocatedLine;
				} else {
					mismatches.push({ line, expected: hash, actual: actualHash });
					continue;
				}
			}

			// Strip prefixes from new_text
			const strippedText = stripNewLinePrefixes(new_text);

			parsedEdits.push({
				type: "set_line",
				startLine: line,
				endLine: line,
				newLines: strippedText === "" ? [] : [strippedText],
				originalAnchor: anchor,
			});
		} else if ("replace_lines" in edit) {
			const { start_anchor, end_anchor, new_text } = edit.replace_lines;
			const start = parseLineRef(start_anchor);
			const end = parseLineRef(end_anchor);

			const actualStartHash = computeLineHash(start.line, fileLines[start.line - 1]);
			const actualEndHash = computeLineHash(end.line, fileLines[end.line - 1]);

			if (actualStartHash !== start.hash) {
				const relocated = hashToLine.get(start.hash);
				if (relocated && !duplicateHashes.has(start.hash)) {
					start.line = relocated;
				} else {
					mismatches.push({ line: start.line, expected: start.hash, actual: actualStartHash });
				}
			}
			if (actualEndHash !== end.hash) {
				const relocated = hashToLine.get(end.hash);
				if (relocated && !duplicateHashes.has(end.hash)) {
					end.line = relocated;
				} else {
					mismatches.push({ line: end.line, expected: end.hash, actual: actualEndHash });
				}
			}

			if (start.line > end.line) {
				throw new Error(`Range start line ${start.line} must be <= end line ${end.line}`);
			}

			// Strip prefixes from new_text
			const strippedText = stripNewLinePrefixes(new_text);

			parsedEdits.push({
				type: "replace_lines",
				startLine: start.line,
				endLine: end.line,
				newLines: strippedText === "" ? [] : strippedText.split("\n"),
			});
		} else if ("insert_after" in edit) {
			const { anchor, text } = edit.insert_after;
			if (!text || text === "") {
				throw new Error("insert_after requires non-empty text");
			}

			let { line, hash } = parseLineRef(anchor);
			const actualHash = computeLineHash(line, fileLines[line - 1]);

			if (actualHash !== hash) {
				const relocated = hashToLine.get(hash);
				if (relocated && !duplicateHashes.has(hash)) {
					line = relocated;
				} else {
					mismatches.push({ line, expected: hash, actual: actualHash });
					continue;
				}
			}

			// Strip prefixes from text
			const strippedText = stripNewLinePrefixes(text);

			parsedEdits.push({
				type: "insert_after",
				startLine: line + 1,
				endLine: line,
				newLines: strippedText.split("\n"),
			});
		} else if ("replace" in edit) {
			// Fuzzy replace fallback - find and replace text
			const { old_text, new_text, all } = edit.replace;
			// Strip prefixes from new_text
			const strippedText = stripNewLinePrefixes(new_text);
			// For now, treat as a single-line operation at line 1
			// This will be enhanced in a later slice
			const idx = fileContent.indexOf(old_text);
			if (idx === -1) {
				throw new Error(`Could not find text: ${old_text.slice(0, 50)}...`);
			}
			// Find which line this starts on
			const beforeMatch = fileContent.slice(0, idx);
			const startLine = beforeMatch.split("\n").length;
			const endLine = startLine + old_text.split("\n").length - 1;

			parsedEdits.push({
				type: "replace",
				startLine,
				endLine,
				newLines: strippedText.split("\n"),
			});
		}
	}

	if (mismatches.length > 0) {
		throw new HashlineMismatchError(mismatches, fileLines);
	}

	// Sort bottom-up (highest line first) for stable application
	parsedEdits.sort((a, b) => b.startLine - a.startLine);

	// Track no-op edits
	const noopEdits: Array<{ editIndex: number; line: number; currentContent: string }> = [];

	// Apply edits
	for (let i = 0; i < parsedEdits.length; i++) {
		const edit = parsedEdits[i];

		if (edit.type === "insert_after") {
			// For insert, check if resulting in empty content
			if (edit.newLines.length === 0 || (edit.newLines.length === 1 && edit.newLines[0] === "")) {
				noopEdits.push({ editIndex: i, line: edit.startLine - 1, currentContent: "" });
				continue;
			}
			fileLines.splice(edit.startLine - 1, 0, ...edit.newLines);
		} else {
			const count = edit.endLine - edit.startLine + 1;
			const origLines = originalLines.slice(edit.startLine - 1, edit.startLine - 1 + count);

			// Restore indentation if model didn't provide any
			const restoredLines = restoreIndentForReplacement(origLines, edit.newLines);

			const origContent = origLines.join("\n");
			const newContent = restoredLines.join("\n");

			// Check for no-op (identical content)
			if (origContent === newContent) {
				noopEdits.push({ editIndex: i, line: edit.startLine, currentContent: origContent });
				continue;
			}

			fileLines.splice(edit.startLine - 1, count, ...restoredLines);
		}
	}

	// If any no-ops detected, throw error with details
	if (noopEdits.length > 0) {
		let diagnostic = `No changes made to ${absolutePath}. The edits produced identical content.`;
		const details = noopEdits
			.map((e) => {
				const hash = computeLineHash(e.line, fileLines[e.line - 1]);
				return `Edit ${e.editIndex}: replacement for ${e.line}:${hash} is identical to current content:\n  ${e.line}:${hash}| ${e.currentContent}`;
			})
			.join("\n");
		diagnostic += `\n${details}`;
		diagnostic +=
			"\nYour content must differ from what the file already contains. Re-read the file to see the current state.";
		throw new Error(diagnostic);
	}

	const newContent = fileLines.join("\n");
	const diff = generateDiffString(originalLines.join("\n"), newContent);

	return { content: newContent, diff };
}

export const editTool: AgentTool<typeof editSchema> = {
	name: "Edit",
	label: "Edit",
	description: getToolDescription("Edit"),
	parameters: editSchema,
	getResourceKey: ({ path }) => `file:${resolvePath(expandPath(path))}`,
	execute: async (_toolCallId: string, params: any, signal?: AbortSignal, _onProgress?: (chunk: string) => void) => {
		if (typeof params?.path !== "string" || params.path.length === 0) {
			throw new Error('Missing required parameter "path".');
		}

		const absolutePath = resolvePath(expandPath(params.path));

		// Route to batch handler or legacy handler
		if (isBatchEdit(params)) {
			// Check for mixed params
			if ("oldText" in params || "newText" in params) {
				throw new Error("Cannot mix edits array with oldText/newText. Use one or the other.");
			}

			const { content, diff } = await applyBatchEdits(absolutePath, params.edits, signal);
			await writeFile(absolutePath, content, "utf-8");

			return {
				content: [{ type: "text" as const, text: `Successfully edited ${params.path}` }],
				details: { diff, path: absolutePath, newContentHash: hashContent(content) },
			};
		}

		// Legacy single-edit handler
		const { oldText, newText, all } = params;
		if (typeof oldText !== "string" || typeof newText !== "string") {
			throw new Error('Legacy edit mode requires both "oldText" and "newText" string parameters.');
		}

		return new Promise<{
			content: Array<{ type: "text"; text: string }>;
			details:
				| {
						diff: string;
						path: string;
						oldText: string;
						newText: string;
						index: number;
						newContentHash: string;
				  }
				| undefined;
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
						reject(new Error(`File not found: ${params.path}`));
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

					// --- TIER 2.5: Confusable Normalization ---
					if (matches.length === 0) {
						const normalizedOld = normalizeConfusables(oldText);
						const normalizedFile = normalizeConfusables(fileContent);

						// Length must be preserved for index safety (invisible char removal can break this)
						const oldChanged = normalizedOld !== oldText;
						const fileChanged = normalizedFile !== fileContent;
						const oldLengthPreserved = oldText.length === normalizedOld.length;
						const fileLengthPreserved = fileContent.length === normalizedFile.length;

						if ((oldChanged || fileChanged) && oldLengthPreserved && fileLengthPreserved) {
							idx = normalizedFile.indexOf(normalizedOld);
							while (idx !== -1) {
								matches.push({
									index: idx,
									length: oldText.length,
									content: fileContent.slice(idx, idx + oldText.length),
								});
								idx = normalizedFile.indexOf(normalizedOld, idx + 1);
							}
							if (matches.length > 0) {
								matchSource = "normalized";
							}
						}
					}

					// --- TIER 3: Flexible Whitespace + Confusables ---
					if (matches.length === 0) {
						const parts = oldText.trim().split(/\s+/);
						if (parts.length > 0 && parts[0].length > 0) {
							const pattern = parts
								.map((p: string) => makeConfusableFlexiblePattern(escapeRegExp(p)))
								.join("\\s+");
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
						const suggestion = findNearestMatch(fileContent, oldText);
						let errorMsg = `Could not find the text in ${params.path}.`;

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
								`Found ${matches.length} occurrences of the text in ${params.path} at lines: ${lineNumbers}.\n` +
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
						reject(new Error(`No changes made to ${params.path}. The replacement produced identical content.`));
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
								text: `Successfully replaced text in ${params.path}${matchType}${countStr}.`,
							},
						],
						details: {
							diff: generateDiffString(fileContent, newContent),
							path: absolutePath,
							oldText: firstMatch.content,
							newText,
							index: firstMatch.index,
							newContentHash: hashContent(newContent),
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
