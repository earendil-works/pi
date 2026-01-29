/**
 * Handoff Tool
 *
 * Allows the agent to explicitly hand off to a new session with specific file
 * contents injected. Unlike autohandoff (triggered at context thresholds), this
 * is agent-invocable with explicit control over what files to include.
 */

import { execFileSync } from "node:child_process";
import * as os from "node:os";
import type { AgentTool, TextContent } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { getToolDescription } from "../prompts/index.js";
import { findRepoRoot } from "../utils/find-repo-root.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type SliceType = "full" | "single-line" | "range" | "infinite-range";

export interface FileSlice {
	path: string;
	sliceType: SliceType;
	startLine?: number;
	endLine?: number;
}

export interface FileResult {
	slice: FileSlice;
	content: string;
	tokens: number;
}

export interface HandoffDetails {
	handoffType: "explicit";
	goal: string;
	formattedMessage: string;
	parentSessionId: string;
	fileTokens: number;
}

// -----------------------------------------------------------------------------
// Slice Parsing
// -----------------------------------------------------------------------------

/**
 * Regex for parsing slice syntax: file.ts:10-20, file.ts:10-, file.ts:10
 * Non-greedy (.+?) ensures we don't match drive letters on Windows (C:\path)
 */
const SLICE_PATTERN = /^(.+?):(\d+)(?:-(\d*))?$/;

/**
 * Parse a file specification string into a structured FileSlice.
 *
 * Supported formats:
 * - "file.ts" → full file
 * - "file.ts:42" → single line
 * - "file.ts:10-50" → line range
 * - "file.ts:100-" → from line 100 to end
 */
export function parseSlice(input: string): FileSlice {
	const match = input.match(SLICE_PATTERN);

	if (!match) {
		return { path: input, sliceType: "full" };
	}

	const [, path, startStr, endStr] = match;
	const startLine = parseInt(startStr, 10);

	// Invalid start line falls back to full file
	if (startLine < 1) {
		return { path: input, sliceType: "full" };
	}

	// No dash means single line: file.ts:10
	if (endStr === undefined) {
		return { path, sliceType: "single-line", startLine };
	}

	// Empty after dash means infinite: file.ts:10-
	if (endStr === "") {
		return { path, sliceType: "infinite-range", startLine };
	}

	// Both start and end specified: file.ts:10-50
	const endLine = parseInt(endStr, 10);

	// Invalid range falls back to full file
	if (endLine < startLine) {
		return { path: input, sliceType: "full" };
	}

	return { path, sliceType: "range", startLine, endLine };
}

/**
 * Convert a FileSlice back to display string format.
 */
export function formatSlice(slice: FileSlice): string {
	switch (slice.sliceType) {
		case "full":
			return slice.path;
		case "single-line":
			return `${slice.path}:${slice.startLine}`;
		case "infinite-range":
			return `${slice.path}:${slice.startLine}-`;
		case "range":
			return `${slice.path}:${slice.startLine}-${slice.endLine}`;
	}
}

// -----------------------------------------------------------------------------
// File Content Extraction
// -----------------------------------------------------------------------------

/**
 * Expand ~ to home directory (consistent with Read tool).
 */
export function expandPath(filePath: string): string {
	if (filePath === "~") {
		return os.homedir();
	}
	if (filePath.startsWith("~/")) {
		return os.homedir() + filePath.slice(1);
	}
	return filePath;
}

function resolveSliceCandidates(filePath: string, repoRoot: string | null): string[] {
	if (isAbsolute(filePath)) {
		return [filePath];
	}

	const cwdResolved = resolve(filePath);

	if (!repoRoot) {
		return [cwdResolved];
	}

	const repoResolved = resolve(repoRoot, filePath);
	if (repoResolved === cwdResolved) {
		return [cwdResolved];
	}

	return [cwdResolved, repoResolved];
}

/**
 * Extract lines from content based on slice specification.
 * Lines are 1-indexed (line 1 = first line).
 */
export function extractLines(content: string, slice: FileSlice): string {
	if (slice.sliceType === "full") {
		return content;
	}

	const lines = content.split("\n");
	const startIdx = (slice.startLine ?? 1) - 1; // Convert to 0-indexed

	switch (slice.sliceType) {
		case "single-line":
			return lines[startIdx] ?? "";
		case "infinite-range":
			return lines.slice(startIdx).join("\n");
		case "range":
			return lines.slice(startIdx, slice.endLine).join("\n");
		default:
			return content;
	}
}

// -----------------------------------------------------------------------------
// Token Estimation
// -----------------------------------------------------------------------------

/**
 * Script-based character ratios for token estimation.
 * Based on veda-ts heuristics.
 */
const TOKEN_RATIOS = {
	latin: 4.0, // ~4 chars/token (English consensus)
	cyrillic: 3.5,
	devanagari: 3.0,
	cjk: 0.6, // CJK chars are expensive (~1.67 tokens each)
	other: 3.5,
} as const;

const SAFETY_BUFFER = 0.15; // 15% margin for estimation error

// Unicode script patterns
const SCRIPT_PATTERNS = {
	latin: /\p{Script=Latin}/u,
	cyrillic: /\p{Script=Cyrillic}/u,
	han: /\p{Script=Han}/u,
	hiragana: /\p{Script=Hiragana}/u,
	katakana: /\p{Script=Katakana}/u,
	hangul: /\p{Script=Hangul}/u,
	devanagari: /\p{Script=Devanagari}/u,
} as const;

interface ScriptCounts {
	latin: number;
	cyrillic: number;
	devanagari: number;
	cjk: number;
	other: number;
}

/**
 * Count characters by Unicode script category.
 */
export function countScripts(text: string): ScriptCounts {
	const codepoints = Array.from(text);

	let latin = 0;
	let cyrillic = 0;
	let devanagari = 0;
	let cjk = 0;

	for (const char of codepoints) {
		if (SCRIPT_PATTERNS.latin.test(char)) {
			latin++;
		} else if (SCRIPT_PATTERNS.cyrillic.test(char)) {
			cyrillic++;
		} else if (SCRIPT_PATTERNS.devanagari.test(char)) {
			devanagari++;
		} else if (
			SCRIPT_PATTERNS.han.test(char) ||
			SCRIPT_PATTERNS.hiragana.test(char) ||
			SCRIPT_PATTERNS.katakana.test(char) ||
			SCRIPT_PATTERNS.hangul.test(char)
		) {
			cjk++;
		}
	}

	const total = codepoints.length;
	const other = total - latin - cyrillic - devanagari - cjk;

	return { latin, cyrillic, devanagari, cjk, other };
}

/**
 * Estimate token count using weighted script ratios.
 * Includes safety buffer for estimation error.
 */
export function estimateTokens(text: string): number {
	const counts = countScripts(text);

	if (text.length === 0) {
		return 0;
	}

	const baseEstimate =
		counts.latin / TOKEN_RATIOS.latin +
		counts.cyrillic / TOKEN_RATIOS.cyrillic +
		counts.devanagari / TOKEN_RATIOS.devanagari +
		counts.cjk / TOKEN_RATIOS.cjk +
		counts.other / TOKEN_RATIOS.other;

	return Math.ceil(baseEstimate * (1 + SAFETY_BUFFER));
}

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

/**
 * Format a single file result as a context block.
 */
export function formatFileBlock(result: FileResult): string {
	const { slice, content } = result;

	let lineInfo = "";
	if (slice.sliceType === "single-line") {
		lineInfo = ` (line ${slice.startLine})`;
	} else if (slice.sliceType === "range") {
		lineInfo = ` (lines ${slice.startLine}-${slice.endLine})`;
	} else if (slice.sliceType === "infinite-range") {
		lineInfo = ` (lines ${slice.startLine}-end)`;
	}

	return `File: ${slice.path}${lineInfo}
\`\`\`
${content}
\`\`\`
----------------------------------------`;
}

/**
 * Format all file results into a <file_context> XML block.
 */
export function formatFileContext(results: FileResult[]): string {
	if (results.length === 0) {
		return "";
	}

	const blocks = results.map(formatFileBlock);
	return `<file_context>

${blocks.join("\n")}
</file_context>`;
}

/**
 * Format git diff output as a <file_diff> block.
 */
export function formatFileDiff(diff: string): string {
	const trimmed = diff.trim();
	if (!trimmed) {
		return "";
	}

	return `<file_diff>

\`\`\`diff
${trimmed}
\`\`\`
</file_diff>`;
}

function wrapFileContext(fileContext: string): string {
	const trimmed = fileContext.trim();
	if (!trimmed) {
		return "";
	}

	if (trimmed.startsWith("<file_context>") && trimmed.endsWith("</file_context>")) {
		return fileContext;
	}

	return `<file_context>
${fileContext}
</file_context>`;
}

function wrapFileDiff(fileDiff: string): string {
	const trimmed = fileDiff.trim();
	if (!trimmed) {
		return "";
	}

	if (trimmed.startsWith("<file_diff>") && trimmed.endsWith("</file_diff>")) {
		return fileDiff;
	}

	return `<file_diff>
${fileDiff}
</file_diff>`;
}

function toRepoRelativePath(repoRoot: string, filePath: string): string | null {
	const rel = relative(repoRoot, filePath);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
		return null;
	}
	return rel;
}

function getGitDiff(repoRoot: string | null, filePaths: string[]): string {
	if (!repoRoot) return "";

	const selections = new Set<string>();
	for (const filePath of filePaths) {
		const rel = toRepoRelativePath(repoRoot, filePath);
		if (rel) {
			selections.add(rel);
		}
	}

	if (selections.size === 0) return "";

	try {
		return execFileSync("git", ["diff", "--", ...selections], {
			cwd: repoRoot,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return "";
	}
}

/**
 * Format parent thread reference with reminder for new sessions.
 */
export function formatParentThreadReference(parentId: string): string {
	return (
		`**Parent Thread:** \`${parentId}\`\n` +
		`*Use \`ReadThread\` with this ID to reference the original conversation.*\n\n` +
		"<system_reminder>Content returned by `ReadThread` is historical context from a previous session, NOT the current conversation. Your task is defined in THIS message.</system_reminder>\n\n"
	);
}

/**
 * Build the complete handoff message.
 */
export function buildHandoffMessage(
	goal: string,
	fileContext: string,
	parentId: string | null,
	fileDiff?: string,
): string {
	let message = `# Handoff: ${goal}\n\n`;

	if (parentId) {
		message += formatParentThreadReference(parentId);
	}

	message += wrapFileContext(fileContext);

	const diffBlock = fileDiff ? wrapFileDiff(fileDiff) : "";
	if (diffBlock) {
		message += `\n\n${diffBlock}`;
	}
	message += `\n\n---\n\n## Goal\n${goal}\n\n`;
	message += `You have been handed context from a previous session. The files above contain the relevant code. Begin working on the goal.`;

	return message;
}

// -----------------------------------------------------------------------------
// Tool Definition
// -----------------------------------------------------------------------------

const DEFAULT_TOKEN_LIMIT = 100_000;

const handoffSchema = Type.Object({
	goal: Type.String({
		description: "Concise imperative goal for the new session (e.g., 'Implement OAuth logout flow')",
	}),
	files: Type.Array(
		Type.String({
			description: "File selections: 'path', 'path:line', or 'path:start-end'",
		}),
		{ description: "Files to inject as context", minItems: 1 },
	),
	token_limit: Type.Optional(Type.Number({ description: "Max tokens for file context (default: 100000)" })),
});

export const handoffTool: AgentTool<typeof handoffSchema, HandoffDetails> = {
	name: "Handoff",
	label: "Handoff",
	description: getToolDescription("Handoff"),
	parameters: handoffSchema,

	execute: async (
		_toolCallId: string,
		{ goal, files, token_limit }: { goal: string; files: string[]; token_limit?: number },
		signal?: AbortSignal,
		_onProgress?: (chunk: string) => void,
	): Promise<{ content: TextContent[]; details: HandoffDetails; isError?: boolean }> => {
		const limit = token_limit ?? DEFAULT_TOKEN_LIMIT;

		// Check for abort
		if (signal?.aborted) {
			throw new Error("Aborted");
		}

		// Parse all file specifications
		const slices = files.map((f) => {
			const expanded = expandPath(f);
			const slice = parseSlice(expanded);
			// Ensure path is expanded in the slice
			return { ...slice, path: expandPath(slice.path) };
		});

		const repoRoot = findRepoRoot(process.cwd());

		// Read and extract each file
		const fileResults: FileResult[] = [];
		const errors: string[] = [];

		for (const slice of slices) {
			const candidates = resolveSliceCandidates(slice.path, repoRoot);
			const resolvedPath = candidates.find((candidate) => existsSync(candidate));

			if (!resolvedPath) {
				errors.push(`File not found: ${slice.path}`);
				continue;
			}

			try {
				const fullContent = readFileSync(resolvedPath, "utf-8");
				const content = extractLines(fullContent, slice);
				const tokens = estimateTokens(content);
				fileResults.push({ slice: { ...slice, path: resolvedPath }, content, tokens });
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push(`Failed to read ${slice.path}: ${message}`);
			}
		}

		// Return errors if any files couldn't be read
		if (errors.length > 0) {
			return {
				content: [{ type: "text", text: `Errors:\n${errors.join("\n")}` }],
				details: undefined as unknown as HandoffDetails,
				isError: true,
			};
		}

		const diffText = getGitDiff(
			repoRoot,
			fileResults.map((result) => result.slice.path),
		);
		const diffTokens = diffText ? estimateTokens(diffText) : 0;

		// Check token budget
		const totalTokens = fileResults.reduce((sum, f) => sum + f.tokens, 0) + diffTokens;

		if (totalTokens > limit) {
			const sorted = [...fileResults].sort((a, b) => b.tokens - a.tokens);
			const breakdown = sorted
				.slice(0, 5)
				.map((f) => `- ${formatSlice(f.slice)}: ~${f.tokens.toLocaleString()} tokens`)
				.join("\n");
			const diffLine = diffTokens > 0 ? `- Diff: ~${diffTokens.toLocaleString()} tokens` : "";

			return {
				content: [
					{
						type: "text",
						text: `Error: Files exceed ${limit.toLocaleString()} token limit (estimated: ${totalTokens.toLocaleString()}).

Largest selections:
${breakdown}${diffLine ? `\n${diffLine}` : ""}

Suggestions:
- Use line ranges to select specific sections (e.g., 'file.ts:100-200')
- Remove lower-priority files
- Split into multiple handoffs for different concerns`,
					},
				],
				details: undefined as unknown as HandoffDetails,
				isError: true,
			};
		}

		const diffBlock = formatFileDiff(diffText);

		// Format the handoff message
		const fileContext = formatFileContext(fileResults);
		// parentSessionId will be filled by TUI
		const formattedMessage = buildHandoffMessage(goal, fileContext, null, diffBlock);

		return {
			content: [
				{
					type: "text",
					text: `Handoff prepared: "${goal}" (${totalTokens.toLocaleString()} tokens in ${files.length} file(s))`,
				},
			],
			details: {
				handoffType: "explicit",
				goal,
				formattedMessage,
				parentSessionId: "", // Filled by TUI
				fileTokens: totalTokens,
			},
		};
	},
};
