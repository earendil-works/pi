import type { AgentTool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { globSync } from "glob";
import { homedir } from "os";
import path from "path";
import { ensureTool } from "../tools-manager.js";

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

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

const DEFAULT_LIMIT = 1000;

export const findTool: AgentTool<typeof findSchema> = {
	name: "find",
	label: "find",
	description:
		"Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore.",
	parameters: findSchema,
	execute: async (
		_toolCallId: string,
		{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
		signal?: AbortSignal,
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
					// Ensure fd is available
					const fdPath = await ensureTool("fd", true);
					if (!fdPath) {
						reject(new Error("fd is not available and could not be downloaded"));
						return;
					}

					const searchPath = path.resolve(expandPath(searchDir || "."));
					const effectiveLimit = limit ?? DEFAULT_LIMIT;

					// Build fd arguments
					const args: string[] = [
						"--glob", // Use glob pattern
						"--color=never", // No ANSI colors
						"--hidden", // Search hidden files (but still respect .gitignore)
						"--max-results",
						String(effectiveLimit),
					];

					// Include .gitignore files (root + nested) so fd respects them even outside git repos
					const gitignoreFiles = new Set<string>();
					const rootGitignore = path.join(searchPath, ".gitignore");
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

					// Pattern and path
					args.push(pattern, searchPath);

					// Run fd
					const result = spawnSync(fdPath, args, {
						encoding: "utf-8",
						maxBuffer: 10 * 1024 * 1024, // 10MB
					});

					signal?.removeEventListener("abort", onAbort);

					if (result.error) {
						reject(new Error(`Failed to run fd: ${result.error.message}`));
						return;
					}

					let output = result.stdout?.trim() || "";

					if (result.status !== 0) {
						const errorMsg = result.stderr?.trim() || `fd exited with code ${result.status}`;
						// fd returns non-zero for some errors but may still have partial output
						if (!output) {
							reject(new Error(errorMsg));
							return;
						}
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
								relativePath = path.relative(searchPath, line);
							}

							if (hadTrailingSlash && !relativePath.endsWith("/")) {
								relativePath += "/";
							}

							relativized.push(relativePath);
						}

						output = relativized.join("\n");

						const count = relativized.length;
						if (count >= effectiveLimit) {
							output += `\n\n(truncated, ${effectiveLimit} results shown)`;
						}
					}

					resolve({ content: [{ type: "text", text: output }], details: undefined });
				} catch (e: any) {
					signal?.removeEventListener("abort", onAbort);
					reject(e);
				}
			})();
		});
	},
};
