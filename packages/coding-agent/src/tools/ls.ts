import type { AgentTool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import nodePath from "path";

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

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

const DEFAULT_LIMIT = 500;

export const lsTool: AgentTool<typeof lsSchema> = {
	name: "ls",
	label: "ls",
	description:
		"List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles.",
	parameters: lsSchema,
	execute: async (_toolCallId: string, { path, limit }: { path?: string; limit?: number }, signal?: AbortSignal) => {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}

			const onAbort = () => reject(new Error("Operation aborted"));
			signal?.addEventListener("abort", onAbort, { once: true });

			try {
				const dirPath = nodePath.resolve(expandPath(path || "."));
				const effectiveLimit = limit ?? DEFAULT_LIMIT;

				// Check if path exists
				if (!existsSync(dirPath)) {
					reject(new Error(`Path not found: ${dirPath}`));
					return;
				}

				// Check if path is a directory
				const stat = statSync(dirPath);
				if (!stat.isDirectory()) {
					reject(new Error(`Not a directory: ${dirPath}`));
					return;
				}

				// Read directory entries
				let entries: string[];
				try {
					entries = readdirSync(dirPath);
				} catch (e: any) {
					reject(new Error(`Cannot read directory: ${e.message}`));
					return;
				}

				// Sort alphabetically (case-insensitive)
				entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

				// Format entries with directory indicators
				const results: string[] = [];
				let truncated = false;

				for (const entry of entries) {
					if (results.length >= effectiveLimit) {
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

				signal?.removeEventListener("abort", onAbort);

				let output = results.join("\n");
				if (truncated) {
					const remaining = entries.length - effectiveLimit;
					output += `\n\n(truncated, ${remaining} more entries)`;
				}
				if (results.length === 0) {
					output = "(empty directory)";
				}

				resolve({ content: [{ type: "text", text: output }], details: undefined });
			} catch (e: any) {
				signal?.removeEventListener("abort", onAbort);
				reject(e);
			}
		});
	},
};
