import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import nodePath from "path";
import { getToolDescription } from "../prompts/index.js";
import { ensureToolWithTimeout } from "../tools-manager.js";
import { DEFAULT_SEARCH_TIMEOUT_MS, killProcessTree } from "./process-utils.js";

const MAX_OUTPUT_BYTES = 16 * 1024; // 16KB

function expandPath(filePath: string): string {
	if (filePath === "~") {
		return homedir();
	}
	if (filePath.startsWith("~/")) {
		return homedir() + filePath.slice(1);
	}
	return filePath;
}

const globMetaRegex = /[*?[\]{}]/;

function splitLeadingLiteralPath(pattern: string): { prefix: string; remainder: string } | null {
	let normalized = pattern.trim();
	if (!normalized) {
		return null;
	}

	if (
		normalized.startsWith("/") ||
		normalized.startsWith("~") ||
		normalized.startsWith("..") ||
		normalized.startsWith("..\\")
	) {
		return null;
	}

	while (normalized.startsWith("./") || normalized.startsWith(".\\")) {
		normalized = normalized.slice(2);
	}

	const segments = normalized.split(/[\\/]/);
	if (segments.length < 2) {
		return null;
	}

	const prefixParts: string[] = [];
	let splitIndex = 0;
	for (let i = 0; i < segments.length; i += 1) {
		const segment = segments[i];
		if (!segment || segment === ".") {
			return null;
		}
		if (segment === ".." || segment === "**" || globMetaRegex.test(segment)) {
			splitIndex = i;
			break;
		}
		prefixParts.push(segment);
		splitIndex = i + 1;
	}

	if (prefixParts.length === 0 || splitIndex >= segments.length) {
		return null;
	}

	const remainder = segments.slice(splitIndex).join("/");
	if (!remainder) {
		return null;
	}

	return {
		prefix: nodePath.join(...prefixParts),
		remainder,
	};
}

const globSchema = Type.Object({
	pattern: Type.Optional(
		Type.String({
			description:
				"Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'. Omit to list directory contents.",
		}),
	),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000 for glob, 500 for ls)" })),
	includeIgnored: Type.Optional(Type.Boolean({ description: "Include files ignored by .gitignore (default: false)" })),
});

const DEFAULT_GLOB_LIMIT = 1000;
const DEFAULT_LS_LIMIT = 500;

async function listDirectory(
	dirPath: string,
	limit: number,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
	if (!existsSync(dirPath)) {
		throw new Error(`Path not found: ${dirPath}`);
	}

	const stat = statSync(dirPath);
	if (!stat.isDirectory()) {
		throw new Error(`Not a directory: ${dirPath}`);
	}

	let entries: string[];
	try {
		entries = readdirSync(dirPath);
	} catch (e: unknown) {
		throw new Error(`Cannot read directory: ${e instanceof Error ? e.message : String(e)}`);
	}

	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}

	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

	const results: string[] = [];
	let truncated = false;
	let byteTruncated = false;
	let totalBytes = 0;

	for (const entry of entries) {
		if (results.length >= limit) {
			truncated = true;
			break;
		}

		const fullPath = nodePath.join(dirPath, entry);
		let suffix = "";

		try {
			const entryStat = statSync(fullPath);
			if (entryStat.isDirectory()) {
				suffix = "/";
			}
		} catch {
			// Skip entries we can't stat
			continue;
		}

		const line = entry + suffix;
		const lineBytes = Buffer.byteLength(line, "utf-8") + 1; // +1 for newline

		if (totalBytes + lineBytes > MAX_OUTPUT_BYTES) {
			byteTruncated = true;
			break;
		}

		totalBytes += lineBytes;
		results.push(line);
	}

	let output = results.join("\n");
	if (byteTruncated) {
		output += `\n\n(output truncated to ${MAX_OUTPUT_BYTES / 1024}KB)`;
	} else if (truncated) {
		const remaining = entries.length - limit;
		output += `\n\n(truncated, ${remaining} more entries)`;
	}
	if (results.length === 0) {
		output = "(empty directory)";
	}

	return { content: [{ type: "text", text: output }], details: undefined };
}

/**
 * Format raw fd output lines into relativized paths
 */
function formatFdOutput(
	rawOutput: string,
	searchPath: string,
	limit: number,
	pathPrefix?: string,
): { output: string; count: number; byteTruncated: boolean } {
	const lines = rawOutput.split("\n");
	const relativized: string[] = [];
	let totalBytes = 0;
	let byteTruncated = false;

	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/, "").trim();
		if (!line) {
			continue;
		}

		const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
		let relativePath = line;
		if (line.startsWith(searchPath)) {
			relativePath = line.slice(searchPath.length + 1); // +1 for the /
		} else {
			relativePath = nodePath.relative(searchPath, line);
		}

		if (pathPrefix) {
			relativePath = relativePath ? nodePath.join(pathPrefix, relativePath) : pathPrefix;
		}

		if (hadTrailingSlash && !relativePath.endsWith("/")) {
			relativePath += "/";
		}

		const lineBytes = Buffer.byteLength(relativePath, "utf-8") + 1; // +1 for newline
		if (totalBytes + lineBytes > MAX_OUTPUT_BYTES) {
			byteTruncated = true;
			break;
		}

		totalBytes += lineBytes;
		relativized.push(relativePath);
	}

	let output = relativized.join("\n");
	const count = relativized.length;

	if (byteTruncated) {
		output += `\n\n(output truncated to ${MAX_OUTPUT_BYTES / 1024}KB)`;
	} else if (count >= limit) {
		output += `\n\n(truncated, ${limit} results shown)`;
	}

	return { output, count, byteTruncated };
}

async function findByGlob(
	pattern: string,
	searchPath: string,
	limit: number,
	includeIgnored: boolean,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
	const fdPath = await ensureToolWithTimeout("fd", undefined, true);
	if (!fdPath) {
		throw new Error("fd is not available and could not be downloaded");
	}

	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}

	const prefixSplit = splitLeadingLiteralPath(pattern);
	const fdSearchPath = prefixSplit ? nodePath.join(searchPath, prefixSplit.prefix) : searchPath;
	const fdPattern = prefixSplit ? prefixSplit.remainder : pattern;
	const outputPrefix = prefixSplit ? prefixSplit.prefix : undefined;

	// fd respects .gitignore natively in git repos.
	// For non-git directories, we only respect the root .gitignore (if present).
	// This avoids the expensive sync traversal that was causing hangs on large directories.
	const args: string[] = ["--glob", "--color=never", "--hidden", "--max-results", String(limit)];

	if (includeIgnored) {
		// Bypass VCS ignore rules (.gitignore) specifically
		args.push("--no-ignore-vcs");
	} else {
		// For non-git directories, manually respect root .gitignore
		const rootGitignore = nodePath.join(searchPath, ".gitignore");
		if (existsSync(rootGitignore)) {
			args.push("--ignore-file", rootGitignore);
		}
	}

	args.push(fdPattern, fdSearchPath);

	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (fn: () => void) => {
			if (!settled) {
				settled = true;
				fn();
			}
		};

		const child = spawn(fdPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = undefined;
			}
			signal?.removeEventListener("abort", onAbort);
		};

		const stopChild = (reason: "timeout" | "abort") => {
			if (!child.killed && child.pid) {
				if (reason === "timeout") {
					timedOut = true;
				}
				killProcessTree(child.pid);
			}
		};

		const onAbort = () => {
			aborted = true;
			stopChild("abort");
		};

		signal?.addEventListener("abort", onAbort, { once: true });

		// Setup timeout
		timeoutHandle = setTimeout(() => {
			stopChild("timeout");
		}, DEFAULT_SEARCH_TIMEOUT_MS);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("error", (err) => {
			cleanup();
			settle(() => reject(new Error(`Failed to run fd: ${err.message}`)));
		});

		child.on("close", (code) => {
			cleanup();

			if (aborted) {
				settle(() => reject(new Error("Operation aborted")));
				return;
			}

			if (timedOut) {
				const trimmed = stdout.trim();
				let result: string;
				if (trimmed) {
					const { output, count } = formatFdOutput(trimmed, fdSearchPath, limit, outputPrefix);
					result =
						output +
						`\n\n(search timed out after ${DEFAULT_SEARCH_TIMEOUT_MS / 1000}s, ${count} files found before timeout)`;
				} else {
					result = `Search timed out after ${DEFAULT_SEARCH_TIMEOUT_MS / 1000}s with no results`;
				}
				settle(() => resolve({ content: [{ type: "text", text: result }], details: undefined }));
				return;
			}

			// fd returns exit code 1 when no matches found (not an error)
			if (code !== 0 && code !== 1 && !stdout.trim()) {
				const errorMsg = stderr.trim() || `fd exited with code ${code}`;
				settle(() => reject(new Error(errorMsg)));
				return;
			}

			const trimmed = stdout.trim();
			if (!trimmed) {
				let message = "No files found matching pattern";
				if (!includeIgnored) {
					message +=
						"\n\n(Note: .gitignored files are excluded. Re-run with includeIgnored: true to include them.)";
				}
				settle(() => resolve({ content: [{ type: "text", text: message }], details: undefined }));
				return;
			}

			const { output } = formatFdOutput(trimmed, fdSearchPath, limit, outputPrefix);
			settle(() => resolve({ content: [{ type: "text", text: output }], details: undefined }));
		});
	});
}

export const globTool: AgentTool<typeof globSchema> = {
	name: "glob",
	label: "glob",
	description: getToolDescription("glob"),
	parameters: globSchema,
	execute: async (
		_toolCallId: string,
		{
			pattern,
			path: searchDir,
			limit,
			includeIgnored,
		}: { pattern?: string; path?: string; limit?: number; includeIgnored?: boolean },
		signal?: AbortSignal,
		_onProgress?: (chunk: string) => void,
	) => {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}

			const onAbort = () => reject(new Error("Operation aborted"));
			signal?.addEventListener("abort", onAbort, { once: true });

			(async () => {
				try {
					const resolvedPath = nodePath.resolve(expandPath(searchDir || "."));

					if (!pattern || pattern.trim() === "") {
						const effectiveLimit = limit ?? DEFAULT_LS_LIMIT;
						const result = await listDirectory(resolvedPath, effectiveLimit, signal);
						signal?.removeEventListener("abort", onAbort);
						resolve(result);
						return;
					}

					const effectiveLimit = limit ?? DEFAULT_GLOB_LIMIT;
					const result = await findByGlob(pattern, resolvedPath, effectiveLimit, includeIgnored ?? false, signal);
					signal?.removeEventListener("abort", onAbort);
					resolve(result);
				} catch (e: unknown) {
					signal?.removeEventListener("abort", onAbort);
					reject(e);
				}
			})();
		});
	},
};
