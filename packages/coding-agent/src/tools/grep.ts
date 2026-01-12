import { createInterface } from "node:readline";
import type { AgentTool } from "@kennyfrc/pi-ai";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { readFileSync, type Stats, statSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getToolDescription } from "../prompts/index.js";
import { ensureTool } from "../tools-manager.js";
import { DEFAULT_SEARCH_TIMEOUT_MS, killProcessTree } from "./process-utils.js";

/**
 * Expand ~ to home directory
 */
function expandPath(filePath: string): string {
	if (filePath === "~") {
		return homedir();
	}
	if (filePath.startsWith("~/")) {
		return homedir() + filePath.slice(1);
	}
	return filePath;
}

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

const DEFAULT_LIMIT = 100;

export const grepTool: AgentTool<typeof grepSchema> = {
	name: "Grep",
	label: "Grep",
	description: getToolDescription("Grep"),
	parameters: grepSchema,
	execute: async (
		_toolCallId: string,
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
		_onProgress?: (chunk: string) => void,
	) => {
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
					const rgPath = await ensureTool("rg", true);
					if (!rgPath) {
						settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
						return;
					}

					const searchPath = path.resolve(expandPath(searchDir || "."));
					let searchStat: Stats;
					try {
						searchStat = statSync(searchPath);
					} catch (err) {
						settle(() => reject(new Error(`Path not found: ${searchPath}`)));
						return;
					}

					const isDirectory = searchStat.isDirectory();
					const contextValue = context && context > 0 ? context : 0;
					const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

					const formatPath = (filePath: string): string => {
						if (isDirectory) {
							const relative = path.relative(searchPath, filePath);
							if (relative && !relative.startsWith("..")) {
								return relative.replace(/\\/g, "/");
							}
						}
						return path.basename(filePath);
					};

					const fileCache = new Map<string, string[]>();
					const getFileLines = (filePath: string): string[] => {
						let lines = fileCache.get(filePath);
						if (!lines) {
							try {
								const content = readFileSync(filePath, "utf-8");
								lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
							} catch {
								lines = [];
							}
							fileCache.set(filePath, lines);
						}
						return lines;
					};

					const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];

					if (ignoreCase) {
						args.push("--ignore-case");
					}

					if (literal) {
						args.push("--fixed-strings");
					}

					if (glob) {
						args.push("--glob", glob);
					}

					args.push(pattern, searchPath);

					const child = spawn(rgPath, args, {
						stdio: ["ignore", "pipe", "pipe"],
						detached: process.platform !== "win32",
					});
					const rl = createInterface({ input: child.stdout });
					let stderr = "";
					let matchCount = 0;
					let truncated = false;
					let aborted = false;
					let timedOut = false;
					let killedDueToLimit = false;
					const outputLines: string[] = [];

					let timeoutHandle: NodeJS.Timeout | undefined;

					const cleanup = () => {
						if (timeoutHandle) {
							clearTimeout(timeoutHandle);
							timeoutHandle = undefined;
						}
						rl.close();
						signal?.removeEventListener("abort", onAbort);
					};

					const stopChild = (reason: "limit" | "timeout" | "abort") => {
						if (!child.killed && child.pid) {
							if (reason === "limit") {
								killedDueToLimit = true;
							} else if (reason === "timeout") {
								timedOut = true;
							}
							killProcessTree(child.pid);
						}
					};

					// Setup timeout
					timeoutHandle = setTimeout(() => {
						stopChild("timeout");
					}, DEFAULT_SEARCH_TIMEOUT_MS);

					const onAbort = () => {
						aborted = true;
						stopChild("abort");
					};

					signal?.addEventListener("abort", onAbort, { once: true });

					child.stderr?.on("data", (chunk) => {
						stderr += chunk.toString();
					});

					const formatBlock = (filePath: string, lineNumber: number) => {
						const relativePath = formatPath(filePath);
						const lines = getFileLines(filePath);
						if (!lines.length) {
							return [`${relativePath}:${lineNumber}: (unable to read file)`];
						}

						const block: string[] = [];
						const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
						const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;

						for (let current = start; current <= end; current++) {
							const lineText = lines[current - 1] ?? "";
							const sanitized = lineText.replace(/\r/g, "");
							const isMatchLine = current === lineNumber;

							if (isMatchLine) {
								block.push(`${relativePath}:${current}: ${sanitized}`);
							} else {
								block.push(`${relativePath}-${current}- ${sanitized}`);
							}
						}

						return block;
					};

					rl.on("line", (line) => {
						if (!line.trim() || matchCount >= effectiveLimit) {
							return;
						}

						let event: any;
						try {
							event = JSON.parse(line);
						} catch {
							return;
						}

						if (event.type === "match") {
							matchCount++;
							const filePath = event.data?.path?.text;
							const lineNumber = event.data?.line_number;

							if (filePath && typeof lineNumber === "number") {
								outputLines.push(...formatBlock(filePath, lineNumber));
							}

							if (matchCount >= effectiveLimit) {
								truncated = true;
								stopChild("limit");
							}
						}
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

						if (timedOut) {
							let result: string;
							if (matchCount > 0) {
								result = outputLines.join("\n");
								result += `\n\n(search timed out after ${DEFAULT_SEARCH_TIMEOUT_MS / 1000}s, ${matchCount} matches found before timeout)`;
							} else {
								result = `Search timed out after ${DEFAULT_SEARCH_TIMEOUT_MS / 1000}s with no matches`;
							}
							settle(() => resolve({ content: [{ type: "text", text: result }], details: undefined }));
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

						let output = outputLines.join("\n");
						if (truncated) {
							output += `\n\n(truncated, limit of ${effectiveLimit} matches reached)`;
						}

						settle(() => resolve({ content: [{ type: "text", text: output }], details: undefined }));
					});
				} catch (err) {
					settle(() => reject(err as Error));
				}
			})();
		});
	},
};
