import type { AgentTool } from "@kennyfrc/pi-ai";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { globSync } from "glob";
import { homedir } from "os";
import nodePath from "path";
import { getToolDescription } from "../prompts/index.js";
import { ensureTool } from "../tools-manager.js";

function expandPath(filePath: string): string {
	if (filePath === "~") {
		return homedir();
	}
	if (filePath.startsWith("~/")) {
		return homedir() + filePath.slice(1);
	}
	return filePath;
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

		results.push(entry + suffix);
	}

	let output = results.join("\n");
	if (truncated) {
		const remaining = entries.length - limit;
		output += `\n\n(truncated, ${remaining} more entries)`;
	}
	if (results.length === 0) {
		output = "(empty directory)";
	}

	return { content: [{ type: "text", text: output }], details: undefined };
}

async function findByGlob(
	pattern: string,
	searchPath: string,
	limit: number,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }> {
	const fdPath = await ensureTool("fd", true);
	if (!fdPath) {
		throw new Error("fd is not available and could not be downloaded");
	}

	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}

	const args: string[] = ["--glob", "--color=never", "--hidden", "--max-results", String(limit)];

	// fd needs explicit --ignore-file for .gitignore outside git repos
	const gitignoreFiles = new Set<string>();
	const rootGitignore = nodePath.join(searchPath, ".gitignore");
	if (existsSync(rootGitignore)) {
		gitignoreFiles.add(rootGitignore);
	}

	try {
		const nestedGitignores = globSync("**/.gitignore", {
			cwd: searchPath,
			dot: true,
			absolute: true,
			ignore: ["**/node_modules/**", "**/.git/**"],
		});
		for (const file of nestedGitignores) {
			gitignoreFiles.add(file);
		}
	} catch {
		// Ignore glob errors
	}

	for (const gitignorePath of gitignoreFiles) {
		args.push("--ignore-file", gitignorePath);
	}

	args.push(pattern, searchPath);

	const result = spawnSync(fdPath, args, {
		encoding: "utf-8",
		maxBuffer: 10 * 1024 * 1024, // 10MB
	});

	if (result.error) {
		throw new Error(`Failed to run fd: ${result.error.message}`);
	}

	let output = result.stdout?.trim() || "";

	if (result.status !== 0 && !output) {
		const errorMsg = result.stderr?.trim() || `fd exited with code ${result.status}`;
		throw new Error(errorMsg);
	}

	if (!output) {
		output = "No files found matching pattern";
	} else {
		const lines = output.split("\n");
		const relativized: string[] = [];

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

			if (hadTrailingSlash && !relativePath.endsWith("/")) {
				relativePath += "/";
			}

			relativized.push(relativePath);
		}

		output = relativized.join("\n");

		const count = relativized.length;
		if (count >= limit) {
			output += `\n\n(truncated, ${limit} results shown)`;
		}
	}

	return { content: [{ type: "text", text: output }], details: undefined };
}

export const globTool: AgentTool<typeof globSchema> = {
	name: "Glob",
	label: "Glob",
	description: getToolDescription("Glob"),
	parameters: globSchema,
	execute: async (
		_toolCallId: string,
		{ pattern, path: searchDir, limit }: { pattern?: string; path?: string; limit?: number },
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
					const result = await findByGlob(pattern, resolvedPath, effectiveLimit, signal);
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
