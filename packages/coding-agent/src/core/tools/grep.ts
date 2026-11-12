import { stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { grepRenderers } from "./renderers/grep.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(
		Type.String({
			description:
				"Filter files by glob pattern relative to path, e.g. 'src/**/*.ts'. Without '/', e.g. '*.ts', it matches file names at any depth",
		}),
	),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export const grepToolSystemPromptContribution = {
	snippet: "Search file contents for patterns (respects .gitignore)",
	guidelines: [],
} as const;

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * The search itself always runs the local ripgrep; to search a remote system, override the tool's execute().
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/**
	 * @deprecated Ignored. Context lines come directly from ripgrep. Override the tool's execute() for remote search.
	 */
	readFile?: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
};

/** Decode a ripgrep JSON text field (path or line). Non-UTF-8 data arrives base64-encoded in `bytes`. */
function decodeRgText(data: { text?: string; bytes?: string } | undefined): string {
	if (typeof data?.text === "string") return data.text;
	if (typeof data?.bytes === "string") return Buffer.from(data.bytes, "base64").toString("utf-8");
	return "";
}

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const rgPath = await ensureTool("rg");
						if (!rgPath) {
							settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", ctx?.cwd || cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						// Clamp so String() never yields exponent notation, which rg rejects.
						const contextValue =
							context && context > 0 ? Math.min(Math.floor(context), Number.MAX_SAFE_INTEGER) : 0;
						const effectiveLimit = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, path.resolve(searchPath, filePath));
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						// --no-config: the tool contract (literal, glob, limit, ...) must not depend on
						// ambient user config like RIPGREP_CONFIG_PATH. Users can customize via bash or extensions.
						const args: string[] = ["--no-config", "--json", "--line-number", "--color=never", "--hidden"];
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						// rg never matches a leading "./" ("./src/*.ts" finds nothing), so drop it; "!" negates.
						if (glob) args.push("--glob", glob.replace(/^(!?)(?:\.\/)+/, "$1"));
						// rg emits the surrounding lines as `context` events, so no matched file is ever read here (#9276).
						if (contextValue > 0) args.push("--context", String(contextValue));
						// rg roots --glob at its own cwd, so a directory search runs inside searchPath (#11807).
						// It searches "." because rg canonicalizes its cwd: with an absolute path, a symlinked
						// searchPath (macOS /tmp) would no longer lie under the glob root.
						args.push("--", pattern, isDirectory ? "." : searchPath);

						const child = spawn(rgPath, args, {
							cwd: isDirectory ? searchPath : undefined,
							stdio: ["ignore", "pipe", "pipe"],
						});
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						const outputLines: string[] = [];

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						// Size of the full output, including lines past the byte cap that are counted but not stored.
						let outputBytes = 0;
						let outputLineCount = 0;
						let lastFile: string | undefined;
						// Set at the last allowed match. rg still sends that match's trailing context, kept up to
						// trailingContextEnd, and the limit notice waits for proof of one more match.
						let limitHit = false;
						let trailingContextEnd = 0;
						let done = false;
						const finish = () => {
							done = true;
							stopChild(true);
						};
						const pushLine = (filePath: string, lineNumber: number, lineText: string, isMatch: boolean) => {
							lastFile = filePath;
							const relativePath = formatPath(filePath);
							// Strip only the line terminator: a lone CR inside a line is content, as in the read tool.
							const sanitized = lineText.replace(/\r?\n?$/, "");
							// Truncate long lines so grep output stays compact.
							const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
							if (wasTruncated) linesTruncated = true;
							const line = isMatch
								? `${relativePath}:${lineNumber}: ${truncatedText}`
								: `${relativePath}-${lineNumber}- ${truncatedText}`;
							// Byte truncation below drops everything past the cap, so keep counting but stop storing (#9276).
							// outputBytes counts a newline after every line; the joined output has one fewer.
							if (outputBytes - 1 <= DEFAULT_MAX_BYTES) outputLines.push(line);
							outputBytes += Buffer.byteLength(line, "utf-8") + 1;
							outputLineCount++;
						};

						rl.on("line", (line) => {
							if (done || !line.trim()) return;
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							const isMatch = event.type === "match";
							if (!isMatch && event.type !== "context") return;
							const filePath = decodeRgText(event.data?.path);
							const lineNumber = event.data?.line_number;
							if (!filePath || typeof lineNumber !== "number") return;
							const lineText = decodeRgText(event.data?.lines);
							if (!limitHit) {
								pushLine(filePath, lineNumber, lineText, isMatch);
								if (!isMatch) return;
								matchCount++;
								if (matchCount >= effectiveLimit) {
									limitHit = true;
									trailingContextEnd = lineNumber + contextValue;
								}
								return;
							}
							const inWindow = filePath === lastFile && lineNumber <= trailingContextEnd;
							// A match inside the last match's trailing context is shown as context.
							if (inWindow) pushLine(filePath, lineNumber, lineText, false);
							// Only another match proves that the limit cut results off.
							if (isMatch) matchLimitReached = true;
							if (matchLimitReached && !(inWindow && lineNumber < trailingContextEnd)) finish();
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", (code) => {
							cleanup();
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							if (matchCount === 0) {
								settle(() =>
									resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }),
								);
								return;
							}

							const rawOutput = outputLines.join("\n");
							// Apply byte truncation. There is no line limit here because the match limit already capped rows.
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							truncation.totalLines = outputLineCount;
							truncation.totalBytes = outputBytes - 1;
							let output = truncation.content;
							const details: GrepToolDetails = {};
							// Build actionable notices for truncation and match limits.
							const notices: string[] = [];
							if (matchLimitReached) {
								notices.push(
									`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.matchLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}
							if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		...grepRenderers,
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): TypeBoxAgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
